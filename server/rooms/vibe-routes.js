'use strict';
/**
 * /api/chat/vibe — a person's chats with Vibe, OpenVibe's assistant (server/rooms/vibe.js). A chat is a private room,
 * so its messages, pictures and live delivery are the rooms API and socket (/api/chat/rooms/:slug/…, join_room).
 *
 *   GET    /           { chats: [{ slug, name, last_message_at, created_at }], allowance: { per_day, used_today }, enabled }
 *   POST   /           { message } → 201 { room, message }: a new chat with its first message (Vibe answers over the socket)
 *   POST   /picture    the body is a picture (Content-Type image/*), an optional question in X-Caption (URI-encoded) →
 *                      201 { room, message, picture }: a new chat that starts with it (it goes to OpenVibe.Pics as the
 *                      person, like a room's picture), and Vibe answers seeing it
 *   GET    /:slug/how  { how: { <message id>: { lines, sources, actor_url } } }: "How Vibe did this" for the agent tasks
 *                      answered in the chat (server/rooms/how.js)
 *   PATCH  /:slug      { name } → { room }
 *   DELETE /:slug      204: the chat and its messages are deleted
 *   POST   /:slug/retry  202 { removed }: Vibe's last answer goes and it answers the person's last message anew (409
 *                      when the last two messages are not that exchange)
 *   POST   /:slug/stop  202 { stopped }: the answer being written stops; what was written stays, marked as stopped
 *   GET    /memory     { on, notes: [{ id, text, source, created_at }], max }: what Vibe remembers about the person
 *                      (server/rooms/vibe-memory.js)
 *   POST   /memory     { text } → 201 { note } (a note of their own), 422 when it is empty, too long, secret-looking,
 *                      already there, or memory is full
 *   PUT    /memory/switch  { on } → { on }: with it off Vibe neither reads nor saves notes
 *   DELETE /memory/:id 204, 404 when it is not theirs
 *   DELETE /memory     { deleted }: every note goes
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const config = require('../config');
const { requireAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const rooms = require('./rooms');
const vibe = require('./vibe');
const how = require('./how');
const memory = require('./vibe-memory');

const router = express.Router();
const startLimit = limits('chat.vibe.start', { minute: 10, hour: 120 });
const manageLimit = limits('chat.vibe.manage', { minute: 30, hour: 300 });

function send(res, err) {
    if (err instanceof vibe.VibeError || err instanceof rooms.RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Vibe]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
/** Vibe speaks for nobody but the person signed in: API tokens get the rooms API instead. */
const personOnly = (req, res, next) => (req.authSource === 'api_token' ? res.status(403).json({ error: 'Chat with Vibe with your own sign-in', code: 'vibe.person_only' }) : next());

router.get('/', requireAuth, personOnly, async (req, res) => {
    try {
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({
            chats: await vibe.list(req.user, { limit: req.query.limit }),
            allowance: { per_day: config.ai.vibeRepliesPerDay, used_today: await vibe.repliesToday(req.user) },
            enabled: vibe.enabled(),
        });
    } catch (err) { send(res, err); }
});

const modeOf = (b) => (b && b.mode && b.mode !== 'chat' ? String(b.mode) : null);
router.post('/', requireAuth, personOnly, startLimit, async (req, res) => {
    try {
        const b = req.body || {};
        const out = modeOf(b) ? await vibe.startWork(req.user, b.message, modeOf(b)) : await vibe.start(req.user, b.message);
        res.status(201).json(out);
    } catch (err) { send(res, err); }
});

/** A Research, Agent or Code request in an existing chat: { message, mode }. → { message, task } */
router.post('/:slug/ask', requireAuth, personOnly, startLimit, async (req, res) => {
    try {
        const room = await vibe.ownChat(req.params.slug, req.user);
        if (!room) return res.status(404).json({ error: 'No such chat', code: 'rooms.not_found' });
        res.status(201).json(await vibe.work(room, req.user, req.body && req.body.message, req.body && req.body.mode));
    } catch (err) { send(res, err); }
});

const pictureLimit = limits('chat.vibe.picture', { minute: 10, hour: 120 });
const bearerOf = (req) => { const m = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || '')); return m ? m[1].trim() : (req.cookies && req.cookies.ov_token) || null; };
router.post('/picture', requireAuth, personOnly, pictureLimit, (req, res, next) => express.raw({ type: () => true, limit: (config.pics.maxBytes || 20 * 1024 * 1024) + 1 })(req, res, (err) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That picture is too large', code: 'pictures.too_large' });
    return next(err);
}), async (req, res) => {
    let room = null;
    try {
        const caption = (() => { try { return decodeURIComponent(String(req.get('x-caption') || '')).slice(0, 500); } catch { return ''; } })();
        room = await vibe.createRoom(req.user, caption || 'A picture');
        const out = await require('./routes').postPicture(room, req.user, { token: bearerOf(req), buffer: Buffer.isBuffer(req.body) ? req.body : null, contentType: req.get('content-type'), caption, ip: req.ip });
        res.status(201).json({ room: await rooms.publicRoom(room, { role: 'owner' }), ...out });
    } catch (err) {
        if (room) await vibe.erase(room.id).catch(() => {});   // a picture Pics refused leaves no empty chat behind
        send(res, err);
    }
});

// Memory, registered before /:slug (a chat's slug always starts with v-, so the two never meet).
router.get('/memory', requireAuth, personOnly, async (req, res) => {
    try {
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ on: await memory.isOn(req.user), notes: await memory.list(req.user), max: memory.MAX_NOTES });
    } catch (err) { send(res, err); }
});
router.post('/memory', requireAuth, personOnly, manageLimit, async (req, res) => {
    try {
        const out = await memory.add(req.user, req.body && req.body.text, { source: 'you' });
        if (out.error) return res.status(422).json({ error: out.error, code: 'vibe.memory_refused' });
        res.status(201).json(out);
    } catch (err) { send(res, err); }
});
router.put('/memory/switch', requireAuth, personOnly, manageLimit, async (req, res) => {
    try {
        const on = req.body && req.body.on;
        if (typeof on !== 'boolean') return res.status(422).json({ error: 'Send { "on": true } or { "on": false }', code: 'vibe.memory_switch' });
        res.json({ on: await memory.setOn(req.user, on) });
    } catch (err) { send(res, err); }
});
router.delete('/memory/:id', requireAuth, personOnly, manageLimit, async (req, res) => {
    try {
        if (!(await memory.remove(req.user, req.params.id))) return res.status(404).json({ error: 'No such note', code: 'vibe.memory_not_found' });
        res.status(204).end();
    } catch (err) { send(res, err); }
});
router.delete('/memory', requireAuth, personOnly, manageLimit, async (req, res) => {
    try { res.json({ deleted: await memory.clear(req.user) }); } catch (err) { send(res, err); }
});

router.get('/:slug/how', requireAuth, personOnly, async (req, res) => {
    try {
        const room = await vibe.ownChat(req.params.slug, req.user);
        if (!room) return res.status(404).json({ error: 'No such chat', code: 'vibe.not_found' });
        return res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ how: Object.fromEntries(await how.forRoom(room)) });
    } catch (err) { return send(res, err); }
});

router.post('/:slug/retry', requireAuth, personOnly, startLimit, async (req, res) => {
    try {
        const room = await vibe.ownChat(req.params.slug, req.user);
        if (!room) return res.status(404).json({ error: 'No such chat', code: 'rooms.not_found' });
        res.status(202).json(await vibe.retry(room, req.user));
    } catch (err) { send(res, err); }
});

router.post('/:slug/stop', requireAuth, personOnly, manageLimit, async (req, res) => {
    try {
        const room = await vibe.ownChat(req.params.slug, req.user);
        if (!room) return res.status(404).json({ error: 'No such chat', code: 'rooms.not_found' });
        res.status(202).json({ stopped: require('./ai-members').stop(room.id) });
    } catch (err) { send(res, err); }
});

router.patch('/:slug', requireAuth, personOnly, manageLimit, async (req, res) => {
    try {
        const room = await vibe.ownChat(req.params.slug, req.user);
        if (!room) return res.status(404).json({ error: 'No such chat', code: 'rooms.not_found' });
        res.json({ room: await vibe.rename(room, req.user, req.body && req.body.name) });
    } catch (err) { send(res, err); }
});

router.delete('/:slug', requireAuth, personOnly, manageLimit, async (req, res) => {
    try {
        const room = await vibe.ownChat(req.params.slug, req.user);
        if (!room) return res.status(404).json({ error: 'No such chat', code: 'rooms.not_found' });
        await vibe.remove(room, req.user);
        res.status(204).end();
    } catch (err) { send(res, err); }
});

module.exports = router;
