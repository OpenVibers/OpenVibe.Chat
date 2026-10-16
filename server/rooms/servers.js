'use strict';
/**
 * Servers (migration 0013; owner 2026-09-28 Q14: friend groups and couples first, then communities with servers,
 * channels and voice). A server is a group of rooms, its channels, with one membership and one set of roles:
 *
 *   chat_servers         slug (/s/<slug>), name, description, visibility (public: listed, anyone reads, signed-in
 *                        people join; private: only people with an invite), owner
 *   chat_server_members  role: owner (the creator, one), admin, mod, member, blocked (banned from the server)
 *   chat_server_invites  /join/<code>: any number of uses or a cap, never expiring or after a while, revocable
 *   rooms.server_id      a channel: a text channel is a community room, a voice channel a call room (its call is
 *                        the room's call, so voice works like any call room: who talks follows the role)
 *
 * What a person may do in a channel comes from the server (channelAccess, which rooms.access() calls for any room
 * with a server): the room's own room_members rows only keep where each person read up to.
 *
 *   server role   read  post  voice: talk                 moderate (delete, kick, ban)   manage (channels, settings, invites)
 *   owner         yes   yes   yes                         yes                            yes, and appoints admins
 *   admin         yes   yes   yes                         yes                            yes, and appoints mods
 *   mod           yes   yes   yes                         yes (members only)             -
 *   member        yes   yes   as the channel says (speakers by default)  -                -
 *   none          public server: read and listen; private server: nothing, not even that it exists
 *   blocked       nothing
 *   chat staff (staff.moderation.chat): read, moderate and manage every server; a site ban: no posting, no talking
 *
 * Every action on another person is logged with db.logModerationAction (scope server:<slug>).
 */
const crypto = require('crypto');
const db = require('../db/database');
const ctx = require('../live-context');
const wordFilter = require('../chat/word-filter');
const rooms = require('./rooms');

const { RoomError } = rooms;
const fail = (status, code, message) => { throw new RoomError(status, code, message); };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(['new', 'servers', 'settings', 'join', 'invite', 'invites', 'api', 'admin', 'staff', 'help', 'explore', 'discover', 'openvibe']);
const ROLES = ['owner', 'admin', 'mod', 'member', 'blocked'];
const RANK = { owner: 0, admin: 1, mod: 2, member: 3, blocked: 4 };
const CHANNEL_KINDS = { text: 'community', voice: 'call' };
/** Channel names the server's own pages use (/s/<server>/settings …). */
const CHANNEL_RESERVED = new Set(['settings', 'join', 'leave', 'channels', 'invites', 'members', 'delete']);
const MAX_SERVERS_PER_OWNER = 5;
const MAX_CHANNELS = 50;
const MAX_INVITES = 25;
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const isStaff = (user) => rooms.isStaff(user);

function slugify(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}
const cleanName = (v, min, max) => {
    const n = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return n.length >= min && n.length <= max ? n : null;
};
const randomCode = (n) => Array.from(crypto.randomBytes(n), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');

async function bySlug(slug) { return await db.get('SELECT * FROM chat_servers WHERE slug = ? AND archived_at IS NULL', [String(slug || '').toLowerCase()]) || null; }
async function byId(id) { return await db.get('SELECT * FROM chat_servers WHERE id = ? AND archived_at IS NULL', [Number(id)]) || null; }
async function roleIn(serverId, userId) {
    if (!userId) return null;
    return (await db.get('SELECT role FROM chat_server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]) || {}).role || null;
}

/** What `user` may do in the server itself: { role, read, member, moderate, manage, owner }. */
async function access(server, user) {
    const role = user ? await roleIn(server.id, user.id) : null;
    const staff = isStaff(user);
    const blocked = role === 'blocked';
    const member = !!role && !blocked;
    return {
        role, member, staff,
        read: !blocked && (server.visibility === 'public' || member || staff),
        moderate: !!user && !blocked && (['owner', 'admin', 'mod'].includes(role) || staff),
        manage: !!user && !blocked && (['owner', 'admin'].includes(role) || staff),
        owner: !!user && role === 'owner',
    };
}

/**
 * What `user` may do in a channel (a room with server_id): the room's access shape (rooms.access), decided by the
 * server role. A channel of a server that is gone reads as nothing.
 */
async function channelAccess(room, user) {
    const kind = room.kind === 'call' ? 'call' : 'community';
    const server = await byId(room.server_id);
    if (!server) return { role: null, kind, read: false, post: false, join: false, talk: false, moderate: false, manage: false, server: null, server_role: null };
    const a = await access(server, user);
    const srole = a.role;
    // Server owner → room owner; admins and moderators → room moderators; members → the channel's member role.
    const vrole = !a.member ? null : srole === 'owner' ? 'owner' : RANK[srole] <= RANK.mod ? 'mod' : kind === 'call' ? rooms.joinRoleOf(room) : 'member';
    const banned = rooms.siteBanned(user);
    const post = !!user && a.read && !banned && a.member && rooms.POSTERS[kind].has(vrole);
    const join = kind === 'call' && a.read;
    const talk = join && !!user && !banned && ((a.member && rooms.TALKERS.has(vrole)) || a.staff);
    return { role: vrole, kind, read: a.read, post, join, talk, moderate: a.moderate, manage: a.manage, server: server.slug, server_role: srole };
}

function publicServer(s, extra = {}) {
    if (!s) return null;
    return {
        id: Number(s.id), slug: s.slug, name: s.name, description: s.description || null, visibility: s.visibility,
        members: Number(s.member_count) || 0, created_at: s.created_at, ...extra,
    };
}

/** A channel as the server shows it. */
function publicChannel(r, extra = {}) {
    return {
        slug: r.channel_slug, room: r.slug, name: r.name, topic: r.topic || null, kind: r.kind === 'call' ? 'voice' : 'text',
        position: Number(r.position) || 0, message_count: Number(r.message_count) || 0, last_message_at: r.last_message_at || null,
        ...(r.kind === 'call' ? { call_channel: `room-${r.slug}`, join_role: rooms.joinRoleOf(r) } : {}), ...extra,
    };
}

/** The server's channels, text first, each kind in its order. `user` adds unread counts (members). */
async function channels(server, user = null) {
    const rows = await db.all(`SELECT r.* ${user ? ', m.last_read_id' : ''} FROM rooms r
        ${user ? 'LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = ?' : ''}
        WHERE r.server_id = ? AND r.archived_at IS NULL ORDER BY CASE r.kind WHEN 'call' THEN 1 ELSE 0 END, r.position, r.id`,
    user ? [user.id, server.id] : [server.id]);
    if (!user) return rows.map((r) => publicChannel(r));
    const out = [];
    for (const r of rows) {
        const unread = r.kind === 'call' && !r.message_count ? 0 : Number((await db.get(
            'SELECT COUNT(*) AS n FROM room_messages WHERE room_id = ? AND id > ? AND is_deleted = 0 AND user_id != ?', [r.id, Number(r.last_read_id) || 0, user.id]) || {}).n) || 0;
        out.push(publicChannel(r, { unread: r.last_read_id == null ? Math.min(unread, 99) : unread }));
    }
    return out;
}
async function channelBySlug(server, channelSlug) {
    return await db.get('SELECT * FROM rooms WHERE server_id = ? AND channel_slug = ? AND archived_at IS NULL', [server.id, String(channelSlug || '').toLowerCase()]) || null;
}

async function insertChannel(server, user, { name, kind, topic = null, position = null }) {
    const n = cleanName(name, 1, 40);
    if (!n) fail(422, 'servers.channel_name', 'Channel names are 1 to 40 characters');
    if (wordFilter.check(n).safe === false) fail(422, 'servers.channel_name_filtered', 'That channel name is not allowed');
    const roomKind = CHANNEL_KINDS[kind];
    if (!roomKind) fail(422, 'servers.channel_kind', 'A channel is text or voice');
    const count = Number((await db.get('SELECT COUNT(*) AS n FROM rooms WHERE server_id = ? AND archived_at IS NULL', [server.id]) || {}).n) || 0;
    if (count >= MAX_CHANNELS) fail(429, 'servers.too_many_channels', `A server has up to ${MAX_CHANNELS} channels`);
    let cs = slugify(n) || (kind === 'voice' ? 'voice' : 'chat');
    if (cs.length < 2 || CHANNEL_RESERVED.has(cs)) cs = `${cs}-${kind}`;
    for (let i = 2; await channelBySlug(server, cs); i++) cs = `${slugify(n).slice(0, 28) || kind}-${i}`;
    let roomSlug;
    do { roomSlug = `ch${randomCode(12)}`; } while (await db.get('SELECT 1 FROM rooms WHERE slug = ?', [roomSlug]));
    const pos = position != null ? position : Number((await db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rooms WHERE server_id = ? AND kind = ?', [server.id, roomKind]) || {}).p) || 0;
    const t = topic ? String(topic).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
    // The server owns its channels: owner_subject stays empty, so a person's own-room tools never act on one.
    const r = await db.run(`INSERT INTO rooms (slug, name, topic, kind, visibility, owner_id, owner_subject, join_role, server_id, channel_slug, position)
                            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [roomSlug, n, t, roomKind, server.visibility, server.owner_id, roomKind === 'call' ? 'speaker' : null, server.id, cs, pos]);
    return await db.get('SELECT * FROM rooms WHERE id = ?', [r.lastInsertRowid]);
}

async function create(user, { name, slug, description, visibility = 'public' } = {}) {
    if (!user) fail(401, 'servers.sign_in', 'Sign in to create a server');
    if (rooms.siteBanned(user)) fail(403, 'servers.banned', 'Your account is banned from chat');
    const n = cleanName(name, 2, 40);
    if (!n) fail(422, 'servers.name', 'Server names are 2 to 40 characters');
    if (wordFilter.check(n).safe === false) fail(422, 'servers.name_filtered', 'That server name is not allowed');
    const s = slug ? String(slug).toLowerCase().trim() : slugify(n);
    if (!SLUG_RE.test(s) || RESERVED.has(s)) fail(422, 'servers.slug', 'Server addresses are 3 to 32 lowercase letters, numbers and dashes (and not a reserved word)');
    if (!['public', 'private'].includes(visibility)) fail(422, 'servers.visibility', 'A server is public or private');
    const d = description ? String(description).replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
    if (d && wordFilter.check(d).safe === false) fail(422, 'servers.description_filtered', 'That description is not allowed');
    const owned = Number((await db.get('SELECT COUNT(*) AS n FROM chat_servers WHERE owner_id = ? AND archived_at IS NULL', [user.id]) || {}).n) || 0;
    if (owned >= MAX_SERVERS_PER_OWNER && !isStaff(user)) fail(429, 'servers.too_many', `You can own up to ${MAX_SERVERS_PER_OWNER} servers`);
    if (await db.get('SELECT 1 FROM chat_servers WHERE slug = ?', [s])) fail(409, 'servers.taken', 'That server address is taken');
    const id = await db.tx(async () => {
        const r = await db.run('INSERT INTO chat_servers (slug, name, description, visibility, owner_id, owner_subject, member_count) VALUES (?, ?, ?, ?, ?, ?, 1)',
            [s, n, d, visibility, user.id, user.subject_id || null]);
        const server = await db.get('SELECT * FROM chat_servers WHERE id = ?', [r.lastInsertRowid]);
        await db.run("INSERT INTO chat_server_members (server_id, user_id, role) VALUES (?, ?, 'owner')", [server.id, user.id]);
        await insertChannel(server, user, { name: 'general', kind: 'text', topic: 'Say hello', position: 0 });
        await insertChannel(server, user, { name: 'Lounge', kind: 'voice', position: 0 });
        await db.run("INSERT INTO room_members (room_id, user_id, role, last_read_id, last_seen_at) SELECT id, ?, 'member', 0, ov_now() FROM rooms WHERE server_id = ?", [user.id, server.id]);
        return Number(server.id);
    });
    return publicServer(await byId(id), { role: 'owner' });
}

/** The servers `user` is in (with unread counts), and public servers by size. */
async function list(user, { limit = 50 } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const pub = (await db.all("SELECT * FROM chat_servers WHERE visibility = 'public' AND archived_at IS NULL ORDER BY member_count DESC, id DESC LIMIT ?", [lim])).map((s) => publicServer(s));
    if (!user) return { public: pub, mine: [] };
    const rows = await db.all(`SELECT s.*, m.role FROM chat_server_members m JOIN chat_servers s ON s.id = m.server_id
        WHERE m.user_id = ? AND m.role != 'blocked' AND s.archived_at IS NULL ORDER BY m.joined_at, s.id`, [user.id]);
    const mine = [];
    for (const s of rows) {
        const unread = Number((await db.get(`SELECT COUNT(*) AS n FROM rooms r JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
            JOIN room_messages x ON x.room_id = r.id AND x.id > rm.last_read_id AND x.is_deleted = 0 AND x.user_id != ?
            WHERE r.server_id = ? AND r.archived_at IS NULL`, [user.id, user.id, s.id]) || {}).n) || 0;
        mine.push(publicServer(s, { role: s.role, unread }));
    }
    return { public: pub, mine };
}

async function syncCount(server) {
    await db.run("UPDATE chat_servers SET member_count = (SELECT COUNT(*) FROM chat_server_members WHERE server_id = ? AND role != 'blocked'), updated_at = ov_now() WHERE id = ?", [server.id, server.id]);
}

/** A valid invite by its code (with its server), or null. */
async function inviteByCode(code) {
    const c = String(code || '').toLowerCase();
    if (!/^[a-z0-9]{6,16}$/.test(c)) return null;
    const inv = await db.get('SELECT * FROM chat_server_invites WHERE code = ? AND revoked_at IS NULL', [c]);
    if (!inv) return null;
    if (inv.expires_at && Date.parse(inv.expires_at) <= Date.now()) return null;
    if (inv.max_uses != null && inv.uses >= inv.max_uses) return null;
    const server = await byId(inv.server_id);
    return server ? { invite: inv, server } : null;
}

/** Join: a public server, or any server with a valid invite. → the caller's role. */
async function join(server, user, { invite = null } = {}) {
    if (!user) fail(401, 'servers.sign_in', 'Sign in to join a server');
    const role = await roleIn(server.id, user.id);
    if (role === 'blocked') fail(403, 'servers.blocked', 'You are banned from this server');
    if (role) return role;
    let inv = null;
    if (invite) {
        const found = await inviteByCode(invite);
        if (!found || Number(found.server.id) !== Number(server.id)) fail(410, 'servers.invite_invalid', 'That invite has expired or was used up');
        inv = found.invite;
    }
    // A private server is not there for someone without an invite (the same answer as a missing one).
    if (server.visibility !== 'public' && !inv && !isStaff(user)) fail(404, 'servers.not_found', 'No such server');
    await db.tx(async () => {
        await db.run("INSERT INTO chat_server_members (server_id, user_id, role) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING", [server.id, user.id]);
        // Everything already in the channels counts as read: a new member starts with nothing unread.
        await db.run(`INSERT INTO room_members (room_id, user_id, role, last_read_id, last_seen_at)
                      SELECT r.id, ?, 'member', COALESCE((SELECT MAX(x.id) FROM room_messages x WHERE x.room_id = r.id), 0), ov_now()
                        FROM rooms r WHERE r.server_id = ? AND r.archived_at IS NULL
                      ON CONFLICT (room_id, user_id) DO NOTHING`, [user.id, server.id]);
        if (inv) await db.run('UPDATE chat_server_invites SET uses = uses + 1 WHERE code = ?', [inv.code]);
        await syncCount(server);
    });
    return 'member';
}

async function dropFromChannels(server, userId) {
    await db.run('DELETE FROM room_members WHERE user_id = ? AND room_id IN (SELECT id FROM rooms WHERE server_id = ?)', [userId, server.id]);
}

async function leave(server, user) {
    const role = await roleIn(server.id, user && user.id);
    if (role === 'owner') fail(409, 'servers.owner_leaves', 'The owner cannot leave their server');
    if (!role || role === 'blocked') return;
    await db.tx(async () => {
        await db.run('DELETE FROM chat_server_members WHERE server_id = ? AND user_id = ?', [server.id, user.id]);
        await dropFromChannels(server, user.id);
        await syncCount(server);
    });
}

/**
 * Change someone's role: admin, mod, member, blocked (a ban) or none (kick). The owner appoints and removes admins;
 * admins appoint mods; mods kick and ban members. Nobody acts on someone of their own rank or above, and nobody
 * changes the owner.
 */
async function setRole(server, actor, targetUserId, role) {
    if (!ROLES.includes(role) && role !== 'none') fail(422, 'servers.role', 'Unknown role');
    if (role === 'owner') fail(422, 'servers.role', 'A server has one owner');
    const a = await access(server, actor);
    if (!a.moderate) fail(403, 'servers.not_mod', 'Only the server\'s owner, admins and moderators manage members');
    const target = await ctx.getUserById(Number(targetUserId));
    if (!target) fail(404, 'servers.no_user', 'No such person');
    const current = await roleIn(server.id, target.id);
    if (current === 'owner') fail(403, 'servers.owner', 'The owner\'s role does not change');
    const mine = a.staff ? -1 : RANK[a.role];
    const need = (r) => (r === 'admin' ? RANK.owner : r === 'mod' ? RANK.admin : RANK.mod);
    const RANK_REFUSAL = { admin: 'Only the owner appoints admins', mod: 'Only the owner and admins appoint moderators' };
    if (mine > need(role === 'none' || role === 'blocked' || role === 'member' ? 'member' : role)) fail(403, 'servers.rank', RANK_REFUSAL[role] || 'Only the owner, admins and moderators manage members');
    if (current && current !== 'blocked' && current !== 'member' && mine >= RANK[current]) fail(403, 'servers.rank', 'You cannot change someone of your own rank or above');
    if (!current && role !== 'blocked' && role !== 'none' && server.visibility !== 'public' && !a.manage) fail(403, 'servers.invite_first', 'Invite them first');
    await db.tx(async () => {
        if (role === 'none') {
            if (current && current !== 'blocked') { await db.run('DELETE FROM chat_server_members WHERE server_id = ? AND user_id = ?', [server.id, target.id]); await dropFromChannels(server, target.id); }
            else if (current === 'blocked') await db.run('DELETE FROM chat_server_members WHERE server_id = ? AND user_id = ?', [server.id, target.id]);
        } else if (current) {
            await db.run('UPDATE chat_server_members SET role = ? WHERE server_id = ? AND user_id = ?', [role, server.id, target.id]);
            if (role === 'blocked') await dropFromChannels(server, target.id);
        } else {
            await db.run('INSERT INTO chat_server_members (server_id, user_id, role) VALUES (?, ?, ?)', [server.id, target.id, role]);
        }
        await syncCount(server);
    });
    const action = role === 'blocked' && current !== 'blocked' ? 'server_ban'
        : current === 'blocked' && role !== 'blocked' ? 'server_unban'
            : role === 'none' && current ? 'server_kick'
                : role !== current ? `server_role_${role}` : null;
    if (action) await db.logModerationAction({ scope_type: 'server', scope_id: server.slug, actor_user_id: actor.id, target_user_id: target.id, action_type: action, details: { from: current, to: role } });
    return role === 'none' ? null : role;
}

/** The server's people by rank (blocked last, only for moderators). */
async function members(server, { blocked = false, limit = 1000 } = {}) {
    const order = `CASE m.role ${Object.entries(RANK).map(([r, n]) => `WHEN '${r}' THEN ${n}`).join(' ')} ELSE 9 END`;
    return await db.all(`SELECT m.user_id, m.role, m.joined_at, u.username, u.display_name, u.profile_color FROM chat_server_members m
        LEFT JOIN ctx_users u ON u.id = m.user_id WHERE m.server_id = ? ${blocked ? '' : "AND m.role != 'blocked'"}
        ORDER BY ${order}, lower(u.username) LIMIT ?`, [server.id, Math.min(5000, Math.max(1, Number(limit) || 1000))]);
}

async function update(server, actor, { name, description, visibility } = {}) {
    if (!(await access(server, actor)).manage) fail(403, 'servers.not_admin', 'Only the server\'s owner and admins change it');
    const next = { name: server.name, description: server.description, visibility: server.visibility };
    if (name != null) { const n = cleanName(name, 2, 40); if (!n || wordFilter.check(n).safe === false) fail(422, 'servers.name', 'Server names are 2 to 40 characters'); next.name = n; }
    if (description != null) next.description = String(description).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
    if (visibility != null) { if (!['public', 'private'].includes(visibility)) fail(422, 'servers.visibility', 'A server is public or private'); next.visibility = visibility; }
    await db.run('UPDATE chat_servers SET name = ?, description = ?, visibility = ?, updated_at = ov_now() WHERE id = ?', [next.name, next.description, next.visibility, server.id]);
    // The channels follow the server: going private redacts what public channels had published (rooms.update).
    if (next.visibility !== server.visibility) {
        for (const r of await db.all('SELECT * FROM rooms WHERE server_id = ? AND archived_at IS NULL', [server.id])) {
            await rooms.update(r, actor, { visibility: next.visibility }, { fromServer: true });
        }
    }
    return await byId(server.id);
}

async function createChannel(server, actor, { name, kind = 'text', topic = null } = {}) {
    if (!(await access(server, actor)).manage) fail(403, 'servers.not_admin', 'Only the server\'s owner and admins add channels');
    const room = await insertChannel(server, actor, { name, kind, topic });
    // Every member reads the new channel from its first message on.
    await db.run(`INSERT INTO room_members (room_id, user_id, role, last_read_id, last_seen_at)
                  SELECT ?, user_id, 'member', 0, NULL FROM chat_server_members WHERE server_id = ? AND role != 'blocked'
                  ON CONFLICT (room_id, user_id) DO NOTHING`, [room.id, server.id]);
    return room;
}

/** Rename, retopic, slow mode, a voice channel's join role, or move it up/down within its kind. */
async function updateChannel(server, actor, room, { name, topic, slow_seconds, join_role, move } = {}) {
    if (!(await access(server, actor)).manage) fail(403, 'servers.not_admin', 'Only the server\'s owner and admins change channels');
    if (Number(room.server_id) !== Number(server.id)) fail(404, 'servers.no_channel', 'No such channel');
    if (name != null) {
        const n = cleanName(name, 1, 40);
        if (!n || wordFilter.check(n).safe === false) fail(422, 'servers.channel_name', 'Channel names are 1 to 40 characters');
    }
    await rooms.update(room, actor, { name: name != null ? name : null, topic, slow_seconds, join_role }, { fromServer: true, minName: 1 });
    if (move === 'up' || move === 'down') {
        const siblings = await db.all('SELECT id, position FROM rooms WHERE server_id = ? AND kind = ? AND archived_at IS NULL ORDER BY position, id', [server.id, room.kind]);
        const i = siblings.findIndex((x) => Number(x.id) === Number(room.id));
        const j = move === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < siblings.length) {
            const order = siblings.map((x) => x.id);
            [order[i], order[j]] = [order[j], order[i]];
            await db.tx(async () => { for (let k = 0; k < order.length; k++) await db.run('UPDATE rooms SET position = ? WHERE id = ?', [k, order[k]]); });
        }
    }
    return await db.get('SELECT * FROM rooms WHERE id = ?', [room.id]);
}

/** Delete a channel (archived: its page goes, its messages stay for moderation). A server keeps one text channel. */
async function deleteChannel(server, actor, room) {
    if (!(await access(server, actor)).manage) fail(403, 'servers.not_admin', 'Only the server\'s owner and admins delete channels');
    if (Number(room.server_id) !== Number(server.id)) fail(404, 'servers.no_channel', 'No such channel');
    if (room.kind !== 'call') {
        const texts = Number((await db.get("SELECT COUNT(*) AS n FROM rooms WHERE server_id = ? AND kind != 'call' AND archived_at IS NULL", [server.id]) || {}).n) || 0;
        if (texts <= 1) fail(409, 'servers.last_channel', 'A server keeps at least one text channel');
    }
    await db.run('UPDATE rooms SET archived_at = ov_now() WHERE id = ? AND archived_at IS NULL', [room.id]);
    await db.logModerationAction({ scope_type: 'server', scope_id: server.slug, actor_user_id: actor.id, target_user_id: null, action_type: 'server_channel_delete', details: { channel: room.channel_slug } });
}

function publicInvite(i) {
    return { code: i.code, uses: Number(i.uses) || 0, max_uses: i.max_uses == null ? null : Number(i.max_uses), expires_at: i.expires_at || null, created_at: i.created_at, revoked: !!i.revoked_at };
}

/** A new invite: `max_uses` (null or 1..1000) and `expires_hours` (null or 1..720). Managers make them; mods too in a public server. */
async function createInvite(server, actor, { max_uses = null, expires_hours = null } = {}) {
    const a = await access(server, actor);
    if (!(a.manage || (a.moderate && server.visibility === 'public'))) fail(403, 'servers.not_admin', 'Only the server\'s owner and admins invite people');
    const uses = max_uses == null || max_uses === '' ? null : Number(max_uses);
    if (uses != null && (!Number.isInteger(uses) || uses < 1 || uses > 1000)) fail(422, 'servers.invite_uses', 'An invite is used 1 to 1000 times, or without a limit');
    const hours = expires_hours == null || expires_hours === '' ? null : Number(expires_hours);
    if (hours != null && (!Number.isInteger(hours) || hours < 1 || hours > 720)) fail(422, 'servers.invite_expiry', 'An invite lasts 1 to 720 hours, or forever');
    const live = Number((await db.get('SELECT COUNT(*) AS n FROM chat_server_invites WHERE server_id = ? AND revoked_at IS NULL', [server.id]) || {}).n) || 0;
    if (live >= MAX_INVITES) fail(429, 'servers.too_many_invites', `A server has up to ${MAX_INVITES} invites: revoke one first`);
    let code;
    do { code = randomCode(10); } while (await db.get('SELECT 1 FROM chat_server_invites WHERE code = ?', [code]));
    const expires = hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
    await db.run('INSERT INTO chat_server_invites (code, server_id, created_by, created_by_subject, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [code, server.id, actor.id, actor.subject_id || null, uses, expires]);
    return publicInvite(await db.get('SELECT * FROM chat_server_invites WHERE code = ?', [code]));
}
async function invites(server) {
    return (await db.all('SELECT * FROM chat_server_invites WHERE server_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 100', [server.id])).map(publicInvite);
}
async function revokeInvite(server, actor, code) {
    const a = await access(server, actor);
    const inv = await db.get('SELECT * FROM chat_server_invites WHERE code = ? AND server_id = ?', [String(code || '').toLowerCase(), server.id]);
    if (!inv) fail(404, 'servers.no_invite', 'No such invite');
    if (!a.manage && !(a.moderate && inv.created_by === actor.id)) fail(403, 'servers.not_admin', 'Only the server\'s owner and admins revoke invites');
    await db.run('UPDATE chat_server_invites SET revoked_at = ov_now() WHERE code = ? AND revoked_at IS NULL', [inv.code]);
}

/** Delete the whole server (the owner, or chat staff): it and its channels are archived. */
async function archive(server, actor) {
    const a = await access(server, actor);
    if (!a.owner && !a.staff) fail(403, 'servers.not_owner', 'Only the owner deletes the server');
    await db.tx(async () => {
        await db.run('UPDATE rooms SET archived_at = ov_now() WHERE server_id = ? AND archived_at IS NULL', [server.id]);
        await db.run('UPDATE chat_server_invites SET revoked_at = ov_now() WHERE server_id = ? AND revoked_at IS NULL', [server.id]);
        await db.run('UPDATE chat_servers SET archived_at = ov_now() WHERE id = ?', [server.id]);
    });
    if (!a.owner) await db.logModerationAction({ scope_type: 'server', scope_id: server.slug, actor_user_id: actor.id, target_user_id: server.owner_id, action_type: 'server_delete', details: {} });
}

module.exports = {
    bySlug, byId, roleIn, access, channelAccess, publicServer, publicChannel, channels, channelBySlug,
    create, list, join, leave, setRole, members, update, createChannel, updateChannel, deleteChannel,
    createInvite, invites, revokeInvite, inviteByCode, archive,
    SLUG_RE, ROLES, RANK, MAX_SERVERS_PER_OWNER, MAX_CHANNELS,
};
