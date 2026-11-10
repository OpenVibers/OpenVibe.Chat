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
 *   POST   /:slug/channels              owner/admins: { name, kind: text | voice | forum | stage, community_space?, topic? }
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
const communityForum = require('./community-forum');

const router = express.Router();
const createLimit = limits('chat.server.create', { minute: 5, hour: 20 });
const manageLimit = limits('chat.server.manage', { minute: 30, hour: 300 });
const joinLimit = limits('chat.server.join', { minute: 20, hour: 200 });

function send(res, err) {
    if (err instanceof rooms.RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof communityForum.ForumError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Servers]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const chatServer = () => require('../chat/chat-server');
const roomRoutes = () => require('./routes');
const siteUrl = () => { try { return require('../config').web.baseUrl; } catch { return 'https://openvibe.chat'; } };
const forumToken = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
    return m ? m[1].trim() : req.cookies && req.cookies.ov_token || null;
};
async function forumChannel(req, res, server) {
    const room = await channelOf(req, res, server);
    if (!room) return null;
    if (!room.forum_space) { res.status(404).json({ error: 'No such forum channel', code: 'forum.not_found' }); return null; }
    return room;
}

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
async function stageChannel(req, res, server) {
    const room = await channelOf(req, res, server);
    if (!room) return null;
    if (!room.stage_channel) { res.status(404).json({ error: 'No such stage channel', code: 'stage.not_found' }); return null; }
    return room;
}
async function stageState(room) {
    const session = await require('../db/database').get('SELECT topic, started_at, ended_at FROM chat_stage_sessions WHERE room_id = ?', [room.id]);
    const speakers = await require('../db/database').all('SELECT user_id, hand_raised FROM chat_stage_speakers WHERE room_id = ? ORDER BY hand_raised DESC, updated_at', [room.id]);
    const people = await Promise.all(speakers.map(async (p) => {
        const user = await ctx.getUserById(Number(p.user_id));
        return { user_id: Number(p.user_id), username: user && user.username || null, display_name: user && user.display_name || null, hand_raised: p.hand_raised };
    }));
    return { topic: session && session.topic || null, started_at: session && session.started_at || null, ended_at: session && session.ended_at || null,
        speakers: people.filter((p) => !p.hand_raised), raised_hands: people.filter((p) => p.hand_raised) };
}
async function updateStageAccess(room) {
    await roomRoutes().applyRoomChange(room);
    try { chatServer().broadcastToRoom(room.id, { type: 'stage', room: room.slug, stage: await stageState(room) }); } catch { /* clients can refetch */ }
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
        if (b.kind === 'forum' && req.authSource === 'api_token') return res.status(403).json({ error: 'Connect a forum with your own sign-in', code: 'forum.person_only' });
        if (b.kind === 'forum' && require('../settings').value('forum_channels_enabled', null, false) !== true) return res.status(403).json({ error: 'Forum channels are not enabled', code: 'servers.forum_disabled' });
        if (b.kind === 'forum' && !(await servers.access(server, req.user)).manage) return res.status(403).json({ error: 'Only the server owner and admins add channels', code: 'servers.not_admin' });
        if (b.kind === 'forum') await communityForum.verifyManage(b.community_space, forumToken(req));
        const room = await servers.createChannel(server, req.user, { name: b.name, kind: b.kind || 'text', topic: b.topic, community_space: b.community_space });
        res.status(201).json({ channel: servers.publicChannel(room) });
    } catch (err) { send(res, err); }
});

router.get('/:slug/:channel/forum', optionalAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await forumChannel(req, res, server); if (!room) return;
    try {
        const out = await communityForum.list(room.forum_space, forumToken(req), req.query);
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json(out);
    } catch (err) { send(res, err); }
});
router.get('/:slug/:channel/forum/categories', optionalAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await forumChannel(req, res, server); if (!room) return;
    try { res.set('Cache-Control', cache.htmlHeaders({ private: true })).json(await communityForum.categories(room.forum_space, forumToken(req))); }
    catch (err) { send(res, err); }
});
router.get('/:slug/:channel/forum/:thread', optionalAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await forumChannel(req, res, server); if (!room) return;
    try { res.set('Cache-Control', cache.htmlHeaders({ private: true })).json(await communityForum.thread(room.forum_space, req.params.thread, forumToken(req), { page: req.query.page })); }
    catch (err) { send(res, err); }
});
router.post('/:slug/:channel/forum', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await forumChannel(req, res, server); if (!room) return;
    if (req.authSource === 'api_token') return res.status(403).json({ error: 'Post with your own sign-in', code: 'forum.person_only' });
    try { res.status(201).json(await communityForum.create(room.forum_space, forumToken(req), req.body || {})); }
    catch (err) { send(res, err); }
});
router.post('/:slug/:channel/forum/:thread/replies', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await forumChannel(req, res, server); if (!room) return;
    if (req.authSource === 'api_token') return res.status(403).json({ error: 'Reply with your own sign-in', code: 'forum.person_only' });
    try { res.status(201).json(await communityForum.reply(room.forum_space, req.params.thread, forumToken(req), req.body || {})); }
    catch (err) { send(res, err); }
});
router.put('/:slug/:channel/forum/:thread/state', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await forumChannel(req, res, server); if (!room) return;
    if (req.authSource === 'api_token') return res.status(403).json({ error: 'Moderate with your own sign-in', code: 'forum.person_only' });
    try { res.json(await communityForum.moderate(room.forum_space, req.params.thread, forumToken(req), req.body || {})); }
    catch (err) { send(res, err); }
});
router.get('/:slug/:channel/stage', optionalAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await stageChannel(req, res, server); if (!room) return;
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ stage: await stageState(room), can: canOf(await servers.channelAccess(room, req.user || null)) });
});
router.post('/:slug/:channel/stage/start', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await stageChannel(req, res, server); if (!room) return;
    const can = await servers.access(server, req.user);
    if (!can.moderate) return res.status(403).json({ error: 'Only moderators can start a stage', code: 'stage.not_mod' });
    const db = require('../db/database');
    const topic = String((req.body || {}).topic ?? room.topic ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    await db.run('UPDATE rooms SET topic = ? WHERE id = ?', [topic, room.id]);
    await db.run('UPDATE chat_stage_sessions SET topic = ?, started_at = ov_now(), ended_at = NULL, updated_at = ov_now() WHERE room_id = ?', [topic, room.id]);
    const fresh = await db.get('SELECT * FROM rooms WHERE id = ?', [room.id]);
    await updateStageAccess(fresh);
    res.json({ stage: await stageState(fresh) });
});
router.post('/:slug/:channel/stage/end', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await stageChannel(req, res, server); if (!room) return;
    if (!(await servers.access(server, req.user)).moderate) return res.status(403).json({ error: 'Only moderators can end a stage', code: 'stage.not_mod' });
    const db = require('../db/database');
    await db.run('UPDATE chat_stage_sessions SET ended_at = ov_now(), updated_at = ov_now() WHERE room_id = ?', [room.id]);
    await db.run('DELETE FROM chat_stage_speakers WHERE room_id = ?', [room.id]);
    await updateStageAccess(room);
    res.json({ stage: await stageState(room) });
});
router.post('/:slug/:channel/stage/hand', requireAuth, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await stageChannel(req, res, server); if (!room) return;
    const role = await servers.roleIn(server.id, req.user.id);
    if (!role || role === 'blocked') return res.status(403).json({ error: 'Join the server to raise your hand', code: 'stage.not_member' });
    const db = require('../db/database');
    const row = await db.get('SELECT started_at, ended_at FROM chat_stage_sessions WHERE room_id = ?', [room.id]);
    if (!row || !row.started_at || row.ended_at) return res.status(409).json({ error: 'The stage is not live', code: 'stage.not_live' });
    await db.run('INSERT INTO chat_stage_speakers (room_id, user_id, hand_raised) VALUES (?, ?, TRUE) ON CONFLICT (room_id, user_id) DO UPDATE SET hand_raised = TRUE, updated_at = ov_now()', [room.id, req.user.id]);
    res.json({ stage: await stageState(room) });
});
router.post('/:slug/:channel/stage/invite', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await stageChannel(req, res, server); if (!room) return;
    if (!(await servers.access(server, req.user)).moderate) return res.status(403).json({ error: 'Only moderators can invite speakers', code: 'stage.not_mod' });
    const userId = Number((req.body || {}).user_id);
    const role = await servers.roleIn(server.id, userId);
    if (!Number.isSafeInteger(userId) || !role || role === 'blocked') return res.status(404).json({ error: 'No such server member', code: 'stage.no_member' });
    const db = require('../db/database');
    await db.run('INSERT INTO chat_stage_speakers (room_id, user_id, invited_by, hand_raised) VALUES (?, ?, ?, FALSE) ON CONFLICT (room_id, user_id) DO UPDATE SET invited_by = EXCLUDED.invited_by, hand_raised = FALSE, updated_at = ov_now()', [room.id, userId, req.user.id]);
    await updateStageAccess(room);
    res.json({ stage: await stageState(room) });
});
router.post('/:slug/:channel/stage/move-back', requireAuth, manageLimit, async (req, res) => {
    const server = await readable(req, res); if (!server) return;
    const room = await stageChannel(req, res, server); if (!room) return;
    if (!(await servers.access(server, req.user)).moderate) return res.status(403).json({ error: 'Only moderators can move speakers back', code: 'stage.not_mod' });
    const userId = Number((req.body || {}).user_id);
    const db = require('../db/database');
    const result = await db.run('DELETE FROM chat_stage_speakers WHERE room_id = ? AND user_id = ?', [room.id, userId]);
    if (!result.changes) return res.status(404).json({ error: 'No such stage speaker', code: 'stage.no_speaker' });
    await updateStageAccess(room);
    res.json({ stage: await stageState(room) });
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
