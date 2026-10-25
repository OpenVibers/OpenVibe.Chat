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

/** The person's chat for this source: the marked one when it is still theirs, else a new "Voice on <name>". */
async function chatFor(user, source) {
    const mark = `${source.kind}:${source.id}`;
    const room = await db.get('SELECT * FROM rooms WHERE owner_id = ? AND assistant = 1 AND assistant_source = ? AND archived_at IS NULL', [user.id, mark]);
    if (room) return room;
    const made = await vibe.createRoom(user, `Voice on ${source.name || 'your computer'}`);
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

const router = express.Router();
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
