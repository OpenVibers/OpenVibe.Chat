'use strict';
/**
 * A Chat room's shared clock (seven domains plan B4, common.sync-clock@1).
 *
 * One state per room: { room, media, position_ms, rate, paused, at_ms, set_by, seq }. Chat stamps at_ms and seq and
 * broadcasts the state; server/chat/chat-server.js refuses a set from anyone but the current control-lease holder.
 * The latest state lives in the module's Map (the live copy) and in room_sync_clocks (the durable copy). The cache is
 * per process, like Chat's other room state; a second process reads the row from the database.
 *
 * Media is a Media ref or an https URL. A set may leave media out to keep the room's current one, and may leave
 * position_ms out to pause or resume where the timeline is now.
 */
const db = require('../db/database');

const MAX_POSITION_MS = 30 * 24 * 60 * 60 * 1000;   // the contract's 30-day cap
const MAX_RATE = 16;
const MEDIA_ID = /^(med_[0-9A-HJKMNP-TV-Z]{26}|legacy:[a-z][a-z0-9-]{1,39}:(vod|clip|file|paste|thumbnail|avatar):[A-Za-z0-9._/-]{1,200})$/;
const HTTP_URL = /^https:\/\/[^\s]{1,2048}$/;
const ROLE = /^[a-z][a-z0-9_]{1,39}$/;
const VARIANT = /^[a-z0-9][a-z0-9_-]{0,39}$/;

class SyncError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
}

const _cache = new Map();   // roomId → state
const _queues = new Map();  // roomId → the tail of that room's set operations

/** Run fn after the earlier operation of this room, so two holders' sockets cannot write the same seq. */
function serial(roomId, fn) {
    const previous = _queues.get(roomId) || Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    _queues.set(roomId, tail);
    tail.finally(() => { if (_queues.get(roomId) === tail) _queues.delete(roomId); });
    return run;
}

function snapshot(state) {
    if (!state) return null;
    return {
        room: state.room,
        media: typeof state.media === 'object' && state.media ? { ...state.media } : state.media,
        position_ms: state.position_ms,
        rate: state.rate,
        paused: state.paused,
        at_ms: state.at_ms,
        set_by: state.set_by,
        seq: state.seq,
    };
}

function rowState(row, room) {
    let media;
    try { media = JSON.parse(row.media); } catch (e) { media = null; }
    if (media == null) throw new SyncError('sync.corrupt', 'The stored clock is not readable');
    return {
        room: room.slug,
        media,
        position_ms: Number(row.position_ms),
        rate: Number(row.rate),
        paused: !!row.paused,
        at_ms: Number(row.at_ms),
        set_by: row.set_by,
        seq: Number(row.seq),
    };
}

function mediaOf(value) {
    if (typeof value === 'string') {
        if (!HTTP_URL.test(value)) throw new SyncError('sync.media', 'media is an https URL or a Media ref');
        return value;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SyncError('sync.media', 'media is an https URL or a Media ref');
    }
    const keys = Object.keys(value);
    if (keys.some((k) => !['media_id', 'role', 'variant'].includes(k))) throw new SyncError('sync.media', 'media has only media_id, role and variant');
    if (!MEDIA_ID.test(String(value.media_id || ''))) throw new SyncError('sync.media', 'media_id is a Media ref');
    if (value.role !== undefined && !ROLE.test(String(value.role))) throw new SyncError('sync.media', 'media role is a lowercase name');
    if (value.variant !== undefined && !VARIANT.test(String(value.variant))) throw new SyncError('sync.media', 'media variant is lowercase letters, numbers, _ or -');
    return {
        media_id: value.media_id,
        ...(value.role !== undefined ? { role: value.role } : {}),
        ...(value.variant !== undefined ? { variant: value.variant } : {}),
    };
}

function positionOf(value, previous, now) {
    if (value !== undefined) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > MAX_POSITION_MS) throw new SyncError('sync.position', 'position_ms is whole milliseconds from 0 to 30 days');
        return n;
    }
    if (!previous) throw new SyncError('sync.position', 'the first clock needs position_ms');
    if (previous.paused) return previous.position_ms;
    return Math.max(0, Math.round(previous.position_ms + (now - previous.at_ms) * previous.rate));
}

function rateOf(value, previous) {
    if (value === undefined) return previous ? previous.rate : 1;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_RATE) throw new SyncError('sync.rate', `rate is a number above 0 and at most ${MAX_RATE}`);
    return n;
}

function pausedOf(value, previous) {
    if (value === undefined) return previous ? previous.paused : false;
    if (typeof value !== 'boolean') throw new SyncError('sync.paused', 'paused is true or false');
    return value;
}

async function load(room) {
    const cached = _cache.get(room.id);
    if (cached) return cached;
    const row = await db.get('SELECT * FROM room_sync_clocks WHERE room_id = ?', [room.id]);
    if (!row) return null;
    const state = rowState(row, room);
    _cache.set(room.id, state);
    return state;
}

/** The room's current clock, or null before the first set. */
async function get(room) {
    return snapshot(await load(room));
}

/**
 * Accept one change. `input` is the frame's media, position_ms, rate, paused (all but position may be left out; a
 * missing position pauses/resumes where the timeline is now). Chat has already checked the caller holds the lease.
 */
async function set(room, subject, input, { now = Date.now() } = {}) {
    return await serial(room.id, async () => {
        const previous = await load(room);
        const body = input && typeof input === 'object' ? input : {};
        const media = body.media === undefined ? (previous ? previous.media : null) : mediaOf(body.media);
        if (media == null) throw new SyncError('sync.media', 'the first clock needs media');
        const position = positionOf(body.position_ms, previous, now);
        const rate = rateOf(body.rate, previous);
        const paused = pausedOf(body.paused, previous);
        const state = {
            room: room.slug,
            media,
            position_ms: position,
            rate,
            paused,
            at_ms: now,
            set_by: String(subject),
            seq: (previous ? previous.seq : 0) + 1,
        };
        await db.run(
            `INSERT INTO room_sync_clocks (room_id, media, position_ms, rate, paused, at_ms, set_by, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room_id) DO UPDATE SET
                media = excluded.media, position_ms = excluded.position_ms, rate = excluded.rate,
                paused = excluded.paused, at_ms = excluded.at_ms, set_by = excluded.set_by,
                seq = excluded.seq, updated_at = now()`,
            [room.id, JSON.stringify(media), position, rate, paused, now, state.set_by, state.seq]
        );
        _cache.set(room.id, state);
        return snapshot(state);
    });
}

/**
 * Forget the in-memory copy, as a restart or a failover would: the next read comes from room_sync_clocks. Tests use
 * it to prove the durable copy; the server uses it if a room's row is changed outside this process.
 */
function evict(roomId) { _cache.delete(roomId); }

/** Drop every cache and queue (a test/server restart). */
function close() { _cache.clear(); _queues.clear(); }

module.exports = {
    MAX_POSITION_MS, MAX_RATE, SyncError, set, get, evict, close,
    // Exposed for the WS layer and its tests; the validation stays here.
    _mediaOf: mediaOf, _positionOf: positionOf, _rateOf: rateOf, _pausedOf: pausedOf,
};
