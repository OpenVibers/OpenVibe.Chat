'use strict';
/**
 * Listening together in a party room (openvibe.party): the room's music, beside the video or the shared desktop.
 *
 * The room's remote (common.control-lease@1) is the right to change it: whoever holds the control lease starts an
 * OpenVibe Radio track, or the Radio station (a continuous run of the licensed catalogue), and pauses, resumes, skips
 * or stops it. The room's state carries the track, who started it and the point the timeline was measured from:
 *
 *   position_ms at at_ms, then paused or moving at rate 1. A late joiner computes where everyone should be from those
 *   two numbers and the Chat server's clock, so the room hears the same thing within a second or two. Each person's
 *   volume is their own: it is not part of this state and never leaves their browser.
 *
 * Only OpenVibe Radio's own catalogue is playable (server/rooms/radio.js): every track is validated for its licence,
 * its official audio URL and its published metadata before it can reach a room. Nothing here accepts a free URL.
 *
 * Durable state is room_parties.music_state (jsonb) with music_version as a compare-and-set counter; changes are
 * broadcast to the room socket as { type: 'music', room, state } and a join also receives it (chat-server.sendRoomState).
 * The live audio is the browser's: Chat keeps the timeline and makes sure everyone follows it.
 */
const db = require('../db/database');
const rooms = require('./rooms');
const parties = require('./parties');
const controlLease = require('./control-lease');
const radio = require('./radio');

const KINDS = new Set(['media', 'desktop']);
const MAX_QUEUE = 200;
const fail = (status, code, message) => { throw new parties.PartyError(status, code, message); };

function decode(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

/** The room's remote holder, as the clock's holder is: a signed-in member with the control lease. */
async function holderOf(row, user) {
    if (!user || !user.subject_id) fail(401, 'music.sign_in', 'Sign in to change the room’s music');
    const access = await rooms.access(row, user);
    if (!access.read) fail(404, 'rooms.not_found', 'No such room');
    const lease = await controlLease.state({ id: row.id, slug: row.slug });
    const holder = lease && lease.holder;
    if (!holder || holder.kind !== 'person' || holder.subject !== user.subject_id) {
        fail(403, 'music.not_holder', 'Only the person with the remote can change the room’s music');
    }
}

/** The room's stored timeline as it stands at `now`: position is base + moving time while it is not paused. */
function positionAt(stored, now) {
    const base = Math.max(0, Number(stored && stored.position_ms) || 0);
    if (!stored || stored.paused) return base;
    return base + Math.max(0, now - (Number(stored.at_ms) || now));
}

/** The state a viewer, a socket or an SDK sees: the timeline measured at `at_ms`, never a stale stored number. */
async function wire(stored, { now = Date.now(), version = 0 } = {}) {
    if (!stored || !stored.track) return null;
    const startedBy = stored.started_by == null ? null : String(stored.started_by);
    let name = null;
    if (startedBy) {
        const who = await db.get('SELECT username, display_name FROM ctx_users WHERE subject_id = ? LIMIT 1', [startedBy]);
        name = who ? (who.display_name || who.username || null) : null;
    }
    return {
        track: stored.track,
        station: !!stored.station,
        started_by: startedBy,
        started_by_name: name,
        started_at: new Date(Number(stored.started_at) || now).toISOString(),
        started_at_ms: Number(stored.started_at) || now,
        position_ms: positionAt(stored, now),
        at_ms: now,
        paused: !!stored.paused,
        up_next: Array.isArray(stored.queue) ? stored.queue.length : 0,
        seq: Number(version) || 0,
    };
}

/** A party's music as its detail view carries it: null when nothing plays, from the row bySlug already read. */
async function state(row, { now = Date.now() } = {}) {
    if (!row || !KINDS.has(row.party_kind)) return null;
    return await wire(decode(row.music_state), { now, version: row.music_version });
}

/** A socket's join: the room's music if this is a kind that plays it, undefined for every other room. */
async function stateForRoom(room, { now = Date.now() } = {}) {
    if (!room || !room.id) return undefined;
    const row = await db.get('SELECT party_kind, ended_at, music_state, music_version FROM room_parties WHERE room_id = ?', [room.id]);
    if (!row || !KINDS.has(row.party_kind)) return undefined;
    if (row.ended_at) return null;
    return await wire(decode(row.music_state), { now, version: row.music_version });
}

function fresh(track, { station = false, queue = [], startedBy = null, now = Date.now() } = {}) {
    return {
        track, station: !!station, queue: (queue || []).slice(0, MAX_QUEUE),
        started_by: startedBy, started_at: now, position_ms: 0, at_ms: now, paused: false,
    };
}

/** The first track of a list that still validates, with the rest as the station's queue; null when none is left. */
async function firstPlayable(ids) {
    const left = (ids || []).slice();
    while (left.length) {
        const id = String(left.shift());
        try {
            return { track: await radio.track(id), queue: left.slice(0, MAX_QUEUE) };
        } catch (err) {
            // A track unpublished between the catalogue and now is skipped; a Radio outage is not.
            if (!(err instanceof parties.PartyError) || err.status >= 500) throw err;
        }
    }
    return null;
}

/**
 * The next track of a station: the stored queue first (each one validated again), then a fresh catalogue pass so a
 * station that has played the whole catalogue once keeps going. A single track has no next.
 */
async function pickNext(stored) {
    if (!stored || !stored.station) return null;
    const found = await firstPlayable(stored.queue || []);
    if (found) return found;
    const catalogue = await radio.catalogue();
    const current = stored.track && stored.track.id;
    const ids = catalogue.map((t) => t.id).filter((id) => id !== current);
    return await firstPlayable(ids);
}

/** One change, behind the version counter: the winner writes and returns, a loser re-reads and tries again. */
async function change(row, party, user, action, input = {}, { now = Date.now() } = {}) {
    if (!row || !party) fail(404, 'rooms.not_found', 'No such room');
    if (!KINDS.has(party.party_kind)) fail(409, 'music.party', 'Music plays in a watch party or a shared computer');
    if (party.ended_at) fail(410, 'party.ended', 'This party has ended');
    await holderOf(row, user);
    for (let tries = 0; tries < 5; tries++) {
        const current = await db.get('SELECT music_state, music_version FROM room_parties WHERE room_id = ?', [party.room_id]);
        if (!current) fail(404, 'rooms.not_found', 'No such room');
        const stored = decode(current.music_state);
        const version = Number(current.music_version) || 0;
        let next = stored;
        if (action === 'play') {
            const asked = input && input.track_id != null ? String(input.track_id) : '';
            const station = !asked || (input && input.station === true);
            if (asked) {
                const track = await radio.track(asked);
                const queue = station ? (await radio.catalogue()).map((t) => t.id).filter((id) => id !== track.id) : [];
                next = fresh(track, { station, queue, startedBy: user.subject_id, now });
            } else {
                const catalogue = await radio.catalogue();
                const first = await firstPlayable(catalogue.map((t) => t.id));
                if (!first) fail(503, 'music.unavailable', 'OpenVibe Radio has no published tracks to play yet');
                next = fresh(first.track, { station: true, queue: first.queue, startedBy: user.subject_id, now });
            }
        } else if (action === 'pause' || action === 'resume') {
            if (!stored || !stored.track) fail(409, 'music.none', 'Nothing is playing in the room');
            if (action === 'pause' ? stored.paused : !stored.paused) {
                // Already there: answer the same state rather than invent a new version.
                const same = await wire(stored, { now, version });
                return same;
            }
            next = { ...stored, at_ms: now, paused: action === 'pause' };
            if (action === 'pause') next.position_ms = positionAt(stored, now);
        } else if (action === 'stop') {
            next = null;
        } else if (action === 'next' || action === 'ended') {
            if (!stored || !stored.track) {
                if (action === 'next') fail(409, 'music.none', 'Nothing is playing in the room');
                next = null;
            } else if (input && input.expected_id && input.expected_id !== stored.track.id) {
                // A late or repeated end for a track the room already moved past: answer the current state.
                const same = await wire(stored, { now, version });
                return same;
            } else {
                const following = await pickNext(stored);
                next = following ? fresh(following.track, {
                    station: true, queue: following.queue,
                    // An auto-advance stays the station's starter; a person skipping names themselves.
                    startedBy: action === 'ended' ? stored.started_by : user.subject_id, now,
                }) : null;
            }
        } else {
            fail(422, 'music.action', 'Unknown music action');
        }
        const updated = await db.get(`UPDATE room_parties
            SET music_state = ?, music_version = music_version + 1
            WHERE room_id = ? AND music_version = ? RETURNING music_version`,
            [next ? JSON.stringify(next) : null, party.room_id, version]);
        if (!updated) continue;
        const out = await wire(next, { now, version: Number(updated.music_version) });
        try {
            require('../chat/chat-server').broadcastToRoom(row.id, { type: 'music', room: row.slug, state: out });
        } catch (err) {
            console.warn('[Music] broadcast:', err && err.message);
        }
        return out;
    }
    fail(409, 'music.conflict', 'The room’s music changed; try again');
}

module.exports = { KINDS, state, stateForRoom, change };
