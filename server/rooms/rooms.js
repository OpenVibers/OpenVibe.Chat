'use strict';
/**
 * Chat rooms (roadmap WS-I task 4, first release): rooms anyone can create on openvibe.chat, beside the
 * global room and the stream/channel rooms Live's chat already has.
 *
 *   rooms          slug (URL id), name, topic, kind (community | system | call), visibility
 *                  (public: anyone reads, signed-in people join; private: members only), owner, slow mode
 *   room_members   role: owner | mod | member | blocked; last_read_id for unread counts
 *   room_messages  the messages (soft-deleted by their author, a room mod or chat staff)
 *
 * Moderation: the owner and mods delete messages and block members; site bans and chat staff
 * (staff.moderation.chat) apply in every room. Every staff/mod action is logged through
 * db.logModerationAction (scope room:<slug>), which also reports it to Network's audit log.
 * Nothing here talks to Live except the ban check (ctx.isUserBanned), so rooms keep working with
 * Live down. chat-server.js delivers messages live to sockets that joined the room (join_room).
 */
const db = require('../db/database');
const ctx = require('../live-context');
const wordFilter = require('../chat/word-filter');
const permissions = require('../auth/permissions');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(['global', 'new', 'rooms', 'settings', 'messages', 'updates', 'auth', 'api', 'admin', 'staff', 'help', 'system']);
const ROLES = ['owner', 'mod', 'member', 'blocked'];
const KINDS = ['community', 'system', 'call'];
const MAX_TEXT = 2000;
const MAX_ROOMS_PER_OWNER = 10;
const RATE = { max: 6, windowMs: 10_000 };

class RoomError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new RoomError(status, code, message); };

let ready = false;
function ensureSchema() {
    if (ready) return;
    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            topic TEXT,
            kind TEXT NOT NULL DEFAULT 'community',
            visibility TEXT NOT NULL DEFAULT 'public',
            owner_id INTEGER NOT NULL,
            owner_subject TEXT,
            slow_seconds INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            last_message_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            archived_at DATETIME
        );
        CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            last_read_id INTEGER NOT NULL DEFAULT 0,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (room_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
        CREATE TABLE IF NOT EXISTS room_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            subject_id TEXT,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            deleted_by INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, id);
    `);
    ready = true;
}

const isStaff = (user) => !!user && permissions.can(user, 'staff.moderation.chat');
const roleOf = (roomId, userId) => (userId ? (db.get('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId]) || {}).role || null : null);
const siteBanned = (user) => !!user && (user.is_banned || (() => { try { return ctx.isUserBanned(user.id, null); } catch { return false; } })());

function slugify(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}

function publicRoom(r, extra = {}) {
    if (!r) return null;
    return {
        id: r.id, slug: r.slug, name: r.name, topic: r.topic || null, kind: r.kind, visibility: r.visibility,
        slow_seconds: r.slow_seconds, message_count: r.message_count, last_message_at: r.last_message_at,
        created_at: r.created_at, members: (db.get("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND role != 'blocked'", [r.id]) || {}).n || 0,
        ...extra,
    };
}

function bySlug(slug) {
    ensureSchema();
    return db.get('SELECT * FROM rooms WHERE slug = ? AND archived_at IS NULL', [String(slug || '').toLowerCase()]) || null;
}

/** What `user` may do in `room`: { read, post, moderate, role }. */
function access(room, user) {
    const role = user ? roleOf(room.id, user.id) : null;
    const staff = isStaff(user);
    const blocked = role === 'blocked';
    const member = !!role && !blocked;
    const read = !blocked && (room.visibility === 'public' || member || staff);
    return { role, read, post: !!user && member && !siteBanned(user), moderate: !!user && (role === 'owner' || role === 'mod' || staff), manage: !!user && (role === 'owner' || staff) };
}

function create(user, { name, slug, topic, visibility = 'public', kind = 'community' } = {}) {
    ensureSchema();
    if (!user) fail(401, 'rooms.sign_in', 'Sign in to create a room');
    if (siteBanned(user)) fail(403, 'rooms.banned', 'Your account is banned from chat');
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    if (n.length < 3 || n.length > 40) fail(422, 'rooms.name', 'Room names are 3 to 40 characters');
    const s = slug ? String(slug).toLowerCase().trim() : slugify(n);
    if (!SLUG_RE.test(s) || RESERVED.has(s)) fail(422, 'rooms.slug', 'Room addresses are 3 to 32 lowercase letters, numbers and dashes (and not a reserved word)');
    if (!['public', 'private'].includes(visibility)) fail(422, 'rooms.visibility', 'Visibility is public or private');
    if (!KINDS.includes(kind) || (kind !== 'community' && !isStaff(user))) fail(422, 'rooms.kind', 'Only chat staff create system and call rooms');
    if (wordFilter.check(n).safe === false) fail(422, 'rooms.name_filtered', 'That room name is not allowed');
    const owned = db.get('SELECT COUNT(*) AS n FROM rooms WHERE owner_id = ? AND archived_at IS NULL', [user.id]).n;
    if (owned >= MAX_ROOMS_PER_OWNER && !isStaff(user)) fail(429, 'rooms.too_many', `You can own up to ${MAX_ROOMS_PER_OWNER} rooms`);
    if (bySlug(s)) fail(409, 'rooms.taken', 'That room address is taken');
    const t = topic ? String(topic).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    const id = db.transaction(() => {
        const r = db.run('INSERT INTO rooms (slug, name, topic, kind, visibility, owner_id, owner_subject) VALUES (?, ?, ?, ?, ?, ?, ?)', [s, n, t, kind, visibility, user.id, user.subject_id || null]);
        db.run("INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'owner')", [r.lastInsertRowid, user.id]);
        return Number(r.lastInsertRowid);
    });
    return publicRoom(db.get('SELECT * FROM rooms WHERE id = ?', [id]), { role: 'owner' });
}

/** Public rooms by recent activity, plus the rooms `user` belongs to with unread counts. */
function list(user, { limit = 50 } = {}) {
    ensureSchema();
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const pub = db.all("SELECT * FROM rooms WHERE visibility = 'public' AND archived_at IS NULL ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?", [lim]).map((r) => publicRoom(r));
    const mine = user ? db.all(`SELECT r.*, m.role, m.last_read_id,
            (SELECT COUNT(*) FROM room_messages x WHERE x.room_id = r.id AND x.id > m.last_read_id AND x.is_deleted = 0 AND x.user_id != ?) AS unread
        FROM room_members m JOIN rooms r ON r.id = m.room_id
        WHERE m.user_id = ? AND m.role != 'blocked' AND r.archived_at IS NULL
        ORDER BY COALESCE(r.last_message_at, r.created_at) DESC`, [user.id, user.id]).map((r) => publicRoom(r, { role: r.role, unread: r.unread })) : [];
    return { public: pub, mine };
}

function join(room, user) {
    if (!user) fail(401, 'rooms.sign_in', 'Sign in to join a room');
    const role = roleOf(room.id, user.id);
    if (role === 'blocked') fail(403, 'rooms.blocked', 'You are blocked from this room');
    if (role) return role;
    if (room.visibility !== 'public' && !isStaff(user)) fail(403, 'rooms.private', 'This room is invite-only');
    const last = (db.get('SELECT MAX(id) AS id FROM room_messages WHERE room_id = ?', [room.id]) || {}).id || 0;
    db.run("INSERT INTO room_members (room_id, user_id, role, last_read_id) VALUES (?, ?, 'member', ?)", [room.id, user.id, last]);
    return 'member';
}

function leave(room, user) {
    const role = roleOf(room.id, user && user.id);
    if (role === 'owner') fail(409, 'rooms.owner_leaves', 'The owner cannot leave their room');
    if (role && role !== 'blocked') db.run('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, user.id]);
}

const _rate = new Map();
function rateOk(key, now = Date.now()) {
    const arr = (_rate.get(key) || []).filter((t) => now - t < RATE.windowMs);
    if (arr.length >= RATE.max) { _rate.set(key, arr); return false; }
    arr.push(now); _rate.set(key, arr);
    if (_rate.size > 20000) _rate.clear();
    return true;
}

/** Post a message; returns the stored row (with the author's names) for broadcasting. */
// ── The realtime plane (WS-I task 9, contracts 0.57.0) ──
// A PUBLIC room's messages are announced as chat.room.message.created (visibility public), so browsers
// subscribed to chat.room.* get them over Events realtime; private rooms and DMs never are. Deleting a
// message, or turning the room private, announces chat.room.message.deleted with a redaction, so what
// the room had published stops being replayable. Both are written in the transaction of the change.
const REDACT_CHUNK = 500;
function announceMessage(room, user, id, message, now) {
    if (room.visibility !== 'public') return;
    require('../events/outbox').enqueue({
        event_type: 'chat.room.message.created',
        visibility: 'public',
        actorSubject: user.subject_id || null,
        subject: { type: 'chat_room_message', id: String(id) },
        payload: {
            message_id: id,
            room: { slug: room.slug, name: room.name },
            user_subject: user.subject_id || null,
            username: user.username || null,
            display_name: user.display_name || user.username || null,
            text: String(message).slice(0, 2000),
            created_at: new Date(now).toISOString(),
        },
    });
}
function announceDeleted(room, ids) {
    const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    for (let i = 0; i < list.length; i += REDACT_CHUNK) {
        const part = list.slice(i, i + REDACT_CHUNK);
        require('../events/outbox').enqueue({
            event_type: 'chat.room.message.deleted',
            visibility: 'public',
            subject: { type: 'chat_room_message', id: String(part[0]) },
            payload: { room: room.slug, message_ids: part, redacts: { subject_type: 'chat_room_message', subject_ids: part.map(String) } },
        });
    }
}

function post(room, user, text, { now = Date.now() } = {}) {
    const a = access(room, user);
    if (!user) fail(401, 'rooms.sign_in', 'Sign in to chat');
    if (siteBanned(user)) fail(403, 'rooms.banned', 'Your account is banned from chat');
    if (!a.post) fail(403, room.visibility === 'public' ? 'rooms.join_first' : 'rooms.private', room.visibility === 'public' ? 'Join the room to post' : 'This room is invite-only');
    const body = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!body) fail(422, 'rooms.empty', 'Write something first');
    if (body.length > MAX_TEXT) fail(422, 'rooms.too_long', `Messages are at most ${MAX_TEXT} characters`);
    if (wordFilter.isSpam(body)) fail(422, 'rooms.spam', 'That looks like spam');
    if (!rateOk(`${room.id}:${user.id}`, now)) fail(429, 'rooms.slow_down', 'Slow down a little');
    if (room.slow_seconds > 0 && !a.moderate) {
        const last = db.get('SELECT created_at FROM room_messages WHERE room_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', [room.id, user.id]);
        if (last && now - Date.parse(`${String(last.created_at).replace(' ', 'T')}Z`) < room.slow_seconds * 1000) fail(429, 'rooms.slow_mode', `Slow mode: one message every ${room.slow_seconds} seconds`);
    }
    const filtered = wordFilter.check(body);
    const message = filtered.safe ? body : filtered.filtered;
    const id = db.transaction(() => {
        const r = db.run('INSERT INTO room_messages (room_id, user_id, subject_id, message) VALUES (?, ?, ?, ?)', [room.id, user.id, user.subject_id || null, message]);
        db.run('UPDATE rooms SET message_count = message_count + 1, last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [room.id]);
        db.run('UPDATE room_members SET last_read_id = ? WHERE room_id = ? AND user_id = ?', [r.lastInsertRowid, room.id, user.id]);
        announceMessage(room, user, Number(r.lastInsertRowid), message, now);
        return Number(r.lastInsertRowid);
    });
    return messageById(id);
}

const MSG_SELECT = `SELECT m.id, m.room_id, m.user_id, m.message, m.created_at, m.is_deleted, u.username, u.display_name, u.profile_color, u.role AS user_role
    FROM room_messages m LEFT JOIN ctx_users u ON u.id = m.user_id`;
function messageById(id) { return db.get(`${MSG_SELECT} WHERE m.id = ?`, [id]) || null; }

/** Messages oldest → newest: the newest page, one before `before`, or everything after `after`. */
function history(room, { before = null, after = null, limit = 60 } = {}) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 60));
    if (after != null) return db.all(`${MSG_SELECT} WHERE m.room_id = ? AND m.id > ? AND m.is_deleted = 0 ORDER BY m.id ASC LIMIT ?`, [room.id, Number(after) || 0, lim]);
    const rows = before != null
        ? db.all(`${MSG_SELECT} WHERE m.room_id = ? AND m.id < ? AND m.is_deleted = 0 ORDER BY m.id DESC LIMIT ?`, [room.id, Number(before) || 0, lim])
        : db.all(`${MSG_SELECT} WHERE m.room_id = ? AND m.is_deleted = 0 ORDER BY m.id DESC LIMIT ?`, [room.id, lim]);
    return rows.reverse();
}

function markRead(room, user, lastId) {
    if (!user) return;
    const top = (db.get('SELECT MAX(id) AS id FROM room_messages WHERE room_id = ?', [room.id]) || {}).id || 0;
    const to = Math.min(top, Number(lastId) || top);
    db.run('UPDATE room_members SET last_read_id = MAX(last_read_id, ?) WHERE room_id = ? AND user_id = ?', [to, room.id, user.id]);
}

function deleteMessage(room, user, messageId) {
    const m = db.get('SELECT * FROM room_messages WHERE id = ? AND room_id = ?', [messageId, room.id]);
    if (!m || m.is_deleted) fail(404, 'rooms.no_message', 'No such message');
    const own = user && m.user_id === user.id;
    const a = access(room, user);
    if (!own && !a.moderate) fail(403, 'rooms.not_yours', 'Only the author or a room moderator can delete this');
    db.transaction(() => {
        db.run('UPDATE room_messages SET is_deleted = 1, deleted_by = ? WHERE id = ?', [user.id, m.id]);
        if (room.visibility === 'public') announceDeleted(room, [m.id]);
    });
    if (!own) db.logModerationAction({ scope_type: 'room', scope_id: room.slug, actor_user_id: user.id, target_user_id: m.user_id, action_type: 'delete_message', details: { message_id: m.id } });
    return m.id;
}

/** Owner/mod actions on a member: invite (by user id), set a role (mod/member), block or unblock. */
function setRole(room, actor, targetUserId, role) {
    if (!ROLES.includes(role) && role !== 'none') fail(422, 'rooms.role', 'Unknown role');
    const a = access(room, actor);
    const current = roleOf(room.id, targetUserId);
    if (current === 'owner') fail(403, 'rooms.owner', 'The owner\'s role does not change');
    if (role === 'owner') fail(422, 'rooms.role', 'A room has one owner');
    if (role === 'mod' && !a.manage) fail(403, 'rooms.not_owner', 'Only the owner appoints moderators');
    if (!a.moderate) fail(403, 'rooms.not_mod', 'Only the room\'s owner and moderators manage members');
    if (current === 'mod' && !a.manage) fail(403, 'rooms.not_owner', 'Only the owner changes a moderator');
    const target = ctx.getUserById(targetUserId);
    if (!target) fail(404, 'rooms.no_user', 'No such person');
    if (role === 'none') { if (current && current !== 'blocked') db.run('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, targetUserId]); }
    else if (current) db.run('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?', [role, room.id, targetUserId]);
    else db.run('INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)', [room.id, targetUserId, role]);
    if (role === 'blocked' || current === 'blocked' || role === 'mod' || current === 'mod') {
        db.logModerationAction({ scope_type: 'room', scope_id: room.slug, actor_user_id: actor.id, target_user_id: targetUserId, action_type: role === 'blocked' ? 'room_block' : current === 'blocked' ? 'room_unblock' : role === 'mod' ? 'room_mod_add' : 'room_mod_remove', details: {} });
    }
    return role;
}

function update(room, actor, { name, topic, visibility, slow_seconds } = {}) {
    if (!access(room, actor).manage) fail(403, 'rooms.not_owner', 'Only the owner changes the room');
    const next = { ...room };
    if (name != null) { const n = String(name).replace(/\s+/g, ' ').trim(); if (n.length < 3 || n.length > 40 || !wordFilter.check(n).safe) fail(422, 'rooms.name', 'Room names are 3 to 40 characters'); next.name = n; }
    if (topic != null) next.topic = String(topic).replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    if (visibility != null) { if (!['public', 'private'].includes(visibility)) fail(422, 'rooms.visibility', 'Visibility is public or private'); next.visibility = visibility; }
    if (slow_seconds != null) { const v = Number(slow_seconds); if (!Number.isInteger(v) || v < 0 || v > 600) fail(422, 'rooms.slow', 'Slow mode is 0 to 600 seconds'); next.slow_seconds = v; }
    db.transaction(() => {
        db.run('UPDATE rooms SET name = ?, topic = ?, visibility = ?, slow_seconds = ? WHERE id = ?', [next.name, next.topic, next.visibility, next.slow_seconds, room.id]);
        // Public → private: everything the room published stops being replayable on the realtime plane.
        if (room.visibility === 'public' && next.visibility === 'private') {
            announceDeleted(room, db.all('SELECT id FROM room_messages WHERE room_id = ? AND is_deleted = 0 ORDER BY id', [room.id]).map((r) => r.id));
        }
    });
    return publicRoom(db.get('SELECT * FROM rooms WHERE id = ?', [room.id]));
}

function members(room) {
    return db.all(`SELECT m.user_id, m.role, u.username, u.display_name FROM room_members m LEFT JOIN ctx_users u ON u.id = m.user_id
        WHERE m.room_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'mod' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.username COLLATE NOCASE LIMIT 500`, [room.id]);
}

function _reset() { ready = false; _rate.clear(); }

module.exports = { ensureSchema, create, list, bySlug, access, join, leave, post, history, markRead, deleteMessage, setRole, update, members, publicRoom, messageById, RoomError, SLUG_RE, _reset };
