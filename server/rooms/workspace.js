'use strict';
/**
 * Workspace rooms: a work queue beside a room's conversation (migrations/0027_workspaces.sql; owner 2026-10-25: one
 * shared screen for the admins, the same system as chat's AI assistant but for many people, where everyone sees the
 * queue and what is being worked on — in place of one person chatting with an agent alone). The staff room
 * (/r/staff) is the first; any room can be one.
 *
 *   add(room, user, { title, details, kind })   anyone who may post adds a task; Vibe adds one with queue_task
 *   list / get                                  what anyone who reads the room sees: every task, its state and result
 *   cancel                                      the person who asked, or a moderator
 *   claim / report                              the kinds no service runs yet (code, computer, other) wait for a worker:
 *                                               a member of the room, or an agent working with a member's API token
 *                                               (the agent harness), claims one, then reports what it did and where
 *
 * The quick kinds (answer, research, web) run at once as OpenVibe.Actor tasks of the person who asked: Chat's own
 * service token names them in X-OV-Subject (Network grants Chat actor.task.create and actor.task.read), so the task is
 * theirs (their allowance, their list) and Actor records Chat as `via`. A poller follows those tasks; every task that
 * ends, whoever ran it, is announced in the room by its Vibe with the result, and the queue on every open page updates
 * over the chat socket (room_task frames).
 */
const db = require('../db/database');
const config = require('../config');
const rooms = require('./rooms');

const KINDS = ['answer', 'research', 'web', 'code', 'computer', 'other'];
const QUICK = new Set(['answer', 'research', 'web']);
const OPEN = ['queued', 'running'];
const DONE = new Set(['succeeded', 'failed', 'cancelled']);
const LIMITS = { title: 200, details: 6000, result: 20000, error: 500, url: 2000 };
const PER_PERSON_HOUR = 20;
const PER_ROOM_DAY = 300;
const POLL_MS = 10_000;

class WorkError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new WorkError(status, code, message); };
const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max * 2).replace(/\s+/g, ' ').slice(0, max);

const TASK_SELECT = `SELECT t.*, u.username AS requester_username, u.display_name AS requester_name
    FROM room_tasks t LEFT JOIN ctx_users u ON u.id = t.requested_by`;

function shape(t, room) {
    let sources = [];
    try { sources = JSON.parse(t.sources || '[]'); } catch { sources = []; }
    return {
        id: Number(t.id), title: t.title, details: t.details || '', kind: t.kind, status: t.status, via: t.via,
        quick: QUICK.has(t.kind),
        requested_by: { id: Number(t.requested_by), username: t.requester_username || null, name: t.requester_name || t.requester_username || 'someone' },
        runner: t.runner || null, result: t.result || null, result_url: t.result_url || null, sources: Array.isArray(sources) ? sources : [],
        error: t.error || null, cost_usd: t.cost_usd == null ? null : Number(t.cost_usd),
        created_at: t.created_at, started_at: t.started_at || null, finished_at: t.finished_at || null,
        url: `/r/${room.slug}/tasks/${Number(t.id)}`,
    };
}

async function mustRead(room, user) {
    // A workspace room's queue, or a Vibe chat's own (its Research, Agent and Code requests, server/rooms/vibe.js).
    if (!rooms.isWorkspace(room) && Number(room.assistant) !== 1) fail(404, 'work.not_workspace', 'This room has no work queue');
    const a = await rooms.access(room, user);
    if (!a.read) fail(404, 'rooms.not_found', 'No such room');
    return a;
}

async function list(room, user, { limit = 60, status = null } = {}) {
    await mustRead(room, user);
    const lim = Math.min(200, Math.max(1, Number(limit) || 60));
    const rows = status && (OPEN.includes(status) || DONE.has(status))
        ? await db.all(`${TASK_SELECT} WHERE t.room_id = ? AND t.status = ? ORDER BY t.id DESC LIMIT ?`, [room.id, status, lim])
        : await db.all(`${TASK_SELECT} WHERE t.room_id = ? ORDER BY (t.status IN ('queued','running')) DESC, t.id DESC LIMIT ?`, [room.id, lim]);
    return rows.map((t) => shape(t, room));
}

async function row(room, id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return await db.get(`${TASK_SELECT} WHERE t.id = ? AND t.room_id = ?`, [n, room.id]) || null;
}

async function get(room, user, id) {
    await mustRead(room, user);
    const t = await row(room, id);
    if (!t) fail(404, 'work.not_found', 'No such task in this room');
    return shape(t, room);
}

/** Tell every open page of the room that the queue changed (the panel refreshes itself). */
function changed(room, task) {
    try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_task', room: room.slug, task: task ? { id: task.id, status: task.status } : null }); } catch { /* sockets are optional */ }
}

async function add(room, user, { title, details = '', kind = 'research', via = 'person', sourceMessage = null } = {}, deps = {}) {
    const a = await mustRead(room, user);
    if (!user) fail(401, 'rooms.sign_in', 'Sign in first');
    if (!a.post) fail(403, a.role ? 'rooms.read_only' : 'rooms.join_first', a.role ? 'Your role in this room is read-only' : 'Join the room to add work');
    const t = oneLine(title, LIMITS.title);
    if (t.length < 3) fail(422, 'work.title', 'Say what to do in a few words');
    const k = KINDS.includes(kind) ? kind : 'other';
    const d = clean(details, LIMITS.details);
    const hour = await db.get("SELECT COUNT(*) AS n FROM room_tasks WHERE requested_by = ? AND created_at > to_char((now() AT TIME ZONE 'UTC') - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS')", [user.id]);
    if (Number(hour && hour.n) >= PER_PERSON_HOUR) fail(429, 'work.slow_down', `You added ${PER_PERSON_HOUR} tasks in the last hour; give the queue a moment`);
    const day = await db.get("SELECT COUNT(*) AS n FROM room_tasks WHERE room_id = ? AND created_at > to_char((now() AT TIME ZONE 'UTC') - interval '1 day', 'YYYY-MM-DD HH24:MI:SS')", [room.id]);
    if (Number(day && day.n) >= PER_ROOM_DAY) fail(429, 'work.room_full', 'This room has queued its limit for today');
    const r = await db.run(`INSERT INTO room_tasks (room_id, title, details, kind, requested_by, requested_subject, via, source_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [room.id, t, d, k, user.id, user.subject_id || null, ['person', 'vibe', 'api'].includes(via) ? via : 'person', sourceMessage]);
    const id = Number(r.lastInsertRowid);
    if (QUICK.has(k)) await startOnActor(room, await row(room, id), deps);
    const task = shape(await row(room, id), room);
    changed(room, task);
    return task;
}

async function setStatus(room, id, patch) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
    sets.push('updated_at = ov_now()');
    await db.run(`UPDATE room_tasks SET ${sets.join(', ')} WHERE id = ? AND room_id = ?`, [...vals, id, room.id]);
}

async function cancel(room, user, id, deps = {}) {
    const a = await mustRead(room, user);
    const t = await row(room, id);
    if (!t) fail(404, 'work.not_found', 'No such task in this room');
    if (!user || (Number(t.requested_by) !== Number(user.id) && !a.moderate)) fail(403, 'work.not_yours', 'Only the person who asked, or a moderator, cancels a task');
    if (DONE.has(t.status)) return shape(t, room);
    if (t.actor_task) await actorCall('POST', `/api/v1/tasks/${encodeURIComponent(t.actor_task)}/cancel`, t.requested_subject, null, deps).catch(() => null);
    await setStatus(room, t.id, { status: 'cancelled', finished_at: nowText(), error: `Cancelled by ${user.display_name || user.username || 'someone'}` });
    const task = shape(await row(room, t.id), room);
    changed(room, task);
    return task;
}

/**
 * "Run on my computer": the person who asked hands their own code or computer task to OpenVibe.Actor, which sends code
 * to OpenVibe.Codes on their machines (OpenVibe.Run's worker chain) and computer work to their computer through
 * OpenVibe.Bot, at the level they set there. Without such a machine Actor says so and the task shows why.
 */
async function runOnComputer(room, user, id, deps = {}) {
    await mustRead(room, user);
    const t = await row(room, id);
    if (!t) fail(404, 'work.not_found', 'No such task in this room');
    if (!user || Number(t.requested_by) !== Number(user.id)) fail(403, 'work.not_yours', 'Only the person who asked runs a task on their own computer');
    if (!['code', 'computer'].includes(t.kind)) fail(409, 'work.not_computer', 'Only code and computer tasks run on a computer');
    if (t.status !== 'queued') fail(409, 'work.taken', 'This task is already being worked on or finished');
    const r = await db.run("UPDATE room_tasks SET status = 'running', runner = 'actor', started_at = ov_now(), updated_at = ov_now() WHERE id = ? AND room_id = ? AND status = 'queued'", [t.id, room.id]);
    if (!r.changes) fail(409, 'work.taken', 'Someone took it a moment ago');
    await startOnActor(room, t, deps);
    const task = shape(await row(room, t.id), room);
    changed(room, task);
    return task;
}

/** A worker takes a task no service runs: a person who may post, or an agent with such a person's API token. */
async function claim(room, user, id, { runner = null } = {}) {
    const a = await mustRead(room, user);
    if (!user || !a.post) fail(403, 'work.cannot_claim', 'Only people who may post here take work from the queue');
    const t = await row(room, id);
    if (!t) fail(404, 'work.not_found', 'No such task in this room');
    if (QUICK.has(t.kind)) fail(409, 'work.runs_itself', 'OpenVibe.Actor runs this kind of task by itself');
    if (t.status !== 'queued') fail(409, 'work.taken', t.status === 'running' ? `Already being worked on by ${t.runner || 'someone'}` : 'This task is finished');
    const who = runner ? `${oneLine(runner, 60)} (for ${user.username || user.id})` : `user:${user.id}`;
    const r = await db.run("UPDATE room_tasks SET status = 'running', runner = ?, started_at = ov_now(), updated_at = ov_now() WHERE id = ? AND room_id = ? AND status = 'queued'", [who, t.id, room.id]);
    if (!r.changes) fail(409, 'work.taken', 'Someone took it a moment ago');
    const task = shape(await row(room, t.id), room);
    changed(room, task);
    return task;
}

/** The worker that claimed a task (or a moderator) says how it went; the room hears it. */
async function report(room, user, id, { status, result = '', result_url = null, error = null } = {}, deps = {}) {
    const a = await mustRead(room, user);
    const t = await row(room, id);
    if (!t) fail(404, 'work.not_found', 'No such task in this room');
    if (t.status !== 'running' || QUICK.has(t.kind)) fail(409, 'work.not_running', 'Claim the task before reporting on it');
    const mine = String(t.runner || '') === `user:${user && user.id}` || String(t.runner || '').endsWith(`(for ${user && (user.username || user.id)})`);
    if (!user || (!mine && !a.moderate)) fail(403, 'work.not_yours', 'Only whoever took the task, or a moderator, reports on it');
    if (!['succeeded', 'failed'].includes(status)) fail(422, 'work.status', 'status is succeeded or failed');
    let url = null;
    if (result_url) {
        try { const u = new URL(String(result_url)); if (u.protocol === 'https:') url = u.toString().slice(0, LIMITS.url); } catch { /* not a URL */ }
        if (!url) fail(422, 'work.url', 'result_url is an https address');
    }
    await setStatus(room, t.id, { status, result: clean(result, LIMITS.result) || null, result_url: url, error: status === 'failed' ? (oneLine(error, LIMITS.error) || 'It did not work out') : null, finished_at: nowText() });
    await announce(room, await row(room, t.id), deps);
    return shape(await row(room, t.id), room);
}

const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ── OpenVibe.Actor ──────────────────────────────────────────────────────────────────────────────────
let tokens = null;
function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.actor', scope: 'actor.task.create actor.task.read',
    });
    return tokens;
}

async function actorCall(method, path, subject, body, { fetchImpl = globalThis.fetch } = {}) {
    if (!config.oauth.clientSecret) throw new WorkError(503, 'work.actor_off', 'OpenVibe.Actor is not available on this server');
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) throw new WorkError(422, 'work.no_subject', 'The person who asked has no OpenVibe account id');
    const token = await tokenClient().getToken();
    const res = await fetchImpl(`${config.actor.internalUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new WorkError(res.status >= 500 ? 503 : res.status, (json && json.code) || 'work.actor', (json && (json.detail || json.title)) ? String(json.detail || json.title).slice(0, 300) : `OpenVibe.Actor answered ${res.status}`);
    return json;
}

/** The text Actor gets: what kind of work, the title, the details. */
function actorText(t) {
    const lead = {
        research: 'Research this and write a short report for a team, with the links of your sources', web: 'Search the web and answer, with the links of your sources', answer: 'Answer this for a team',
        code: 'Make this code change with OpenVibe.Codes on my own computer, run its tests, and hand it in as a pull request for review (never straight to main)',
        computer: 'Do this on my own computer, step by step, and say what you did',
    }[t.kind] || 'Do this';
    return `${lead}: ${t.title}${t.details ? `\n\n${t.details}` : ''}`.slice(0, 7000);
}

async function startOnActor(room, t, deps = {}) {
    try {
        const task = await actorCall('POST', '/api/v1/tasks', t.requested_subject, { task: actorText(t), idempotency_key: `chat-room-task-${t.id}` }, deps);
        // A task a worker could take stays taken while Actor holds it, so nobody claims it twice.
        await setStatus(room, t.id, { actor_task: String(task.id), runner: 'actor', status: task.state === 'running' || !QUICK.has(t.kind) ? 'running' : 'queued', started_at: nowText() });
    } catch (err) {
        await setStatus(room, t.id, { status: 'failed', runner: 'actor', error: oneLine(err.message, LIMITS.error), finished_at: nowText() });
        await announce(room, await row(room, t.id), deps).catch(() => {});
    }
}

/** Follow every open Actor task once: new states are stored, finished ones announced. */
async function poll(deps = {}) {
    const open = await db.all("SELECT t.*, r.slug AS room_slug FROM room_tasks t JOIN rooms r ON r.id = t.room_id WHERE t.status IN ('queued','running') AND t.actor_task IS NOT NULL ORDER BY t.id LIMIT 50");
    for (const t of open) {
        const room = await rooms.bySlug(t.room_slug);
        if (!room) continue;
        let task;
        try { task = await actorCall('GET', `/api/v1/tasks/${encodeURIComponent(t.actor_task)}`, t.requested_subject, null, deps); } catch (err) {
            if (err.status === 404) { await setStatus(room, t.id, { status: 'failed', error: 'OpenVibe.Actor no longer has this task', finished_at: nowText() }); await announce(room, await row(room, t.id), deps).catch(() => {}); }
            continue;
        }
        const state = task && task.state;
        if (state === 'running' && t.status !== 'running') { await setStatus(room, t.id, { status: 'running' }); changed(room, { id: Number(t.id), status: 'running' }); }
        // The agent handed its person a step on its desk (Desks plan D4): Vibe asks them here, once per hand-off.
        if (state === 'running' && task.needs_you && task.needs_you.url) await askPerson(room, t, task.needs_you, deps).catch(() => {});
        // The agent works on a desk of its own (Desks plan): in a Vibe chat, Vibe offers to watch it and take it over, once.
        if (state === 'running' && task.desk && task.desk.url && Number(room.assistant) === 1) await showDesk(room, t, task.desk, deps).catch(() => {});
        if (!DONE.has(state)) continue;
        const r = task.result || {};
        const sources = (Array.isArray(r.sources) ? r.sources : []).map((s) => (typeof s === 'string' ? s : s && s.url)).filter((u) => /^https?:\/\//.test(String(u || ''))).slice(0, 12);
        // Actor's task (actor.task wire): cost.usd is what the task spent; the result names its agent, model and check.
        const cost = task.cost && Number.isFinite(Number(task.cost.usd)) ? Number(task.cost.usd) : null;
        const checked = r.checked && typeof r.checked === 'object' ? { by: oneLine(r.checked.by, 40) || null, reason: oneLine(r.checked.reason, 300) || null } : null;
        const how = state === 'succeeded' ? JSON.stringify({ agent: oneLine(r.agent, 60) || null, model: oneLine(r.model, 80) || null, class: oneLine(r.class, 40) || null, checked, actor_task: String(task.id || t.actor_task) }) : null;
        await setStatus(room, t.id, {
            status: state, result: state === 'succeeded' ? clean(r.answer, LIMITS.result) || null : null, sources: JSON.stringify(sources), how,
            error: state === 'succeeded' ? null : oneLine((task.error && (task.error.detail || task.error.code)) || state, LIMITS.error), cost_usd: cost, finished_at: nowText(),
        });
        await announce(room, await row(room, t.id), deps).catch(() => {});
    }
}

// Hand-offs already asked about (actor task | its step's seq), so a poll every few seconds asks once.
const asked = new Set();

/** Vibe asks the person to take the agent's desk for one step (a sign-in, a CAPTCHA), with the link to it. */
async function askPerson(room, t, needs, deps = {}) {
    const key = `${t.actor_task}|${Number(needs.seq)}`;
    if (asked.has(key) || !/^https:\/\//.test(String(needs.url || ''))) return null;
    if (asked.size > 2000) asked.clear();
    asked.add(key);
    const members = await db.all('SELECT * FROM room_ai_members WHERE room_id = ? AND enabled = 1 ORDER BY (handle = \'vibe\') DESC, id LIMIT 1', [room.id]);
    const member = members[0];
    if (!member) return null;
    const what = oneLine(needs.what, 300) || 'one step only you can do';
    const text = `🙋 Your agent needs you for "${t.title}": ${what}\n\nOpen its desk, take it over, do it, then let go; it goes on by itself: ${oneLine(needs.url, LIMITS.url)}`;
    const roomsMod = deps.rooms || rooms;
    const posted = await roomsMod.postAsAi(room, member, text);
    try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message: posted }); } catch { /* sockets are optional */ }
    return posted;
}

// Tasks whose desk Vibe already offered (actor task), so a poll every few seconds offers it once.
const shownDesks = new Set();

/** Vibe offers the person the link to watch the agent's desk live and take it over (Desks plan: Watch, Take over). */
async function showDesk(room, t, desk, deps = {}) {
    const key = String(t.actor_task);
    if (shownDesks.has(key) || !/^https:\/\//.test(String(desk.url || ''))) return null;
    if (shownDesks.size > 2000) shownDesks.clear();
    shownDesks.add(key);
    const members = await db.all('SELECT * FROM room_ai_members WHERE room_id = ? AND enabled = 1 ORDER BY (handle = \'vibe\') DESC, id LIMIT 1', [room.id]);
    const member = members[0];
    if (!member) return null;
    const what = desk.kind === 'browser' ? 'a browser of its own' : 'a desk of its own';
    const text = `🖥️ Your agent is working on "${t.title}" in ${what}. Watch it live, and take it over whenever you like (it waits while you use it): ${oneLine(desk.url, LIMITS.url)}`;
    const roomsMod = deps.rooms || rooms;
    const posted = await roomsMod.postAsAi(room, member, text);
    try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message: posted }); } catch { /* sockets are optional */ }
    return posted;
}

/** The room hears how a task ended, from its Vibe (or its first AI member), once. */
async function announce(room, t, deps = {}) {
    if (!t || t.posted_message || !DONE.has(t.status)) { changed(room, t && shape(t, room)); return null; }
    const members = await db.all('SELECT * FROM room_ai_members WHERE room_id = ? AND enabled = 1 ORDER BY (handle = \'vibe\') DESC, id LIMIT 1', [room.id]);
    const member = members[0];
    const who = t.requester_name || t.requester_username || 'someone';
    const asked = Number(room.assistant) === 1 ? '' : ` (asked by ${who})`;   // a Vibe chat has one person in it
    let text;
    if (t.status === 'succeeded') {
        const body = String(t.result || '').trim();
        const clip = body.length > 1500 ? `${body.slice(0, 1500).replace(/\s+\S*$/, '')}…` : body;
        text = `✅ Done: "${t.title}"${asked}${clip ? `\n\n${clip}` : ''}${t.result_url ? `\n\n${t.result_url}` : ''}\n\nFull result: ${config.web.baseUrl}/r/${room.slug}/tasks/${Number(t.id)}`;
    } else if (t.status === 'failed') {
        text = `⚠️ Could not finish "${t.title}"${asked}: ${t.error || 'it did not work out'}. ${config.web.baseUrl}/r/${room.slug}/tasks/${Number(t.id)}`;
    } else {
        text = `Cancelled: "${t.title}".`;
    }
    let posted = null;
    if (member) {
        const roomsMod = deps.rooms || rooms;
        posted = await roomsMod.postAsAi(room, member, text);
        try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message: posted }); } catch { /* sockets are optional */ }
        await setStatus(room, t.id, { posted_message: posted.id });
    }
    changed(room, shape(t, room));
    return posted;
}

// ── The poller ─────────────────────────────────────────────────────────────────────────────────────
let timer = null;
let busy = false;
function start() {
    if (timer || !config.oauth.clientSecret) return;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try { await poll(); } catch (err) { console.warn('[Workspace] poll:', err && err.message); } finally { busy = false; }
    };
    timer = setInterval(tick, POLL_MS);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

function _setTokens(t) { tokens = t; }

module.exports = { KINDS, QUICK, WorkError, list, get, add, cancel, claim, report, runOnComputer, poll, announce, start, stop, shape, _setTokens };
