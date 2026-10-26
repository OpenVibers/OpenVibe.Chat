'use strict';
/**
 * Vibe answers a person through another OpenVibe service (capability chat.vibe.ask; openvibe-contracts 0.214.0
 * chat.vibe-ask-request@1 / chat.vibe-ask-result@1). OpenVibe.Bot's Vibe by voice hands over what a person said after
 * their machine's call word, with the machine's owner as the subject (Bot checks the owner turned voice on for it).
 * Loopback only, a service token for audience openvibe.chat.
 *
 *   POST /internal/chat/vibe/ask  { subject, text, source: { kind: 'voice', id, name? }, lang?, idempotency_key? }
 *     → 200 { state: 'answered', text, url, chat } | { state: 'refused', text, code }
 *
 * The question and the answer are kept in the person's own Vibe chats: one per source, "Voice on <name>", made on first
 * use and marked by rooms.assistant_source (migrations/0033_vibe_asks.sql; deleting the chat removes the mark, and the
 * next question starts a new one). The answer counts against the person's daily allowance like any of theirs, and comes
 * back as plain text to speak (Markdown taken off). The same idempotency key from the same caller answers once: asked
 * again, the first answer (kept 7 days). A person Chat has not seen, Vibe resting or the allowance spent: refused, with why.
 *
 *   POST /internal/chat/vibe/deliver  { subject, source: { kind: 'agent', id, name? }, text, url?, idempotency_key }
 *     → 201 { chat, url, repeated: false } | 200 { chat, url, repeated: true }
 *
 * Each run is a chat you can open (capability chat.vibe.deliver; chat.vibe-deliver-request@1 / -result@1): OpenVibe.Actor
 * posts each passed run of one of the person's agents, as Vibe's message, into their Vibe chat named after the agent
 * (one per agent, marked like the voice chats), with a link to the whole run. No AI answer is made and nothing counts
 * against their allowance; they can reply in the chat and Vibe answers knowing the result. One post per caller's key
 * (vibe_deliveries, kept 30 days). A person Chat has not seen is 422. They get one OpenVibe notification per post
 * ("<agent> has a new result", category chat, which they can switch off on the Network), sent after the answer.
 */
const express = require('express');
const config = require('../config');
const db = require('../db/database');
const serviceAuth = require('../net/service-auth');
const vibe = require('../rooms/vibe');
const rooms = require('../rooms/rooms');
const aiMembers = require('../rooms/ai-members');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SOURCE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** The request's fields, checked as chat.vibe-ask-request@1 says (Chat's own check until it pins the schema). */
function requestOf(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'A JSON object is required');
    if (Object.keys(b).some((k) => !['subject', 'text', 'source', 'lang', 'idempotency_key'].includes(k))) fail(400, 'Invalid fields');
    if (!SUBJECT.test(String(b.subject || ''))) fail(400, 'subject is a person (usr_…)');
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text || text.length > 2000) fail(400, 'text is 1 to 2000 characters');
    const s = b.source;
    if (!s || typeof s !== 'object' || s.kind !== 'voice' || !SOURCE_ID.test(String(s.id || '')) || Object.keys(s).some((k) => !['kind', 'id', 'name'].includes(k))) fail(400, 'source is { kind: voice, id, name? }');
    if (b.idempotency_key != null && !KEY.test(String(b.idempotency_key))) fail(400, 'idempotency_key is 1 to 128 of A-Z a-z 0-9 _ . : -');
    const name = typeof s.name === 'string' ? s.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return { subject: b.subject, text, source: { kind: 'voice', id: s.id, name }, key: b.idempotency_key || null };
}

/** Markdown off, for a voice to read: links keep their text, code and emphasis marks go, lists become sentences. */
function spoken(md) {
    return String(md || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, '$2')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
        .slice(0, 4000);
}

/** The person's chat for this source: the marked one when it is still theirs, else a new one ("Voice on <name>", or the agent's name). */
async function chatFor(user, source) {
    const mark = `${source.kind}:${source.id}`;
    const room = await db.get('SELECT * FROM rooms WHERE owner_id = ? AND assistant = 1 AND assistant_source = ? AND archived_at IS NULL', [user.id, mark]);
    if (room) return room;
    const made = await vibe.createRoom(user, source.kind === 'agent' ? (source.name || 'Your agent') : `Voice on ${source.name || 'your computer'}`);
    await db.run('UPDATE rooms SET assistant_source = ? WHERE id = ?', [mark, made.id]);
    return { ...made, assistant_source: mark };
}

async function ask(req) {
    const r = requestOf(req.body);
    const caller = String((req.principal && req.principal.sub) || '');
    const key = r.key ? `${caller}|${r.key}` : null;
    if (key) {
        const seen = await db.get('SELECT * FROM vibe_asks WHERE idempotency_key = ?', [key]);
        if (seen) return seen.state === 'answered' ? answered(seen.answer, seen.room_id) : refused(seen.answer, seen.code);
    }
    const user = await db.get('SELECT * FROM ctx_users WHERE subject_id = ? ORDER BY id LIMIT 1', [r.subject]);
    let out;
    let roomId = null;
    if (!user || Number(user.is_banned)) out = refused('This account cannot use Vibe yet: sign in on openvibe.chat once first.', 'chat.vibe.unknown_person');
    else if (!vibe.enabled()) out = refused('Vibe is resting right now. Try again later.', 'chat.vibe.off');
    else if (await vibe.repliesToday(user) >= config.ai.vibeRepliesPerDay) out = refused(`You have used today's ${config.ai.vibeRepliesPerDay} free answers. They come back at midnight UTC.`, 'chat.vibe.allowance');
    else {
        const room = await chatFor(user, r.source);
        roomId = Number(room.id);
        const message = await rooms.post(room, user, r.text, { ai: false });
        try { require('./chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message }); } catch { /* sockets are optional */ }
        const reply = await aiMembers.afterPost(room, message, user);
        out = reply && reply.message ? answered(spoken(reply.message), roomId, room.slug) : refused('Vibe could not answer just now. Try again in a minute.', 'chat.vibe.unavailable');
    }
    if (key) {
        if (Math.random() < 0.05) await db.run('DELETE FROM vibe_asks WHERE created_at < ?', [sqlTime(Date.now() - KEEP_MS)]);
        await db.run(`INSERT INTO vibe_asks (idempotency_key, caller, user_id, room_id, state, answer, code) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (idempotency_key) DO NOTHING`, [key, caller, user ? user.id : 0, roomId, out.state, out.text, out.code || null]);
    }
    return out;
}

function answered(text, roomId, slug = null) {
    return { state: 'answered', text: String(text || '').slice(0, 4000), ...(slug ? { url: `${config.web.baseUrl}/vibe/${slug}`, chat: slug } : {}), ...(roomId && !slug ? { room_id: roomId } : {}) };
}
const refused = (text, code) => ({ state: 'refused', text, code });

/** chat.vibe-deliver-request@1, checked as the schema says. */
function deliveryOf(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'A JSON object is required');
    if (Object.keys(b).some((k) => !['subject', 'source', 'text', 'url', 'idempotency_key'].includes(k))) fail(400, 'Invalid fields');
    if (!SUBJECT.test(String(b.subject || ''))) fail(400, 'subject is a person (usr_…)');
    const s = b.source;
    if (!s || typeof s !== 'object' || s.kind !== 'agent' || !SOURCE_ID.test(String(s.id || '')) || Object.keys(s).some((k) => !['kind', 'id', 'name'].includes(k))) fail(400, 'source is { kind: agent, id, name? }');
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text || text.length > 8000) fail(400, 'text is 1 to 8000 characters');
    let url = null;
    if (b.url != null) {
        try { const u = new URL(String(b.url)); if (u.protocol === 'https:') url = u.href; } catch { /* checked below */ }
        if (!url) fail(400, 'url is an https address');
    }
    if (!KEY.test(String(b.idempotency_key || ''))) fail(400, 'idempotency_key is 1 to 128 of A-Z a-z 0-9 _ . : -');
    const name = typeof s.name === 'string' ? s.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return { subject: b.subject, source: { kind: 'agent', id: s.id, name }, text, url, key: b.idempotency_key };
}

const chatUrl = (slug) => `${config.web.baseUrl}/vibe/${slug}`;

/** "<agent> has a new result", with its first line, to the chat (never holds up the answer to the caller). */
async function notifyResult(user, room, d) {
    if (!user.subject_id || (!config.oauth.clientSecret && !require('../inbox/notify')._hasTestPush())) return;
    const name = d.source.name || 'Your agent';
    await require('../inbox/notify').pushOne({
        subjectId: user.subject_id, type: 'AGENT_RESULT', category: 'chat', service: 'chat', icon: '🤖', sender_name: name, priority: 'normal',
        title: `${name} has a new result`, message: spoken(d.text).split('\n')[0].slice(0, 160) || 'Open the chat to read it.', url: chatUrl(room.slug),
    });
}
async function deliver(req) {
    const d = deliveryOf(req.body);
    const caller = String((req.principal && req.principal.sub) || '');
    const key = `${caller}|${d.key}`;
    const seen = await db.get('SELECT d.room_id, r.slug FROM vibe_deliveries d LEFT JOIN rooms r ON r.id = d.room_id WHERE d.idempotency_key = ?', [key]);
    if (seen && seen.slug) return { status: 200, body: { chat: seen.slug, url: chatUrl(seen.slug), repeated: true } };
    const user = await db.get('SELECT * FROM ctx_users WHERE subject_id = ? ORDER BY id LIMIT 1', [d.subject]);
    if (!user || Number(user.is_banned)) fail(422, 'This account has no Vibe chats yet: they sign in on openvibe.chat once first');
    const room = await chatFor(user, d.source);
    const member = await db.get("SELECT * FROM room_ai_members WHERE room_id = ? AND handle = 'vibe'", [room.id]);
    if (!member) fail(409, 'That Vibe chat has no Vibe in it');
    const link = d.url ? `\n\n[See the whole run on OpenVibe Agents](${d.url})` : '';
    const message = await rooms.postAsAi(room, member, `${d.text.slice(0, 8000 - link.length)}${link}`);
    try { require('./chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message }); } catch { /* sockets are optional */ }
    if (Math.random() < 0.05) await db.run('DELETE FROM vibe_deliveries WHERE created_at < ?', [sqlTime(Date.now() - 30 * 24 * 3600 * 1000)]);
    await db.run('INSERT INTO vibe_deliveries (idempotency_key, caller, user_id, room_id, message_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING',
        [key, caller, user.id, room.id, message ? message.id : null]);
    notifyResult(user, room, d).catch((err) => console.warn(`[Vibe deliver] notify: ${err && err.message}`));
    return { status: 201, body: { chat: room.slug, url: chatUrl(room.slug), repeated: false } };
}

const router = express.Router();
router.post('/vibe/deliver', serviceAuth.guard('chat.vibe.deliver'), async (req, res) => {
    try {
        const out = await deliver(req);
        res.status(out.status).json(out.body);
    } catch (err) {
        const status = err && err.status && err.status < 500 ? err.status : 500;
        if (status >= 500) console.error('[Vibe deliver]', err && err.message);
        res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message, code: err && err.code });
    }
});

router.post('/vibe/ask', serviceAuth.guard('chat.vibe.ask'), async (req, res) => {
    try {
        const out = await ask(req);
        // A replayed answer names its chat by id only: look the slug up so the url is there too.
        if (out.room_id) {
            const room = await db.get('SELECT slug FROM rooms WHERE id = ?', [out.room_id]);
            delete out.room_id;
            if (room) Object.assign(out, { url: `${config.web.baseUrl}/vibe/${room.slug}`, chat: room.slug });
        }
        res.json(out);
    } catch (err) {
        const status = err && err.status && err.status < 500 ? err.status : (err && err.code && String(err.code).startsWith('rooms.') ? 422 : 500);
        if (status >= 500) console.error('[Vibe ask]', err && err.message);
        res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message, code: err && err.code });
    }
});

module.exports = router;
module.exports.spoken = spoken;
