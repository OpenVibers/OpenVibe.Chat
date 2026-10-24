'use strict';
/**
 * Vibe, OpenVibe's assistant, on openvibe.chat (plan track K, 2026-10-24: "turn openvibe.chat into the main chat app").
 * A conversation with Vibe is a private room (rooms.assistant = 1, migrations/0015_vibe_chats.sql) that its person owns,
 * with one AI member, Vibe, who answers every message without being named (ai-members.js afterPost). Everything else is
 * a room's: messages, pictures, the live socket (join_room / room_message / room_ai_typing), the account export, and
 * deletion with the account (a room nobody else is in goes with its owner).
 *
 *   start(user, text)          → { room, message }: a new chat named after its first message, the message posted
 *   createRoom(user, title)    → the new chat's room row, nothing posted yet (a chat that starts with a picture)
 *   erase(roomId)              the chat and everything in it, at once (a first picture Pics refused)
 *   list(user, { limit })      → the person's chats, the latest conversation first
 *   ownChat(slug, user)        → the room when it is one of `user`'s Vibe chats, else null
 *   rename(room, user, name)   → the room
 *   remove(room, user)         → the chat and its messages are deleted (not archived: it was the person's own)
 *   repliesToday(user) / countReply(user)   the person's answers from Vibe this UTC day, across all their chats
 *
 * Limits: config.ai.vibeRepliesPerDay answers a person a day, MAX_CHATS chats kept (starting one more deletes the
 * oldest), and each message goes through the rooms' own post checks (length, spam, rate).
 */
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');
const wordFilter = require('../chat/word-filter');
const rooms = require('./rooms');

const VIBE = { name: 'Vibe', handle: 'vibe' };
const MAX_CHATS = 500;
const TITLE_MAX = 40;
const DEFAULT_TITLE = 'Chat with Vibe';

class VibeError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new VibeError(status, code, message); };

const enabled = () => Boolean(config.ai.vibe && config.ai.members && config.oauth.clientSecret);
const isVibeRoom = (room) => !!room && Number(room.assistant) === 1;
const today = () => new Date().toISOString().slice(0, 10);

/** A chat's name from its first message: the first line, cut at a word within TITLE_MAX characters. */
function titleOf(text) {
    const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    const flat = line.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
    if (flat.length < 2 || wordFilter.check(flat).safe === false) return DEFAULT_TITLE;
    if (flat.length <= TITLE_MAX) return flat;
    const cut = flat.slice(0, TITLE_MAX - 1);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

const newSlug = () => `v-${crypto.randomBytes(8).toString('hex').slice(0, 12)}`;

async function createRoom(user, title) {
    if (!user) fail(401, 'vibe.sign_in', 'Sign in to chat with Vibe');
    if (!enabled()) fail(503, 'vibe.off', 'Vibe is resting right now. Try again later.');
    const id = await db.tx(async () => {
        // The oldest chats beyond the limit go, so starting one never fails on it.
        const extra = await db.all('SELECT id FROM rooms WHERE owner_id = ? AND assistant = 1 ORDER BY COALESCE(last_message_at, created_at) DESC OFFSET ?', [user.id, MAX_CHATS - 1]);
        for (const r of extra) await erase(r.id);
        const r = await db.run("INSERT INTO rooms (slug, name, kind, visibility, owner_id, owner_subject, assistant) VALUES (?, ?, 'community', 'private', ?, ?, 1)",
            [newSlug(), titleOf(title), user.id, user.subject_id || null]);
        const roomId = Number(r.lastInsertRowid);
        await db.run("INSERT INTO room_members (room_id, user_id, role, last_seen_at) VALUES (?, ?, 'owner', ov_now())", [roomId, user.id]);
        await db.run("INSERT INTO room_ai_members (room_id, name, handle, persona, memory, created_by_subject, engine) VALUES (?, ?, ?, '', '', ?, 'openvibe')",
            [roomId, VIBE.name, VIBE.handle, user.subject_id || null]);
        return roomId;
    });
    return await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
}

async function start(user, text) {
    const body = String(text || '').replace(/\r\n/g, '\n').trim();
    if (user && enabled() && !body) fail(422, 'rooms.empty', 'Write something first');
    const room = await createRoom(user, body);
    const id = room.id;
    try {
        const message = await rooms.post(room, user, body);
        return { room: await rooms.publicRoom(room, { role: 'owner' }), message };
    } catch (err) {
        await db.tx(() => erase(id));   // a first message the room refuses (spam, too long) leaves no empty chat behind
        throw err;
    }
}

async function list(user, { limit = 100 } = {}) {
    if (!user) return [];
    const lim = Math.min(MAX_CHATS, Math.max(1, Number(limit) || 100));
    const rows = await db.all(`SELECT slug, name, last_message_at, created_at FROM rooms
        WHERE owner_id = ? AND assistant = 1 AND archived_at IS NULL ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`, [user.id, lim]);
    return rows.map((r) => ({ slug: r.slug, name: r.name, last_message_at: r.last_message_at || r.created_at, created_at: r.created_at }));
}

async function ownChat(slug, user) {
    if (!user) return null;
    const room = await rooms.bySlug(slug);
    return isVibeRoom(room) && Number(room.owner_id) === Number(user.id) ? room : null;
}

async function rename(room, user, name) {
    if (!isVibeRoom(room) || !user || Number(room.owner_id) !== Number(user.id)) fail(404, 'rooms.not_found', 'No such chat');
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    if (n.length < 1 || n.length > TITLE_MAX) fail(422, 'vibe.name', `A chat's name is 1 to ${TITLE_MAX} characters`);
    await db.run('UPDATE rooms SET name = ? WHERE id = ?', [n, room.id]);
    return await rooms.publicRoom(await db.get('SELECT * FROM rooms WHERE id = ?', [room.id]), { role: 'owner' });
}

async function erase(roomId) {
    await db.run('DELETE FROM room_messages WHERE room_id = ?', [roomId]);
    await db.run('DELETE FROM room_ai_members WHERE room_id = ?', [roomId]);
    await db.run('DELETE FROM room_ai_usage WHERE room_id = ?', [roomId]);
    await db.run('DELETE FROM room_members WHERE room_id = ?', [roomId]);
    await db.run('DELETE FROM rooms WHERE id = ? AND assistant = 1', [roomId]);
}

async function remove(room, user) {
    if (!isVibeRoom(room) || !user || Number(room.owner_id) !== Number(user.id)) fail(404, 'rooms.not_found', 'No such chat');
    await db.tx(() => erase(room.id));
}

async function repliesToday(user) {
    const row = await db.get('SELECT replies FROM vibe_usage WHERE user_id = ? AND day = ?', [user.id, today()]);
    return Number(row && row.replies) || 0;
}
async function countReply(user) {
    await db.run(`INSERT INTO vibe_usage (user_id, day, replies) VALUES (?, ?, 1)
        ON CONFLICT (user_id, day) DO UPDATE SET replies = vibe_usage.replies + 1`, [user.id, today()]);
}

module.exports = { VIBE, MAX_CHATS, TITLE_MAX, DEFAULT_TITLE, VibeError, enabled, isVibeRoom, titleOf, start, createRoom, erase: (roomId) => db.tx(() => erase(roomId)), list, ownChat, rename, remove, repliesToday, countReply };
