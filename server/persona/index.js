'use strict';
/**
 * Vibe personas (the owner, 2026-11-12): every Vibe conversation gets a name and a face made from what the
 * chat is about, remade when the topic changes.
 *
 *   persona { name, glyph, hue, image_url|null, topic, made_at }
 *
 * The shape is deliberately small and product-neutral: Actor and Codes can show the same run card's agent with
 * it (research-2026-11-12/one-agent-system.md §2), and the main session draws it in the Vibe panel from the API
 * field, without OpenVibe.Shared changing.
 *
 * Rules:
 *   - Made after the first answer; checked every `check_every` messages (default 8). A check asks the cheapest
 *     text model whether the topic changed, one word: YES or NO. YES makes a new persona.
 *   - Due-based, idempotent and never blocking a reply: afterPost() schedules setImmediate() work and returns;
 *     one generation per room at a time; every model call carries an idempotency key; a change's key names the
 *     persona generation and the message count it read.
 *   - The name also names the conversation, unless the person renamed it (rooms.vibe_title_locked).
 *   - Glyph is one name from openvibe-shared/glyphs; an invalid answer is retried once and then replaced by a
 *     deterministic glyph from the same registry, so no other product can ever receive an unknown icon.
 *   - The models are the owner's: '' = Auto = the cheapest chat (or image) model in Exchange's catalogue, read
 *     through Chat's own OpenVibe.AI grant (`chat.member.turn`'s ai.complete passthrough is not used; Chat runs
 *     `ai.complete` with an explicit catalogue model). Text runs are billed to Chat, not the person.
 *   - A monthly cap in US dollars is checked before every call and read from the runs' own usage. At the cap
 *     Chat stops making and checking personas; existing ones stay.
 *   - Images are off by default. When on, a small avatar is made by the cheapest image model through the
 *     Chat-owned `chat.persona.image` workflow (OpenVibe.AI), uploaded to OpenVibe.Media as Chat, and its
 *     public URL stored on the persona. A failed picture never loses the name.
 *
 * Owner settings and the admin page: server/persona/settings.js, /admin/persona (server/web/persona-admin.js),
 * GET|POST /api/admin/persona and POST /api/admin/persona/remake (server/rooms/persona-api.js).
 */
const crypto = require('crypto');
const db = require('../db/database');
const aiClient = require('../ai/client');
const media = require('../media/client');
const wordFilter = require('../chat/word-filter');
const settings = require('./settings');

const GLYPHS = require('openvibe-shared/glyphs');
const GLYPH_NAMES = Object.freeze([...GLYPHS.NAMES]);
const GLYPH_SET = new Set(GLYPH_NAMES);
// Topic-friendly names from the registry, checked here so a prompt never asks for an icon that does not exist.
const GLYPH_CHOICES = Object.freeze([
    'airplane', 'archive', 'bell', 'book', 'book-open', 'brain', 'branch', 'bridge', 'briefcase', 'bug',
    'calendar', 'camera', 'car', 'cart', 'chart', 'chat', 'chip', 'city', 'clapper', 'clipboard', 'clock',
    'cloud', 'code', 'coin', 'compass', 'computer', 'cookie', 'crown', 'database', 'dice', 'dish', 'dollar',
    'door', 'download', 'drive', 'ear', 'film', 'filter', 'fire', 'fish', 'flag', 'flask', 'focus', 'folder',
    'food', 'game', 'gauge', 'gavel', 'gear', 'gem', 'ghost', 'gift', 'globe', 'grid', 'group', 'hammer',
    'hand', 'handshake', 'hash', 'headphones', 'heart', 'help', 'history', 'home', 'idea', 'image', 'inbox',
    'key', 'keyboard', 'language', 'layers', 'leaf', 'lifebuoy', 'link', 'live', 'lock', 'lungs', 'mail',
    'map', 'mask', 'medical', 'megaphone', 'members', 'mic', 'money', 'moon', 'mountain', 'mug', 'music',
    'news', 'palette', 'paw', 'pencil', 'phone', 'piggy', 'plane', 'play', 'puzzle', 'radio', 'ranking',
    'recycle', 'reply', 'road', 'robot', 'rocket', 'route', 'scale', 'scissors', 'scroll', 'search',
    'seedling', 'send', 'server', 'shapes', 'shield', 'shirt', 'shoe', 'signature', 'skull', 'smile', 'snow',
    'spark', 'star', 'steps', 'store', 'storm', 'sun', 'sword', 'table', 'tag', 'target', 'task', 'tent',
    'terminal', 'text', 'ticket', 'timeline', 'toolbox', 'train', 'tree', 'trophy', 'tv', 'umbrella', 'user',
    'video', 'wallet', 'wave', 'weight', 'wifi', 'wind', 'wizard', 'wrench', 'zap',
].filter((name) => GLYPH_SET.has(name)));

const FALLBACK_TEXT_MODEL = 'shared/gpt-5-nano';
const FALLBACK_IMAGE_MODEL = 'openrouter/google/gemini-3.1-flash-lite-image';
const MAX_NAME = 32;
const MAX_TOPIC = 120;
const HISTORY_FOR_FIRST = 4;
const HISTORY_FOR_CHECK = 12;
const MAX_MESSAGE_CHARS = 700;
const MAX_PROMPT_CHARS = 7000;
const CAP_SEEN = 60_000;
const TEXT_CALL_MS = 45_000;
const IMAGE_CALL_MS = 60_000;

const inFlight = new Set();
const catalogCache = { at: 0, value: null };
const lastProblem = new Map();

class PersonaError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new PersonaError(status, code, message); };

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

function iso(value) {
    if (!value) return null;
    const text = String(value);
    const d = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clean(value, max) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** A name as a character: 1–3 Title Case words, no digits, no markdown, nothing the word filter refuses. */
function cleanName(raw) {
    const s = clean(String(raw == null ? '' : raw).replace(/^["'`*_]+|["'`*_]+$/g, ''), MAX_NAME);
    if (!s || s.length < 2 || s.length > MAX_NAME) return null;
    if (!/^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*){0,2}$/u.test(s)) return null;
    if (wordFilter.check(s).safe === false) return null;
    return s;
}

function cleanTopic(raw, fallback = 'a conversation') {
    const s = clean(String(raw == null ? '' : raw).replace(/^["'`*_]+|["'`*_]+$/g, ''), MAX_TOPIC);
    if (!s || s.length < 2) return fallback;
    if (wordFilter.check(s).safe === false) return fallback;
    return s;
}

/** A deterministic glyph from the same registry when the model's answer is unusable. */
function fallbackGlyph(seed) {
    const digest = crypto.createHash('sha256').update(String(seed || 'vibe')).digest();
    return GLYPH_CHOICES[digest[0] % GLYPH_CHOICES.length] || 'spark';
}

function cleanHue(raw, seed) {
    const n = Number(raw);
    if (Number.isFinite(n)) return ((Math.round(n) % 360) + 360) % 360;
    const digest = crypto.createHash('sha256').update(String(seed || 'vibe')).digest();
    return ((digest[1] << 8 | digest[2]) % 360 + 360) % 360;
}

/** JSON from a model that may wrap it in prose or a code fence. */
function jsonOf(text) {
    const raw = String(text || '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/** The model's one-word answer: YES only when the first word is YES. */
function yesOf(text) {
    return /^\s*(?:yes|y)\b/i.test(String(text || ''));
}

const clampInt = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

// ── models and spend ────────────────────────────────────────────────────────

function offerPrice(model) {
    let best = null;
    for (const offer of (model && Array.isArray(model.offers) ? model.offers : [])) {
        const p = offer && offer.price;
        if (!p) continue;
        const input = Number(p.in != null ? p.in : p.input_per_million);
        const output = Number(p.out != null ? p.out : p.output_per_million);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        const score = input + output;
        if (!best || score < best.score) best = { in: input, out: output, score };
    }
    return best;
}

const modelIdOf = (model) => String((model && (model.slug || model.id)) || '').trim();

/** Exchange's live catalogue, cached for a minute so a page load does not scan it twice. */
async function models() {
    if (catalogCache.value && Date.now() - catalogCache.at < CAP_SEEN) return catalogCache.value;
    const out = await aiClient.catalog();
    catalogCache.at = Date.now();
    catalogCache.value = out && Array.isArray(out.models) ? out.models : [];
    return catalogCache.value;
}

async function cheapestModel(kind) {
    let catalog = [];
    try { catalog = await models(); } catch { catalog = []; }
    let best = null;
    for (const model of catalog) {
        const modelKind = model.kind || 'chat';
        if (modelKind !== kind) continue;
        const id = modelIdOf(model);
        if (!id) continue;
        const price = offerPrice(model);
        if (!price) continue;
        if (!best || price.score < best.score || (price.score === best.score && String(model.name || '').localeCompare(String(best.name || '')) < 0)) {
            best = { id, score: price.score, name: model.name || id };
        }
    }
    if (best) return best.id;
    return kind === 'image' ? FALLBACK_IMAGE_MODEL : FALLBACK_TEXT_MODEL;
}

async function modelFor(kind) {
    const configured = clean(settings.value(kind === 'image' ? 'image_model' : 'text_model'), 200);
    if (configured) return configured;
    return await cheapestModel(kind);
}

async function spendThisMonth() {
    const row = await db.get('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM vibe_persona_spend WHERE month = ?', [monthKey()]);
    return Number(row && row.usd) || 0;
}

async function capReached() {
    const cap = Number(settings.value('monthly_cap_usd'));
    if (!Number.isFinite(cap) || cap <= 0) return true;
    return (await spendThisMonth()) >= cap;
}

async function recordSpend(roomId, kind, model, run) {
    const cost = run && run.usage && run.usage.cost_usd != null ? Math.max(0, Number(run.usage.cost_usd) || 0) : 0;
    try {
        await db.run('INSERT INTO vibe_persona_spend (room_id, month, kind, model, cost_usd, run_id) VALUES (?, ?, ?, ?, ?, ?)',
            [roomId || null, monthKey(), kind, clean(model, 200) || null, cost, clean(run && run.id, 80) || null]);
    } catch (err) { console.warn('[Vibe persona] spend:', err && err.message); }
}

// ── prompts and calls ────────────────────────────────────────────────────────

function transcriptOf(rows) {
    return (rows || []).map((m) => `${m.ai_member_id ? 'Vibe' : (m.display_name || m.username || 'They')}: ${String(m.message || '').replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS)}`).join('\n').slice(-MAX_PROMPT_CHARS);
}

const PERSONA_SYSTEM = [
    'You name a private chat with Vibe, OpenVibe\'s assistant. Read the messages and answer with JSON only, no markdown, no code fence:',
    '{"name":"...","glyph":"...","hue":210,"topic":"..."}',
    '- name: 1 to 3 English words in Title Case that say what this chat is really about, as a character: "Keyboard Scout", "Stream Doctor", "Dinner Planner". It is a nickname, never a real person\'s name, never a slur, and never more than 32 characters.',
    '- glyph: exactly one name from this list (one word, lowercase): ' + GLYPH_CHOICES.join(', ') + '.',
    '- hue: an integer from 0 to 359, the colour that fits the topic.',
    '- topic: at most 12 plain words saying what the chat is about.',
    'Do not repeat the person\'s words. Do not use a person\'s name. Answer only the JSON object.',
].join('\n');

function personaUser(rows, previous) {
    return [
        previous ? `The chat had this persona before: ${previous.name} (${previous.topic}). Make a different name and glyph that fit the new topic.` : '',
        'The conversation:',
        transcriptOf(rows) || '(no messages yet)',
        '',
        'Return only the JSON object for this chat.',
    ].filter(Boolean).join('\n');
}

const CHECK_SYSTEM = [
    'You decide whether the topic of a chat has changed.',
    'Answer exactly one word: YES or NO.',
    'Answer YES only when the conversation is now mostly about something else than the current topic; a follow-up, a detail or a new question on the same subject is NO.',
].join('\n');

function checkUser(rows, persona) {
    return [
        `Current topic: ${persona.topic}`,
        'Recent messages:',
        transcriptOf(rows) || '(none)',
        '',
        'Has the topic changed? Answer only YES or NO.',
    ].join('\n');
}

async function callModel({ roomId, kind, model, messages, maxTokens, temperature, key, timeoutMs }) {
    let output = null;
    try {
        output = await aiClient.structured('ai.complete', {
            model, messages, max_tokens: maxTokens, temperature,
        }, {
            force: true,
            idempotencyKey: key,
            onRun: (run) => recordSpend(roomId, kind, model, run),
        });
    } catch (err) {
        lastProblem.set(roomId, clean(err && err.message, 200));
        return null;
    }
    if (!output) { lastProblem.set(roomId, 'ai.empty'); return null; }
    const content = output && Array.isArray(output.choices) && output.choices[0] && output.choices[0].message
        ? output.choices[0].message.content : null;
    if (typeof content !== 'string' || !content.trim()) { lastProblem.set(roomId, 'ai.empty'); return null; }
    lastProblem.delete(roomId);
    return { text: content, model, at: Date.now() };
}

async function askForPersona(room, rows, previous, key) {
    const model = await modelFor('chat');
    return await callModel({
        roomId: room.id, kind: 'text', model, key,
        messages: [{ role: 'system', content: PERSONA_SYSTEM }, { role: 'user', content: personaUser(rows, previous) }],
        maxTokens: 240, temperature: 0.4, timeoutMs: TEXT_CALL_MS,
    });
}

function personaFrom(answer, seed, previous) {
    if (!answer) return null;
    const j = jsonOf(answer.text);
    if (!j || typeof j !== 'object') return null;
    const name = cleanName(j.name);
    if (!name) return null;
    const topic = cleanTopic(j.topic, previous ? previous.topic : 'a conversation');
    const glyph = GLYPH_SET.has(String(j.glyph || '')) ? String(j.glyph) : null;
    const hue = cleanHue(j.hue, `${name}|${topic}`);
    return { name, topic, glyph, hue };
}

/**
 * A picture an image provider answered with an address: https only, every hop's address checked public by
 * openvibe-shared/egress (DNS rebinding included, through its lookup), at most two redirects, 20 s and 2 MB.
 * Null for anything else.
 */
async function downloadImage(url, hops = 0) {
    const { assertPublicUrl, safeLookup } = require('openvibe-shared/egress');
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || hops > 2) return null;
    try { await assertPublicUrl(u, { protocols: ['https:'] }); } catch { return null; }
    const res = await new Promise((resolve) => {
        const https = require('https');
        const req = https.request(u.href, { method: 'GET', lookup: safeLookup, timeout: 20_000, headers: { accept: 'image/*' } }, (r) => {
            const chunks = []; let size = 0; let over = false;
            r.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { over = true; r.destroy(); return; } chunks.push(c); });
            r.on('end', () => resolve(over ? null : { status: r.statusCode, headers: r.headers, bytes: Buffer.concat(chunks) }));
            r.on('close', () => resolve(over ? null : { status: r.statusCode, headers: r.headers, bytes: Buffer.concat(chunks) }));
            r.on('error', () => resolve(null));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
        req.end();
    });
    if (!res) return null;
    if ([301, 302, 303, 307, 308].includes(Number(res.status)) && res.headers.location) {
        let next; try { next = new URL(String(res.headers.location), u).href; } catch { return null; }
        return downloadImage(next, hops + 1);
    }
    if (res.status !== 200 || !res.bytes.length) return null;
    return { type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), bytes: res.bytes };
}

/** The avatar: one small picture from the image model, uploaded to Media as Chat. Never fatal. */
async function avatarFor(room, persona, key) {
    if (!settings.value('images')) return null;
    if (await capReached()) return null;
    const configured = clean(settings.value('image_model'), 200);
    const model = configured || await modelFor('image');
    const prompt = `A small square avatar picture for a chat called "${persona.name}" about "${persona.topic}". One clear subject, flat vector style, bold simple shapes, centred, no text, no letters, no logos, readable at 48 pixels.`;
    const call = (withModel, suffix) => aiClient.structured('chat.persona.image', {
        ...(withModel ? { model } : {}),
        prompt, size: '256x256', n: 1,
    }, {
        force: true,
        idempotencyKey: `${key}-image${suffix}`,
        onRun: (run) => recordSpend(room.id, 'image', model, run),
    });
    let out = null;
    try {
        out = await call(true, '');
        // Auto names the cheapest image model; an Exchange without that exact model falls back to the
        // image route's own configured model instead of losing the avatar. A model the owner chose is theirs.
        if (!out && !configured) out = await call(false, '-default');
    } catch (err) {
        console.warn('[Vibe persona] image:', err && err.message);
        return null;
    }
    const first = out && Array.isArray(out.images) ? out.images[0] : null;
    if (!first) return null;
    let buffer = null;
    let mimeType = 'image/png';
    try {
        if (typeof first.b64 === 'string' && first.b64.length > 32) {
            buffer = Buffer.from(first.b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''), 'base64');
            const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(first.b64);
            if (m) mimeType = m[1].toLowerCase();
        } else if (typeof first.url === 'string' && first.url) {
            if (/^data:image\//i.test(first.url)) {
                const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(first.url);
                if (m) { mimeType = m[1].toLowerCase(); buffer = Buffer.from(m[2], 'base64'); }
            } else if (/^https:\/\//i.test(first.url)) {
                // The provider's picture address is not ours to trust: the egress guard checks every hop is public.
                const got = await downloadImage(first.url);
                if (!got) return null;
                if (/^image\//.test(got.type)) mimeType = got.type;
                buffer = got.bytes;
            }
        }
        if (!buffer || !buffer.length || buffer.length > 2 * 1024 * 1024) return null;
        const uploaded = await media.uploadObject(buffer, { filename: `vibe-persona-${room.slug}.png`, mimeType });
        return uploaded && uploaded.url ? String(uploaded.url).slice(0, 1000) : null;
    } catch (err) {
        console.warn('[Vibe persona] avatar:', err && err.message);
        return null;
    }
}

// ── storage ──────────────────────────────────────────────────────────────────

const PERSONA_COLUMNS = 'room_id, name, glyph, hue, image_url, topic, made_at, checked_at, checked_count, generation';

function wire(row) {
    if (!row) return null;
    return {
        name: String(row.name || ''),
        glyph: GLYPH_SET.has(String(row.glyph || '')) ? String(row.glyph) : fallbackGlyph(row.name || row.room_id),
        hue: cleanHue(row.hue, row.name || row.room_id),
        image_url: row.image_url ? String(row.image_url) : null,
        topic: String(row.topic || ''),
        made_at: iso(row.made_at),
    };
}

async function forRoom(roomId) {
    return await db.get(`SELECT ${PERSONA_COLUMNS} FROM vibe_personas WHERE room_id = ?`, [Number(roomId)]) || null;
}

async function forRooms(roomIds) {
    const ids = [...new Set((roomIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    const out = new Map();
    if (!ids.length) return out;
    const rows = await db.all(`SELECT ${PERSONA_COLUMNS} FROM vibe_personas WHERE room_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const row of rows) out.set(Number(row.room_id), row);
    return out;
}

const countMessages = async (roomId) => Number((await db.get('SELECT COUNT(*) AS n FROM room_messages WHERE room_id = ? AND is_deleted = 0', [roomId]))?.n) || 0;
const hasAnswer = async (roomId) => !!(await db.get('SELECT 1 AS yes FROM room_messages WHERE room_id = ? AND ai_member_id IS NOT NULL AND is_deleted = 0 LIMIT 1', [roomId]));

async function recentRows(roomId, { limit = HISTORY_FOR_CHECK, first = false } = {}) {
    const rows = await db.all(`SELECT m.id, m.message, m.ai_member_id, m.created_at, u.display_name, u.username
        FROM room_messages m LEFT JOIN ctx_users u ON u.id = m.user_id
        WHERE m.room_id = ? AND m.is_deleted = 0 ORDER BY m.id ${first ? 'ASC' : 'DESC'} LIMIT ?`, [roomId, limit]);
    return first ? rows : rows.reverse();
}

async function firstMessage(roomId) {
    return await db.get('SELECT message FROM room_messages WHERE room_id = ? AND ai_member_id IS NULL AND is_deleted = 0 ORDER BY id LIMIT 1', [roomId]);
}

async function touch(roomId, count) {
    await db.run('UPDATE vibe_personas SET checked_count = ?, checked_at = ov_now() WHERE room_id = ?', [Math.max(0, Number(count) || 0), roomId]);
}

/** The conversation's name follows the persona until the person renames it (rooms.vibe_title_locked). */
async function titleFromPersona(roomId, name, previousName = null) {
    const room = await db.get('SELECT id, name, vibe_title_locked FROM rooms WHERE id = ?', [roomId]);
    if (!room || Number(room.vibe_title_locked)) return;
    const first = await firstMessage(roomId);
    let vibe = null;
    try { vibe = require('../rooms/vibe'); } catch { vibe = null; }
    const auto = first && vibe ? vibe.titleOf(first.message) : (vibe ? vibe.DEFAULT_TITLE : null);
    const current = String(room.name || '').trim();
    // Ours to write: the auto title, the default, or the last persona's own name. Anything else is a rename
    // from before this feature (no lock flag existed); a rename now sets the flag and returns above.
    const ours = !current || current === auto || current === (vibe && vibe.DEFAULT_TITLE) || (previousName && current === previousName);
    if (!ours) return;
    await db.run('UPDATE rooms SET name = ? WHERE id = ? AND COALESCE(vibe_title_locked, 0) = 0', [name, roomId]);
}

async function savePersona(room, persona, { previous, imageUrl, count }) {
    const madeAt = new Date().toISOString();
    const generation = previous ? Number(previous.generation || 1) + 1 : 1;
    await db.run(`INSERT INTO vibe_personas (room_id, name, glyph, hue, image_url, topic, made_at, checked_at, checked_count, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ov_now(), ?, ?)
        ON CONFLICT (room_id) DO UPDATE SET name = excluded.name, glyph = excluded.glyph, hue = excluded.hue,
            image_url = excluded.image_url, topic = excluded.topic, made_at = excluded.made_at,
            checked_at = excluded.checked_at, checked_count = excluded.checked_count, generation = excluded.generation`,
    [room.id, persona.name, persona.glyph, persona.hue, imageUrl, persona.topic, madeAt, Math.max(0, Number(count) || 0), generation]);
    await titleFromPersona(room.id, persona.name, previous && previous.name);
    return await forRoom(room.id);
}

// ── generation ───────────────────────────────────────────────────────────────

/**
 * Make a persona, or remake one. `previous` is the row being replaced; `count` is the message count this
 * generation read. Every call is idempotent under `key`; an invalid glyph or name is retried once and then
 * replaced from the registry, so a persona is never stored with an unknown icon.
 */
async function generate(room, { previous = null, mode = 'first', count = 0, key = null } = {}) {
    if (!settings.available() || !settings.value('enabled')) return null;
    if (await capReached()) return null;
    const rows = mode === 'first'
        ? await recentRows(room.id, { limit: HISTORY_FOR_FIRST, first: true })
        : await recentRows(room.id, { limit: HISTORY_FOR_CHECK });
    if (!rows.length) return null;
    const baseKey = key || `chat-persona-${room.id}-${mode}-${previous ? `${previous.generation}-${count}` : count || 'first'}`;
    let answer = await askForPersona(room, rows, previous, baseKey);
    let parsed = personaFrom(answer, `${room.id}|${count}`, previous);
    if (!parsed || !parsed.glyph) {
        // One retry with the failure named: a model can answer "None" for a glyph, or prose instead of JSON.
        if (!(await capReached())) {
            const retry = await callModel({
                roomId: room.id, kind: 'text', model: await modelFor('chat'), key: `${baseKey}-retry`,
                messages: [{ role: 'system', content: PERSONA_SYSTEM }, { role: 'user', content: `${personaUser(rows, previous)}\n\nYour previous answer was not usable (${!parsed ? 'not the JSON object' : `glyph "${parsed.glyph || ''}" is not in the list`}). Answer again with the JSON object only and a glyph from the list.` }],
                maxTokens: 240, temperature: 0.2, timeoutMs: TEXT_CALL_MS,
            });
            parsed = personaFrom(retry, `${room.id}|${count}|retry`, previous) || parsed;
        }
    }
    if (!parsed) return null;
    const persona = {
        name: parsed.name,
        glyph: parsed.glyph || fallbackGlyph(`${parsed.name}|${parsed.topic}`),
        hue: parsed.hue,
        topic: parsed.topic,
    };
    let imageUrl = null;
    if (settings.value('images')) imageUrl = await avatarFor(room, persona, baseKey);
    // A remake with no new picture keeps the old one rather than dropping a face the chat already had.
    if (!imageUrl && previous && previous.image_url) imageUrl = previous.image_url;
    const finalCount = await countMessages(room.id);
    const row = await savePersona(room, persona, { previous, imageUrl, count: finalCount });
    return wire(row);
}

async function topicChanged(room, persona, count) {
    if (await capReached()) return null;
    const rows = await recentRows(room.id, { limit: HISTORY_FOR_CHECK });
    const model = await modelFor('chat');
    const answer = await callModel({
        roomId: room.id, kind: 'text', model, key: `chat-persona-${room.id}-check-${count}`,
        messages: [{ role: 'system', content: CHECK_SYSTEM }, { role: 'user', content: checkUser(rows, persona) }],
        maxTokens: 4, temperature: 0, timeoutMs: TEXT_CALL_MS,
    });
    if (!answer) return null;
    return yesOf(answer.text);
}

/**
 * The engine's due check. Never called from a request path directly: afterPost() schedules it, and the admin
 * remake awaits its own call. One per room at a time; every model call is idempotent under the room and the
 * generation it reads.
 */
async function maybe(roomLike) {
    if (!settings.available() || !settings.value('enabled')) return null;
    const id = Number(roomLike && roomLike.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    const room = await db.get("SELECT * FROM rooms WHERE id = ? AND assistant = 1 AND archived_at IS NULL", [id]);
    if (!room || inFlight.has(id)) return null;
    // Claim the room before the first await: two answers arriving together must make one persona, not two.
    inFlight.add(id);
    try {
        const persona = await forRoom(id);
        const count = await countMessages(id);
        if (!persona && !(await hasAnswer(id))) return null;
        if (persona) {
            const every = clampInt(settings.value('check_every'), 2, 100, 8);
            if (count - Number(persona.checked_count || 0) < every) return null;
        }
        if (await capReached()) return null;
        if (!persona) return await generate(room, { mode: 'first', count });
        const changed = await topicChanged(room, persona, count);
        if (changed === true) {
            try { return await generate(room, { previous: persona, mode: 'change', count }); }
            finally { await touch(id, await countMessages(id)); }
        }
        // NO, or a check that could not answer: wait another interval instead of asking on every message.
        await touch(id, count);
        return null;
    } finally { inFlight.delete(id); }
}

/** Called after Vibe answered: schedules the due check and returns at once, never blocking the reply. */
function afterAnswer(room) {
    const id = Number(room && room.id);
    if (!Number.isFinite(id) || id <= 0) return;
    setImmediate(() => {
        maybe({ id }).catch((err) => console.warn(`[Vibe persona] room ${id}: ${err && err.message}`));
    });
}

/** The admin's "remake one conversation": awaited, cap-respecting, one at a time. */
async function remake(slug, ownerId) {
    if (!settings.available()) fail(503, 'persona.unavailable', 'Persona settings are not available right now');
    if (!settings.value('enabled')) fail(409, 'persona.disabled', 'Vibe personas are off; turn them on at /admin/persona first');
    // Only the owner's own conversations: other people's Vibe chats are private (a persona's topic summarises them).
    const room = await db.get('SELECT * FROM rooms WHERE slug = ? AND owner_id = ? AND assistant = 1 AND archived_at IS NULL', [String(slug || ''), Number(ownerId) || 0]);
    if (!room) fail(404, 'persona.not_found', 'No such Vibe conversation');
    if (inFlight.has(room.id)) fail(409, 'persona.busy', 'That conversation is already making a persona; try again in a moment');
    if (await capReached()) fail(409, 'persona.cap', 'The monthly persona spend cap is reached; raise it on /admin/persona or wait for next month');
    const count = await countMessages(room.id);
    if (!(await hasAnswer(room.id))) fail(409, 'persona.no_answer', 'This conversation has no answer to name yet');
    const previous = await forRoom(room.id);
    inFlight.add(room.id);
    try {
        const made = await generate(room, { previous, mode: previous ? 'remake' : 'first', count, key: `chat-persona-${room.id}-remake-${Date.now()}` });
        if (!made) fail(502, 'persona.failed', 'The model did not answer with a usable persona; try again');
        return made;
    } finally { inFlight.delete(room.id); }
}

// ── admin ────────────────────────────────────────────────────────────────────

async function conversations({ limit = 60, ownerId = 0 } = {}) {
    const rows = await db.all(`SELECT r.id, r.slug, r.name, r.last_message_at, r.created_at,
            p.name AS persona_name, p.glyph, p.hue, p.image_url, p.topic, p.made_at,
            COALESCE(u.display_name, u.username, 'person ' || r.owner_id) AS owner,
            (SELECT COUNT(*) FROM room_messages m WHERE m.room_id = r.id AND m.is_deleted = 0) AS messages
        FROM rooms r
        LEFT JOIN vibe_personas p ON p.room_id = r.id
        LEFT JOIN ctx_users u ON u.id = r.owner_id
        WHERE r.assistant = 1 AND r.archived_at IS NULL AND r.owner_id = ?
        ORDER BY COALESCE(r.last_message_at, r.created_at) DESC, r.id DESC LIMIT ?`, [Number(ownerId) || 0, Math.min(200, Math.max(1, Number(limit) || 60))]);
    return rows.map((r) => ({
        slug: r.slug, name: r.name, owner: r.owner, messages: Number(r.messages) || 0,
        last_message_at: iso(r.last_message_at || r.created_at),
        persona: r.persona_name ? wire({ name: r.persona_name, glyph: r.glyph, hue: r.hue, image_url: r.image_url, topic: r.topic, made_at: r.made_at }) : null,
    }));
}

function modelOptionsOf(list, kind) {
    const out = [];
    for (const model of list) {
        if ((model.kind || 'chat') !== kind) continue;
        const id = modelIdOf(model);
        if (!id) continue;
        const price = offerPrice(model);
        out.push({ id, name: String(model.name || id), price });
    }
    out.sort((a, b) => {
        const pa = a.price ? a.price.score : Number.POSITIVE_INFINITY;
        const pb = b.price ? b.price.score : Number.POSITIVE_INFINITY;
        return pa - pb || a.name.localeCompare(b.name);
    });
    const capped = out.slice(0, 60);
    const configured = clean(settings.value(kind === 'image' ? 'image_model' : 'text_model'), 200);
    if (configured && !capped.some((m) => m.id === configured)) {
        const found = out.find((m) => m.id === configured);
        if (found) capped.push(found);
    }
    return capped;
}

/** The settings, the month's spend (everyone's, no content) and the owner's OWN conversations. */
async function state(ownerId = 0) {
    const all = settings.all();
    const month = monthKey();
    const spent = await spendThisMonth();
    const cap = Number(all.monthly_cap_usd);
    let catalog = [];
    try { catalog = await models(); } catch { catalog = []; }
    return {
        settings: all,
        defaults: settings.DEFAULTS,
        revision: settings.current() && settings.current().revision ? settings.current().revision() : null,
        month,
        spend: {
            month, usd: Math.round(spent * 1e6) / 1e6, cap_usd: cap,
            remaining_usd: Math.max(0, Math.round((cap - spent) * 1e6) / 1e6),
            reached: !(cap > 0) || spent >= cap,
        },
        models: { text: modelOptionsOf(catalog, 'chat'), image: modelOptionsOf(catalog, 'image') },
        conversations: await conversations({ limit: 60, ownerId }),
        last_problem: Object.fromEntries(lastProblem),
    };
}

const MODEL_RE = /^[a-z0-9][a-z0-9._/@:-]{1,255}$/i;

async function update(input, { actor = null, reason = 'Vibe persona settings', ownerId = 0 } = {}) {
    if (!settings.available()) fail(503, 'persona.unavailable', 'Persona settings are not available right now');
    const b = input && typeof input === 'object' ? input : {};
    const changes = {};
    if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean' && b.enabled !== 'true' && b.enabled !== 'false' && b.enabled !== 1 && b.enabled !== 0) fail(422, 'persona.enabled', 'enabled is true or false');
        changes.enabled = b.enabled === true || b.enabled === 'true' || b.enabled === 1;
    }
    for (const [key, code] of [['text_model', 'persona.text_model'], ['image_model', 'persona.image_model']]) {
        if (b[key] === undefined) continue;
        const value = clean(b[key], 200);
        if (value && !MODEL_RE.test(value)) fail(422, code, 'A model id is letters, digits, dots, dashes, underscores, slashes or colons');
        changes[key] = value;
    }
    if (b.images !== undefined) {
        if (typeof b.images !== 'boolean' && b.images !== 'true' && b.images !== 'false' && b.images !== 1 && b.images !== 0) fail(422, 'persona.images', 'images is true or false');
        changes.images = b.images === true || b.images === 'true' || b.images === 1;
    }
    if (b.check_every !== undefined) {
        const n = Number(b.check_every);
        if (!Number.isFinite(n) || n < 2 || n > 100) fail(422, 'persona.check_every', 'Messages between topic checks is from 2 to 100');
        changes.check_every = Math.round(n);
    }
    if (b.monthly_cap_usd !== undefined) {
        const n = Number(b.monthly_cap_usd);
        if (!Number.isFinite(n) || n < 0 || n > 1000) fail(422, 'persona.cap', 'The monthly cap is from 0 to 1000 US dollars');
        changes.monthly_cap_usd = Math.round(n * 1e6) / 1e6;
    }
    if (!Object.keys(changes).length) return await state(ownerId);
    try {
        await settings.current().apply(changes, { merge: true, actor, reason: String(reason).slice(0, 300) });
    } catch (err) {
        if (err && err.status) fail(err.status, err.code || 'persona.settings', err.message);
        throw err;
    }
    return await state(ownerId);
}

/** For tests: forget in-process locks and the catalogue cache. Never forgets the owner's stored settings. */
function _reset() {
    inFlight.clear();
    catalogCache.at = 0;
    catalogCache.value = null;
    lastProblem.clear();
}

module.exports = {
    PersonaError, GLYPH_NAMES, GLYPH_CHOICES, MAX_NAME, MAX_TOPIC,
    wire, forRoom, forRooms, afterAnswer, maybe, remake, generate, state, update, conversations,
    spendThisMonth, capReached, cheapestModel, modelFor, _reset,
    // Read by tests that want to prove the prompts and validators without a network.
    cleanName, cleanTopic, cleanHue, jsonOf, yesOf, iso,
};
