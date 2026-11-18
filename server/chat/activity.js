'use strict';
/**
 * Activity: what happened to a person in Chat (migration 0061_chat_activity.sql). One table of rows, one row per
 * event, written when the event happens and read newest first by the person it happened to:
 *
 *   mention        @you in a room, a channel, a direct message or global chat
 *   reply          an answer to one of your messages in a room, a channel, a direct message or global chat
 *   reaction       a reaction on your message in a room or a channel (room_message_reactions)
 *   server_invite  someone invited you to a server
 *   friend_accept  someone accepted your friend request
 *   role           someone gave you a role in a server or a room
 *
 * A row names who (the actor's snapshot), what (kind, excerpt, reaction or role), where (ids, resolved to a link
 * when it is read) and when. The read is not a thin table lookup: the person's current access is checked on every
 * read, so a kick, a block or a deleted room never leaks a line through the feed, and a blocked person's activity
 * is left out. Writes never fail the thing that caused them (a message, a reaction, a role): they are recorded
 * after it, and a failure is logged and forgotten.
 *
 * The API is server/chat/activity-routes.js (GET /api/v1/activity, GET /api/v1/activity/unread,
 * POST /api/v1/activity/read and POST /api/v1/activity/:id/read).
 */
const db = require('../db/database');
const networkBlocks = require('./network-blocks');

const KINDS = Object.freeze(['mention', 'reply', 'reaction', 'server_invite', 'friend_accept', 'role']);
const REACTIONS = Object.freeze(['thumbsup', 'thumbsdown', 'heart', 'laugh', 'surprised', 'sad']);
const HANDLE_RE = /(^|[^\w@])@([A-Za-z0-9_]{3,24})(?![\w])/g;
const MAX_EXCERPT = 200;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_MENTIONS = 10;

const handleSet = (text) => {
    const out = new Set();
    for (const m of String(text || '').matchAll(HANDLE_RE)) out.add(String(m[2]).toLowerCase());
    return out;
};
const excerptOf = (text) => {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, MAX_EXCERPT) : null;
};
const samePerson = (a, b) => Number(a) > 0 && Number(a) === Number(b);
const snapshot = (actor) => ({
    id: Number(actor && actor.id) || null,
    username: (actor && (actor.username || actor.handle)) || null,
    display_name: (actor && (actor.display_name || actor.name || actor.username || actor.handle)) || null,
    avatar_url: (actor && actor.avatar_url) || null,
});

/** One activity row. Skips a person acting on themselves. → the row id, or null. */
async function record({ userId, kind, actor, roomId = null, serverId = null, conversationId = null, messageId = null,
    parentId = null, scope = 'none', excerpt = null, reaction = null, role = null, inviteCode = null,
    placeLabel = null, placeHref = null } = {}) {
    const recipient = Number(userId) || 0;
    if (!recipient || !KINDS.includes(kind)) return null;
    const who = snapshot(actor);
    if (who.id && samePerson(recipient, who.id)) return null;
    try {
        const r = await db.run(`INSERT INTO chat_activity
            (user_id, kind, actor_user_id, actor_username, actor_display_name, actor_avatar_url, room_id, server_id,
             conversation_id, message_id, parent_id, scope, excerpt, reaction, role, invite_code, place_label, place_href)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [recipient, kind, who.id, who.username, who.display_name, who.avatar_url, roomId ? Number(roomId) : null,
            serverId ? Number(serverId) : null, conversationId ? Number(conversationId) : null,
            messageId ? Number(messageId) : null, parentId ? Number(parentId) : null, scope,
            excerptOf(excerpt), reaction, role, inviteCode, placeLabel, placeHref]);
        const id = Number(r.lastInsertRowid) || null;
        // The Network hears about it too (server/chat/activity-notify.js): one OpenVibe notification per row, in
        // the background, so the menu shows the same list as /activity. Never in the way of the thing that caused it.
        if (id) {
            try { require('./activity-notify').later(id); } catch (err) { console.warn(`[Activity] notify: ${err && err.message}`); }
        }
        return id;
    } catch (err) {
        console.warn(`[Activity] ${kind} not recorded: ${err && err.message}`);
        return null;
    }
}

// ── Recording at the place where the thing happens ───────────────────────────

/** @you in a room or a server channel: its members, never the author. */
async function mentionsInRoom({ room, message, actor }) {
    const handles = handleSet(message && message.message);
    if (!room || !message || !handles.size || !actor) return;
    try {
        const marks = [...handles].map(() => '?').join(',');
        const rows = await db.all(`SELECT DISTINCT u.id, u.username, u.display_name, u.avatar_url
            FROM room_members m JOIN ctx_users u ON u.id = m.user_id
            WHERE m.room_id = ? AND u.id != ? AND lower(u.username) IN (${marks}) LIMIT ?`,
        [room.id, actor.id, ...handles, MAX_MENTIONS]);
        for (const p of rows) {
            if (await networkBlocks.eitherBlockedUsers(actor.id, p.id)) continue;
            await record({ userId: p.id, kind: 'mention', actor, roomId: room.id, messageId: message.id, scope: 'room', excerpt: message.message });
        }
    } catch (err) {
        console.warn(`[Activity] room mention: ${err && err.message}`);
    }
}

/** A reply in a room or a server channel. `parent` is the message being answered. */
async function replyInRoom({ room, message, parent, actor }) {
    if (!room || !message || !parent || !actor || !parent.user_id) return;
    await record({ userId: parent.user_id, kind: 'reply', actor, roomId: room.id, messageId: message.id, parentId: parent.id, scope: 'room', excerpt: message.message });
}

/** @you in a direct message: the conversation's people, never the author. */
async function mentionsInDm({ conversationId, message, actor }) {
    const handles = handleSet(message && message.message);
    if (!conversationId || !message || !handles.size || !actor) return;
    try {
        const rows = await db.all(`SELECT u.id, u.username, u.display_name, u.avatar_url
            FROM dm_participants p JOIN ctx_users u ON u.id = p.user_id
            WHERE p.conversation_id = ? AND u.id != ? LIMIT 20`, [conversationId, actor.id]);
        let n = 0;
        for (const p of rows) {
            if (!handles.has(String(p.username || '').toLowerCase())) continue;
            if (await networkBlocks.eitherBlockedUsers(actor.id, p.id)) continue;
            await record({ userId: p.id, kind: 'mention', actor, conversationId, messageId: message.id, scope: 'dm', excerpt: message.message });
            if (++n >= MAX_MENTIONS) break;
        }
    } catch (err) {
        console.warn(`[Activity] dm mention: ${err && err.message}`);
    }
}

/** A reply in a direct message. `parent` is the message being answered. */
async function replyInDm({ conversationId, message, parent, actor }) {
    if (!conversationId || !message || !parent || !actor || !parent.sender_id) return;
    await record({ userId: parent.sender_id, kind: 'reply', actor, conversationId, messageId: message.id, parentId: parent.id, scope: 'dm', excerpt: message.message });
}

/** Where a global/channel chat line opens: the site's global room, or the channel on Live. */
async function chatPlace(client) {
    const ctx = require('../live-context');
    try {
        let ownerId = client && client.channelUserId;
        if (!ownerId && client && client.streamId) ownerId = (await ctx.getStreamById(client.streamId) || {}).user_id;
        const owner = ownerId ? await ctx.getUserById(ownerId) : null;
        if (owner && owner.username) {
            return { label: `${owner.display_name || owner.username}'s chat`, href: `https://openvibe.live/@${encodeURIComponent(owner.username)}` };
        }
    } catch { /* the global room is still a place */ }
    return { label: 'Global chat', href: '/' };
}

/** @you in global or channel chat. */
async function mentionsInChat({ client, message }) {
    const handles = handleSet(message && message.message);
    if (!client || !client.user || !client.user.id || !message || !message.id || !handles.size) return;
    const place = await chatPlace(client);
    const ctx = require('../live-context');
    let n = 0;
    for (const handle of handles) {
        if (n >= MAX_MENTIONS) break;
        try {
            // The ctx projection only: a chat message never waits on Live for a mention.
            const p = await ctx.getUserByUsername(handle);
            if (!p || samePerson(p.id, client.user.id)) continue;
            if (await networkBlocks.eitherBlockedUsers(client.user.id, p.id)) continue;
            await record({ userId: p.id, kind: 'mention', actor: client.user, messageId: message.id, scope: 'global', excerpt: message.message, placeLabel: place.label, placeHref: place.href });
            n += 1;
        } catch { /* one unknown handle never stops the rest */ }
    }
}

/** A reply in global or channel chat (chat_messages.reply_to_id). */
async function replyInChat({ client, message, parent }) {
    if (!client || !client.user || !client.user.id || !message || !message.id || !parent || !parent.user_id) return;
    if (samePerson(parent.user_id, client.user.id)) return;
    const place = await chatPlace(client);
    await record({ userId: parent.user_id, kind: 'reply', actor: client.user, messageId: message.id, parentId: parent.id, scope: 'global', excerpt: message.message, placeLabel: place.label, placeHref: place.href });
}

/** A reaction on a room message. One row per person and message: changing it updates, taking it back removes. */
async function reaction({ room, message, actor, reaction: kind }) {
    if (!room || !message || !actor || !message.user_id || !REACTIONS.includes(kind)) return;
    const recipient = Number(message.user_id);
    if (!recipient || samePerson(recipient, actor.id)) return;
    try {
        const existing = await db.get("SELECT id FROM chat_activity WHERE user_id = ? AND kind = 'reaction' AND message_id = ? AND actor_user_id = ?",
            [recipient, message.id, actor.id]);
        if (existing) {
            await db.run('UPDATE chat_activity SET reaction = ?, excerpt = ?, created_at = ov_now(), read_at = NULL WHERE id = ?', [kind, excerptOf(message.message), existing.id]);
        } else {
            await record({ userId: recipient, kind: 'reaction', actor, roomId: room.id, messageId: message.id, scope: 'room', excerpt: message.message, reaction: kind });
        }
    } catch (err) {
        console.warn(`[Activity] reaction: ${err && err.message}`);
    }
}

/** The reaction was taken back: its activity goes with it. */
async function removeReaction({ message, actor }) {
    if (!message || !actor) return;
    try { await db.run("DELETE FROM chat_activity WHERE kind = 'reaction' AND message_id = ? AND actor_user_id = ?", [message.id, actor.id]); } catch { /* best effort */ }
}

/** Someone invited this person to their server (a single-use invite, server/rooms/servers.js invitePerson). */
async function serverInvite({ userId, actor, server, code }) {
    if (!server) return;
    await record({ userId, kind: 'server_invite', actor, serverId: server.id, scope: 'server', inviteCode: code || null, excerpt: server.name });
}

/** Someone accepted this person's friend request. The actor is the person who accepted. */
async function friendAccept({ userId, actor }) {
    await record({ userId, kind: 'friend_accept', actor, scope: 'friends' });
}

/** A role given in a server or a room. `targetUserId` is the person who now has it. */
async function roleGiven({ targetUserId, actor, role, serverId = null, roomId = null }) {
    if (!role || role === 'blocked' || role === 'none') return;
    await record({ userId: targetUserId, kind: 'role', actor, role, serverId, roomId, scope: serverId ? 'server' : 'room', excerpt: role });
}

// ── Reading: the access checks ────────────────────────────────────────────────

/**
 * The current-access clauses for a reader, on alias `a`: their room membership (and server membership unless
 * blocked), their DM participation, a server that still exists, a message that was not deleted, and no block
 * between them and the actor (Network blocks, one way, and Chat's own DM blocks, both ways).
 * → { sql, params } whose placeholders follow the caller's own in the same order.
 */
function visibleTo(user) {
    const me = Number(user && user.id) || 0;
    const clauses = [];
    const params = [];
    if (user && user.subject_id) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM network_blocks nb JOIN ctx_users au ON au.subject_id = nb.blocked_subject
            WHERE nb.blocker_subject = ? AND nb.active = 1 AND au.id = a.actor_user_id)`);
        params.push(user.subject_id);
    }
    clauses.push(`NOT EXISTS (SELECT 1 FROM dm_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = a.actor_user_id)
        OR (b.blocked_id = ? AND b.blocker_id = a.actor_user_id))`);
    params.push(me, me);
    clauses.push(`(a.room_id IS NULL OR (EXISTS (SELECT 1 FROM rooms r WHERE r.id = a.room_id AND r.archived_at IS NULL)
        AND EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = a.room_id AND rm.user_id = ?)
        AND (EXISTS (SELECT 1 FROM rooms r2 WHERE r2.id = a.room_id AND r2.server_id IS NULL)
             OR EXISTS (SELECT 1 FROM rooms r3 JOIN chat_server_members sm ON sm.server_id = r3.server_id
                        WHERE r3.id = a.room_id AND sm.user_id = ? AND sm.role != 'blocked'))))`);
    params.push(me, me);
    clauses.push(`(a.conversation_id IS NULL OR EXISTS (SELECT 1 FROM dm_participants p WHERE p.conversation_id = a.conversation_id AND p.user_id = ?))`);
    params.push(me);
    clauses.push(`(a.server_id IS NULL OR EXISTS (SELECT 1 FROM chat_servers s WHERE s.id = a.server_id AND s.archived_at IS NULL))`);
    clauses.push(`(a.message_id IS NULL OR a.scope NOT IN ('room', 'global', 'dm')
        OR (a.scope = 'room' AND EXISTS (SELECT 1 FROM room_messages m WHERE m.id = a.message_id AND m.is_deleted = 0))
        OR (a.scope = 'global' AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.id = a.message_id AND cm.is_deleted = 0))
        OR (a.scope = 'dm' AND EXISTS (SELECT 1 FROM dm_messages d WHERE d.id = a.message_id)))`);
    return { sql: clauses.map((c) => `(${c})`).join(' AND '), params };
}

const isoOf = (ts) => {
    const s = String(ts || '');
    if (!s) return null;
    const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The labels of the direct conversations in a page: the group's name, else the other people's names. */
async function dmLabels(userId, ids) {
    const out = new Map();
    const list = [...new Set(ids.map(Number).filter((n) => n > 0))];
    if (!list.length) return out;
    const marks = list.map(() => '?').join(',');
    const rows = await db.all(`SELECT p.conversation_id, u.username, u.display_name
        FROM dm_participants p LEFT JOIN ctx_users u ON u.id = p.user_id
        WHERE p.conversation_id IN (${marks}) AND p.user_id != ?`, [...list, Number(userId)]);
    for (const r of rows) {
        if (!out.has(Number(r.conversation_id))) out.set(Number(r.conversation_id), []);
        const name = r.display_name || r.username;
        if (name) out.get(Number(r.conversation_id)).push(name);
    }
    return out;
}

/**
 * Where a row happened: the place's label and the link that opens it. The feed and the Network's notification
 * (server/chat/activity-notify.js) both name the place this way, so they never disagree.
 */
function placeOf(r, dmNames) {
    if (r.room_id) {
        const inServer = r.room_server_slug && r.channel_slug;
        return {
            kind: 'room',
            label: r.room_name ? `#${r.room_name}${r.room_server_name ? ` in ${r.room_server_name}` : ''}` : (r.place_label || 'A room'),
            href: inServer ? `/s/${r.room_server_slug}/${r.channel_slug}` : (r.room_slug ? `/r/${r.room_slug}` : '/rooms'),
            room: r.room_slug || null,
            server: r.room_server_slug || null,
        };
    }
    if (r.conversation_id) {
        const names = dmNames.get(Number(r.conversation_id)) || [];
        return {
            kind: 'dm',
            label: r.conversation_name || names.join(', ') || 'A direct message',
            href: `/messages/${Number(r.conversation_id)}`,
            conversation: Number(r.conversation_id),
        };
    }
    if (r.server_id && r.scope === 'server') {
        return {
            kind: 'server',
            label: r.server_name || r.place_label || 'A server',
            href: r.invite_code ? `/join/${encodeURIComponent(r.invite_code)}` : (r.server_slug ? `/s/${r.server_slug}` : '/servers'),
            server: r.server_slug || null,
        };
    }
    if (r.scope === 'friends') return { kind: 'friends', label: 'Friends', href: '/messages' };
    return { kind: 'global', label: r.place_label || 'Global chat', href: r.place_href || '/' };
}

/** One row from the database as the API and the page want it: who, what, where, when. */
function shape(r, dmNames) {
    const actor = {
        id: r.actor_user_id == null ? null : Number(r.actor_user_id),
        username: r.actor_username || null,
        display_name: r.actor_display_name || r.actor_username || null,
        avatar_url: r.actor_avatar_url || null,
    };
    const where = placeOf(r, dmNames);
    return {
        id: Number(r.id),
        kind: r.kind,
        actor,
        where,
        what: {
            excerpt: r.excerpt || null,
            reaction: r.reaction || null,
            role: r.role || null,
        },
        at: isoOf(r.created_at) || r.created_at,
        read: !!r.read_at,
    };
}

/** One page of a person's activity, newest first. `kind` is one kind or a list. → { items, next_before } */
async function list(user, { before = null, limit = DEFAULT_LIMIT, kind = null } = {}) {
    const me = Number(user && user.id) || 0;
    if (!me) return { items: [], next_before: null };
    const lim = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const kinds = [].concat(kind == null ? [] : kind).map((k) => String(k)).filter((k) => KINDS.includes(k));
    const vis = visibleTo(user);
    const params = [me];
    let sql = `SELECT a.id, a.kind, a.actor_user_id, a.actor_username, a.actor_display_name, a.actor_avatar_url,
            a.room_id, a.server_id, a.conversation_id, a.message_id, a.parent_id, a.scope, a.excerpt, a.reaction,
            a.role, a.invite_code, a.place_label, a.place_href, a.created_at, a.read_at,
            r.slug AS room_slug, r.name AS room_name, r.channel_slug,
            rs.slug AS room_server_slug, rs.name AS room_server_name,
            s.slug AS server_slug, s.name AS server_name,
            c.name AS conversation_name
        FROM chat_activity a
        LEFT JOIN rooms r ON r.id = a.room_id
        LEFT JOIN chat_servers rs ON rs.id = r.server_id
        LEFT JOIN chat_servers s ON s.id = a.server_id
        LEFT JOIN dm_conversations c ON c.id = a.conversation_id
        WHERE a.user_id = ?`;
    if (Number(before) > 0) { sql += ' AND a.id < ?'; params.push(Number(before)); }
    if (kinds.length) { sql += ` AND a.kind IN (${kinds.map(() => '?').join(',')})`; params.push(...kinds); }
    sql += ` AND ${vis.sql} ORDER BY a.id DESC LIMIT ?`;
    params.push(...vis.params, lim + 1);
    const rows = await db.all(sql, params);
    const page = rows.slice(0, lim);
    const dmNames = await dmLabels(me, page.filter((r) => r.conversation_id).map((r) => r.conversation_id));
    return {
        items: page.map((r) => shape(r, dmNames)),
        next_before: rows.length > lim ? Number(page[page.length - 1].id) : null,
    };
}

/** How many activities this person has not read yet, under the same access checks. */
async function unreadCount(user) {
    const me = Number(user && user.id) || 0;
    if (!me) return 0;
    const vis = visibleTo(user);
    try {
        const row = await db.get(`SELECT COUNT(*) AS n FROM chat_activity a WHERE a.user_id = ? AND a.read_at IS NULL AND ${vis.sql}`, [me, ...vis.params]);
        return Number(row && row.n) || 0;
    } catch (err) {
        console.warn(`[Activity] unread: ${err && err.message}`);
        return 0;
    }
}

/** Mark a person's activity read: one row by id, or several, or all of it. → how many rows changed. */
async function markRead(user, { id = null, ids = null, all = false } = {}) {
    const me = Number(user && user.id) || 0;
    if (!me) return 0;
    const list = all ? [] : [...new Set([].concat(id == null ? [] : [id], Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    if (!all && !list.length) return 0;
    // Which rows this read covers (the ones that were still unread): their notifications on the Network are cleared
    // with them, the way a read direct message clears its own.
    const covered = all
        ? (await db.all('SELECT id FROM chat_activity WHERE user_id = ? AND read_at IS NULL', [me])).map((r) => Number(r.id))
        : list;
    const r = all
        ? await db.run('UPDATE chat_activity SET read_at = ov_now() WHERE user_id = ? AND read_at IS NULL', [me])
        : await db.run(`UPDATE chat_activity SET read_at = ov_now() WHERE user_id = ? AND read_at IS NULL AND id IN (${list.map(() => '?').join(',')})`, [me, ...list]);
    if ((r.changes || 0) && covered.length) require('./activity-notify').clear(user, covered).catch(() => {});
    return r.changes || 0;
}

module.exports = {
    KINDS, REACTIONS, MAX_LIMIT,
    record,
    mentionsInRoom, replyInRoom, mentionsInDm, replyInDm, mentionsInChat, replyInChat,
    reaction, removeReaction, serverInvite, friendAccept, roleGiven,
    list, unreadCount, markRead,
    placeOf, dmLabels,
    _handleSet: handleSet, _visibleTo: visibleTo,
};
