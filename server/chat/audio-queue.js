/**
 * OpenVibe.Chat — the persisted TTS and sound queue (roadmap Wave 6 D4).
 *
 * Every TTS utterance, channel !sound and 101soundboards clip a room asks for is a row of
 * `audio_requests`, played one at a time per room:
 *
 *     queued ──▶ playing ──▶ played
 *        │          │
 *        ├──────────┴──▶ skipped   (a moderator or the broadcaster: /skiptts, /cleartts, /api/tts/queue)
 *        └──────────┴──▶ failed    (synthesis or the clip failed, it expired, or the playing client said so)
 *
 *   queued   accepted, not delivered yet. The audio is made (synthesized / read / fetched) when its
 *            turn comes, so a skipped or cleared request costs nothing.
 *   playing  delivered to the room (the `tts-audio` / `soundboard-audio` frame, now with request_id)
 *            and inside its play window (the clip's length, estimated from the audio). When the
 *            window ends it is played and the next one goes out.
 *   played, skipped, failed  final.
 *
 * One clip per room across every Chat process: `claim()` takes the room's advisory lock in its
 * transaction and takes nothing while the room has a playing row (the partial unique index
 * idx_audio_requests_one_playing, migrations/0002, is the store's guarantee). A process that loses
 * gets nothing; the room's next pump (the owner's, when its clip ends, or the heartbeat) plays it.
 *
 * Claims are owned: a playing row records its process (`claimed_by`, the instance id: host and port,
 * or CHAT_AUDIO_INSTANCE_ID) and a lease (`lease_until`) the owner renews every HEARTBEAT_MS while it
 * lives. Only a row whose owner is dead is ever settled by another hand — its lease has passed, or it
 * is this process's own row from before a restart (same instance id) — by `recover()` at boot and by
 * the heartbeat's sweep. Such a row:
 *   - was never delivered (no started_at: its owner died while making it): it goes back to queued,
 *     in its old place (the queue plays by id), once; `attempts` counts claims, so a row claimed
 *     MAX_ATTEMPTS (2) times that dies again undelivered fails ('not delivered: its owner stopped
 *     twice') and a clip that crashes Chat cannot loop;
 *   - was delivered (started_at set): it is played ('delivered before a restart'), never replayed.
 * A row of a live owner, on any process, is never touched.
 *
 * A Chat restart keeps the queue: `recover()` at boot settles its own and dead owners' playing rows
 * as above, fails rows queued too long ago to still matter, and plays the rest once the room has
 * listeners again: a second after the first socket rejoins it (clients come back 1–4 s after a
 * restart notice), or after RESUME_GRACE_MS whatever happens.
 *
 * Start and stop are ordered, so a restart is the same every time:
 *   - `recover()` closes the pump gate before its first await and opens it when the queue is settled and held:
 *     a pump asked for meanwhile (a socket's request, the heartbeat) is parked and runs after, so a fresh claim of
 *     this process is never read by recover() as a row left over from before the restart, and nothing plays out of order;
 *   - `stop()` is async: it cancels the pacing timers, then waits for the work in flight (a pump making a clip, a
 *     finish, a tick, a recover) before it resolves, and what that work does after the stop is limited to what a
 *     restart settles anyway: a clip made but not yet delivered is left claimed and undelivered (replayed once), a
 *     clip delivered is left with its started_at (played, 'delivered before a restart') and gets no pacing timer.
 *     The chat server awaits it before it closes its sockets and the database.
 * A keyed request (a TTS of chat message m<id>) is queued once per room, so a retried bridge call
 * or a double delivery never reads it twice, even across a restart.
 *
 * Browsers keep their own playback queue and the frames they already know; the server pacing means
 * that queue holds at most the clip playing now, so skip and clear on the server take effect at
 * once for everything not yet delivered. Two new frames, ignored by clients that don't know them,
 * let a client stop the clip in hand: `{ type: 'audio-skip', request_id }` and
 * `{ type: 'audio-clear', request_ids }`.
 */
'use strict';

const os = require('os');
const db = require('../db/database');

const STATES = ['queued', 'playing', 'played', 'skipped', 'failed'];
const TRANSITIONS = {
    queued: ['playing', 'skipped', 'failed'],
    playing: ['played', 'skipped', 'failed'],
    played: [],
    skipped: [],
    failed: [],
};
const KINDS = ['tts', 'channel-sound', 'soundboard'];

const GAP_MS = 250;                  // between two clips
const MIN_PLAY_MS = 500;
const MAX_PLAY_MS = 60 * 1000;
const STALE_MS = 5 * 60 * 1000;      // a request still queued this long after it was made is dropped
const MAX_ATTEMPTS = 2;              // claims of one request: its owner may die undelivered once (one replay)
const LEASE_MS = 30 * 1000;          // a playing row's owner is dead once its lease is this old…
const HEARTBEAT_MS = 10 * 1000;      // …and a live owner renews it this often (and sweeps dead owners' rows)
const LOCK_SPACE = 71_440_216;       // pg_advisory_xact_lock(LOCK_SPACE, hashtext(room)): one claim per room at a time
const KEEP_MS = 7 * 24 * 3600 * 1000;
const RESUME_GRACE_MS = 8000;        // after a restart, a room with waiting requests resumes by then…
const RESUME_SETTLE_MS = 1000;       // …or this long after a socket rejoins it

function canTransition(from, to) {
    return !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function roomKey({ streamId, channelUserId }) {
    if (streamId) return `stream:${Number(streamId)}`;
    if (channelUserId) return `channel:${Number(channelUserId)}`;
    return null;
}

// ── Clip length ─────────────────────────────────────────────────────────────────────────────────
const MP3_BITRATES = {
    // [version 1, version 2/2.5] × layer III kbps
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
/** Bitrate (bits/s) of the first MPEG layer III frame, skipping an ID3v2 tag; null if none. */
function mp3Bitrate(buf) {
    let i = 0;
    if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
        i = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
    }
    for (const end = Math.min(buf.length - 4, i + 64 * 1024); i < end; i++) {
        if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
        const version = (buf[i + 1] >> 3) & 0x03;   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
        const layer = (buf[i + 1] >> 1) & 0x03;     // 1 = layer III
        const idx = (buf[i + 2] >> 4) & 0x0f;
        if (version === 1 || layer !== 1 || idx === 0 || idx === 15) continue;
        return MP3_BITRATES[version === 3 ? 1 : 2][idx] * 1000;
    }
    return null;
}
/** How long a clip plays, in ms: a known length, a WAV header, an MP3 frame's bitrate, or a guess. */
function estimatePlayMs({ audio, mimeType, seconds, speed } = {}) {
    const rate = Number(speed) > 0 ? Number(speed) : 1;
    let ms = null;
    if (Number(seconds) > 0) ms = Number(seconds) * 1000;
    else if (audio) {
        let buf = null;
        try { buf = Buffer.from(String(audio), 'base64'); } catch { buf = null; }
        if (buf && buf.length) {
            if (buf.length > 44 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') {
                const byteRate = buf.readUInt32LE(28);
                if (byteRate > 0) ms = ((buf.length - 44) / byteRate) * 1000;
            } else {
                const bps = /mpeg|mp3/.test(String(mimeType || '')) ? mp3Bitrate(buf) : null;
                ms = (buf.length * 8 / (bps || 128000)) * 1000;
            }
        }
    }
    if (ms == null) ms = 3000;
    return Math.round(Math.min(MAX_PLAY_MS, Math.max(MIN_PLAY_MS, ms / rate)));
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────
async function getRequest(id) { return await db.get('SELECT * FROM audio_requests WHERE id = ?', [id]) || null; }

/**
 * Move one request along the state machine. Returns true when it moved (the row was in a state
 * that allows `to`); false when something else moved it first.
 */
async function transition(id, to, { error = null, actor = null, durationMs = null, now = clock() } = {}) {
    const from = Object.keys(TRANSITIONS).filter((s) => TRANSITIONS[s].includes(to));
    if (!from.length) return false;
    const final = to !== 'playing';
    const r = await db.run(
        `UPDATE audio_requests SET state = ?, error = COALESCE(?, error), actor = COALESCE(?, actor),
                duration_ms = COALESCE(?, duration_ms),
                started_at = CASE WHEN ? = 'playing' THEN ? ELSE started_at END,
                finished_at = CASE WHEN ? THEN ? ELSE finished_at END
          WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`,
        [to, error, actor, durationMs, to, now, final ? 1 : 0, now, id, ...from],
    );
    return r.changes > 0;
}

// ── Runtime ─────────────────────────────────────────────────────────────────────────────────────
const performers = {};   // kind → async (row, payload) → { frame, durationMs } | null
let deliver = null;      // (row, frame) → void
let instanceId = process.env.CHAT_AUDIO_INSTANCE_ID || `${os.hostname()}:${process.env.PORT || 4400}`;
let clock = () => Date.now();
let timers = { setTimeout, clearTimeout };   // the pacing, hold and deferral timers (tests drive them by hand)
let heartbeat = null;
const inflight = new Set(); // pumps, finishes, ticks and recovers still running: stop() waits for them
const deferred = new Set(); // rooms a pump was asked for while recover() ran: pumped when it is done
let recovering = false;
const waiting = new Set(); // rooms whose claim lost to another process's playing row: pumped again by the heartbeat
const rooms = new Map(); // room → { busy, timer, playingId }
let stopped = false;

function roomState(room) {
    if (!rooms.has(room)) rooms.set(room, { busy: false, timer: null, playingId: null, makingId: null, holdUntil: 0, holdTimer: null });
    return rooms.get(room);
}

/** Hold a room's queue until `until` (restart recovery), then play. A shorter hold replaces a longer one. */
function holdRoom(room, until) {
    if (stopped) return;
    const st = roomState(room);
    if (st.holdUntil && st.holdUntil <= until) return;
    st.holdUntil = until;
    if (st.holdTimer) timers.clearTimeout(st.holdTimer);
    st.holdTimer = timers.setTimeout(() => { st.holdUntil = 0; st.holdTimer = null; pump(room).catch((err) => console.warn('[AudioQueue] pump:', err.message)); }, Math.max(0, until - clock()));
    if (st.holdTimer.unref) st.holdTimer.unref();
}

/** A socket joined a room: a queue held since a restart plays shortly. */
function roomJoined(room) {
    const st = room && rooms.get(room);
    if (st && st.holdUntil > clock()) holdRoom(room, clock() + RESUME_SETTLE_MS);
}

/**
 * Wire the queue to the chat server: how each kind is made, and how a frame reaches a room.
 * `performers[kind](row, payload)` resolves { frame, durationMs } or null (nothing to play).
 * `instanceId` names this process's claims (default: host and port); `clock` (ms) is for tests.
 * `heartbeat: false` leaves lease renewal and the sweep to the caller (tests call tick()); `timers`
 * ({ setTimeout, clearTimeout }) replaces the pacing, hold and deferral timers (tests fire them by hand).
 */
function init({ performers: p, deliver: d, instanceId: id = null, clock: c = null, timers: t = null, heartbeat: beat = true }) {
    Object.assign(performers, p || {});
    deliver = d;
    if (id) instanceId = String(id);
    if (c) clock = c;
    if (t) timers = { ...timers, ...t };
    stopped = false;
    recovering = false;
    deferred.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (beat) {
        heartbeat = setInterval(() => { tick().catch((err) => console.warn('[AudioQueue] heartbeat:', err.message)); }, HEARTBEAT_MS);
        if (heartbeat.unref) heartbeat.unref();
    }
}

/** Run `work` as something stop() and idle() wait for. */
function track(work) {
    inflight.add(work);
    const done = () => inflight.delete(work);
    work.then(done, done);
    return work;
}
/** Resolves once nothing is in flight (what a timer or a request started has finished). */
async function idle() {
    while (inflight.size) await Promise.allSettled([...inflight]);
}

/**
 * Stop (shutdown): cancel the pacing timers, then wait (at most `graceMs`) for the work in flight, so nothing
 * of this process's queue is still touching the database or the sockets once it resolves. States stay as they are;
 * recover() picks them up at boot. Never rejects.
 */
async function stop({ graceMs = 3000 } = {}) {
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    waiting.clear();
    deferred.clear();
    for (const st of rooms.values()) {
        if (st.timer) timers.clearTimeout(st.timer);
        if (st.holdTimer) timers.clearTimeout(st.holdTimer);
        st.timer = null; st.holdTimer = null;
    }
    let bound;
    await Promise.race([idle(), new Promise((resolve) => { bound = setTimeout(resolve, graceMs); })]);
    clearTimeout(bound);
    rooms.clear();
}

/**
 * Accept a request. Returns { id, queued: true } or { queued: false, reason } — `duplicate` (this
 * room already has this key), `full` (the room or this requester is at its limit).
 */
async function enqueue({ kind, streamId = null, channelUserId = null, requestedBy = null, identityKey = null, label = null, payload = {}, dedupeKey = null, maxRoom = null, maxPerRequester = null, now = Date.now() }) {
    if (!KINDS.includes(kind)) throw new Error(`audio-queue: unknown kind ${kind}`);
    const room = roomKey({ streamId, channelUserId });
    if (!room) return { queued: false, reason: 'no_room' };
    // One transaction: the caps are counted in it, and the unique (room, dedupe_key) index decides a duplicate
    // (ON CONFLICT DO NOTHING: no row back), so two processes enqueueing the same key store one row.
    const result = await db.tx(async () => {
        if (dedupeKey && await db.get('SELECT 1 FROM audio_requests WHERE room = ? AND dedupe_key = ?', [room, dedupeKey])) return { queued: false, reason: 'duplicate' };
        if (maxRoom) {
            const n = (await db.get("SELECT COUNT(*) AS n FROM audio_requests WHERE room = ? AND state IN ('queued', 'playing')", [room])).n;
            if (n >= maxRoom) return { queued: false, reason: 'full' };
        }
        if (maxPerRequester && identityKey) {
            const n = (await db.get("SELECT COUNT(*) AS n FROM audio_requests WHERE room = ? AND identity_key = ? AND state IN ('queued', 'playing')", [room, identityKey])).n;
            if (n >= maxPerRequester) return { queued: false, reason: 'full' };
        }
        const r = await db.run(
            `INSERT INTO audio_requests (room, stream_id, channel_user_id, kind, state, requested_by, identity_key, label, payload, dedupe_key, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room, dedupe_key) DO NOTHING`,
            [room, streamId || null, channelUserId || null, kind, requestedBy, identityKey, label ? String(label).slice(0, 300) : null, JSON.stringify(payload || {}), dedupeKey, now],
        );
        if (!r.changes) return { queued: false, reason: 'duplicate' };
        return { queued: true, id: Number(r.lastInsertRowid), room };
    });
    if (result.queued) timers.setTimeout(() => { pump(result.room).catch((err) => console.warn('[AudioQueue] pump:', err.message)); }, 0);
    return result;
}

/**
 * Take a queued request to play (plan T3 decision 3), owned by this process under a lease. One transaction holding
 * the room's advisory lock: nothing while the room has a playing row (any process's), else one atomic UPDATE, so of
 * two pumps (two processes) at most one gets a row of a room back. Counts the attempt.
 * → the row, or null with `busy` set when the room is playing (null without it: someone took or skipped this row).
 */
async function claim(id, { now = clock() } = {}) {
    const out = await claimOrBusy(id, now);
    return out.row;
}
async function claimOrBusy(id, now) {
    try {
        return await db.tx(async () => {
            const q = await db.get("SELECT room FROM audio_requests WHERE id = ? AND state = 'queued'", [id]);
            if (!q) return { row: null, busy: false };
            await db.get('SELECT pg_advisory_xact_lock(?, hashtext(?)) AS locked', [LOCK_SPACE, q.room]);
            if (await db.get("SELECT 1 AS one FROM audio_requests WHERE room = ? AND state = 'playing'", [q.room])) return { row: null, busy: true };
            const row = await db.get(
                `UPDATE audio_requests SET state = 'playing', attempts = attempts + 1, claimed_by = ?, lease_until = ?
                  WHERE id = ? AND state = 'queued' RETURNING *`,
                [instanceId, now + LEASE_MS, id],
            );
            return { row: row || null, busy: false };
        });
    } catch (err) {
        // The one-playing-row index refused it: a claimer that does not take the lock (a previous release) won.
        if (err && err.code === '23505') return { row: null, busy: true };
        throw err;
    }
}

/** Play the next request of a room if none is playing (not while recover() runs: the room is pumped when it is done). */
function pump(room) { return track(pumpRoom(room)); }
async function pumpRoom(room) {
    if (stopped || !room) return;
    if (recovering) { deferred.add(room); return; }
    const st = roomState(room);
    if (st.busy || st.playingId || st.holdUntil > clock()) return;
    st.busy = true;
    try {
        for (;;) {
            if (stopped) return;
            let row;
            try { row = await db.get("SELECT * FROM audio_requests WHERE room = ? AND state = 'queued' ORDER BY id LIMIT 1", [room]); } catch { return; }
            if (stopped) return;
            if (!row) { waiting.delete(room); return; }
            if (row.attempts >= MAX_ATTEMPTS) { await transition(row.id, 'failed', { error: 'gave up after repeated attempts', actor: 'system' }); continue; }
            const { row: claimed, busy } = await claimOrBusy(row.id, clock());
            if (busy) { waiting.add(room); return; }   // another process plays this room: its finish (or the heartbeat) pumps again
            if (!claimed) continue;   // another pump took it (or it was skipped): the next one
            waiting.delete(room);
            row = claimed;
            // The audio is made outside any transaction (a synth takes seconds); the row stays 'playing' meanwhile.
            st.makingId = row.id;
            const perform = performers[row.kind];
            let made = null, error = null;
            try {
                made = perform ? await perform(row, JSON.parse(row.payload || '{}')) : null;
                if (!perform) error = `no performer for ${row.kind}`;
                else if (!made || !made.frame) error = 'no audio';
            } catch (err) { error = (err && err.message) || 'failed'; }
            st.makingId = null;
            if (stopped) return;
            if (error) { await transition(row.id, 'failed', { error: String(error).slice(0, 300), actor: 'system' }); continue; }
            const durationMs = Math.round(Math.min(MAX_PLAY_MS, Math.max(MIN_PLAY_MS, Number(made.durationMs) || estimatePlayMs(made.frame))));
            // Skipped or cleared while it was being made: nothing goes out.
            const started = await db.run("UPDATE audio_requests SET started_at = ?, duration_ms = ? WHERE id = ? AND state = 'playing'", [clock(), durationMs, row.id]);
            if (!started.changes) continue;
            try { if (deliver) deliver(row, { ...made.frame, request_id: row.id }); } catch (err) { console.warn('[AudioQueue] deliver:', err.message); }
            if (stopped) return;   // delivered (started_at is set: a restart counts it played); stop() cleared the timers, so no window to pace
            st.playingId = row.id;
            st.timer = timers.setTimeout(() => { finish(room, row.id, 'played').catch((err) => console.warn('[AudioQueue] finish:', err.message)); }, durationMs + GAP_MS);
            if (st.timer.unref) st.timer.unref();
            return;
        }
    } finally { st.busy = false; }
}

/** End the playing request of a room (its window ended, it was skipped, or the client reported). */
function finish(room, id, to, opts = {}) { return track(finishRoom(room, id, to, opts)); }
async function finishRoom(room, id, to, opts) {
    const st = roomState(room);
    let moved = false;
    try { moved = await transition(id, to, opts); } catch { moved = false; }
    if (st.playingId === id) {
        if (st.timer) timers.clearTimeout(st.timer);
        st.timer = null;
        st.playingId = null;
        if (!stopped) timers.setTimeout(() => { pump(room).catch((err) => console.warn('[AudioQueue] pump:', err.message)); }, 0);
    }
    return moved;
}

/**
 * Skip one request of a room: `id`, or else the one playing, or else the next queued.
 * Returns the skipped row or null.
 */
async function skip(room, { id = null, actor = null } = {}) {
    let row = null;
    if (id) row = await db.get("SELECT * FROM audio_requests WHERE id = ? AND room = ? AND state IN ('queued', 'playing')", [id, room]);
    else row = await db.get("SELECT * FROM audio_requests WHERE room = ? AND state = 'playing' ORDER BY id LIMIT 1", [room])
        || await db.get("SELECT * FROM audio_requests WHERE room = ? AND state = 'queued' ORDER BY id LIMIT 1", [room]);
    if (!row) return null;
    // 'playing' and out (the room's clip) is finished; 'playing' still being made never went out: no skip frame.
    const out = row.state === 'playing' && roomState(room).playingId === row.id;
    const moved = out ? await finish(room, row.id, 'skipped', { actor }) : await transition(row.id, 'skipped', { actor });
    if (!moved) return null;
    if (out && deliver) { try { deliver(row, { type: 'audio-skip', request_id: row.id, kind: row.kind }); } catch { /* */ } }
    return { ...row, state: 'skipped' };
}

/** Skip everything queued or playing in a room. Returns the ids skipped. */
async function clear(room, { actor = null } = {}) {
    const rows = await db.all("SELECT * FROM audio_requests WHERE room = ? AND state IN ('queued', 'playing') ORDER BY id", [room]);
    const ids = [];
    let sample = null;
    for (const row of rows) {
        const moved = row.state === 'playing' ? await finish(room, row.id, 'skipped', { actor }) : await transition(row.id, 'skipped', { actor });
        if (moved) { ids.push(row.id); sample = sample || row; }
    }
    if (ids.length && deliver) { try { deliver(sample, { type: 'audio-clear', request_ids: ids }); } catch { /* */ } }
    return ids;
}

/** The playing client's report: its clip ended ('played') or could not play ('failed'). */
async function report(room, id, state, { error = null, actor = null } = {}) {
    if (state !== 'played' && state !== 'failed') return false;
    const row = await db.get("SELECT * FROM audio_requests WHERE id = ? AND room = ? AND state = 'playing'", [id, room]);
    if (!row) return false;
    return await finish(room, row.id, state, { error: state === 'failed' ? String(error || 'playback failed').slice(0, 300) : null, actor });
}

/** A room's queue: what plays now, what waits, and the latest finished requests. */
async function list(room, { recent = 20 } = {}) {
    const shape = (r) => ({
        id: r.id, kind: r.kind, state: r.state, requested_by: r.requested_by, label: r.label,
        error: r.error, actor: r.actor, duration_ms: r.duration_ms,
        created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
    });
    const playing = await db.get("SELECT * FROM audio_requests WHERE room = ? AND state = 'playing' ORDER BY id LIMIT 1", [room]);
    const queued = await db.all("SELECT * FROM audio_requests WHERE room = ? AND state = 'queued' ORDER BY id", [room]);
    const done = await db.all("SELECT * FROM audio_requests WHERE room = ? AND state IN ('played', 'skipped', 'failed') ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT ?", [room, Math.min(Math.max(parseInt(recent, 10) || 0, 0), 100)]);
    return { room, playing: playing ? shape(playing) : null, queued: queued.map(shape), recent: done.map(shape) };
}

/**
 * Settle the playing rows of dead owners: a lease that has passed (or none: a previous release's claim), and with
 * `mine` this instance's own rows (at boot they are from before the restart). Delivered → played; undelivered →
 * queued again in its old place, or failed once it has been claimed MAX_ATTEMPTS times. A live owner's row is
 * never touched. → { played, requeued, failed, rooms }
 */
async function reclaimDead({ now = clock(), mine = false } = {}) {
    const dead = `state = 'playing' AND (lease_until IS NULL OR lease_until < ?${mine ? ' OR claimed_by = ?' : ''})`;
    const args = mine ? [now, instanceId] : [now];
    const played = await db.all(`UPDATE audio_requests SET state = 'played', finished_at = ?, error = 'delivered before a restart'
                                  WHERE ${dead} AND started_at IS NOT NULL RETURNING room`, [now, ...args]);
    const failed = await db.all(`UPDATE audio_requests SET state = 'failed', finished_at = ?, error = 'not delivered: its owner stopped twice', actor = 'system'
                                  WHERE ${dead} AND started_at IS NULL AND attempts >= ? RETURNING room`, [now, ...args, MAX_ATTEMPTS]);
    const requeued = await db.all(`UPDATE audio_requests SET state = 'queued', claimed_by = NULL, lease_until = NULL, duration_ms = NULL
                                    WHERE ${dead} AND started_at IS NULL AND attempts < ? RETURNING room`, [...args, MAX_ATTEMPTS]);
    const rooms = [...new Set([...played, ...failed, ...requeued].map((r) => r.room))];
    return { played: played.length, requeued: requeued.length, failed: failed.length, rooms };
}

/**
 * The heartbeat (every HEARTBEAT_MS, or by hand in tests): renew this process's leases, settle dead owners' rows
 * and pump the rooms that freed, and retry rooms whose claim lost to another process.
 */
function tick(opts) { return track(tickOnce(opts)); }
async function tickOnce({ now = clock() } = {}) {
    if (stopped) return { renewed: 0, rooms: [] };
    const renewed = (await db.run("UPDATE audio_requests SET lease_until = ? WHERE state = 'playing' AND claimed_by = ?", [now + LEASE_MS, instanceId])).changes;
    const swept = await reclaimDead({ now });
    if (swept.rooms.length) console.log(`[AudioQueue] swept dead owners' rows: ${swept.played} finished, ${swept.requeued} requeued, ${swept.failed} failed`);
    const rooms = [...new Set([...swept.rooms, ...waiting])];
    for (const room of rooms) await pump(room).catch((err) => console.warn('[AudioQueue] pump:', err.message));
    return { renewed, ...swept, rooms };
}

/**
 * Boot: this instance's rows from before the restart and dead owners' rows are settled (reclaimDead); rows
 * queued too long ago fail as expired; every room with queued rows starts playing again. Another live process's
 * playing rows stay as they are.
 */
function recover(opts) { return track(recoverOnce(opts)); }
async function recoverOnce({ now = clock(), graceMs = RESUME_GRACE_MS } = {}) {
    recovering = true;   // before the first await: no pump of this process runs until the queue is settled and held
    try {
        return await settleAtBoot(now, graceMs);
    } finally {
        recovering = false;
        const asked = [...deferred];
        deferred.clear();
        for (const room of asked) pump(room).catch((err) => console.warn('[AudioQueue] pump:', err.message));
    }
}
async function settleAtBoot(now, graceMs) {
    const settled = await reclaimDead({ now, mine: true });
    const played = settled.played;
    const expired = (await db.run("UPDATE audio_requests SET state = 'failed', finished_at = ?, error = 'expired', actor = 'system' WHERE state = 'queued' AND created_at < ?", [now, now - STALE_MS])).changes;
    await db.run("DELETE FROM audio_requests WHERE state IN ('played', 'skipped', 'failed') AND COALESCE(finished_at, created_at) < ?", [now - KEEP_MS]);
    const pending = (await db.all("SELECT DISTINCT room FROM audio_requests WHERE state = 'queued'")).map((r) => r.room);
    for (const room of pending) holdRoom(room, now + graceMs);
    if (played || settled.requeued || settled.failed || expired || pending.length) {
        console.log(`[AudioQueue] recovered: ${played} finished, ${settled.requeued} requeued, ${settled.failed} failed, ${expired} expired, ${pending.length} room(s) resuming`);
    }
    return { played, requeued: settled.requeued, failed: settled.failed, expired, rooms: pending };
}

module.exports = {
    STATES, TRANSITIONS, KINDS, STALE_MS, GAP_MS, RESUME_GRACE_MS, RESUME_SETTLE_MS, MAX_ATTEMPTS, LEASE_MS, HEARTBEAT_MS,
    canTransition, roomKey, estimatePlayMs, mp3Bitrate,
    init, stop, idle, enqueue, pump, claim, skip, clear, report, list, recover, tick, reclaimDead, roomJoined, getRequest, transition,
    get instanceId() { return instanceId; },
};
