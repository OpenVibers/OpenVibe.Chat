'use strict';
/**
 * A Chat room's control lease (seven domains plan B3, common.control-lease@1).
 *
 * { thing, holder: { kind: person|ai|nobody, subject }, since_ms, expires_ms?, watchers[], seq }
 *
 * The room is the thing: Chat names it chat.room:<slug>, so a room socket carries exactly one lease. Chat checks who
 * may send what; this module decides and stores the state:
 *
 *   request  a signed-in member asks for the controls. Free controls (nobody) go to the requester at once; otherwise
 *            the room hears the request and the holder may grant it.
 *   grant    the holder hands the controls to a person in the room, an AI, or nobody. A person target must be
 *            watching, so a lease never goes to somebody who is not there.
 *   release  the holder gives the controls up (nobody).
 *   take     the room's owner (or chat staff) takes the controls back; it always wins and needs no holder's consent.
 *   expire   at expires_ms the holder becomes nobody and seq increments; a timer broadcasts that even if the room is
 *            quiet, and a lazy check covers a restart.
 *
 * The live copy is the module's Map; room_control_leases is the durable copy. Watchers are live presence from the
 * room's sockets (server/chat/chat-server.js) and do not increment seq.
 */
const db = require('../db/database');

const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;
// A person holder whose last socket closed keeps the remote this long (a reload, a phone between networks); after it
// the remote is free. Coming back inside it restores the holder's own expiry.
let AWAY_GRACE_MS = 60 * 1000;
/** Tests shorten the minute; nothing else calls this. */
function setAwayGraceForTests(ms) { AWAY_GRACE_MS = Math.max(1, Number(ms) || 60 * 1000); }
const MAX_WATCHERS = 500;
const KINDS = ['person', 'ai', 'nobody'];

class LeaseError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
}

const _cache = new Map();   // roomId → state
const _timers = new Map();  // roomId → expiry timer
const _meta = new Map();    // roomId → { id, slug }
const _away = new Map();    // roomId → { subject, expires_ms } the holder's own expiry while their seat waits
const _queues = new Map();  // roomId → tail of that room's operations
let _onExpire = null;

function serial(roomId, fn) {
    const previous = _queues.get(roomId) || Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    _queues.set(roomId, tail);
    tail.finally(() => { if (_queues.get(roomId) === tail) _queues.delete(roomId); });
    return run;
}

function thingFor(room) { return `chat.room:${room.slug}`; }

function snapshot(state) {
    if (!state) return null;
    return {
        thing: state.thing,
        holder: { ...state.holder },
        since_ms: state.since_ms,
        expires_ms: state.expires_ms == null ? null : state.expires_ms,
        watchers: state.watchers.slice(),
        seq: state.seq,
    };
}

function watchersOf(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const value of list) {
        if (typeof value !== 'string') continue;
        const subject = value.trim().slice(0, 200);
        if (subject && !out.includes(subject)) out.push(subject);
        if (out.length >= MAX_WATCHERS) break;
    }
    return out.sort();
}

function sameWatchers(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function rowState(row) {
    let watchers;
    try { watchers = JSON.parse(row.watchers || '[]'); } catch (e) { watchers = []; }
    return {
        thing: row.thing,
        holder: {
            kind: row.holder_kind,
            subject: row.holder_subject == null ? null : row.holder_subject,
        },
        since_ms: Number(row.since_ms),
        expires_ms: row.expires_ms == null ? null : Number(row.expires_ms),
        watchers: watchersOf(watchers),
        seq: Number(row.seq),
    };
}

function defaultState(room, now) {
    return {
        thing: thingFor(room),
        holder: { kind: 'nobody', subject: null },
        since_ms: now,
        expires_ms: null,
        watchers: [],
        seq: 1,
    };
}

async function load(roomId) {
    const cached = _cache.get(roomId);
    if (cached) return cached;
    const row = await db.get('SELECT * FROM room_control_leases WHERE room_id = ?', [roomId]);
    if (!row) return null;
    const state = rowState(row);
    _cache.set(roomId, state);
    return state;
}

async function persist(roomId, state) {
    await db.run(
        `INSERT INTO room_control_leases (room_id, thing, holder_kind, holder_subject, since_ms, expires_ms, watchers, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id) DO UPDATE SET
            thing = excluded.thing, holder_kind = excluded.holder_kind, holder_subject = excluded.holder_subject,
            since_ms = excluded.since_ms, expires_ms = excluded.expires_ms, watchers = excluded.watchers,
            seq = excluded.seq, updated_at = now()`,
        [roomId, state.thing, state.holder.kind, state.holder.subject, state.since_ms, state.expires_ms, JSON.stringify(state.watchers), state.seq]
    );
}

function remember(room) {
    _meta.set(room.id, { id: room.id, slug: room.slug });
}

function expired(state, now) {
    return state.holder.kind !== 'nobody' && state.expires_ms != null && state.expires_ms <= now;
}

function becomeNobody(state, now) {
    return {
        ...state,
        holder: { kind: 'nobody', subject: null },
        since_ms: now,
        expires_ms: null,
        seq: state.seq + 1,
    };
}

function expiryOf(value, now) {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= now || n > now + MAX_EXPIRY_MS) {
        throw new LeaseError('lease.expiry', 'expires_ms is a time in the next 24 hours, in epoch milliseconds');
    }
    return n;
}

function targetOf(to) {
    if (!to || typeof to !== 'object') throw new LeaseError('lease.target', 'A hand-off names a holder');
    const kind = String(to.kind || '');
    if (!KINDS.includes(kind)) throw new LeaseError('lease.target', 'A holder is a person, an ai or nobody');
    if (kind === 'nobody') return { kind, subject: null };
    const subject = typeof to.subject === 'string' ? to.subject.trim().slice(0, 200) : '';
    if (!subject) throw new LeaseError('lease.target', 'A person or AI holder needs a subject');
    return { kind, subject };
}

function schedule(roomId, state) {
    const previous = _timers.get(roomId);
    if (previous) clearTimeout(previous);
    _timers.delete(roomId);
    if (state.holder.kind === 'nobody' || state.expires_ms == null) return;
    const delay = Math.max(0, state.expires_ms - Date.now()) + 5;
    const timer = setTimeout(() => expire(roomId), delay);
    if (timer.unref) timer.unref();
    _timers.set(roomId, timer);
}

async function expire(roomId) {
    let next = null;
    try {
        next = await serial(roomId, async () => {
            const state = await load(roomId);
            const now = Date.now();
            if (!state || !expired(state, now)) return null;
            const fresh = becomeNobody(state, now);
            await persist(roomId, fresh);
            _cache.set(roomId, fresh);
            schedule(roomId, fresh);
            return fresh;
        });
    } catch (err) {
        console.warn('[Lease] expiry failed:', err && err.message);
        return;
    }
    if (next && _onExpire) {
        try { _onExpire({ room: _meta.get(roomId) || { id: roomId, slug: null }, state: snapshot(next) }); } catch (e) { /* the server's handler */ }
    }
}

/** Normalise expiry and the person-holder-is-watching rule after a presence or time change. */
async function current(room, watchers, now = Date.now()) {
    remember(room);
    return await serial(room.id, async () => {
        let state = await load(room.id);
        let changed = false;
        let holderChanged = false;
        if (!state) {
            state = defaultState(room, now);
            changed = true;
        } else if (expired(state, now)) {
            state = becomeNobody(state, now);
            changed = holderChanged = true;
        }
        const list = watchers === undefined ? state.watchers : watchersOf(watchers);
        if (!sameWatchers(state.watchers, list)) { state = { ...state, watchers: list }; changed = true; }
        const away = _away.get(room.id);
        if (state.holder.kind === 'person' && !state.watchers.includes(state.holder.subject)) {
            // Gone: the seat waits AWAY_GRACE_MS (as an expiry, so a restart and the timer both honour it).
            if (!away || away.subject !== state.holder.subject) {
                _away.set(room.id, { subject: state.holder.subject, expires_ms: state.expires_ms });
                const until = now + AWAY_GRACE_MS;
                state = { ...state, expires_ms: state.expires_ms == null ? until : Math.min(state.expires_ms, until) };
                changed = holderChanged = true;
            }
        } else if (away) {
            // Back inside the minute (or the holder changed): the holder's own expiry again.
            _away.delete(room.id);
            if (state.holder.kind === 'person' && state.holder.subject === away.subject) {
                state = { ...state, expires_ms: away.expires_ms };
                changed = holderChanged = true;
            }
        }
        if (holderChanged) await persist(room.id, state);
        _cache.set(room.id, state);
        schedule(room.id, state);
        return { state, changed };
    });
}

/** The room's current lease (never null; a room with no control history is nobody at seq 1). */
async function state(room, watchers, now = Date.now()) {
    return snapshot((await current(room, watchers, now)).state);
}

/**
 * Ask for the controls. When nobody holds them the requester gets them at once; otherwise the answer carries the
 * pending request for the holder (and the room) to see.
 */
async function request(room, subject, { watchers, expires_ms: expiresRaw, now = Date.now() } = {}) {
    remember(room);
    const expires = expiryOf(expiresRaw, now);
    return await serial(room.id, async () => {
        let entry = await load(room.id);
        if (!entry) entry = defaultState(room, now);
        if (expired(entry, now)) entry = becomeNobody(entry, now);
        const list = watchersOf(watchers === undefined ? entry.watchers : watchers);
        entry = { ...entry, watchers: list };
        if (entry.holder.kind === 'person' && entry.holder.subject === subject) {
            _cache.set(room.id, entry);
            schedule(room.id, entry);
            return { state: snapshot(entry), granted: true, already: true };
        }
        if (entry.holder.kind !== 'nobody') {
            _cache.set(room.id, entry);
            schedule(room.id, entry);
            return {
                state: snapshot(entry),
                granted: false,
                request: {
                    room: room.slug,
                    requester: { kind: 'person', subject },
                    holder: { ...entry.holder },
                    since_ms: now,
                    expires_ms: expires,
                    seq: entry.seq,
                },
            };
        }
        const next = {
            ...entry,
            holder: { kind: 'person', subject },
            since_ms: now,
            expires_ms: expires,
            seq: entry.seq + 1,
        };
        await persist(room.id, next);
        _cache.set(room.id, next);
        schedule(room.id, next);
        return { state: snapshot(next), granted: true };
    });
}

/** The holder hands the controls on. A person target must be one of the room's watchers. */
async function grant(room, actor, to, { watchers, expires_ms: expiresRaw, now = Date.now() } = {}) {
    remember(room);
    const target = targetOf(to);
    const expires = target.kind === 'nobody' ? null : expiryOf(expiresRaw, now);
    return await serial(room.id, async () => {
        let entry = await load(room.id);
        if (!entry) entry = defaultState(room, now);
        if (expired(entry, now)) entry = becomeNobody(entry, now);
        const list = watchersOf(watchers === undefined ? entry.watchers : watchers);
        entry = { ...entry, watchers: list };
        if (entry.holder.kind !== 'person' || entry.holder.subject !== actor) {
            throw new LeaseError('lease.not_holder', 'Only the current holder can hand the controls on');
        }
        if (target.kind === 'person' && !list.includes(target.subject)) {
            throw new LeaseError('lease.not_watching', 'That person is not in the room');
        }
        const next = {
            ...entry,
            holder: target,
            since_ms: now,
            expires_ms: expires,
            seq: entry.seq + 1,
        };
        await persist(room.id, next);
        _cache.set(room.id, next);
        schedule(room.id, next);
        return { state: snapshot(next) };
    });
}

/** The holder gives the controls up. */
async function release(room, actor, { watchers, now = Date.now() } = {}) {
    remember(room);
    return await serial(room.id, async () => {
        let entry = await load(room.id);
        if (!entry) entry = defaultState(room, now);
        if (expired(entry, now)) entry = becomeNobody(entry, now);
        const list = watchersOf(watchers === undefined ? entry.watchers : watchers);
        entry = { ...entry, watchers: list };
        if (entry.holder.kind !== 'person' || entry.holder.subject !== actor) {
            throw new LeaseError('lease.not_holder', 'Only the current holder can release the controls');
        }
        const next = becomeNobody(entry, now);
        await persist(room.id, next);
        _cache.set(room.id, next);
        schedule(room.id, next);
        return { state: snapshot(next) };
    });
}

/** Take the controls back. Chat checks the room owner (or staff); this always wins, whatever the holder is doing. */
async function take(room, actor, { watchers, expires_ms: expiresRaw, now = Date.now() } = {}) {
    remember(room);
    const expires = expiryOf(expiresRaw, now);
    return await serial(room.id, async () => {
        let entry = await load(room.id);
        if (!entry) entry = defaultState(room, now);
        const list = watchersOf(watchers === undefined ? entry.watchers : watchers);
        const next = {
            ...entry,
            holder: { kind: 'person', subject: String(actor) },
            since_ms: now,
            expires_ms: expires,
            watchers: list,
            seq: entry.seq + 1,
        };
        await persist(room.id, next);
        _cache.set(room.id, next);
        schedule(room.id, next);
        return { state: snapshot(next) };
    });
}

/** Presence changed: refresh watchers, and release a person holder who left the room. */
async function reconcile(room, watchers, now = Date.now()) {
    return await current(room, watchers, now);
}

/** Where the expiry broadcast goes (the Chat server attaches a listener once). */
function setExpiryHandler(fn) { _onExpire = typeof fn === 'function' ? fn : null; }

/** Forget a room's live copy; the next read comes from room_control_leases (tests and recovery). */
function evict(roomId) {
    _cache.delete(roomId);
    _away.delete(roomId);
    const timer = _timers.get(roomId);
    if (timer) clearTimeout(timer);
    _timers.delete(roomId);
}

function close() {
    for (const timer of _timers.values()) clearTimeout(timer);
    _timers.clear();
    _cache.clear();
    _queues.clear();
    _meta.clear();
    _away.clear();
    _onExpire = null;
}

module.exports = {
    MAX_EXPIRY_MS, MAX_WATCHERS, KINDS, LeaseError,
    thingFor, state, request, grant, release, take, reconcile,
    setExpiryHandler, evict, close,
    _watchersOf: watchersOf, setAwayGraceForTests,
};
