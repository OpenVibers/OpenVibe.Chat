'use strict';
/**
 * Translation for an inbox's people (server/inbox/inbox.js): a visitor's message in their reader's language, on request,
 * and a reply draft in the visitor's. OpenVibe.AI translates (chat.member.turn, Chat's token); each message's
 * translation into a language is kept (inbox_translations), so a second reader pays nothing. At most
 * CHAT_INBOX_TRANSLATIONS_PER_DAY (300) new translations an inbox a UTC day.
 */
const db = require('../db/database');
const config = require('../config');

const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const NAMES = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', uk: 'Ukrainian', pl: 'Polish', tr: 'Turkish', ar: 'Arabic', hi: 'Hindi', id: 'Indonesian', vi: 'Vietnamese', th: 'Thai', sv: 'Swedish' };
const today = () => new Date().toISOString().slice(0, 10);

class TranslateError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new TranslateError(status, code, message); };

function langOf(to) {
    const l = String(to || '').trim();
    if (!LANG_RE.test(l)) fail(422, 'inbox.lang', 'A language is a code like en or pt-BR');
    return l.toLowerCase();
}
const nameOf = (l) => NAMES[l.split('-')[0]] || l;

async function spend(inboxId) {
    const used = Number((await db.get('SELECT translations FROM inbox_ai_usage WHERE inbox_id = ? AND day = ?', [inboxId, today()]) || {}).translations) || 0;
    if (used >= config.inbox.translationsPerDay) fail(429, 'inbox.translations', 'This inbox has translated a lot today; try again tomorrow');
    await db.run(`INSERT INTO inbox_ai_usage (inbox_id, day, replies, translations) VALUES (?, ?, 0, 1)
        ON CONFLICT (inbox_id, day) DO UPDATE SET translations = inbox_ai_usage.translations + 1`, [inboxId, today()]);
}

async function ask(inbox, text, to, deps = {}) {
    const aiClient = deps.aiClient || require('../ai/client');
    const out = await aiClient.structured('chat.member.turn', {
        messages: [
            { role: 'system', content: `Translate the user's message into ${nameOf(to)}. Answer with the translation only: no quotes, no notes. Keep names, numbers, links and order numbers as they are. If it is already in ${nameOf(to)}, answer it unchanged.` },
            { role: 'user', content: String(text).slice(0, 4000) },
        ],
        max_tokens: 900, temperature: 0,
    }, { force: true, attribution: { service: 'chat', type: 'inbox-translation', id: inbox.id, label: inbox.name.slice(0, 200) } });
    const msg = out && Array.isArray(out.choices) && out.choices[0] && out.choices[0].message;
    const t = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!t) fail(503, 'inbox.translate_unavailable', 'Translation is not available right now');
    return t.slice(0, 6000);
}

/** A message of the conversation in `to`: { text, cached }. */
async function message(inbox, conv, messageId, to, deps = {}) {
    const lang = langOf(to);
    const m = await db.get('SELECT id, body FROM inbox_messages WHERE id = ? AND conversation_id = ?', [Number(messageId) || 0, conv.id]);
    if (!m) fail(404, 'inbox.no_message', 'No such message');
    const kept = await db.get('SELECT text FROM inbox_translations WHERE message_id = ? AND lang = ?', [m.id, lang]);
    if (kept) return { text: kept.text, lang, cached: true };
    await spend(inbox.id);
    const text = await ask(inbox, m.body, lang, deps);
    await db.run('INSERT INTO inbox_translations (message_id, lang, text) VALUES (?, ?, ?) ON CONFLICT (message_id, lang) DO NOTHING', [m.id, lang, text]);
    return { text, lang, cached: false };
}

/** A reply draft in `to` (not kept): { text }. */
async function draft(inbox, text, to, deps = {}) {
    const lang = langOf(to);
    const body = String(text || '').trim().slice(0, 4000);
    if (!body) fail(422, 'inbox.empty', 'Write the reply first');
    await spend(inbox.id);
    return { text: await ask(inbox, body, lang, deps), lang };
}

module.exports = { TranslateError, message, draft, langOf };
