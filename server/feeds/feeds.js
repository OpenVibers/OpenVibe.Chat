'use strict';
/**
 * Feeds (docs/platform.md step 2; migrations/0017_feeds.sql): live activity a person publishes into Chat. Vibe coding,
 * moved here from OpenVibe.Live (its server/vibe-coding/, same canonical events), is the first kind: an editor, agent or
 * CLI sends sanitized events (a prompt, an answer, a tool used, a file saved) with the feed's key, and viewers see a
 * compact card in the feed's room, on its Live channel slot while live, or on any site (openvibe.chat/embed/feed/:id).
 *
 *   feeds        create(user, input) → { feed, key } · update(feed, user, input) · rotateKey(feed) → key · remove(feed) ·
 *                get(id) · byKey(key) · mine(user) · forSlots(ids) · forRoom(roomId) · publicShape(feed)
 *   publishing   hello(feed, msg) · publish(feed, input) → [{ eventId, delivered }] · fromClaudeCode(hook) → events
 *   viewing      view(feed, { limit }) → { feed, publisher, events } · project(event, settings)
 *
 * What a viewer sees is decided when they see it: project() applies the feed's settings to the stored event (the
 * projection is Live's), so turning prompts off hides them in the history too. Events are scrubbed of secrets (keys,
 * tokens, passwords, private keys) and home folders on the way in, and reach viewers only after the feed's delay, kept
 * on the server (Live sent the delay to the browser). A feed keeps its newest 5,000 events.
 */
const crypto = require('crypto');
const path = require('path');
const db = require('../db/database');
const wordFilter = require('../chat/word-filter');

class FeedError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new FeedError(status, code, message); };

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = () => `fed_${Array.from(crypto.randomBytes(26), (b) => B32[b % 32]).join('')}`;
const newKey = () => `ovf_${crypto.randomBytes(24).toString('base64url')}`;
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const FEED_RE = /^fed_[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY_RE = /^ovf_[A-Za-z0-9_-]{32}$/;
const MAX_FEEDS = 10;
const KEEP_EVENTS = 5000;
const MAX_BATCH = 50;
const TYPES = ['session.status', 'prompt', 'response', 'thinking', 'tool.call', 'file.change', 'file.save'];

const DEFAULTS = Object.freeze({
    enabled: 1,
    viewer_depth: 'standard',
    show_prompts: 1,
    show_responses: 1,
    show_thinking: 0,
    show_tool_calls: 1,
    show_tool_arguments: 0,
    show_file_events: 1,
    show_file_snippets: 0,
    redact_file_paths: 1,
    paused: 0,
    delay_ms: 0,
    max_events: 18,
    max_prompt_chars: 220,
    max_response_chars: 360,
    max_thinking_chars: 140,
    max_tool_chars: 140,
    max_snippet_chars: 140,
});

const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const str = (v, max = 200) => { const s = clean(v, max); return s || null; };
const bool = (v, d) => (v === undefined || v === null ? d : (v === true || v === 1 || v === '1' || v === 'on' || v === 'true') ? 1 : 0);
const int = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };
const depthOf = (v) => (['headline', 'deep'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'standard');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const iso = (t) => (t ? (String(t).includes('T') ? String(t) : `${String(t).replace(' ', 'T')}Z`) : null);   // ov_now() is UTC text
const json = (v, d) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || 'null') || d; } catch { return d; } };

function normalizeSettings(input = {}, current = DEFAULTS) {
    const s = { ...DEFAULTS, ...current };
    const out = {};
    for (const k of ['enabled', 'show_prompts', 'show_responses', 'show_thinking', 'show_tool_calls', 'show_tool_arguments', 'show_file_events', 'show_file_snippets', 'redact_file_paths', 'paused']) out[k] = bool(input[k], s[k]);
    out.viewer_depth = depthOf(input.viewer_depth !== undefined ? input.viewer_depth : s.viewer_depth);
    const n = (k, min, max) => { out[k] = int(input[k] !== undefined ? input[k] : s[k], min, max, DEFAULTS[k]); };
    n('delay_ms', 0, 120000); n('max_events', 1, 100); n('max_prompt_chars', 60, 1200); n('max_response_chars', 80, 2400);
    n('max_thinking_chars', 40, 1200); n('max_tool_chars', 40, 1200); n('max_snippet_chars', 40, 1200);
    return out;
}

// ── Scrubbing: what a publisher should never have sent ─────────────────────────────────────────────────────────────
const HIDDEN = '[hidden]';
const SECRETS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    /\b(?:hbt|ovf|ovs|whsec)_[A-Za-z0-9_-]{8,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
function scrubText(s) {
    let t = String(s);
    for (const re of SECRETS) t = t.replace(re, HIDDEN);
    return t
        .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${HIDDEN}`)
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${HIDDEN}@`)
        .replace(/\b((?:[A-Z0-9_]*_)?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${HIDDEN}`)
        .replace(/(?:\/home|\/Users)\/[^/\s"'`]+/g, '~')
        .replace(/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '~');
}
function scrub(v, depth = 0) {
    if (depth > 6) return null;
    if (typeof v === 'string') return scrubText(v).slice(0, 8000);
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 60)) o[k] = scrub(x, depth + 1); return o; }
    return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : null;
}

// ── Feeds ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function shape(r) {
    if (!r) return null;
    return {
        id: r.id, owner_id: Number(r.owner_id), kind: r.kind, title: r.title,
        room_id: r.room_id == null ? null : Number(r.room_id), managed_stream_id: r.managed_stream_id == null ? null : Number(r.managed_stream_id),
        settings: normalizeSettings({}, json(r.settings, {})), key_hint: r.key_hint || null, legacy_source: r.legacy_source || null,
        created_at: iso(r.created_at), last_event_at: iso(r.last_event_at),
    };
}
/** What anyone may know about a feed (the embed, the room card, Live's channel). */
function publicShape(feed) {
    return { id: feed.id, kind: feed.kind, title: feed.title, enabled: !!feed.settings.enabled && !feed.settings.paused, depth: feed.settings.viewer_depth, last_event_at: feed.last_event_at };
}

async function get(id) {
    if (!FEED_RE.test(String(id || ''))) return null;
    return shape(await db.get('SELECT * FROM feeds WHERE id = ? AND archived_at IS NULL', [id]));
}
async function byKey(key) {
    if (!KEY_RE.test(String(key || ''))) return null;
    return shape(await db.get('SELECT * FROM feeds WHERE key_hash = ? AND archived_at IS NULL', [hashKey(key)]));
}
async function mine(user) {
    return (await db.all('SELECT * FROM feeds WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id', [user.id])).map(shape);
}
async function forSlots(ids) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 50);
    if (!list.length) return [];
    return (await db.all(`SELECT * FROM feeds WHERE managed_stream_id IN (${list.map(() => '?').join(',')}) AND archived_at IS NULL ORDER BY last_event_at DESC NULLS LAST`, list)).map(shape);
}
/** The feed a room shows (the most recently active one its owner put there that viewers may see), or null. */
async function forRoom(roomId) {
    const list = (await db.all('SELECT * FROM feeds WHERE room_id = ? AND archived_at IS NULL ORDER BY last_event_at DESC NULLS LAST LIMIT 5', [roomId])).map(shape);
    return list.find((f) => f.settings.enabled && !f.settings.paused) || null;
}

// Where a feed shows: a room the person owns, a channel slot of theirs. null clears it.
async function placeOf(user, input, current = {}) {
    const out = {};
    if (input.room !== undefined || input.room_id !== undefined) {
        const v = input.room !== undefined ? input.room : input.room_id;
        if (v === null || v === '' || v === 0 || v === '0') out.room_id = null;
        else {
            const rooms = require('../rooms/rooms');
            const room = /^\d+$/.test(String(v)) ? await db.get('SELECT * FROM rooms WHERE id = ?', [Number(v)]) : await rooms.bySlug(String(v));
            if (!room || room.assistant) fail(422, 'feeds.room', 'No such room');
            if (!(await rooms.access(room, user)).manage) fail(403, 'feeds.room', 'A feed shows only in a room you own');
            out.room_id = Number(room.id);
        }
    }
    if (input.slot !== undefined || input.managed_stream_id !== undefined) {
        const v = input.slot !== undefined ? input.slot : input.managed_stream_id;
        if (v === null || v === '' || v === 0 || v === '0') out.managed_stream_id = null;
        else {
            const ms = await db.get('SELECT id, user_id FROM ctx_managed_streams WHERE id = ?', [Number(v)]);
            if (!ms || Number(ms.user_id) !== Number(user.id)) fail(403, 'feeds.slot', 'A feed shows only on a channel slot of yours');
            out.managed_stream_id = Number(ms.id);
        }
    }
    return { room_id: current.room_id ?? null, managed_stream_id: current.managed_stream_id ?? null, ...out };
}

function titleOf(v) {
    const t = clean(v, 81).replace(/\s+/g, ' ');
    if (t.length < 2 || t.length > 80) fail(422, 'feeds.title', 'A feed\'s title is 2 to 80 characters');
    if (wordFilter.check(t).safe === false) fail(422, 'feeds.title', 'That title is not allowed');
    return t;
}

async function create(user, input = {}) {
    const n = await db.get('SELECT count(*)::int AS n FROM feeds WHERE owner_id = ? AND archived_at IS NULL', [user.id]);
    if (n.n >= MAX_FEEDS) fail(409, 'feeds.too_many', `At most ${MAX_FEEDS} feeds`);
    const title = titleOf(input.title || 'Vibe coding');
    const place = await placeOf(user, input);
    const id = newId();
    const key = newKey();
    await db.run(`INSERT INTO feeds (id, owner_id, owner_subject, title, room_id, managed_stream_id, settings, key_hash, key_hint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, user.id, user.subject_id || null, title, place.room_id, place.managed_stream_id,
        JSON.stringify(normalizeSettings(obj(input.settings) || {})), hashKey(key), key.slice(-4)]);
    return { feed: await get(id), key };
}
async function update(feed, user, input = {}) {
    const title = input.title !== undefined ? titleOf(input.title) : feed.title;
    const place = await placeOf(user, input, feed);
    const settings = normalizeSettings(obj(input.settings) || {}, feed.settings);
    await db.run('UPDATE feeds SET title = ?, room_id = ?, managed_stream_id = ?, settings = ? WHERE id = ?',
        [title, place.room_id, place.managed_stream_id, JSON.stringify(settings), feed.id]);
    return await get(feed.id);
}
async function rotateKey(feed) {
    const key = newKey();
    await db.run('UPDATE feeds SET key_hash = ?, key_hint = ? WHERE id = ?', [hashKey(key), key.slice(-4), feed.id]);
    return key;
}
async function remove(feed) {
    await db.run('DELETE FROM feed_events WHERE feed_id = ?', [feed.id]);
    await db.run('DELETE FROM feed_sessions WHERE feed_id = ?', [feed.id]);
    await db.run('DELETE FROM feeds WHERE id = ?', [feed.id]);
}

// ── Publishing ─────────────────────────────────────────────────────────────────────────────────────────────────────

function publisherOf(p) {
    const s = obj(p) || {};
    const caps = obj(s.capabilities) || {};
    const clientType = String(s.clientType || '').toLowerCase();
    return {
        integrationId: str(s.integrationId, 60) || 'custom',
        integrationLabel: str(s.integrationLabel, 60) || str(s.integrationId, 60) || 'Custom publisher',
        vendor: str(s.vendor, 60),
        clientType: ['vscode-extension', 'cli', 'browser', 'service'].includes(clientType) ? clientType : 'other',
        clientName: str(s.clientName, 80) || str(s.integrationLabel, 80) || 'Custom publisher',
        clientVersion: str(s.clientVersion || s.extensionVersion, 40),
        workspaceName: str(s.workspaceName, 80),
        machineName: null,                     // never shown; Live kept it, Chat does not
        viewerDepth: depthOf(s.viewerDepth),
        capabilities: { thinking: !!caps.thinking, toolCalls: !!caps.toolCalls, workspaceFileEvents: !!caps.workspaceFileEvents },
    };
}
const eventPublisher = (p) => { const x = publisherOf(p); return { integrationId: x.integrationId, integrationLabel: x.integrationLabel, vendor: x.vendor, clientType: x.clientType, clientName: x.clientName }; };

/** One canonical event from what a publisher sent (Live's envelope, the bare event, or a short { type, text }). */
function normalizeEvent(input, fallbackSession) {
    let e = obj(input);
    if (!e) fail(422, 'feeds.event', 'An event is an object');
    if (e.type === 'vibe-coding.event') e = obj(e.event) || fail(422, 'feeds.event', 'The envelope has no event');
    const type = String(e.eventType || e.type || '');
    if (!TYPES.includes(type)) fail(422, 'feeds.event_type', `eventType is one of ${TYPES.join(', ')}`);
    const text = (k) => str((obj(e[k]) && e[k].text) || (e.text && (type === k) ? e.text : null), 8000);
    const out = {
        version: 1,
        eventId: str(e.eventId || e.id, 100) || crypto.randomUUID(),
        sessionKey: str(e.sessionKey, 120) || fallbackSession || 'default',
        sequence: int(e.sequence, 0, Number.MAX_SAFE_INTEGER, 0),
        eventType: type,
        visibility: 'public',
        occurredAt: str(e.occurredAt, 40) || new Date().toISOString(),
        summary: str(e.summary, 2000) || '',
        source: obj(e.source) ? { channel: str(e.source.channel, 60), rawType: str(e.source.rawType, 60) } : null,
        publisher: obj(e.publisher) ? eventPublisher(e.publisher) : null,
        metadata: obj(e.metadata) ? { requestId: str(e.metadata.requestId, 100), responseId: str(e.metadata.responseId, 100), workspaceName: str(e.metadata.workspaceName, 80), model: str(e.metadata.model, 80) } : null,
    };
    if (type === 'prompt') out.prompt = { text: text('prompt') || out.summary };
    if (type === 'response') out.response = { text: text('response') || out.summary };
    if (type === 'thinking') out.thinking = { text: text('thinking') || out.summary };
    if (type === 'tool.call') {
        const t = obj(e.tool) || {};
        out.tool = { name: str(t.name || e.name, 80) || 'tool', phase: str(t.phase, 20) || 'completed', argumentsPreview: str(t.argumentsPreview || e.args, 2000), resultPreview: str(t.resultPreview, 2000) };
    }
    if (type === 'file.change' || type === 'file.save') {
        const f = obj(e.file) || {};
        const rel = str(f.relativePath || e.path, 400);
        out.file = { name: str(f.name, 200) || (rel ? path.posix.basename(rel.replace(/\\/g, '/')) : 'file'), relativePath: rel, operation: str(f.operation, 20) || (type === 'file.save' ? 'save' : 'edit'), changeCount: int(f.changeCount, 0, 1e6, 0), snippet: str(f.snippet, 2000) };
    }
    if (!out.summary) out.summary = (out.prompt || out.response || out.thinking || {}).text || '';
    return scrub(out);
}

function deliverer(deps) {
    return deps.deliver || ((feed, event) => { try { require('../chat/chat-server').deliverFeed(feed, event); } catch { /* no socket server (tests) */ } });
}

/** A publisher starts (or resumes) a session: who it is. */
async function hello(feed, msg = {}) {
    const key = str(msg.sessionKey, 120) || 'default';
    const publisher = publisherOf(msg.publisher);
    await db.run(`INSERT INTO feed_sessions (feed_id, session_key, publisher, status, last_event_at) VALUES (?, ?, ?, 'active', ov_now())
        ON CONFLICT (feed_id, session_key) DO UPDATE SET publisher = excluded.publisher, status = 'active', ended_at = NULL, last_event_at = ov_now()`,
    [feed.id, key, JSON.stringify(publisher)]);
    return { sessionKey: key, publisher };
}

/**
 * Store and deliver events: one, { events: [...] } (at most 50), or Live's envelopes. A repeated eventId replaces the
 * stored one and is not delivered again. → [{ eventId, delivered }]
 */
async function publish(feed, input, deps = {}) {
    const list = Array.isArray(input) ? input : Array.isArray(input && input.events) ? input.events : [input];
    if (!list.length) fail(422, 'feeds.empty', 'No events');
    if (list.length > MAX_BATCH) fail(413, 'feeds.batch', `At most ${MAX_BATCH} events at once`);
    const events = list.map((e) => normalizeEvent(e, input && input.sessionKey));
    const deliver = deliverer(deps);
    const now = Date.now();
    const out = [];
    for (const event of events) {
        const r = await db.get(`INSERT INTO feed_events (feed_id, session_key, event_id, seq, type, summary, payload, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (feed_id, event_id) DO UPDATE SET seq = excluded.seq, type = excluded.type, summary = excluded.summary, payload = excluded.payload
            RETURNING (xmax = 0) AS fresh`, [feed.id, event.sessionKey, event.eventId, event.sequence, event.eventType, event.summary.slice(0, 2000), JSON.stringify(event), now]);
        await db.run(`INSERT INTO feed_sessions (feed_id, session_key, publisher, status, last_event_at) VALUES (?, ?, ?, 'active', ov_now())
            ON CONFLICT (feed_id, session_key) DO UPDATE SET last_event_at = ov_now()${event.eventType === 'session.status' && /\bend(ed)?\b/i.test(event.summary) ? ", status = 'ended', ended_at = ov_now()" : ''}`,
        [feed.id, event.sessionKey, JSON.stringify(event.publisher || {})]);
        const fresh = !!(r && r.fresh);
        const viewed = fresh ? project(event, feed.settings) : null;
        // The delay is the server's: a viewer cannot read ahead of it (the history waits for it too, in view()).
        if (viewed && feed.settings.delay_ms) setTimeout(() => deliver(feed, viewed), feed.settings.delay_ms).unref();
        else if (viewed) deliver(feed, viewed);
        out.push({ eventId: event.eventId, delivered: !!viewed });
    }
    await db.run('UPDATE feeds SET last_event_at = ov_now() WHERE id = ?', [feed.id]);
    if (Math.random() < 0.02) await prune(feed.id);
    return out;
}
async function prune(feedId) {
    await db.run(`DELETE FROM feed_events WHERE feed_id = ? AND id < (SELECT id FROM feed_events WHERE feed_id = ? ORDER BY id DESC OFFSET ? LIMIT 1)`, [feedId, feedId, KEEP_EVENTS - 1]);
}

// Claude Code's hooks (an "http" hook POSTs each event's JSON): what a viewer may see of a prompt, a tool used, a
// turn's answer. Paths become relative to the session's folder; nothing is read from the transcript.
const CC = { integrationId: 'claude-code', integrationLabel: 'Claude Code', vendor: 'Anthropic', clientType: 'cli', clientName: 'Claude Code' };
function relTo(cwd, p) {
    const s = String(p || '');
    if (cwd && s.startsWith(String(cwd).replace(/\/+$/, '') + '/')) return s.slice(String(cwd).replace(/\/+$/, '').length + 1);
    return s;
}
function fromClaudeCode(h) {
    const hook = obj(h) || {};
    const sessionKey = `cc-${clean(hook.session_id, 80) || 'session'}`;
    const base = { sessionKey, publisher: CC, metadata: { model: str(obj(hook.model) ? hook.model.id || hook.model.display_name : hook.model, 80), workspaceName: hook.cwd ? path.basename(String(hook.cwd)) : null } };
    const id = (suffix) => `${sessionKey}-${clean(hook.tool_use_id || hook.prompt_id || '', 80) || crypto.randomUUID()}${suffix}`;
    switch (hook.hook_event_name) {
        case 'SessionStart': return [{ ...base, eventId: id('-start'), eventType: 'session.status', summary: hook.source === 'resume' ? 'Resumed a Claude Code session' : 'Started a Claude Code session' }];
        case 'SessionEnd': return [{ ...base, eventId: id('-end'), eventType: 'session.status', summary: 'Session ended' }];
        case 'UserPromptSubmit': return hook.prompt ? [{ ...base, eventId: id('-prompt'), eventType: 'prompt', prompt: { text: String(hook.prompt) } }] : [];
        case 'Stop': return hook.last_assistant_message ? [{ ...base, eventId: id(`-answer-${Date.now()}`), eventType: 'response', response: { text: String(hook.last_assistant_message) } }] : [];
        case 'PostToolUse': {
            const name = clean(hook.tool_name, 80) || 'tool';
            const input = obj(hook.tool_input) || {};
            const file = input.file_path || input.notebook_path || null;
            const rel = file ? relTo(hook.cwd, file) : null;
            const arg = input.command || rel || input.pattern || input.url || input.query || input.description || null;
            // A file written or edited is a file event (the feed's file settings apply), not a tool used as well.
            if (rel && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
                return [{ ...base, eventId: id('-file'), eventType: name === 'Write' ? 'file.save' : 'file.change', file: { relativePath: rel, operation: name === 'Write' ? 'write' : 'edit', changeCount: Array.isArray(input.edits) ? input.edits.length : 1 } }];
            }
            const what = { Bash: 'Ran a command', Read: `Read ${rel || 'a file'}`, Grep: 'Searched the code', Glob: 'Looked for files', WebFetch: 'Read a web page', WebSearch: 'Searched the web', Task: 'Started a helper', Agent: 'Started a helper' }[name];
            return [{ ...base, eventId: id('-tool'), eventType: 'tool.call', summary: what || `Used ${name}`, tool: { name, phase: 'completed', argumentsPreview: arg ? String(arg) : null, resultPreview: null } }];
        }
        default: return [];
    }
}

// ── Viewing ────────────────────────────────────────────────────────────────────────────────────────────────────────

function cut(value, max, depth) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const limit = depth === 'headline' ? Math.max(40, Math.floor(max * 0.6)) : depth === 'deep' ? Math.max(max, Math.floor(max * 1.1)) : max;
    return text.length <= limit ? text : `${text.slice(0, Math.max(20, limit - 1)).trim()}…`;
}
const TOOL_PREVIEW_ALWAYS = ['run_in_terminal', 'create_and_run_task', 'run_notebook_cell'];

/** What a viewer sees of a stored event under these settings, or null (Live's projectViewerEvent). */
function project(event, settings) {
    if (!event || !settings || !settings.enabled || settings.paused) return null;
    const d = settings.viewer_depth;
    const p = {
        eventId: event.eventId, eventType: event.eventType, occurredAt: event.occurredAt, sequence: event.sequence, depth: d,
        summary: '', source: event.source || null, prompt: null, response: null, thinking: null, tool: null, file: null,
        publisher: event.publisher ? eventPublisher(event.publisher) : null,
        metadata: { requestId: event.metadata?.requestId || null, responseId: event.metadata?.responseId || null, workspaceName: event.metadata?.workspaceName || null, model: event.metadata?.model || null },
    };
    switch (event.eventType) {
        case 'session.status': p.summary = cut(event.summary, settings.max_prompt_chars, d); return p;
        case 'prompt': if (!settings.show_prompts) return null; p.summary = cut(event.prompt?.text || event.summary, settings.max_prompt_chars, d); p.prompt = { text: p.summary }; return p;
        case 'response': if (!settings.show_responses) return null; p.summary = cut(event.response?.text || event.summary, settings.max_response_chars, d); p.response = { text: p.summary }; return p;
        case 'thinking': if (!settings.show_thinking) return null; p.summary = cut(event.thinking?.text || event.summary, settings.max_thinking_chars, d); p.thinking = { text: p.summary }; return p;
        case 'tool.call': {
            if (!settings.show_tool_calls) return null;
            const preview = settings.show_tool_arguments || TOOL_PREVIEW_ALWAYS.includes(String(event.tool?.name || '').toLowerCase());
            p.summary = cut(event.summary || `Used ${event.tool?.name || 'tool'}`, settings.max_tool_chars, d);
            p.tool = { name: event.tool?.name || 'tool', phase: event.tool?.phase || 'completed', argumentsPreview: preview ? cut(event.tool?.argumentsPreview, settings.max_tool_chars, d) || null : null, resultPreview: preview ? cut(event.tool?.resultPreview, settings.max_tool_chars, d) || null : null };
            if (!preview && settings.redact_file_paths) p.summary = p.summary.replace(/[\w.~/-]*\/([\w.-]+)/g, '$1');
            return p;
        }
        case 'file.change': case 'file.save': {
            if (!settings.show_file_events) return null;
            const raw = String(event.file?.relativePath || event.file?.name || '').trim();
            const shown = settings.redact_file_paths ? path.posix.basename(raw.replace(/\\/g, '/')) : raw;
            p.summary = `${event.eventType === 'file.save' ? 'Saved' : 'Editing'} ${shown || event.file?.name || 'file'}`;
            p.file = { name: event.file?.name || shown || 'file', relativePath: shown || null, operation: event.file?.operation || (event.eventType === 'file.save' ? 'save' : 'edit'), changeCount: Number(event.file?.changeCount || 0), snippet: settings.show_file_snippets ? cut(event.file?.snippet, settings.max_snippet_chars, d) || null : null };
            return p;
        }
        default: return null;
    }
}

/** The feed as a viewer sees it now: its newest events, older than its delay, projected. */
async function view(feed, { limit } = {}) {
    const n = int(limit, 1, 100, feed.settings.max_events);
    const before = Date.now() - feed.settings.delay_ms;
    const rows = await db.all('SELECT payload FROM feed_events WHERE feed_id = ? AND received_ms <= ? ORDER BY id DESC LIMIT ?', [feed.id, before, n * 3]);
    const events = rows.map((r) => project(json(r.payload, null), feed.settings)).filter(Boolean).slice(0, n).reverse();
    const s = await db.get("SELECT publisher FROM feed_sessions WHERE feed_id = ? ORDER BY COALESCE(last_event_at, created_at) DESC, id DESC LIMIT 1", [feed.id]);
    return { feed: publicShape(feed), publisher: s ? publisherOf(json(s.publisher, {})) : null, events };
}

function _reset() { /* no module state */ }

module.exports = {
    FeedError, FEED_RE, KEY_RE, TYPES, DEFAULTS, MAX_FEEDS, KEEP_EVENTS, MAX_BATCH, hashKey,
    normalizeSettings, scrubText, scrub, normalizeEvent, project, fromClaudeCode,
    create, update, rotateKey, remove, get, byKey, mine, forSlots, forRoom, shape, publicShape, hello, publish, view, prune, _reset,
};
