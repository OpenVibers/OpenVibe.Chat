'use strict';
/**
 * AI members of a room (migrations/0012_room_ai_members.sql). The owner's ask (2026-09-28, Q14 and Q15): friend
 * groups and couples with AI members in their chat, and a Food household's chat with an AI member that knows the
 * pantry.
 *
 *   - A room's managers (its owner, or chat staff) add up to MAX_PER_ROOM: a name, a lowercase @handle, how they want
 *     it to be (persona) and the room's notes for it (memory). A linked service (Food, for a household) can give it
 *     shared context; see contextFor().
 *   - When someone who may post writes @handle, that member answers: the room's last TRANSCRIPT messages, its notes
 *     and the shared context go to OpenVibe.AI (`chat.member.reply`, Chat's own service token, attributed to the
 *     room), and the answer is posted as a room message with ai_member_id set. Only the first member named answers;
 *     an AI member never answers an AI member.
 *   - Limits: one answer at a time per room, CHAT_AI_MEMBER_REPLIES_PER_DAY a room (100), and 20 an hour from one
 *     person. Past them, or with AI unavailable, the member says so once instead of answering.
 *   - A model of its own (migrations/0014_ai_member_models.sql): engine 'openvibe' thinks with OpenVibe's model; engine
 *     'own' with the provider key the manager who set it keeps in OpenVibe.AI through Chat (server/ai/credentials.js:
 *     OpenAI, Anthropic or an OpenAI-compatible endpoint, their model, their daily budget). The room sees which
 *     (engine_label). Such a member is outside the room's daily cap (the key's own budget limits it); if the key is
 *     removed, its members go back to OpenVibe's model (dropKey).
 *   - Off with CHAT_AI_MEMBERS=0, and without the OAuth client secret (no token to call AI with).
 *
 * Room messages written by an AI member have user_id 0 and the member's name (rooms.js MSG_SELECT joins it).
 */
const db = require('../db/database');
const config = require('../config');
const aiClient = require('../ai/client');
const credentials = require('../ai/credentials');

const MAX_PER_ROOM = 3;
const TRANSCRIPT = 30;
const LIMITS = { name: 24, persona: 1000, memory: 2000 };
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,22}[\p{L}\p{N}]$/u;
const PER_PERSON_HOUR = 20;

const inFlight = new Set();          // room ids with an answer being written
const personHour = new Map();        // `${room}:${user}` → [timestamps]

const handleOf = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 24);
const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

class AiMemberError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new AiMemberError(status, code, message); };

const enabled = () => Boolean(config.ai.members && config.oauth.clientSecret);

async function list(room) {
    return await db.all('SELECT * FROM room_ai_members WHERE room_id = ? ORDER BY id', [room.id]);
}
async function byId(room, id) {
    return await db.get('SELECT * FROM room_ai_members WHERE room_id = ? AND id = ?', [room.id, Number(id) || 0]) || null;
}

function validate({ name, persona, memory } = {}, { partial = false } = {}) {
    const out = {};
    if (!partial || name !== undefined) {
        const n = clean(name, LIMITS.name + 1).replace(/\s+/g, ' ');
        if (!NAME_RE.test(n) || n.length > LIMITS.name) fail(422, 'rooms.ai_name', 'An AI member\'s name is 2 to 24 letters, digits, spaces, dots, dashes or apostrophes');
        out.name = n;
        out.handle = handleOf(n);
        if (out.handle.length < 2) fail(422, 'rooms.ai_name', 'An AI member\'s name needs at least two letters or digits');
    }
    if (persona !== undefined) out.persona = clean(persona, LIMITS.persona);
    if (memory !== undefined) out.memory = clean(memory, LIMITS.memory);
    return out;
}

/**
 * The engine an add or an update asks for: 'openvibe', or 'own' (the acting person's own key, which must be stored).
 * Returns the columns to write, or null when the input does not name an engine.
 */
async function engineOf(input, user) {
    if (input.engine === undefined || input.engine === null || input.engine === '') return null;
    if (input.engine === 'openvibe') return { engine: 'openvibe', engine_subject: null, engine_label: null };
    if (input.engine !== 'own') fail(422, 'rooms.ai_engine', 'An AI member thinks with OpenVibe\'s model or with your own key');
    const subject = user && user.subject_id;
    if (!subject) fail(403, 'rooms.ai_engine', 'Sign in with an OpenVibe account to use your own AI key');
    let cred;
    try { cred = await credentials.get(subject); } catch (err) { fail(err.status || 502, err.code || 'credentials.unreachable', err.message); }
    if (!cred) fail(409, 'rooms.ai_no_key', 'Add your own AI key in Settings first');
    return { engine: 'own', engine_subject: subject, engine_label: `${credentials.label(cred)}, ${(user.display_name || user.username || 'a member').slice(0, 40)}'s key` };
}

/** Add one. `can` is rooms.access() for `user`: only a room's managers add, edit or remove AI members. */
async function add(room, user, can, input = {}) {
    if (!can || !can.manage) fail(403, 'rooms.forbidden', 'Only the room\'s owner adds AI members');
    if (room.kind === 'system') fail(422, 'rooms.ai_kind', 'Announcement rooms have no AI members');
    const v = validate(input);
    if ((await list(room)).length >= MAX_PER_ROOM) fail(409, 'rooms.ai_limit', `A room has at most ${MAX_PER_ROOM} AI members`);
    if (await db.get('SELECT 1 FROM room_ai_members WHERE room_id = ? AND handle = ?', [room.id, v.handle])) fail(409, 'rooms.ai_taken', `This room already has an AI member called @${v.handle}`);
    const link = input.link_service === 'food' && /^[A-Za-z0-9_-]{4,64}$/.test(String(input.link_resource || '')) ? { service: 'food', resource: String(input.link_resource) } : null;
    const e = (await engineOf(input, user)) || { engine: 'openvibe', engine_subject: null, engine_label: null };
    const r = await db.run(
        `INSERT INTO room_ai_members (room_id, name, handle, persona, memory, link_service, link_resource, created_by_subject, engine, engine_subject, engine_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [room.id, v.name, v.handle, v.persona || '', v.memory || '', link ? link.service : null, link ? link.resource : null, (user && user.subject_id) || null, e.engine, e.engine_subject, e.engine_label]);
    return await byId(room, r.lastInsertRowid);
}

async function update(room, can, id, input = {}, user = null) {
    if (!can || !can.manage) fail(403, 'rooms.forbidden', 'Only the room\'s owner changes AI members');
    const m = await byId(room, id);
    if (!m) fail(404, 'rooms.ai_not_found', 'No such AI member in this room');
    const v = validate(input, { partial: true });
    if (v.handle && v.handle !== m.handle && await db.get('SELECT 1 FROM room_ai_members WHERE room_id = ? AND handle = ? AND id <> ?', [room.id, v.handle, m.id])) fail(409, 'rooms.ai_taken', `This room already has an AI member called @${v.handle}`);
    const enabledFlag = input.enabled === undefined ? m.enabled : (input.enabled === false || input.enabled === '0' || input.enabled === 0 ? 0 : 1);
    // Keeping 'own' as it is needs no key of the editor's: only a change to it does (someone else's key stays theirs).
    const e = input.engine === 'own' && m.engine === 'own' ? null : await engineOf(input, user);
    const eng = e || { engine: m.engine || 'openvibe', engine_subject: m.engine_subject || null, engine_label: m.engine_label || null };
    await db.run('UPDATE room_ai_members SET name = ?, handle = ?, persona = ?, memory = ?, enabled = ?, engine = ?, engine_subject = ?, engine_label = ?, updated_at = ov_now() WHERE id = ?',
        [v.name || m.name, v.handle || m.handle, v.persona !== undefined ? v.persona : m.persona, v.memory !== undefined ? v.memory : m.memory, enabledFlag, eng.engine, eng.engine_subject, eng.engine_label, m.id]);
    return await byId(room, m.id);
}

async function remove(room, can, id) {
    if (!can || !can.manage) fail(403, 'rooms.forbidden', 'Only the room\'s owner removes AI members');
    await db.run('DELETE FROM room_ai_members WHERE room_id = ? AND id = ?', [room.id, Number(id) || 0]);
}

/** A person's key is gone (they removed it, or their account was erased): their members go back to OpenVibe's model. */
async function dropKey(subject) {
    if (!subject) return 0;
    const r = await db.run("UPDATE room_ai_members SET engine = 'openvibe', engine_subject = NULL, engine_label = NULL, updated_at = ov_now() WHERE engine_subject = ?", [String(subject)]);
    return r.changes || 0;
}

/** Keeps every member that uses this person's key showing the key's current provider and model. */
async function relabelKey(subject, cred, user) {
    if (!subject || !cred) return;
    await db.run("UPDATE room_ai_members SET engine_label = ?, updated_at = ov_now() WHERE engine = 'own' AND engine_subject = ?",
        [`${credentials.label(cred)}, ${((user && (user.display_name || user.username)) || 'a member').slice(0, 40)}'s key`, String(subject)]);
}

/** The first enabled member a message names (@handle, as a word), or null. */
function mentioned(members, text) {
    const t = String(text || '').toLowerCase();
    let best = null;
    for (const m of members) {
        if (!Number(m.enabled)) continue;
        const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${m.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u');
        const hit = re.exec(t);
        if (hit && (!best || hit.index < best.at)) best = { member: m, at: hit.index };
    }
    return best ? best.member : null;
}

/**
 * Shared context a linked service gives the member, as text, or null. Food (a household's pantry and meal plan) is
 * read from Food's internal API with Chat's service token: see server/rooms/food-context.js.
 */
async function contextFor(member) {
    if (member.link_service !== 'food' || !member.link_resource) return null;
    try { return await require('./food-context').contextOf(member.link_resource); } catch { return null; }
}

function personOk(roomId, userId, now) {
    const key = `${roomId}:${userId}`;
    const recent = (personHour.get(key) || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= PER_PERSON_HOUR) { personHour.set(key, recent); return false; }
    recent.push(now);
    personHour.set(key, recent);
    if (personHour.size > 5000) personHour.delete(personHour.keys().next().value);
    return true;
}

async function countReply(room) {
    const day = new Date().toISOString().slice(0, 10);
    const row = await db.get(
        `INSERT INTO room_ai_usage (room_id, day, replies) VALUES (?, ?, 1)
         ON CONFLICT (room_id, day) DO UPDATE SET replies = room_ai_usage.replies + 1 RETURNING replies`, [room.id, day]);
    return Number(row && row.replies) || 1;
}
async function repliesToday(room) {
    const row = await db.get('SELECT replies FROM room_ai_usage WHERE room_id = ? AND day = ?', [room.id, new Date().toISOString().slice(0, 10)]);
    return Number(row && row.replies) || 0;
}

/** The room's recent messages as plain lines, oldest first, for the prompt. */
function transcriptOf(rows) {
    return rows.map((m) => `${(m.display_name || m.username || 'someone').slice(0, 40)}${m.ai_member_id ? ' (AI)' : ''}: ${String(m.message || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n').slice(-12000);
}

/**
 * After a person's message is stored and broadcast (rooms.post). Never throws: an AI member that cannot answer
 * stays quiet or says why. `deps` lets tests inject the poster and the broadcast.
 */
async function afterPost(room, message, user, deps = {}) {
    if (!enabled() || !message || message.ai_member_id || !user) return null;
    const members = await list(room);
    if (!members.length) return null;
    const member = mentioned(members, message.message);
    if (!member) return null;
    const rooms = deps.rooms || require('./rooms');
    const broadcast = deps.broadcast || ((frame) => require('../chat/chat-server').broadcastToRoom(room.id, frame));
    const say = async (text) => {
        const posted = await rooms.postAsAi(room, member, text);
        broadcast({ type: 'room_message', room: room.slug, message: posted });
        return posted;
    };
    if (inFlight.has(room.id)) return null;
    if (!personOk(room.id, user.id, Date.now())) return null;
    const own = member.engine === 'own' && member.engine_subject;
    if (!own && await repliesToday(room) >= config.ai.memberRepliesPerDay) {
        return await say(`I have answered ${config.ai.memberRepliesPerDay} times in this room today, which is my limit. Ask me again tomorrow.`);
    }
    inFlight.add(room.id);
    try {
        broadcast({ type: 'room_ai_typing', room: room.slug, name: member.name });
        const history = await rooms.history(room, { limit: TRANSCRIPT });
        const context = await contextFor(member);
        const out = await aiClient.structured('chat.member.reply', {
            ai_name: member.name, persona: member.persona || '', room: String(room.name || room.slug).slice(0, 120),
            memory: member.memory || '', context: context ? context.text.slice(0, 4000) : '', context_source: context ? context.source.slice(0, 80) : '',
            transcript: transcriptOf(history) || '(no earlier messages)',
            asked_by: (user.display_name || user.username || 'someone').slice(0, 80), message: String(message.message).slice(0, 2000),
        }, { force: true, attribution: { service: 'chat', type: 'room', id: String(room.id), label: String(room.name || room.slug).slice(0, 200) }, idempotencyKey: `chat-ai-${room.id}-${message.id}`,
            ...(own ? { credential: { subject: member.engine_subject } } : {}) });
        const text = out && typeof out.text === 'string' ? clean(out.text, 2000) : '';
        if (!text) return await say(own ? 'I could not reach my model just now (its key may be out of today\'s budget, or the provider did not answer). Try again later, or the room\'s owner can switch me to OpenVibe\'s model.' : 'I could not answer just now. Try again in a minute.');
        if (!own) await countReply(room);
        return await say(text);
    } catch (err) {
        console.warn(`[Chat AI members] room ${room.id}: ${(err && err.message) || err}`);
        return null;
    } finally {
        inFlight.delete(room.id);
    }
}

/** What the room shows a member thinks with: "OpenVibe", or the own key's provider, model and whose key it is. */
const modelOf = (m) => (m.engine === 'own' ? (m.engine_label || 'someone\'s own key') : 'OpenVibe');

const toWire = (m) => ({
    id: Number(m.id), name: m.name, handle: m.handle, persona: m.persona, memory: m.memory, enabled: Boolean(Number(m.enabled)),
    link: m.link_service ? { service: m.link_service, resource: m.link_resource } : null,
    engine: m.engine || 'openvibe', model: modelOf(m), created_at: m.created_at, updated_at: m.updated_at,
});

function _reset() { inFlight.clear(); personHour.clear(); }

module.exports = { MAX_PER_ROOM, LIMITS, AiMemberError, enabled, list, byId, add, update, remove, dropKey, relabelKey, modelOf, mentioned, handleOf, afterPost, transcriptOf, toWire, _reset };
