'use strict';
/**
 * OpenVibe.Chat — the chat plays queue (Agent Streams S6, design 2026-11-06, §2).
 *
 * A request is written with '!do <request>' (at most 200 characters) in an agent stream's room. It passes the
 * house text filters and the safety check before it is listed; a refused request never enters the queue and
 * the room gets one line saying why.
 *
 * The rules:
 *   - one open request per person at a time, and an account younger than a day cannot ask;
 *   - a vote is a thumbs up on the request's message or '!vote <n>' — one vote per person, never two;
 *   - every five minutes, or when the current request finishes, the top request is the next task: the top is
 *     the pinned one, else the one with the most votes, else the oldest;
 *   - the owner or a moderator can skip, remove or pin a request.
 *
 * The queue is read and written by Codes for the stream's owner (the capabilities chat.play_queue.read and
 * chat.play_queue.write). The people, the votes and the moderation belong to the room: the task's service
 * may move a request along and record how it ended, and nothing else.
 */
const crypto = require('crypto');
const db = require('../db/database');
const safety = require('./play-safety');

const MAX_CHARS = safety.MAX_CHARS;
const MIN_ACCOUNT_AGE_MS = 86_400_000;      // an account younger than a day cannot ask
const OPEN_STATES = ['queued', 'running'];

// A request's id: req_<ULID> (Crockford base32). The id is made here rather than by the contracts
// package, so the queue does not wait for a pin that names this kind of id.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let time = '';
    for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
    return time + rand;
}
function newRequestId() {
    return 'req_' + ulid();
}

// ── The queue ────────────────────────────────────────────────────────────

/** The request as the contract says it is (chat.play-request@1). */
function requestView(row, votes) {
    return {
        request_id: String(row.id),
        room: String(row.room_slug || ''),
        author: { handle: String(row.handle || ''), display_name: row.display_name ? String(row.display_name) : null },
        text: String(row.text || ''),
        votes: Number(votes && votes.votes) || 0,
        voters: Number(votes && votes.voters) || 0,
        state: String(row.state),
        pinned: row.pinned === true,
        created_at: new Date(row.created_at).toISOString(),
        started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
        ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
        refusal: row.refusal_code ? { code: String(row.refusal_code), reason: String(row.refusal_reason || '') } : null,
        result: row.outcome ? {
            outcome: String(row.outcome),
            line: String(row.result_line || ''),
            scratch_url: row.scratch_url ? String(row.scratch_url) : null,
            task_id: row.task_id ? String(row.task_id) : null,
        } : null,
    };
}

/**
 * How many people voted for a request: a thumbs up on its message and a '!vote' count once each, and a
 * person counts once however they voted.
 */
async function votesOf(request) {
    const messageId = Number(request.message_id) || 0;
    const rows = await db.all(
        `SELECT COUNT(DISTINCT user_id) AS n FROM (
             SELECT user_id FROM room_message_reactions WHERE message_id = ? AND reaction = 'thumbsup'
             UNION
             SELECT user_id FROM agent_play_votes WHERE request_id = ?
         ) AS voters`,
        [messageId, String(request.id)]
    );
    const voters = Number(rows && rows[0] && rows[0].n) || 0;
    return { votes: voters, voters };
}

/** The requests of a room, newest first. */
async function listRequests(room, { limit = 20, states = null } = {}) {
    const rows = states
        ? await db.all(
            `SELECT * FROM agent_play_requests WHERE room_id = ? AND state IN (${states.map(() => '?').join(',')})
              ORDER BY created_at DESC LIMIT ?`,
            [room.id, ...states, Math.min(100, Math.max(1, Number(limit) || 20))])
        : await db.all('SELECT * FROM agent_play_requests WHERE room_id = ? ORDER BY created_at DESC LIMIT ?',
            [room.id, Math.min(100, Math.max(1, Number(limit) || 20))]);
    const out = [];
    for (const row of rows) out.push({ row, votes: await votesOf(row) });
    return out;
}

/** The open requests of a room, in the order they would run: pinned first, then the most votes, then the oldest. */
async function openRequests(room) {
    const list = await listRequests(room, { limit: 100, states: OPEN_STATES });
    list.sort((a, b) => (Number(b.row.pinned) - Number(a.row.pinned))
        || ((b.votes.votes || 0) - (a.votes.votes || 0))
        || (new Date(a.row.created_at) - new Date(b.row.created_at)));
    return list;
}

/** The request that runs next, or null. */
async function topRequest(room) {
    const open = await openRequests(room);
    return open.length ? open[0] : null;
}

/** The request that is running now, or null. */
async function currentRequest(room) {
    const list = await listRequests(room, { limit: 100, states: ['running'] });
    return list.length ? list[0] : null;
}

// ── Asking ───────────────────────────────────────────────────────────────

/** The account must be at least a day old: a person cannot ask with a fresh account. */
async function accountIsOldEnough(user) {
    const row = await db.get('SELECT created_at FROM ctx_users WHERE id = ?', [Number(user && user.id) || 0]);
    if (!row || !row.created_at) return false;
    const created = Date.parse(String(row.created_at).replace(' ', 'T') + (String(row.created_at).endsWith('Z') ? '' : 'Z'));
    if (!Number.isFinite(created)) return false;
    return Date.now() - created >= MIN_ACCOUNT_AGE_MS;
}

/**
 * A request for the queue. It answers { ok: true, request } or { ok: false, code, reason }: a refused request
 * never enters the queue, and the reason is the one line the room sees.
 */
async function addRequest(room, user, text, { now = Date.now() } = {}) {
    const body = String(text == null ? '' : text).trim();
    const check = safety.check(body);
    if (!check.ok) return { ok: false, code: check.code, reason: check.reason };
    if (!await accountIsOldEnough(user)) {
        return { ok: false, code: 'account_too_new', reason: safety.REASONS.account_too_new };
    }
    // One open request per person: the room is not a queue of one person's wishes.
    const open = await db.get(
        `SELECT id FROM agent_play_requests WHERE room_id = ? AND user_id = ? AND state IN ('queued', 'running') LIMIT 1`,
        [room.id, Number(user && user.id) || 0]);
    if (open) return { ok: false, code: 'already_open', reason: safety.REASONS.already_open };
    const id = newRequestId();
    await db.run(
        `INSERT INTO agent_play_requests (id, room_id, user_id, subject_id, handle, display_name, text, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
        [id, room.id, Number(user && user.id) || 0, (user && user.subject_id) || null,
            String((user && (user.username || user.handle)) || '').toLowerCase().slice(0, 32),
            (user && user.display_name) ? String(user.display_name).slice(0, 64) : null,
            check.text]);
    await log(room, 'request', { request_id: id, by_handle: handleOf(user), detail: check.text.slice(0, 200) });
    const row = await db.get('SELECT * FROM agent_play_requests WHERE id = ?', [id]);
    return { ok: true, request: { row, votes: await votesOf(row) } };
}

/** The request's message is the message of the room, so a thumbs up on it is a vote. */
async function attachMessage(requestId, messageId) {
    await db.run('UPDATE agent_play_requests SET message_id = ? WHERE id = ?', [Number(messageId) || 0, String(requestId)]);
}

// ── Voting ───────────────────────────────────────────────────────────────

/** A vote. One per person: pressing again changes it, but a person never counts twice. */
async function vote(request, user, { via = 'command' } = {}) {
    if (!request) return { ok: false, code: 'play_queue.not_found' };
    if (!OPEN_STATES.includes(String(request.state))) return { ok: false, code: 'play_queue.not_open' };
    const userId = Number(user && user.id) || 0;
    if (!userId) return { ok: false, code: 'play_queue.sign_in' };
    await db.run(
        'INSERT INTO agent_play_votes (request_id, user_id, via) VALUES (?, ?, ?) ON CONFLICT (request_id, user_id) DO NOTHING',
        [String(request.id), userId, via === 'reaction' ? 'reaction' : 'command']);
    await db.run('UPDATE agent_play_requests SET votes = ? WHERE id = ?',
        [(await votesOf(request)).votes, String(request.id)]);
    // The owner's log: who voted, for what.
    await log({ id: request.room_id }, 'vote', { request_id: String(request.id), by_handle: handleOf(user) });
    return { ok: true };
}

// ── The owner's and the moderators' hand ─────────────────────────────────

/** Skip a request: it leaves the queue without running. */
async function skip(request, by) {
    if (!request) return { ok: false, code: 'play_queue.not_found' };
    await db.run("UPDATE agent_play_requests SET state = 'skipped', ended_at = now() WHERE id = ?", [String(request.id)]);
    await log(by.room, 'skip', { request_id: String(request.id), by_handle: handleOf(by) });
    return { ok: true, state: 'skipped' };
}

/** Remove a request from the queue. */
async function remove(request, by) {
    if (!request) return { ok: false, code: 'play_queue.not_found' };
    await db.run("UPDATE agent_play_requests SET state = 'removed', ended_at = now() WHERE id = ?", [String(request.id)]);
    await log(by.room, 'remove', { request_id: String(request.id), by_handle: handleOf(by) });
    return { ok: true, state: 'removed' };
}

/** Pin a request: it stays at the top of the queue until it is removed or it runs. */
async function pin(request, by, on = true) {
    if (!request) return { ok: false, code: 'play_queue.not_found' };
    await db.run('UPDATE agent_play_requests SET pinned = ? WHERE id = ?', [on ? true : false, String(request.id)]);
    await log(by.room, on ? 'pin' : 'unpin', { request_id: String(request.id), by_handle: handleOf(by) });
    return { ok: true, pinned: on ? true : false };
}

// ── What the desk does with a request ────────────────────────────────────

/** The desk began the request. */
async function markRunning(requestId) {
    await db.run("UPDATE agent_play_requests SET state = 'running', started_at = now() WHERE id = ? AND state = 'queued'",
        [String(requestId)]);
    const row = await db.get('SELECT * FROM agent_play_requests WHERE id = ?', [String(requestId)]);
    return row || null;
}

/** The desk finished the request: the outcome, the one line and the scratch site it left. */
async function finish(requestId, { outcome = 'done', line = '', scratch_url = null, task_id = null } = {}) {
    const state = ['done', 'failed'].includes(String(outcome)) ? String(outcome) : 'failed';
    await db.run(
        `UPDATE agent_play_requests SET state = ?, ended_at = now(), outcome = ?, result_line = ?, scratch_url = ?, task_id = ?
         WHERE id = ?`,
        [state, String(outcome), String(line || '').slice(0, 200), scratch_url ? String(scratch_url) : null,
            task_id ? String(task_id) : null, String(requestId)]);
    const row = await db.get('SELECT * FROM agent_play_requests WHERE id = ?', [String(requestId)]);
    return row || null;
}

// ── The room and the log ─────────────────────────────────────────────────

/** The handle of a person, never an id. */
function handleOf(user) {
    return String((user && (user.username || user.handle)) || '').toLowerCase().slice(0, 32) || 'someone';
}

/** Everything the owner sees in the log: who, what, when. */
async function log(room, action, { request_id = null, by_handle = '', detail = null } = {}) {
    try {
        await db.run(
            'INSERT INTO agent_play_log (room_id, action, request_id, by_handle, detail) VALUES (?, ?, ?, ?, ?)',
            [room.id, String(action), request_id ? String(request_id) : null, String(by_handle || '').slice(0, 32),
                detail ? String(detail).slice(0, 200) : null]);
    } catch (err) {
        console.error('[Chat] the play log failed:', err.message);
    }
}

/** The owner's log of the room. */
async function logOf(room, { limit = 100 } = {}) {
    return await db.all('SELECT action, request_id, by_handle, detail, at FROM agent_play_log WHERE room_id = ? ORDER BY at DESC LIMIT ?',
        [room.id, Math.min(500, Math.max(1, Number(limit) || 100))]);
}

/**
 * A line from the desk, posted by the agent's own chat identity (labelled 'AI agent'), at most one message
 * every 20 seconds: the queue says what it did and why it refused something.
 */
async function say(room, text, { now = Date.now(), force = false } = {}) {
    const body = String(text || '').trim().slice(0, 200);
    if (!body) return null;
    const identity = await db.get('SELECT * FROM agent_room_identities WHERE room_id = ?', [room.id]);
    const last = identity && identity.last_message_at ? new Date(identity.last_message_at).getTime() : 0;
    // The agent's own identity posts at most one message every 20 s. A refusal is said anyway: the person
    // who asked is owed the reason.
    if (!force && last && now - last < 20_000) return null;
    const id = await db.tx(async () => {
        const r = await db.run(
            'INSERT INTO room_messages (room_id, user_id, subject_id, message, agent_stream) VALUES (?, 0, NULL, ?, true)',
            [room.id, body]);
        await db.run('UPDATE rooms SET message_count = message_count + 1, last_message_at = ov_now() WHERE id = ?', [room.id]);
        await db.run('UPDATE agent_room_identities SET last_message_at = now() WHERE room_id = ?', [room.id]);
        return Number(r.lastInsertRowid);
    });
    try {
        require('./chat-server').broadcastToRoom(room.id, {
            type: 'agent_message', room: room.slug, id, label: 'AI agent', handle: 'aiagent', message: body,
        });
    } catch { /* the room is quiet when nobody is watching */ }
    return id;
}

module.exports = {
    MAX_CHARS, MIN_ACCOUNT_AGE_MS, OPEN_STATES, newRequestId, ulid,
    requestView, votesOf, listRequests, openRequests, topRequest, currentRequest,
    addRequest, attachMessage, accountIsOldEnough,
    vote, skip, remove, pin, markRunning, finish,
    log, logOf, say, handleOf,
};

// ── The commands of the room ─────────────────────────────────────────────

const DO = /^!do\s+(.+)$/i;
const VOTE = /^!vote\s+(\d{1,2})$/i;
const SKIP = /^!skip\s+(\d{1,2})$/i;
const REMOVE = /^!remove\s+(\d{1,2})$/i;
const PIN = /^!pin\s+(\d{1,2})$/i;
const UNPIN = /^!unpin\s+(\d{1,2})$/i;

/**
 * The chat plays commands of an agent stream's room: '!do <request>', '!vote <n>', and the moderators'
 * '!skip <n>', '!remove <n>' and '!pin <n>'. The request is a message of the room, so a thumbs up on it is
 * a vote; the number of a command is the place of the request in the queue (the pinned one first, then the
 * most votes, then the oldest).
 */
async function handleCommand(room, user, body, { access = null, now = Date.now(), messageId = null } = {}) {
    const text = String(body || '').trim();
    let m = DO.exec(text);
    if (m) {
        const out = await addRequest(room, user, m[1], { now });
        if (!out.ok) {
            await log(room, 'refused', { by_handle: handleOf(user), detail: out.code });
            await say(room, out.reason, { now, force: true });
            return { kind: 'refused', code: out.code, reason: out.reason };
        }
        if (messageId) await attachMessage(out.request.row.id, messageId);
        const open = await openRequests(room);
        const place = open.findIndex((r) => String(r.row.id) === String(out.request.row.id)) + 1;
        await say(room, 'Queued #' + place + ': ' + String(out.request.row.text).slice(0, 120), { now });
        return { kind: 'request', request_id: String(out.request.row.id) };
    }
    m = VOTE.exec(text);
    if (m) {
        const open = await openRequests(room);
        const target = open[Number(m[1]) - 1];
        if (!target) return { kind: 'vote', ok: false };
        const out = await vote(target.row, user);
        return { kind: 'vote', ok: out.ok, request_id: String(target.row.id) };
    }
    const moderator = !!(access && access.moderate);
    const by = { room, username: (user && user.username) || '', handle: (user && user.username) || '' };
    for (const [pattern, action, fn, on] of [
        [SKIP, 'skip', skip, null], [REMOVE, 'remove', remove, null], [PIN, 'pin', pin, true], [UNPIN, 'unpin', pin, false],
    ]) {
        const hit = pattern.exec(text);
        if (!hit) continue;
        if (!moderator) return { kind: action, ok: false, code: 'play_queue.not_moderator' };
        const open = await openRequests(room);
        const target = open[Number(hit[1]) - 1];
        if (!target) return { kind: action, ok: false, code: 'play_queue.not_found' };
        const out = await fn(target.row, by, on);
        return { kind: action, ok: true, request_id: String(target.row.id) };
    }
    return null;
}

module.exports.handleCommand = handleCommand;
module.exports.COMMANDS = { DO, VOTE, SKIP, REMOVE, PIN, UNPIN };
