'use strict';
/**
 * Vibe from any OpenVibe site (plan L48, V2; the owner, 2026-11-01: "access your agent or the AI or the conversation
 * from across all websites… use a voice feature to tell it to set a reminder… have a conversation with your Vibe AI").
 * The Dock (openvibe-shared/dock.js) calls these with the person's own Network token, as it calls /api/dm: the same
 * conversations as openvibe.chat/vibe, so a chat started on Live carries on on Chat and back.
 *
 *   GET  /api/vibe/chat?slug=&after=   the chat (by slug, else the latest) and its messages: { chat, messages }, or
 *                                     { chat: null } before the first. after = a message id: only what came after it
 *                                     (the Dock polls this for Vibe's answer).
 *   POST /api/vibe/ask { message, slug?, timezone?, fresh? }
 *                                     post into that chat, else the latest one if it moved in the last 6 hours, else
 *                                     a new chat (fresh: always new). Vibe answers in the background, as on Chat.
 *                                     → { chat, message }
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const rooms = require('./rooms');
const vibe = require('./vibe');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

const SIX_HOURS = 6 * 3600 * 1000;
const asked = limits('chat.vibe.ask', { minute: 12, hour: 300 });
const zone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz) }); return String(tz).slice(0, 64); } catch { return null; } };
const at = (ts) => { const d = new Date(String(ts || '').includes('T') ? ts : `${String(ts || '').replace(' ', 'T')}Z`); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const wire = (m) => ({ id: Number(m.id), from: m.ai_member_id ? 'vibe' : 'you', text: String(m.message || ''), at: at(m.created_at) });
const chatOf = (room) => (room ? { slug: room.slug, name: room.name || 'Vibe', url: `https://openvibe.chat/vibe/${encodeURIComponent(room.slug)}` } : null);

async function latest(user) {
    const list = await vibe.list(user, { limit: 1 });
    const first = Array.isArray(list) ? list[0] : (list && list.chats ? list.chats[0] : null);
    return first ? await vibe.ownChat(first.slug, user) : null;
}

router.get('/chat', async (req, res) => {
    if (req.authSource === 'api_token' || req.authSource === 'dock') return res.status(403).json({ error: 'Vibe is for the person themself' });
    const room = req.query.slug ? await vibe.ownChat(String(req.query.slug), req.user) : await latest(req.user);
    if (!room) return res.set('Cache-Control', 'private, no-store').json({ chat: null, messages: [] });
    const after = Number(req.query.after) || null;
    const rows = await rooms.history(room, after ? { after, limit: 50 } : { limit: 40 });
    return res.set('Cache-Control', 'private, no-store').json({ chat: chatOf(room), messages: rows.filter((m) => !m.is_deleted).map(wire) });
});

router.post('/ask', asked, async (req, res) => {
    if (req.authSource === 'api_token' || req.authSource === 'dock') return res.status(403).json({ error: 'Vibe is for the person themself' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const message = String(b.message || '').replace(/\r\n/g, '\n').trim();
    if (!message) return res.status(422).json({ error: 'Write something first' });
    if (message.length > 8000) return res.status(422).json({ error: 'That is longer than Vibe reads in one message' });
    const timezone = zone(b.timezone);
    try {
        let room = b.slug ? await vibe.ownChat(String(b.slug), req.user) : null;
        if (!room && !b.fresh) {
            const last = await latest(req.user);
            const moved = last ? Date.parse(at(last.updated_at || last.last_message_at || last.created_at) || 0) : 0;
            if (last && Date.now() - moved < SIX_HOURS) room = last;
        }
        if (!room) {
            const out = await vibe.start(req.user, message, { timezone });
            const full = await vibe.ownChat(out.room.slug, req.user);
            return res.status(201).json({ chat: chatOf(full || out.room), message: wire(out.message) });
        }
        const posted = await rooms.post(room, req.user, message, { timezone });
        try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message: posted }); } catch { /* the socket is optional */ }
        return res.status(201).json({ chat: chatOf(room), message: wire(posted) });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.status ? err.message : 'Your message could not be sent' });
    }
});

module.exports = router;
