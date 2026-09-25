/**
 * OpenVibe.Chat — the call lifecycle (roadmap WS-I task 1): one row of `calls` per call.
 *
 *   direct — a ring from one person to another (POST /api/streams/voice-channels/call-user):
 *
 *       pending ──▶ ringing ──▶ active ──▶ ended      (the channel emptied or closed)
 *          │           ├──────▶ missed                (no answer within the ring timeout, or the callee's "no-answer")
 *          │           ├──────▶ declined              (declined, or busy in another call)
 *          │           └──────▶ ended                 (the caller's channel closed before an answer: canceled)
 *          └───────────┴──────▶ failed                (the invite could not be delivered)
 *
 *   channel / stream — a session of a voice channel ('stream' for a stream-linked one): created
 *       active when the first person joins, ended when the channel empties or is closed.
 *
 *   pending   the row exists, the invite is not out yet.
 *   ringing   the invite went to the callee's chat sockets (and Live was asked for the notification).
 *   active    answered: the callee accepted, or joined the channel; a session: somebody is in.
 *   ended, missed, declined, failed  final; `end_reason` says why (timeout, no-answer, busy,
 *             declined, canceled, empty, ended, closed, stream_ended, restart, invite_failed: …).
 *
 * Signalling state is memory (as it was in Live), so a Chat restart forgets every room: recover()
 * at boot closes what was left open — pending → failed, ringing → missed, active → ended — with
 * reason `restart`. Times are ms.
 */
'use strict';

const db = require('../db/database');

const STATES = ['pending', 'ringing', 'active', 'ended', 'missed', 'declined', 'failed'];
const OPEN = ['pending', 'ringing', 'active'];
const TRANSITIONS = {
    pending: ['ringing', 'failed', 'ended'],
    ringing: ['active', 'missed', 'declined', 'failed', 'ended'],
    active: ['ended', 'failed'],
    ended: [],
    missed: [],
    declined: [],
    failed: [],
};
const KINDS = ['channel', 'direct', 'stream'];
// A callee's answer (POST …/call-user/respond `status`) → [state, end_reason].
const RESPONSES = {
    accepted: ['active', null],
    declined: ['declined', 'declined'],
    busy: ['declined', 'busy'],
    'no-answer': ['missed', 'no-answer'],
    canceled: ['ended', 'canceled'],
};

const _timers = new Map();   // call id → ring timeout

function canTransition(from, to) {
    return !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function get(id) { return db.get('SELECT * FROM calls WHERE id = ?', [id]) || null; }

function clearTimer(id) {
    const t = _timers.get(id);
    if (t) { clearTimeout(t); _timers.delete(id); }
}

/** Move a call to `to` when its state allows it. Returns the updated row, or null (nothing written). */
function transition(id, to, { reason = null, now = Date.now() } = {}) {
    const row = get(id);
    if (!row || !canTransition(row.state, to)) return null;
    const sets = ['state = ?'];
    const params = [to];
    if (to === 'ringing') { sets.push('started_at = COALESCE(started_at, ?)'); params.push(now); }
    if (to === 'active') {
        sets.push('started_at = COALESCE(started_at, ?)'); params.push(now);
        if (row.kind === 'direct') { sets.push('answered_at = COALESCE(answered_at, ?)'); params.push(now); }
    }
    if (!OPEN.includes(to)) { sets.push('ended_at = ?', 'end_reason = ?'); params.push(now, reason); }
    const r = db.run(`UPDATE calls SET ${sets.join(', ')} WHERE id = ? AND state = ?`, [...params, id, row.state]);
    if (r.changes !== 1) return null;
    if (to !== 'ringing') clearTimer(id);
    return get(id);
}

function insert({ kind, state, channelId, streamId = null, createdBy = null, targetId = null, now = Date.now() }) {
    if (!KINDS.includes(kind) || !STATES.includes(state)) throw new Error(`bad call ${kind}/${state}`);
    const r = db.run(`INSERT INTO calls (kind, state, channel_id, stream_id, created_by, created_by_subject, target_user_id, target_subject, created_at, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, state, String(channelId), streamId || null, createdBy || null, db.subjectFor(createdBy), targetId || null, db.subjectFor(targetId), now, state === 'active' ? now : null]);
    return get(r.lastInsertRowid);
}

// ── Direct calls ────────────────────────────────────────────────────────────────────────────────

/** The caller's open ring to this person on this channel, if any (calling again re-rings it). */
function openDirectFor(callerId, targetId, channelId) {
    return db.get(`SELECT * FROM calls WHERE kind = 'direct' AND created_by = ? AND target_user_id = ? AND channel_id = ?
        AND state IN ('pending', 'ringing') ORDER BY id DESC LIMIT 1`, [callerId, targetId, String(channelId)]) || null;
}

/** A ring from callerId to targetId in channelId: the open one again, or a new pending row. */
function openDirect({ callerId, targetId, channelId }) {
    return openDirectFor(callerId, targetId, channelId) || insert({ kind: 'direct', state: 'pending', channelId, createdBy: callerId, targetId });
}

/**
 * The invite went out: ringing, and missed after `timeoutMs` unless answered first. `onTimeout(row)`
 * runs once the row is missed (the call server tells the caller). Ringing again restarts the timer.
 */
function ring(id, { timeoutMs, onTimeout = null } = {}) {
    let row = get(id);
    if (!row) return null;
    if (row.state === 'pending') row = transition(id, 'ringing');
    if (!row || row.state !== 'ringing') return row;
    clearTimer(id);
    const t = setTimeout(() => {
        _timers.delete(id);
        const missed = transition(id, 'missed', { reason: 'timeout' });
        if (missed && onTimeout) { try { onTimeout(missed); } catch (err) { console.warn('[Calls] ring timeout:', err.message); } }
    }, Math.max(1, Number(timeoutMs) || 0));
    if (t.unref) t.unref();
    _timers.set(id, t);
    return row;
}

/** The invite could not be delivered. */
function fail(id, reason) {
    return transition(id, 'failed', { reason: String(reason || 'failed').slice(0, 200) });
}

/**
 * The callee answered (a respond status). Returns the row after the answer, or null when there is
 * no ring to answer (never rang, already over). `accepted` on an active call changes nothing.
 */
function respond({ callerId, targetId, channelId, status }) {
    const rule = RESPONSES[status];
    if (!rule) return null;
    const row = db.get(`SELECT * FROM calls WHERE kind = 'direct' AND created_by = ? AND target_user_id = ? AND channel_id = ?
        AND state IN ('pending', 'ringing', 'active') ORDER BY id DESC LIMIT 1`, [callerId, targetId, String(channelId)]);
    if (!row) return null;
    if (row.state === 'active') return status === 'accepted' ? row : null;
    return transition(row.id, rule[0], { reason: rule[1] });
}

/** The callee joined the caller's channel while it rang: that is an answer too. */
function answeredByJoin(channelId, userId) {
    if (!userId) return [];
    const rows = db.all(`SELECT id FROM calls WHERE kind = 'direct' AND channel_id = ? AND target_user_id = ? AND state = 'ringing'`, [String(channelId), userId]);
    return rows.map((r) => transition(r.id, 'active')).filter(Boolean);
}

// ── Channel sessions ────────────────────────────────────────────────────────────────────────────

/** Somebody is in the channel: its session is active (one per channel at a time). */
function sessionStarted({ channelId, streamId = null, createdBy = null }) {
    const open = db.get(`SELECT * FROM calls WHERE kind IN ('channel', 'stream') AND channel_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1`, [String(channelId)]);
    if (open) return open;
    return insert({ kind: streamId ? 'stream' : 'channel', state: 'active', channelId, streamId, createdBy });
}

/** Nobody is left (or everyone was sent away): the session and every answered ring on it end. */
function channelEmptied(channelId, reason = 'empty') {
    const rows = db.all(`SELECT id FROM calls WHERE channel_id = ? AND state = 'active'`, [String(channelId)]);
    return rows.map((r) => transition(r.id, 'ended', { reason })).filter(Boolean);
}

/** The channel is gone (deleted, ended, stream over): rings still waiting on it end as canceled. */
function channelClosed(channelId, reason = 'closed') {
    const ended = channelEmptied(channelId, reason);
    const rows = db.all(`SELECT id FROM calls WHERE kind = 'direct' AND channel_id = ? AND state IN ('pending', 'ringing')`, [String(channelId)]);
    return ended.concat(rows.map((r) => transition(r.id, 'ended', { reason: 'canceled' })).filter(Boolean));
}

// ── Boot ────────────────────────────────────────────────────────────────────────────────────────

/** After a restart no room survives: close whatever the previous process left open. */
function recover() {
    const out = { failed: 0, missed: 0, ended: 0 };
    for (const r of db.all(`SELECT id, state FROM calls WHERE state IN ('pending', 'ringing', 'active')`)) {
        const to = r.state === 'pending' ? 'failed' : r.state === 'ringing' ? 'missed' : 'ended';
        if (transition(r.id, to, { reason: 'restart' })) out[to]++;
    }
    if (out.failed + out.missed + out.ended) console.log(`[Calls] closed calls left open by the last run: ${JSON.stringify(out)}`);
    return out;
}

function list({ channelId = null, kind = null, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (channelId) { where.push('channel_id = ?'); params.push(String(channelId)); }
    if (kind) { where.push('kind = ?'); params.push(kind); }
    return db.all(`SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...params, Math.min(Math.max(Number(limit) || 50, 1), 500)]);
}

function stop() { for (const id of [..._timers.keys()]) clearTimer(id); }

module.exports = {
    STATES, OPEN, TRANSITIONS, KINDS, RESPONSES,
    canTransition, transition, get, list,
    openDirect, ring, fail, respond, answeredByJoin,
    sessionStarted, channelEmptied, channelClosed,
    recover, stop,
};
