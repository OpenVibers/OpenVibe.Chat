'use strict';
/** The unlisted agent room's link gated read and post path. Chat keeps the
 * stream's link hash, so rotating the Live link immediately revokes old views. */
const crypto = require('node:crypto');
const express = require('express');
const { optionalAuth, requireAuth } = require('../auth/auth');
const db = require('../db/database');
const rooms = require('../rooms/rooms');
const agent = require('./agent-room');

const router = express.Router();

async function visible(req, res) {
    const id = agent.roomIdOf(req.params.id);
    const room = id && await agent.roomByAgentId(id);
    if (!room) { res.status(404).json({ error: 'No such room' }); return null; }
    const access = await rooms.access(room, req.user || null);
    if (room.visibility !== 'public' && !access.read) {
        const secret = String(req.query.k || '');
        const saved = await db.get('SELECT link_secret_hash FROM agent_room_identities WHERE room_id = ?', [room.id]);
        const hash = crypto.createHash('sha256').update(secret).digest('hex');
        if (!/^[A-Za-z0-9_-]{22}$/.test(secret) || !saved || !/^[a-f0-9]{64}$/.test(String(saved.link_secret_hash || '')) ||
            !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(saved.link_secret_hash))) {
            res.status(404).json({ error: 'No such room' }); return null;
        }
    }
    if (access.role === 'blocked') { res.status(404).json({ error: 'No such room' }); return null; }
    res.set('Cache-Control', 'no-store');
    return { room, access };
}

function error(res, err) {
    if (err instanceof rooms.RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Agent room]', err && err.message);
    return res.status(500).json({ error: 'The room could not be read' });
}

router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const found = await visible(req, res); if (!found) return;
        res.json({ room: found.room.slug, can: { read: true, post: !!req.user && !rooms.siteBanned(req.user) }, role: found.access.role || null });
    } catch (err) { error(res, err); }
});

router.get('/:id/messages', optionalAuth, async (req, res) => {
    try {
        const found = await visible(req, res); if (!found) return;
        const messages = await rooms.history(found.room, { after: req.query.after || null, limit: 100 });
        res.json({ messages });
    } catch (err) { error(res, err); }
});

router.post('/:id/messages', requireAuth, async (req, res) => {
    try {
        const found = await visible(req, res); if (!found) return;
        const message = await rooms.post(found.room, req.user, req.body && req.body.message, { agentView: true });
        res.status(201).json({ message });
    } catch (err) { error(res, err); }
});

router.delete('/:id/messages/:message', requireAuth, async (req, res) => {
    try {
        const found = await visible(req, res); if (!found) return;
        const id = await rooms.deleteMessage(found.room, req.user, Number(req.params.message));
        res.json({ ok: true, id });
    } catch (err) { error(res, err); }
});

module.exports = { router, visible };
