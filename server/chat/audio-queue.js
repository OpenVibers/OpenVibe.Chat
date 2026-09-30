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
 * A Chat restart keeps the queue: `recover()` at boot finishes rows that were playing (they reached
 * the room before the restart), fails rows queued too long ago to still matter, and plays the rest
 * once the room has listeners again: a second after the first socket rejoins it (clients come back
 * 1–4 s after a restart notice), or after RESUME_GRACE_MS whatever happens.
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
const MAX_ATTEMPTS = 3;              // a request whose making crashed Chat this often fails
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
async function transition(id, to, { error = null, actor = null, durationMs = null, now = Date.now() } = {}) {
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
const rooms = new Map(); // room → { busy, timer, playingId }
let stopped = false;

function roomState(room) {
    if (!rooms.has(room)) rooms.set(room, { busy: false, timer: null, playingId: null, makingId: null, holdUntil: 0, holdTimer: null });
    return rooms.get(room);
}

/** Hold a room's queue until `until` (restart recovery), then play. A shorter hold replaces a longer one. */
function holdRoom(room, until) {
    const st = roomState(room);
    if (st.holdUntil && st.holdUntil <= until) return;
    st.holdUntil = until;
    if (st.holdTimer) clearTimeout(st.holdTimer);
    st.holdTimer = setTimeout(() => { st.holdUntil = 0; st.holdTimer = null; pump(room).catch((err) => console.warn('[AudioQueue] pump:', err.message)); }, Math.max(0, until - Date.now()));
    if (st.holdTimer.unref) st.holdTimer.unref();
}

/** A socket joined a room: a queue held since a restart plays shortly. */
function roomJoined(room) {
    const st = room && rooms.get(room);
    if (st && st.holdUntil > Date.now()) holdRoom(room, Date.now() + RESUME_SETTLE_MS);
}

/**
 * Wire the queue to the chat server: how each kind is made, and how a frame reaches a room.
 * `performers[kind](row, payload)` resolves { frame, durationMs } or null (nothing to play).
 */
function init({ performers: p, deliver: d }) {
    Object.assign(performers, p || {});
    deliver = d;
    stopped = false;
}

/** Stop pacing timers (shutdown). States stay as they are; recover() picks them up at boot. */
function stop() {
    stopped = true;
    for (const st of rooms.values()) {
        if (st.timer) clearTimeout(st.timer);
        if (st.holdTimer) clearTimeout(st.holdTimer);
        st.timer = null; st.holdTimer = null;
    }
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
    if (result.queued) setImmediate(() => { pump(result.room).catch((err) => console.warn('[AudioQueue] pump:', err.message)); });
    return result;
}

/**
 * Take a queued request to play (plan T3 decision 3): one atomic UPDATE, so of two pumps (two processes) at most
 * one gets the row back; null = someone else took it, or it was skipped. Counts the attempt.
 */
async function claim(id) {
    return await db.get("UPDATE audio_requests SET state = 'playing', attempts = attempts + 1 WHERE id = ? AND state = 'queued' RETURNING *", [id]) || null;
}

/** Play the next request of a room if none is playing. */
async function pump(room) {
    if (stopped || !room) return;
    const st = roomState(room);
    if (st.busy || st.playingId || st.holdUntil > Date.now()) return;
    st.busy = true;
    try {
        for (;;) {
            if (stopped) return;
            let row;
            try { row = await db.get("SELECT * FROM audio_requests WHERE room = ? AND state = 'queued' ORDER BY id LIMIT 1", [room]); } catch { return; }
            if (!row) return;
            if (row.attempts >= MAX_ATTEMPTS) { await transition(row.id, 'failed', { error: 'gave up after repeated attempts', actor: 'system' }); continue; }
            const claimed = await claim(row.id);
            if (!claimed) continue;   // another pump took it (or it was skipped): the next one
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
            const now = Date.now();
            const started = await db.run("UPDATE audio_requests SET started_at = ?, duration_ms = ? WHERE id = ? AND state = 'playing'", [now, durationMs, row.id]);
            if (!started.changes) continue;
            try { if (deliver) deliver(row, { ...made.frame, request_id: row.id }); } catch (err) { console.warn('[AudioQueue] deliver:', err.message); }
            st.playingId = row.id;
            st.timer = setTimeout(() => { finish(room, row.id, 'played').catch((err) => console.warn('[AudioQueue] finish:', err.message)); }, durationMs + GAP_MS);
            if (st.timer.unref) st.timer.unref();
            return;
        }
    } finally { st.busy = false; }
}

/** End the playing request of a room (its window ended, it was skipped, or the client reported). */
async function finish(room, id, to, opts = {}) {
    const st = roomState(room);
    let moved = false;
    try { moved = await transition(id, to, opts); } catch { moved = false; }
    if (st.playingId === id) {
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        st.playingId = null;
        setImmediate(() => { pump(room).catch((err) => console.warn('[AudioQueue] pump:', err.message)); });
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
 * Boot: rows playing when Chat stopped were delivered, so they are played; rows queued too long
 * ago fail as expired; every room with queued rows starts playing again.
 */
async function recover({ now = Date.now(), graceMs = RESUME_GRACE_MS } = {}) {
    const played = (await db.run("UPDATE audio_requests SET state = 'played', finished_at = ?, error = 'delivered before a restart' WHERE state = 'playing'", [now])).changes;
    const expired = (await db.run("UPDATE audio_requests SET state = 'failed', finished_at = ?, error = 'expired', actor = 'system' WHERE state = 'queued' AND created_at < ?", [now, now - STALE_MS])).changes;
    await db.run("DELETE FROM audio_requests WHERE state IN ('played', 'skipped', 'failed') AND COALESCE(finished_at, created_at) < ?", [now - KEEP_MS]);
    const pending = (await db.all("SELECT DISTINCT room FROM audio_requests WHERE state = 'queued'")).map((r) => r.room);
    for (const room of pending) holdRoom(room, now + graceMs);
    if (played || expired || pending.length) console.log(`[AudioQueue] recovered: ${played} finished, ${expired} expired, ${pending.length} room(s) resuming`);
    return { played, expired, rooms: pending };
}

module.exports = {
    STATES, TRANSITIONS, KINDS, STALE_MS, GAP_MS, RESUME_GRACE_MS, RESUME_SETTLE_MS,
    canTransition, roomKey, estimatePlayMs, mp3Bitrate,
    init, stop, enqueue, pump, claim, skip, clear, report, list, recover, roomJoined, getRequest, transition,
};
