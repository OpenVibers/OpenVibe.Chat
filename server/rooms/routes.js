'use strict';
/**
 * /api/chat/rooms — chat rooms over REST (server/rooms/rooms.js); openvibe.chat and bots use it, and
 * chat-server.js carries the same rooms live (join_room / room_message).
 *
 *   GET    /                        public rooms by activity + the caller's rooms (with unread counts)
 *   POST   /                        create { name, slug?, topic?, visibility?, kind?: community | call | system (staff),
 *                                   join_role?: speaker | participant | viewer (call rooms) }
 *   GET    /:slug                   the room, what the caller may do (can: read/post/join/talk/moderate/manage)
 *                                   and, for a call room, its call (404 when they may not read it)
 *   PATCH  /:slug                   owner: { name?, topic?, visibility?, slow_seconds?, join_role? }
 *   GET    /:slug/messages          ?before=<id> | ?after=<id>, &limit
 *   POST   /:slug/messages          { message }
 *   DELETE /:slug/messages/:id      the author, a room moderator or chat staff
 *   POST   /:slug/join | /leave | /read { last_id? }
 *   GET    /:slug/members           (moderators also get last_seen_at)
 *   POST   /:slug/members           owner/mods: { username, role } — one of the kind's roles (rooms.KIND_ROLES) or none
 *   GET    /:slug/attachments       managers: where the room is attached (a Community space)
 *   POST   /:slug/attachments       managers, with their own Network token: { service: 'community', resource: <space slug>, title? }
 *   DELETE /:slug/attachments/:service/:resource   managers or whoever attached it (both idempotent)
 *
 * Role and room changes reach a running call at once (call-server.js applyRoomAccess): a new speaker
 * may talk, a demoted one is muted, a blocked person is dropped.
 */
const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const rooms = require('./rooms');
const ctx = require('../live-context');

const router = express.Router();

// Per-actor limits (net/actor-limits.js), after requireAuth: reads take the defaults at app.js.
// Creating a room (owners keep at most MAX_ROOMS_PER_OWNER): 10 a minute, 60 an hour.
const createLimit = limits('chat.room.create', { minute: 10, hour: 60 });
// Posting: above the per-room limit (6 every 10 s, and slow mode), which keeps deciding; refusals count.
const postLimit = limits('chat.room.message.send', { minute: 60, hour: 1200 });
// Deleting a line (the author, a moderator): one at a time, by hand.
const deleteLimit = limits('chat.room.message.delete', { minute: 60, hour: 600 });
// Settings, membership and roles reach every socket and a running call: a few at a time.
const manageLimit = limits('chat.room.manage', { minute: 30, hour: 300 });
// Marking read: once per room opened or caught up.
const readLimit = limits('chat.room.read_mark', { minute: 60, hour: 1200 });
// Attaching links the room to a Community space: an owner sets up a few.
const attachLimit = limits('chat.room.attach', { minute: 10, hour: 100 });

function send(res, err) {
    if (err instanceof rooms.RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Rooms]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const chatServer = () => require('../chat/chat-server');
/**
 * After a role or room change: sockets following the room learn what they may do now, and a running
 * call in it follows the room's roles (no-op when calls are off or nobody is in).
 */
async function applyRoomChange(room) {
    const fresh = await rooms.bySlug(room.slug) || room;
    try { await chatServer().refreshRoomAccess(fresh); } catch (err) { console.warn('[Rooms] socket update:', err.message); }
    try { await require('../calls/call-server').applyRoomAccess(fresh); } catch (err) { console.warn('[Rooms] call update:', err.message); }
}
/** The room's call as the room page shows it: on or off, and who is in. */
function callOf(room) {
    if (room.kind !== 'call') return undefined;
    const enabled = !!require('../config').calls.enabled;
    let people = [];
    try { people = enabled ? require('../calls/call-server').getParticipants(`room-${room.slug}`) : []; } catch { people = []; }
    return { enabled, channel: `room-${room.slug}`, participants: people.length, people: people.map((p) => ({ username: p.username, display_name: p.displayName, muted: !!p.muted, speaking: !!p.speaking, listening: !!p.forceMuted })) };
}
/** People only: attaching speaks for the person (API tokens and services cannot). */
const personOnly = (req, res, next) => (req.authSource === 'api_token' ? res.status(403).json({ error: 'Attach rooms with your own sign-in, not an API token', code: 'rooms.person_only' }) : next());

/** The room behind :slug when the caller may read it (else a 404 that says nothing about private rooms). */
async function readable(req, res) {
    const room = await rooms.bySlug(req.params.slug);
    if (!room || !(await rooms.access(room, req.user || null)).read) { res.status(404).json({ error: 'No such room', code: 'rooms.not_found' }); return null; }
    return room;
}

router.get('/', optionalAuth, async (req, res) => {
    try { res.set('Cache-Control', 'private, no-store').json(await rooms.list(req.user || null, { limit: req.query.limit })); } catch (err) { send(res, err); }
});

router.post('/', requireAuth, createLimit, async (req, res) => {
    try { res.status(201).json({ room: await rooms.create(req.user, req.body || {}) }); } catch (err) { send(res, err); }
});

router.get('/:slug', optionalAuth, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    const a = await rooms.access(room, req.user || null);
    res.set('Cache-Control', 'private, no-store').json({
        room: await rooms.publicRoom(room, { role: a.role }),
        can: { read: a.read, post: a.post, join: a.join, talk: a.talk, moderate: a.moderate, manage: a.manage },
        ...(room.kind === 'call' ? { call: callOf(room) } : {}),
    });
});

router.patch('/:slug', requireAuth, manageLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try { const out = await rooms.update(room, req.user, req.body || {}); await applyRoomChange(room); res.json({ room: out }); } catch (err) { send(res, err); }
});

router.get('/:slug/messages', optionalAuth, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try {
        const messages = await rooms.history(room, { before: req.query.before ?? null, after: req.query.after ?? null, limit: req.query.limit });
        res.set('Cache-Control', 'private, no-store').json({ messages, latest_id: messages.length ? messages[messages.length - 1].id : null });
    } catch (err) { send(res, err); }
});

router.post('/:slug/messages', requireAuth, postLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try {
        const message = await rooms.post(room, req.user, req.body && req.body.message);
        chatServer().broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.status(201).json({ message });
    } catch (err) { send(res, err); }
});

router.delete('/:slug/messages/:id', requireAuth, deleteLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try {
        const id = await rooms.deleteMessage(room, req.user, parseInt(req.params.id, 10));
        chatServer().broadcastToRoom(room.id, { type: 'room_message_deleted', room: room.slug, id });
        res.json({ ok: true, id });
    } catch (err) { send(res, err); }
});

router.post('/:slug/join', requireAuth, manageLimit, async (req, res) => {
    const room = await rooms.bySlug(req.params.slug);
    if (!room) return res.status(404).json({ error: 'No such room', code: 'rooms.not_found' });
    try { const role = await rooms.join(room, req.user); await applyRoomChange(room); res.json({ ok: true, role }); } catch (err) { send(res, err); }
});

router.post('/:slug/leave', requireAuth, manageLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try {
        await rooms.leave(room, req.user);
        chatServer().removeFromRoom(room.id, req.user.id);
        await applyRoomChange(room);
        res.json({ ok: true });
    } catch (err) { send(res, err); }
});

router.post('/:slug/read', requireAuth, readLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try { await rooms.markRead(room, req.user, req.body && req.body.last_id); res.json({ ok: true }); } catch (err) { send(res, err); }
});

router.get('/:slug/members', optionalAuth, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    const moderate = (await rooms.access(room, req.user || null)).moderate;
    res.set('Cache-Control', 'private, no-store').json({ members: (await rooms.members(room, { seen: moderate })).filter((m) => m.role !== 'blocked' || moderate) });
});

router.post('/:slug/members', requireAuth, manageLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try {
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? await ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.status(404).json({ error: `Nobody called ${name.slice(0, 24)} on OpenVibe`, code: 'rooms.no_user' });
        const role = await rooms.setRole(room, req.user, target.id, String((req.body && req.body.role) || 'member'));
        if (role === 'blocked' || (room.visibility === 'private' && role === 'none')) chatServer().removeFromRoom(room.id, target.id);
        await applyRoomChange(room);
        res.json({ ok: true, user_id: target.id, username: target.username, role });
    } catch (err) { send(res, err); }
});

router.get('/:slug/attachments', requireAuth, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    if (!(await rooms.access(room, req.user)).manage) return res.status(403).json({ error: 'Only the room\'s owner sees where it is attached', code: 'rooms.not_owner' });
    res.set('Cache-Control', 'private, no-store').json({ attachments: await rooms.attachments(room) });
});

router.post('/:slug/attachments', requireAuth, personOnly, attachLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try {
        const b = req.body || {};
        const out = await rooms.attach(room, req.user, { service: b.service, resource: b.resource, title: b.title });
        res.status(out.created ? 201 : 200).json({ ...out, room: await rooms.publicRoom(room) });
    } catch (err) { send(res, err); }
});

router.delete('/:slug/attachments/:service/:resource', requireAuth, personOnly, attachLimit, async (req, res) => {
    const room = await readable(req, res); if (!room) return;
    try { res.json({ ok: true, ...await rooms.detach(room, req.user, req.params.service, req.params.resource) }); } catch (err) { send(res, err); }
});

module.exports = router;
module.exports.callOf = callOf;
module.exports.applyRoomChange = applyRoomChange;
