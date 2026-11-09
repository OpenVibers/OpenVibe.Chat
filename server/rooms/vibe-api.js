'use strict';
/**
 * Vibe from any OpenVibe site (plan L48, V2; the owner, 2026-11-01: "access your agent or the AI or the conversation
 * from across all websites… use a voice feature to tell it to set a reminder… have a conversation with your Vibe AI").
 * The Dock (openvibe-shared/dock.js) calls these with the person's own Network token, as it calls /api/dm: the same
 * conversations as openvibe.chat/vibe, so a chat started on Live carries on on Chat and back.
 *
 *   GET  /api/vibe/chat?slug=&after=   the chat (by slug, else the latest) and its messages: { chat, messages }, or
 *                                     { chat: null } before the first. after = a message id: only what came after it
 *                                     (the Dock polls this for Vibe's answer). A Vibe message carries what Vibe really
 *                                     did (results: the reminders and timers it set or stopped), absent when none.
 *   POST /api/vibe/undo { message_id, index }
 *                                     undo one of those results: the reminder is stopped, the timer too, and the
 *                                     result is marked undone. The person themself, in their own chat, within a day.
 *   POST /api/vibe/ask { message, slug?, timezone?, fresh? }
 *                                     post into that chat, else the latest one if it moved in the last 6 hours, else
 *                                     a new chat (fresh: always new). Vibe answers in the background, as on Chat.
 *                                     → { chat, message }
 *   POST /api/vibe/listen?lang=en     the body is a short recording (Content-Type audio/webm, audio/ogg or
 *                                     audio/mp4, at most 1 MB) → { text }: Vibe's speech-to-text, for browsers
 *                                     without their own (plan L48 V2). The person's own Network token, never an API
 *                                     or Dock token; 20 a minute and 200 an hour each. The bytes stay in memory,
 *                                     go to OpenVibe.AI inline with Chat's service token, and are never stored.
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const rooms = require('./rooms');
const vibe = require('./vibe');
const vibeResults = require('./vibe-results');
const aiClient = require('../ai/client');
const compare = require('./vibe-compare');
const importer = require('./vibe-import');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
router.use(requireAuth);

const SIX_HOURS = 6 * 3600 * 1000;
const asked = limits('chat.vibe.ask', { minute: 12, hour: 300 });
// The limiter counts calls; charge a compare once for each answer before any message is written.
const answerLimit = async (req, res, next) => {
    let count = Array.isArray(req.body && req.body.models) ? Math.min(3, req.body.models.length) : 1;
    if (!Array.isArray(req.body && req.body.models) && !(req.body && req.body.fresh)) {
        try {
            const slug = req.body && req.body.slug || await vibe.current(req.user);
            const room = slug && await vibe.ownChat(slug, req.user);
            if (room) count = Math.max(1, (await compare.settings(room)).models.length);
        } catch { /* the route below reports a storage error */ }
    }
    let remaining = Math.max(1, count);
    const charge = () => remaining-- > 0 ? asked(req, res, charge) : next();
    return charge();
};
const undone = limits('chat.vibe.undo', { minute: 12, hour: 300 });   // like ask: undoing is as rare as asking
const listened = limits('chat.vibe.listen', { minute: 20, hour: 200 });
const AUDIO_MAX = 1024 * 1024;
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
/** Vibe speaks for nobody but the person signed in: API tokens get the rooms API instead. */
const personOnly = (req, res, next) => (req.authSource === 'api_token' || req.authSource === 'dock' ? res.status(403).json({ error: 'Vibe is for the person themself', code: 'vibe.person_only' }) : next());
const zone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz) }); return String(tz).slice(0, 64); } catch { return null; } };
const at = (ts) => { const d = new Date(String(ts || '').includes('T') ? ts : `${String(ts || '').replace(' ', 'T')}Z`); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
// A Vibe message: its text, and what Vibe really did for the person (the chips; server/rooms/vibe-results.js).
const wire = (m) => {
    const results = vibeResults.list(m.results);
    return { id: Number(m.id), from: m.ai_member_id ? 'vibe' : 'you', text: String(m.message || ''), at: at(m.created_at),
        ...(m.vibe_model ? { model: m.vibe_model } : {}), ...(results.length ? { results } : {}) };
};
const chatOf = (room) => (room ? { slug: room.slug, name: room.name || 'Vibe', url: `https://openvibe.chat/vibe/${encodeURIComponent(room.slug)}` } : null);

async function latest(user) {
    // The chat they last wrote in (vibe.current): an answer arriving later in an older chat does not take its place.
    const slug = await vibe.current(user);
    return slug ? await vibe.ownChat(slug, user) : null;
}

router.get('/chat', personOnly, async (req, res) => {
    const room = req.query.slug ? await vibe.ownChat(String(req.query.slug), req.user) : await latest(req.user);
    if (!room) return res.set('Cache-Control', 'private, no-store').json({ chat: null, messages: [] });
    const after = Number(req.query.after) || null;
    const rows = await rooms.history(room, after ? { after, limit: 50 } : { limit: 40 });
    const by = await compare.answers(room, rows.filter((m) => !m.ai_member_id).map((m) => Number(m.id)));
    return res.set('Cache-Control', 'private, no-store').json({ chat: { ...chatOf(room), ...(await compare.settings(room)) },
        messages: rows.filter((m) => !m.is_deleted).map((m) => ({ ...wire(m), ...(by.has(Number(m.id)) ? { answers: by.get(Number(m.id)) } : {}) })) });
});

router.get('/models', personOnly, async (_req, res) => {
    try { return res.set('Cache-Control', 'private, max-age=120').json(await aiClient.catalog()); }
    catch { return res.status(503).json({ error: 'Models are unavailable right now' }); }
});
router.post('/settings', personOnly, asked, async (req, res) => {
    try {
        const room = await vibe.ownChat(String(req.body && req.body.slug || ''), req.user);
        if (!room) return res.status(404).json({ error: 'No such chat' });
        return res.json(await compare.saveSettings(room, { ...(await compare.settings(room)), ...req.body }));
    } catch (err) { return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save settings' }); }
});

router.get('/import', personOnly, async (req, res) => {
    try { return res.set('Cache-Control', 'private, no-store').json(await importer.status(req.user)); }
    catch { return res.status(503).json({ error: 'Exchange chat import is unavailable' }); }
});
router.post('/import', personOnly, asked, async (req, res) => {
    try { return res.set('Cache-Control', 'private, no-store').json(await importer.bring(req.user)); }
    catch { return res.status(503).json({ error: 'Exchange chat import could not finish' }); }
});
router.post('/import/dismiss', personOnly, async (req, res) => {
    try { return res.json(await importer.dismiss(req.user)); }
    catch { return res.status(500).json({ error: 'Could not dismiss this notice' }); }
});

/**
 * Undo what Vibe did in one of its answers: the reminder is stopped on OpenVibe.Today, the timer on the Dock, and the
 * result is marked undone so it is not offered again. The person themself (personOnly, like ask), only in their own
 * chat, only a result Vibe set, and only within a day of the answer.
 *   POST /api/vibe/undo { message_id, index } → { results, undone }
 */
router.post('/undo', personOnly, undone, async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const messageId = Number(b.message_id);
    const index = Number(b.index);
    if (!Number.isInteger(messageId) || messageId <= 0) return res.status(422).json({ error: 'Which answer?', code: 'vibe.undo_message' });
    if (!Number.isInteger(index) || index < 0) return res.status(422).json({ error: 'Which result?', code: 'vibe.undo_index' });
    try {
        const out = await vibeResults.undo({ messageId, index, user: req.user });
        return res.set('Cache-Control', 'private, no-store').json(out);
    } catch (err) {
        const status = err && err.status ? err.status : 500;
        return res.status(status).set('Cache-Control', 'private, no-store').json({
            error: status === 500 ? 'That could not be undone' : String(err.message || 'That could not be undone'),
            code: (err && err.code) || 'vibe.undo_failed',
        });
    }
});

const readAudio = express.raw({ type: AUDIO_TYPES, limit: AUDIO_MAX + 1 });
const audioBody = (req, res, next) => readAudio(req, res, (err) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That recording is too long: keep it under 30 seconds', code: 'vibe.listen_too_large' });
    return err ? next(err) : next();
});

/** The recording's type, without MediaRecorder's `;codecs=opus`. */
const audioType = (req) => String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();

/**
 * A short recording → { text }. The bytes live in this request only: they are handed to OpenVibe.AI inline
 * (data URL, chat.vibe.listen → its live.stt route) and are never written to disk or logged here. AI retains no
 * input for that workflow at all (only its hash), and deletes its temp file in the same call. `force` is the
 * person waiting, not a background job: it runs even when CHAT_AI_ENABLED (the insight jobs' switch) is off.
 */
router.post('/listen', personOnly, listened, audioBody, async (req, res) => {
    const type = audioType(req);
    if (!AUDIO_TYPES.includes(type)) return res.status(415).json({ error: 'Send the recording as audio/webm, audio/ogg or audio/mp4', code: 'vibe.listen_type' });
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || !bytes.length) return res.status(422).json({ error: 'The recording is empty', code: 'vibe.listen_empty' });
    if (bytes.length > AUDIO_MAX) return res.status(413).json({ error: 'That recording is too long: keep it under 30 seconds', code: 'vibe.listen_too_large' });
    const lang = req.query.lang == null || req.query.lang === '' ? null : String(req.query.lang).toLowerCase();
    if (lang && !/^[a-z]{2}$/.test(lang)) return res.status(422).json({ error: 'lang is a two-letter language code, like en', code: 'vibe.listen_lang' });
    const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
    const subject = req.user.subject_id ? String(req.user.subject_id) : `user:${req.user.id}`;
    let out = null;
    try {
        out = await aiClient.structured('chat.vibe.listen', {
            audio: { data_url: dataUrl, mime: type },
            ...(lang ? { language: lang } : {}),
        }, { force: true, attribution: { service: 'chat', type: 'user', id: subject } });
    } finally {
        bytes.fill(0);   // the request's copy goes as soon as AI has its own; nothing is kept after the answer
    }
    const text = String((out && out.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) return res.status(503).json({ error: 'I could not hear that just now. Try again.', code: 'vibe.listen_unavailable' });
    return res.set('Cache-Control', 'private, no-store').json({ text });
});

router.post('/ask', personOnly, (req, res, next) => (req.body && req.body.models !== undefined && !compare.modelIds(req.body.models)
    ? res.status(422).json({ error: 'Choose one to three distinct models' }) : next()), answerLimit, async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const message = String(b.message || '').replace(/\r\n/g, '\n').trim();
    if (!message) return res.status(422).json({ error: 'Write something first' });
    if (message.length > 8000) return res.status(422).json({ error: 'That is longer than Vibe reads in one message' });
    if (b.models !== undefined && !compare.modelIds(b.models)) return res.status(422).json({ error: 'Choose one to three distinct models' });
    const timezone = zone(b.timezone);
    try {
        let room = b.slug ? await vibe.ownChat(String(b.slug), req.user) : null;
        if (!room && !b.fresh) {
            const last = await latest(req.user);
            const moved = last ? Date.parse(at(last.updated_at || last.last_message_at || last.created_at) || 0) : 0;
            if (last && Date.now() - moved < SIX_HOURS) room = last;
        }
        if (!room && b.models) {
            room = await vibe.createRoom(req.user, message);
            try {
                const posted = await compare.ask(room, req.user, message, b.models, { system_prompt: b.system_prompt, temperature: b.temperature });
                return res.status(201).json({ chat: chatOf(room), message: wire(posted) });
            } catch (err) { await vibe.erase(room.id); throw err; }
        }
        if (!room) {
            const out = await vibe.start(req.user, message, { timezone });
            const full = await vibe.ownChat(out.room.slug, req.user);
            return res.status(201).json({ chat: chatOf(full || out.room), message: wire(out.message) });
        }
        const selected = b.models || (await compare.settings(room)).models;
        const posted = selected.length ? await compare.ask(room, req.user, message, selected,
            { ...(b.system_prompt === undefined ? {} : { system_prompt: b.system_prompt }), ...(b.temperature === undefined ? {} : { temperature: b.temperature }) })
            : await rooms.post(room, req.user, message, { timezone });
        try { require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message: posted }); } catch { /* the socket is optional */ }
        return res.status(201).json({ chat: chatOf(room), message: wire(posted) });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.status ? err.message : 'Your message could not be sent' });
    }
});

router.post('/pick', personOnly, asked, async (req, res) => {
    try { return res.json(await compare.pick(req.user, Number(req.body && req.body.message_id), String(req.body && req.body.model || ''))); }
    catch (err) { return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not pick that answer' }); }
});
router.post('/prefer', personOnly, asked, async (req, res) => {
    try { return res.json(await compare.prefer(req.user, Number(req.body && req.body.message_id), String(req.body && req.body.model || ''))); }
    catch (err) { return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not record that preference' }); }
});

module.exports = router;
