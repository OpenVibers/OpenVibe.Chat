'use strict';
/**
 * /api/chat/servers — servers over REST (server/rooms/servers.js); openvibe.chat and bots use it. A channel is a room,
 * so its messages, history, reads and calls are /api/chat/rooms/<channel.room> and /ws/chat join_room as usual.
 *
 *   GET    /                            public servers by size + the caller's servers (with unread counts)
 *   POST   /                            create { name, slug?, description?, visibility? } (with #general and a voice Lounge)
 *   GET    /:slug                       the server, its channels (members: unread counts), what the caller may do
 *   PATCH  /:slug                       owner/admins: { name?, description?, visibility? } (channels follow it)
 *   DELETE /:slug                       the owner (or chat staff): the server and its channels are archived
 *   POST   /:slug/join                  { invite? }: a public server, or any with a valid invite → { role }
 *   POST   /:slug/leave
 *   GET    /:slug/members               (moderators also see who is banned)
 *   POST   /:slug/members               moderators: { username | subject, role: admin | mod | member | blocked | none }
 *   POST   /:slug/channels              owner/admins: { name, kind: text | voice, topic? }
 *   PATCH  /:slug/channels/:channel     owner/admins: { name?, topic?, slow_seconds?, join_role?, move?: up | down }
 *   DELETE /:slug/channels/:channel     owner/admins (a server keeps one text channel)
 *   GET    /:slug/invites               owner/admins: the live invites
 *   POST   /:slug/invites               { max_uses?, expires_hours? } → { invite: { code, … }, url }
 *   DELETE /:slug/invites/:code
 *   GET    /invites/:code               what an invite opens (anyone with the code): the server's name and size
 *
 * A private server is a 404 to anyone who is not in it, whatever they ask.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { requireAuth, optionalAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const rooms = require('./rooms');
const servers = require('./servers');
const ctx = require('../live-context');

const router = express.Router();
const createLimit = limits('chat.server.create', { minute: 5, hour: 20 });
const manageLimit = limits('chat.server.manage', { minute: 30, hour: 300 });
const joinLimit = limits('chat.server.join', { minute: 20, hour: 200 });

function send(res, err) {
    if (err instanceof rooms.RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Servers]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const chatServer = () => require('../chat/chat-server');
const roomRoutes = () => require('./routes');
const siteUrl = () => { try { return require('../config').web.baseUrl; } catch { return 'https://openvibe.chat'; } };

/** After a membership, role or visibility change: every channel's sockets and calls follow the server. */
async function applyServerChange(server) {
    for (const r of await require('../db/database').all('SELECT * FROM rooms WHERE server_id = ? AND archived_at IS NULL', [server.id])) {
        try { await roomRoutes().applyRoomChange(r); } catch (err) { console.warn('[Servers] room update:', err.message); }
    }
}

async function readable(req, res) {
    const server = await servers.bySlug(req.params.slug);
    if (!server || !(await servers.access(server, req.user || null)).read) { res.status(404).json({ error: 'No such server', code: 'servers.not_found' }); return null; }
    return server;
}
async function channelOf(req, res, server) {
    const room = await servers.channelBySlug(server, req.params.channel);
    if (!room) { res.status(404).json({ error: 'No such channel', code: 'servers.no_channel' }); return null; }
    return room;
}
const canOf = (a) => ({ read: a.read, member: a.member, moderate: a.moderate, manage: a.manage, owner: a.owner });

router.get('/', optionalAuth, async (req, res) => {
    try { res.set('Cache-Control', cache.htmlHeaders({ private: true })).json(await servers.list(req.user || null, { limit: req.query.limit })); } catch (err) { send(res, err); }
});

router.post('/', requireAuth, createLimit, async (req, res) => {
    try { res.status(201).json({ server: await servers.create(req.user, req.body || {}) }); } catch (err) { send(res, err); }
});

router.get('/invites/:code', optionalAuth, async (req, res) => {
    const found = await servers.inviteByCode(req.params.code);
    if (!found) return res.status(404).json({ error: 'That invite has expired or was used up', code: 'servers.invite_invalid' });
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ server: servers.publicServer(found.server), invite: { code: found.invite.code, expires_at: found.invite.expires_at || null } });
});

router.get('/:slug', optionalAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const a = await servers.access(server, req.user || null);
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({
        server: servers.publicServer(server, { role: a.role }),
        channels: await servers.channels(server, a.member ? req.user : null),
        can: canOf(a),
    });
});

router.patch('/:slug', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try { const out = await servers.update(server, req.user, req.body || {}); await applyServerChange(out); res.json({ server: servers.publicServer(out) }); } catch (err) { send(res, err); }
});

router.delete('/:slug', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try { await servers.archive(server, req.user); await applyServerChange(server); res.status(204).end(); } catch (err) { send(res, err); }
});

router.post('/:slug/join', requireAuth, joinLimit, async (req, res) => {
    const server = await servers.bySlug(req.params.slug);
    if (!server) return res.status(404).json({ error: 'No such server', code: 'servers.not_found' });
    try { const role = await servers.join(server, req.user, { invite: req.body && req.body.invite }); await applyServerChange(server); res.json({ ok: true, role }); } catch (err) { send(res, err); }
});

router.post('/:slug/leave', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try { await servers.leave(server, req.user); await applyServerChange(server); res.json({ ok: true }); } catch (err) { send(res, err); }
});

router.get('/:slug/members', optionalAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const a = await servers.access(server, req.user || null);
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ members: await servers.members(server, { blocked: a.moderate }) });
});

router.post('/:slug/members', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try {
        const name = String((req.body && req.body.username) || '').trim();
        const subject = String((req.body && req.body.subject) || '').replace(/^user:/, '').trim();
        let target = null;
        if (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) target = await ctx.getUserBySubject(subject);
        else if (/^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.getUserByUsername(name) || await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.status(404).json({ error: subject ? 'No such OpenVibe account' : `Nobody called ${name.slice(0, 24)} on OpenVibe`, code: 'servers.no_user' });
        const role = await servers.setRole(server, req.user, target.id, String((req.body && req.body.role) || 'member'));
        if (role === 'blocked' || role == null) {
            for (const r of await require('../db/database').all('SELECT id FROM rooms WHERE server_id = ?', [server.id])) chatServer().removeFromRoom(r.id, target.id);
        }
        await applyServerChange(server);
        res.json({ ok: true, user_id: target.id, username: target.username, role });
    } catch (err) { send(res, err); }
});

router.post('/:slug/channels', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try {
        const b = req.body || {};
        const room = await servers.createChannel(server, req.user, { name: b.name, kind: b.kind || 'text', topic: b.topic });
        res.status(201).json({ channel: servers.publicChannel(room) });
    } catch (err) { send(res, err); }
});

router.patch('/:slug/channels/:channel', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await channelOf(req, res, server); if (!room) return;
    try {
        const out = await servers.updateChannel(server, req.user, room, req.body || {});
        await roomRoutes().applyRoomChange(out);
        res.json({ channel: servers.publicChannel(out) });
    } catch (err) { send(res, err); }
});

router.delete('/:slug/channels/:channel', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await channelOf(req, res, server); if (!room) return;
    try { await servers.deleteChannel(server, req.user, room); res.status(204).end(); } catch (err) { send(res, err); }
});

router.get('/:slug/invites', requireAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const a = await servers.access(server, req.user);
    if (!a.moderate) return res.status(403).json({ error: 'Only the server\'s owner, admins and moderators see its invites', code: 'servers.not_mod' });
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ invites: await servers.invites(server) });
});

router.post('/:slug/invites', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try {
        const invite = await servers.createInvite(server, req.user, req.body || {});
        res.status(201).json({ invite, url: `${siteUrl()}/join/${invite.code}` });
    } catch (err) { send(res, err); }
});

router.delete('/:slug/invites/:code', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    try { await servers.revokeInvite(server, req.user, req.params.code); res.status(204).end(); } catch (err) { send(res, err); }
});

module.exports = router;
module.exports.applyServerChange = applyServerChange;
