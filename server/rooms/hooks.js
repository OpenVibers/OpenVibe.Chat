'use strict';
/**
 * Incoming hooks for workspace rooms (migrations/0029_room_hooks.sql): what other systems see lands in the room. A room's
 * owner makes a hook on the room's settings page; its address and secret are shown once.
 *
 *   POST /api/chat/hooks/:id   the raw body, signed like an OpenVibe.Events delivery (X-OpenVibe-Timestamp and
 *                              X-OpenVibe-Signature-V2 with the hook's secret, ±5 minutes: openvibe-sdk/events
 *                              signDeliveryHeaders makes them, and an OpenVibe.Watch webhook action sends them)
 *
 * The body, as JSON, is one of:
 *   a Watch firing             { type: 'watch.watch.triggered', watch: { name, url }, observation: { value, previous_value } }
 *   an OpenVibe event          { event: { type, data } } (data.text, .summary or .title is the line, if any)
 *   a line                     { text } (or { message })
 * It becomes a message from the room's Vibe (its first AI member), "🔔 <label>: …". A hook with a queue kind also adds
 * a task of that kind to the room's queue for the person who made it (server/rooms/workspace.js), while they may still
 * post there: quick kinds run at once on their OpenVibe.Actor allowance.
 *
 * 202 when it is in the room. 401 for a missing, stale or wrong signature, 404 for no such hook (or a room that is no
 * longer a workspace), 422 for a body it cannot read, 429 past 60 deliveries an hour per hook. A repeat of the same
 * X-OpenVibe-Delivery-Id within the hour is answered 202 and changes nothing.
 */
const crypto = require('crypto');
const db = require('../db/database');
const rooms = require('./rooms');

const MAX_PER_ROOM = 5;
const PER_HOUR = 60;
const LINE_MAX = 1500;
const ID_RE = /^rh_[A-Za-z0-9_-]{20,40}$/;
const KINDS = ['answer', 'research', 'web', 'code', 'computer', 'other'];
const recent = new Map();   // hook id → { since, n, ids: Set } for the rate limit and repeats, per process

class HookError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new HookError(status, code, message); };
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const valueText = (v) => (v == null ? 'no value' : typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());

const shape = (h) => ({ id: h.id, label: h.label, queue_kind: h.queue_kind || null, deliveries: Number(h.deliveries) || 0, last_at: h.last_at || null, created_at: h.created_at });

async function mustManage(room, user) {
    const a = await rooms.access(room, user);
    if (!a.read) fail(404, 'rooms.not_found', 'No such room');
    if (!rooms.isWorkspace(room)) fail(409, 'hooks.not_workspace', 'Only workspace rooms take incoming hooks');
    if (!a.manage) fail(403, 'hooks.owner_only', 'Only the room\'s owner makes hooks');
    return a;
}

async function list(room) {
    return (await db.all('SELECT * FROM room_hooks WHERE room_id = ? ORDER BY created_at, id', [room.id])).map(shape);
}

/** A new hook. → { hook, secret }: the secret is never shown again. */
async function create(room, user, { label, queue_kind = null } = {}) {
    await mustManage(room, user);
    const name = oneLine(label, 60);
    if (name.length < 2) fail(422, 'hooks.label', 'Give the hook a short name, such as "Site errors"');
    const kind = KINDS.includes(queue_kind) ? queue_kind : null;
    const n = await db.get('SELECT COUNT(*) AS n FROM room_hooks WHERE room_id = ?', [room.id]);
    if (Number(n && n.n) >= MAX_PER_ROOM) fail(429, 'hooks.too_many', `At most ${MAX_PER_ROOM} hooks a room`);
    const id = `rh_${crypto.randomBytes(18).toString('base64url')}`;
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const row = await db.get('INSERT INTO room_hooks (id, room_id, label, secret, queue_kind, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING *', [id, room.id, name, secret, kind, user.id]);
    return { hook: shape(row), secret };
}

async function remove(room, user, id) {
    await mustManage(room, user);
    await db.run('DELETE FROM room_hooks WHERE room_id = ? AND id = ?', [room.id, String(id || '')]);
}

/** The room's line for a body, or null when the body is none of the forms above. */
function lineOf(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.type === 'watch.watch.triggered' && body.watch && typeof body.watch === 'object') {
        const o = body.observation || {};
        const was = o.previous_value === undefined || o.previous_value === null ? '' : ` (was ${oneLine(valueText(o.previous_value), 200)})`;
        const url = /^https:\/\//.test(String(body.watch.url || '')) ? `\n${oneLine(body.watch.url, 500)}` : '';
        return { title: `${oneLine(body.watch.name || 'A watch', 120)} fired`, text: `${oneLine(body.watch.name || 'A watch', 120)} fired: ${oneLine(valueText(o.value), 400)}${was}${url}` };
    }
    if (body.event && typeof body.event === 'object' && typeof body.event.type === 'string') {
        const d = body.event.data && typeof body.event.data === 'object' ? body.event.data : {};
        const said = oneLine(d.text || d.summary || d.title || '', LINE_MAX);
        const type = oneLine(body.event.type, 120);
        return { title: said ? `${type}: ${said}` : type, text: said ? `${type}: ${said}` : type };
    }
    const text = typeof body.text === 'string' ? body.text : typeof body.message === 'string' ? body.message : null;
    if (text && oneLine(text, LINE_MAX)) return { title: oneLine(text, 200), text: oneLine(text, LINE_MAX) };
    return null;
}

/** One delivery: check it, post it, queue it. → { message_id, task_id, repeat } */
async function deliver(id, rawBody, headers, deps = {}) {
    if (!ID_RE.test(String(id || ''))) fail(404, 'hooks.not_found', 'No such hook');
    const hook = await db.get('SELECT * FROM room_hooks WHERE id = ?', [id]);
    if (!hook) fail(404, 'hooks.not_found', 'No such hook');
    const { verifyDeliveryV2 } = require('openvibe-sdk/events');
    if (!verifyDeliveryV2(rawBody, headers, hook.secret, deps.now ? { now: deps.now() } : {})) fail(401, 'hooks.signature', 'The signature is missing, stale or wrong');
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', [hook.room_id]);
    if (!room || !rooms.isWorkspace(room)) fail(404, 'hooks.not_found', 'No such hook');

    const now = deps.now ? deps.now() : Date.now();
    let r = recent.get(id);
    if (!r || now - r.since > 3600_000) { r = { since: now, n: 0, ids: new Set() }; recent.set(id, r); }
    const deliveryId = oneLine(headers['x-openvibe-delivery-id'] || '', 120);
    if (deliveryId && r.ids.has(deliveryId)) return { message_id: null, task_id: null, repeat: true };
    if (r.n >= PER_HOUR) fail(429, 'hooks.slow_down', `At most ${PER_HOUR} deliveries an hour to one hook`);

    let body;
    try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { body = null; }
    const line = lineOf(body);
    if (!line) fail(422, 'hooks.body', 'Send JSON: a Watch firing, an OpenVibe event, or { "text": "…" }');
    r.n += 1;
    if (deliveryId) r.ids.add(deliveryId);

    const member = (await db.all("SELECT * FROM room_ai_members WHERE room_id = ? AND enabled = 1 ORDER BY (handle = 'vibe') DESC, id LIMIT 1", [room.id]))[0];
    let posted = null;
    if (member) {
        posted = await rooms.postAsAi(room, member, `🔔 ${hook.label}: ${line.text}`);
        try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message: posted }); } catch { /* sockets are optional */ }
    }
    let task = null;
    if (hook.queue_kind) {
        const creator = await require('../live-context').getUserById(Number(hook.created_by));
        try {
            task = await require('./workspace').add(room, creator, {
                title: `${hook.label}: ${line.title}`.slice(0, 200), kind: hook.queue_kind, via: 'api',
                details: `From the room's hook "${hook.label}":\n\n${JSON.stringify(body, null, 2).slice(0, 5500)}`,
            }, deps.work || {});
        } catch (err) {
            // The person who made the hook can no longer post here, or the queue is full: the message still stands.
            if (!(err && err.status)) throw err;
        }
    }
    await db.run('UPDATE room_hooks SET deliveries = deliveries + 1, last_at = ov_now() WHERE id = ?', [id]);
    return { message_id: posted ? posted.id : null, task_id: task ? task.id : null, repeat: false };
}

/** The Express handler for POST /api/chat/hooks/:id (mounted with a raw body parser before the JSON one). */
async function ingress(req, res) {
    try {
        const out = await deliver(req.params.id, Buffer.isBuffer(req.body) ? req.body : Buffer.from(''), req.headers);
        res.status(202).json({ ok: true, ...out });
    } catch (err) {
        if (err instanceof HookError) return res.status(err.status).json({ error: err.message, code: err.code });
        console.warn('[Hooks] delivery failed:', err && err.message);
        res.status(500).json({ error: 'Could not take that right now', code: 'hooks.error' });
    }
}

function _reset() { recent.clear(); }

module.exports = { HookError, MAX_PER_ROOM, list, create, remove, deliver, ingress, lineOf, _reset };
