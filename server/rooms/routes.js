'use strict';
/**
 * /api/chat/rooms — chat rooms over REST (server/rooms/rooms.js); openvibe.chat and bots use it, and
 * chat-server.js carries the same rooms live (join_room / room_message).
 *
 *   GET    /                        public rooms by activity + the caller's rooms (with unread counts)
 *   POST   /                        create { name, slug?, topic?, visibility? }
 *   GET    /:slug                   the room and what the caller may do (404 when they may not read it)
 *   PATCH  /:slug                   owner: { name?, topic?, visibility?, slow_seconds? }
 *   GET    /:slug/messages          ?before=<id> | ?after=<id>, &limit
 *   POST   /:slug/messages          { message }
 *   DELETE /:slug/messages/:id      the author, a room moderator or chat staff
 *   POST   /:slug/join | /leave | /read { last_id? }
 *   GET    /:slug/members
 *   POST   /:slug/members           owner/mods: { username, role: member | mod | blocked | none }
 */
const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const rooms = require('./rooms');
const ctx = require('../live-context');

const router = express.Router();

function send(res, err) {
    if (err instanceof rooms.RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Rooms]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const chatServer = () => require('../chat/chat-server');

/** The room behind :slug when the caller may read it (else a 404 that says nothing about private rooms). */
function readable(req, res) {
    const room = rooms.bySlug(req.params.slug);
    if (!room || !rooms.access(room, req.user || null).read) { res.status(404).json({ error: 'No such room', code: 'rooms.not_found' }); return null; }
    return room;
}

router.get('/', optionalAuth, (req, res) => {
    try { res.set('Cache-Control', 'private, no-store').json(rooms.list(req.user || null, { limit: req.query.limit })); } catch (err) { send(res, err); }
});

router.post('/', requireAuth, (req, res) => {
    try { res.status(201).json({ room: rooms.create(req.user, req.body || {}) }); } catch (err) { send(res, err); }
});

router.get('/:slug', optionalAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    const a = rooms.access(room, req.user || null);
    res.set('Cache-Control', 'private, no-store').json({ room: rooms.publicRoom(room, { role: a.role }), can: { post: a.post, moderate: a.moderate, manage: a.manage } });
});

router.patch('/:slug', requireAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    try { res.json({ room: rooms.update(room, req.user, req.body || {}) }); } catch (err) { send(res, err); }
});

router.get('/:slug/messages', optionalAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    try {
        const messages = rooms.history(room, { before: req.query.before ?? null, after: req.query.after ?? null, limit: req.query.limit });
        res.set('Cache-Control', 'private, no-store').json({ messages, latest_id: messages.length ? messages[messages.length - 1].id : null });
    } catch (err) { send(res, err); }
});

router.post('/:slug/messages', requireAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    try {
        const message = rooms.post(room, req.user, req.body && req.body.message);
        chatServer().broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.status(201).json({ message });
    } catch (err) { send(res, err); }
});

router.delete('/:slug/messages/:id', requireAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    try {
        const id = rooms.deleteMessage(room, req.user, parseInt(req.params.id, 10));
        chatServer().broadcastToRoom(room.id, { type: 'room_message_deleted', room: room.slug, id });
        res.json({ ok: true, id });
    } catch (err) { send(res, err); }
});

router.post('/:slug/join', requireAuth, (req, res) => {
    const room = rooms.bySlug(req.params.slug);
    if (!room) return res.status(404).json({ error: 'No such room', code: 'rooms.not_found' });
    try { res.json({ ok: true, role: rooms.join(room, req.user) }); } catch (err) { send(res, err); }
});

router.post('/:slug/leave', requireAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    try { rooms.leave(room, req.user); chatServer().removeFromRoom(room.id, req.user.id); res.json({ ok: true }); } catch (err) { send(res, err); }
});

router.post('/:slug/read', requireAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    try { rooms.markRead(room, req.user, req.body && req.body.last_id); res.json({ ok: true }); } catch (err) { send(res, err); }
});

router.get('/:slug/members', optionalAuth, (req, res) => {
    const room = readable(req, res); if (!room) return;
    res.set('Cache-Control', 'private, no-store').json({ members: rooms.members(room).filter((m) => m.role !== 'blocked' || rooms.access(room, req.user || null).moderate) });
});

router.post('/:slug/members', requireAuth, async (req, res) => {
    const room = readable(req, res); if (!room) return;
    try {
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.status(404).json({ error: `Nobody called ${name.slice(0, 24)} on OpenVibe`, code: 'rooms.no_user' });
        const role = rooms.setRole(room, req.user, target.id, String((req.body && req.body.role) || 'member'));
        if (role === 'blocked' || role === 'none' || (room.visibility === 'private' && role === 'none')) chatServer().removeFromRoom(room.id, target.id);
        res.json({ ok: true, user_id: target.id, username: target.username, role });
    } catch (err) { send(res, err); }
});

module.exports = router;
