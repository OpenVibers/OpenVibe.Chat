/**
 * chat-ai.js — rolling AI insight for chat, moved into Chat (plan T3 step 2, decision 5).
 *
 * Live's server/ai/chat-ai.js, ported: same tunables, cadence, selection rules and output fields,
 * but the messages and the summaries are Chat's own tables (server/db/database.js) and the model is
 * OpenVibe.AI called with Chat's own service token (server/ai/client.js). Where Live's
 * getUsersNeedingChatAi joined Live's tables, the reads join Chat's ctx_* projections.
 *
 * Two products, one engine:
 *   • GLOBAL — an overview + timeline of ALL chat across the whole site.
 *   • PER-SUBJECT — a "today (24h) vs all-time" read on a chatter (native user, relay user, anon).
 *
 * Lower cost + graceful scaling as Live: a DB poller with the high-water mark in
 * chat_ai_summaries.last_message_id, an adaptive window, a few subjects per tick.
 *
 * Chat is the only writer of the two summaries tables since the C-04 cutover: the writes are plain
 * calls, no authority gate. The job itself is off unless config.ai.enabled (CHAT_AI_ENABLED=1) —
 * off in development and the test harness, like Chat's other background jobs.
 */
'use strict';

const config = require('../config');
const db = require('../db/database');
const aiClient = require('./client');
const extractive = require('./extractive');
const consent = require('../net/consent');
const memory = require('../rooms/memory');

// ── Tunables (Live's) ────────────────────────────────────────────────────────
const TICK_MS = config.ai.tickMs;

const GLOBAL_MSG_THRESHOLD = 100;               // refresh once this many new msgs pile up
const GLOBAL_MIN_INTERVAL_MS = 5 * 60 * 1000;   // never more often than this (flood guard)
const GLOBAL_MAX_AGE_MS = 30 * 60 * 1000;       // ...but refresh at least this often if any new

const USER_MSG_THRESHOLD = 15;                  // per-user refresh trigger
const USER_MAX_PER_TICK = 2;                    // cap LLM calls per tick
const USER_PASS_EVERY_MS = 3 * 60 * 1000;       // throttle the (heavier) user discovery scan
const USER_STALE_MS = 24 * 60 * 60 * 1000;      // refresh a lagging user at least daily
const USER_DISCOVERY_LOOKBACK_DAYS = 14;        // bound the discovery GROUP BY

// Rooms and Live channels (plan 2026-11-10, part 2): the same one-room summary, one or two rooms per
// pass, and only when there were new messages — the summary is a room's read, not a site-wide one.
const ROOM_MSG_THRESHOLD = 20;                  // a room refreshes once this many new messages pile up
const ROOM_MAX_PER_TICK = 1;                    // cap LLM calls per pass (rooms can be many)
const ROOM_PASS_EVERY_MS = 3 * 60 * 1000;        // same cadence as the per-chatter scan
const ROOM_STALE_MS = 24 * 60 * 60 * 1000;      // ...and at least daily for a quiet room
const ROOM_BATCH = 120;                         // newest messages a room summary reads
const CHANNEL_MSG_THRESHOLD = 30;               // Live channel chats: same rules, a slightly higher bar
const CHANNEL_MAX_PER_TICK = 1;

const WINDOW_TARGET_MESSAGES = 300;             // adaptive-window sizing target
const MAX_BATCH_MESSAGES = 300;                 // token cap per call
const WINDOW_MIN_MS = 30 * 60 * 1000;           // overview window is never shorter than 30 min
const WINDOW_MAX_MS = 14 * 24 * 60 * 60 * 1000; // ...nor longer than 14 days
const MEMORY_MAX_CHARS = 1600;
const USER_MEMORY_MAX_CHARS = 1200;
const TIMELINE_MAX = 40;
const MSG_MAX_CHARS = 220;

// OpenVibe.AI workflows for these summaries. Under the `chat` namespace, which is what Network
// grants Chat (ai.run.create/ai.run.read, namespace chat.*); the equivalents in AI today are
// live.chat.global / live.chat.profile, unreachable with Chat's token (see README, For Opus).
const WORKFLOW_GLOBAL = 'chat.global';
const WORKFLOW_PROFILE = 'chat.profile';

let _running = false;
let _timer = null;
let _tickInFlight = false;
let _lastUserPass = 0;
let _lastRoomPass = 0;

// ── Small utils ──────────────────────────────────────────────────────────────
// DB timestamps are UTC 'YYYY-MM-DD HH:MM:SS' (ov_now()). Match that format.
function _sqlTime(d) { return new Date(d).toISOString().slice(0, 19).replace('T', ' '); }
function _parseSqlTime(s) { return s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : 0; }
function _clip(str, n) { str = (str == null ? '' : String(str)).trim(); return str.length > n ? str.slice(0, n) : str; }

/** Messages as data for OpenVibe.AI's chat templates (WS-O task 2). */
function _msgData(rows, { includeChannel = false, now = 0 } = {}) {
    return rows.slice(-MAX_BATCH_MESSAGES).map((r) => {
        let where = null;
        if (includeChannel) where = r.is_global ? 'global' : r.channel_username ? `#${r.channel_username}` : r.stream_id ? 'stream' : null;
        const t = now ? _parseSqlTime(r.timestamp || r.created_at) : 0;
        return {
            mins_ago: t ? Math.max(0, Math.round((now - t) / 60000)) : null, where: where ? String(where).slice(0, 80) : null,
            author: String(r.username || (r.user_id ? `user#${r.user_id}` : 'anon')).slice(0, 80),
            kind: r.message_type && r.message_type !== 'chat' ? String(r.message_type).slice(0, 40) : null, text: _clip(r.message, MSG_MAX_CHARS),
        };
    });
}

function _windowLabel(ms) {
    const min = Math.round(ms / 60000);
    if (min < 90) return min <= 60 ? 'past hour' : `past ${min} min`;
    const hrs = Math.round(ms / 3600000);
    if (hrs < 36) return `past ${hrs} hours`;
    const days = Math.max(1, Math.round(ms / 86400000));
    return `past ${days} day${days === 1 ? '' : 's'}`;
}

// Stamp raw model additions into {ts,label,detail}, skipping placeholders.
function _stampAdditions(additions, fallbackTs, nowMs) {
    const now = nowMs || Date.now();
    const out = [];
    for (const a of (Array.isArray(additions) ? additions : [])) {
        const label = _clip(a && (a.label || a.title), 80);
        if (!label || _isPlaceholder(label)) continue;
        let ts = fallbackTs;
        const mins = Number(a && a.mins_ago);
        if (Number.isFinite(mins) && mins >= 0 && mins <= 43200) ts = _sqlTime(now - mins * 60000);
        const messageId = a && a.message_id != null && Number.isFinite(Number(a.message_id)) ? Number(a.message_id) : null;
        out.push({
            ts, label, detail: _clip(a.detail || a.description || '', 240),
            kind: _clip(a && a.kind ? a.kind : 'moment', 20), message_id: messageId,
        });
    }
    return out;
}
function _mergeTimeline(priorJson, additions, fallbackTs, nowMs) {
    let prior = [];
    try { prior = JSON.parse(priorJson || '[]'); if (!Array.isArray(prior)) prior = []; } catch { prior = []; }
    prior.push(..._stampAdditions(additions, fallbackTs, nowMs));
    prior.sort((x, y) => _parseSqlTime(x.ts) - _parseSqlTime(y.ts));
    if (prior.length > TIMELINE_MAX) prior = prior.slice(prior.length - TIMELINE_MAX);
    return JSON.stringify(prior);
}
function _isPlaceholder(s) { return /^(short title|one sentence|label|title|detail|\.\.\.)$/i.test(String(s || '').trim()); }
function _cleanTimeline(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(t => t && t.label && !_isPlaceholder(t.label))
        .sort((a, b) => _parseSqlTime(a.ts) - _parseSqlTime(b.ts));
}

// The words people keep coming back to in the window: a topic with how many messages mentioned it.
// Extractive so the room read has topics even when the model wrote only prose.
const TOPIC_STOP = new Set(('the and for that this with you your are was were have has had not but all can '
    + 'just from they them their there here what when who how why will would could should about into over than then '
    + 'its it\'s i\'m dont don\'t im ive you\'re your\'re hes shes theyre we\'re thats whats lets get got like one '
    + 'now out up off too very really some any more most much many also only even still back well good bad lol lmao '
    + 'yeah yes nope ok okay hi hello hey thanks thank please bro dude guys guy chat room message messages people').split(' '));
function _topics(rows, limit = 8) {
    const counts = new Map();
    for (const r of rows || []) {
        const text = String((r && r.message) || '').toLowerCase()
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/:[a-z0-9_+-]+:/g, ' ')
            .replace(/@[a-z0-9_.-]+/g, ' ');
        for (const m of text.matchAll(/[a-z][a-z'’-]{2,}/g)) {
            const word = m[0].replace(/['’-]+$/g, '');
            if (word.length < 3 || TOPIC_STOP.has(word)) continue;
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([label, count]) => ({ label: _clip(label, 40), count }));
}
/** How many different people wrote in the window (one per signed-in author, else per name). */
function _people(rows) {
    const seen = new Set();
    for (const r of rows || []) {
        const key = r && (r.user_id ? `u:${r.user_id}` : r.username ? `n:${String(r.username).toLowerCase()}` : null);
        if (key) seen.add(key);
    }
    return seen.size;
}

// Chat is the only writer of the two summaries tables since the C-04 cutover: no authority gate.

// ── GLOBAL ───────────────────────────────────────────────────────────────────
async function _refreshGlobal() {
    const prior = await db.getChatAiSummary('global', 0, 'global');
    const hw = prior ? (prior.last_message_id || 0) : 0;
    const maxId = await db.getMaxChatMessageId();
    const newCount = maxId > hw ? await db.countChatMessagesSince(hw) : 0;
    if (newCount === 0) return false;

    const ageMs = prior && prior.updated_at ? (Date.now() - _parseSqlTime(prior.updated_at)) : Infinity;
    if (ageMs < GLOBAL_MIN_INTERVAL_MS) return false;
    if (newCount < GLOBAL_MSG_THRESHOLD && ageMs < GLOBAL_MAX_AGE_MS) return false;

    const now = Date.now();
    const nthTs = await db.getNthRecentChatTs(WINDOW_TARGET_MESSAGES);
    let startMs = nthTs ? _parseSqlTime(nthTs) : (now - WINDOW_MAX_MS);
    startMs = Math.min(startMs, now - WINDOW_MIN_MS);
    startMs = Math.max(startMs, now - WINDOW_MAX_MS);
    const windowStart = _sqlTime(startMs);
    const windowLabel = _windowLabel(now - startMs);

    // The room's read includes only people who allowed AI use of their messages (network.consent@1,
    // ai.train on kind chat). Anon and relay authors have no Network subject and are left out; when
    // Network cannot answer, the check fails closed and this window is skipped.
    const batch = await db.getChatMessagesForAi({ sinceTs: windowStart, order: 'desc', limit: MAX_BATCH_MESSAGES });
    if (!batch.length) return false;
    const rows = await consent.filterRows(batch);
    if (!rows.length) {
        console.log('[ChatAI] global window has no consenting messages; nothing summarised');
        return false;
    }
    const priorMemory = prior ? (prior.memory_json || '') : '';
    let priorTl = [];
    try { priorTl = JSON.parse(prior ? (prior.timeline_json || '[]') : '[]'); } catch { priorTl = []; }

    let parsed = await aiClient.structured(WORKFLOW_GLOBAL, {
        window_label: windowLabel, prior_memory: _clip(priorMemory, MEMORY_MAX_CHARS),
        recent_labels: priorTl.slice(-8).map(t => _clip(t.label, 200)).filter(Boolean),
        messages: _msgData(rows, { includeChannel: true, now }),
    });
    if (!parsed) parsed = extractive.globalFrom(rows, { windowLabel, priorMemory, now });
    if (!parsed) return false;

    const nowIso = _sqlTime(now);
    await db.addChatTimelineEvents('global', 0, _stampAdditions(parsed.timeline, nowIso, now));
    await db.upsertChatAiSummary({
        scope: 'global', subject_id: 0, window: 'global',
        overview: _clip(parsed.recent_overview || '', 2000),
        memory_json: _clip(parsed.memory || priorMemory, MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: (prior ? (prior.message_count || 0) : 0) + newCount,
        window_message_count: rows.length,
        last_message_id: maxId,
        window_label: windowLabel,
        window_start: windowStart,
        window_end: nowIso,
        people: _people(rows),
        topics_json: JSON.stringify(_topics(rows)),
    });
    console.log(`[ChatAI] global refreshed (${newCount} new, ${rows.length} consenting, window=${windowLabel})`);
    return true;
}

// ── ROOMS AND LIVE CHANNELS (plan 2026-11-10, part 2) ───────────────────────
// One room's rolling picture, from the room's own newest messages. The same engine, prompt and budget
// rules as Global, capped to a room or two a pass. Only people who allowed AI use of their messages are
// read (network.consent@1), exactly as Global.
function _newSince(rows, prior) {
    const hw = prior ? (Number(prior.last_message_id) || 0) : 0;
    return (rows || []).reduce((n, r) => n + (Number(r.id) > hw ? 1 : 0), 0);
}
function _windowOf(rows, now) {
    const first = rows[0] && (rows[0].created_at || rows[0].timestamp);
    const ms = Math.max(60_000, now - _parseSqlTime(first || now));
    return { label: _windowLabel(ms), start: _sqlTime(now - ms) };
}

async function _refreshRoom(room) {
    const prior = await db.getChatAiSummary('room', room.id, 'rolling');
    const raw = await db.getRoomMessagesForAi({ roomId: room.id, limit: ROOM_BATCH });
    if (!raw.length) return false;
    const rows = await consent.filterRows(raw);
    if (!rows.length) return false;
    const now = Date.now();
    const { label: windowLabel, start: windowStart } = _windowOf(rows, now);
    // The room's memory is part of what the summariser reads: standing facts from earlier summaries.
    const shared = await memory.forPrompt(room).catch(() => '');
    const priorMemory = [prior ? (prior.memory_json || '') : '', shared].filter(Boolean).join('\n');
    let priorTl = [];
    try { priorTl = JSON.parse(prior ? (prior.timeline_json || '[]') : '[]'); } catch { priorTl = []; }

    let parsed = await aiClient.structured(WORKFLOW_GLOBAL, {
        window_label: windowLabel, prior_memory: _clip(priorMemory, MEMORY_MAX_CHARS),
        recent_labels: priorTl.slice(-8).map(t => _clip(t.label, 200)).filter(Boolean),
        messages: _msgData(rows, { now }),
    });
    if (!parsed) parsed = extractive.globalFrom(rows, { windowLabel, priorMemory, now });
    if (!parsed) return false;

    const nowIso = _sqlTime(now);
    const newCount = _newSince(rows, prior);
    await db.addChatTimelineEvents('room', room.id, _stampAdditions(parsed.timeline, nowIso, now));
    await db.upsertChatAiSummary({
        scope: 'room', subject_id: room.id, window: 'rolling',
        overview: _clip(parsed.recent_overview || '', 2000),
        memory_json: _clip(parsed.memory || priorMemory, MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: (prior ? (prior.message_count || 0) : 0) + newCount,
        window_message_count: rows.length,
        last_message_id: Number(room.max_id) || (rows[rows.length - 1] || {}).id || 0,
        window_label: windowLabel,
        window_start: windowStart,
        window_end: nowIso,
        people: _people(rows),
        topics_json: JSON.stringify(_topics(rows)),
    });
    // Keep what the summary learned about the room, with the messages it came from. A removed entry is not
    // recreated (memory.remember skips known and removed text).
    let remembered = 0;
    if (parsed.memory) {
        remembered = await memory.remember(room, {
            memory: parsed.memory,
            source_message_ids: rows.slice(-30).map((r) => r.id),
            source_subjects: [...new Set(rows.map((r) => r.subject_id).filter(Boolean))],
            confidence: 45,
        }).catch((e) => { console.warn(`[ChatAI] room ${room.slug} memory:`, e.message); return 0; });
    }
    console.log(`[ChatAI] room ${room.slug} refreshed (${newCount} new, ${rows.length} consenting, ${remembered} remembered, window=${windowLabel})`);
    return true;
}

async function _roomPass() {
    const staleCutoff = _sqlTime(Date.now() - ROOM_STALE_MS);
    const sinceTs = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try { candidates = await db.getRoomsNeedingInsight({ threshold: ROOM_MSG_THRESHOLD, staleCutoffIso: staleCutoff, sinceTs, limit: ROOM_MAX_PER_TICK }); }
    catch (e) { console.warn('[ChatAI] room discovery failed:', e.message); return; }
    for (const room of candidates) {
        try { await _refreshRoom(room); }
        catch (e) { console.warn(`[ChatAI] room ${room.slug} refresh failed:`, e.message); }
    }
}

async function _refreshChannel(channel) {
    const subjectId = Number(channel.channel_id);
    if (!subjectId) return false;
    const prior = await db.getChatAiSummary('channel', subjectId, 'rolling');
    const raw = await db.getChannelMessagesForAi({ channelUserId: subjectId, limit: ROOM_BATCH });
    if (!raw.length) return false;
    const rows = await consent.filterRows(raw);
    if (!rows.length) return false;
    const now = Date.now();
    const { label: windowLabel, start: windowStart } = _windowOf(rows, now);
    const priorMemory = prior ? (prior.memory_json || '') : '';
    let priorTl = [];
    try { priorTl = JSON.parse(prior ? (prior.timeline_json || '[]') : '[]'); } catch { priorTl = []; }

    let parsed = await aiClient.structured(WORKFLOW_GLOBAL, {
        window_label: windowLabel, prior_memory: _clip(priorMemory, MEMORY_MAX_CHARS),
        recent_labels: priorTl.slice(-8).map(t => _clip(t.label, 200)).filter(Boolean),
        messages: _msgData(rows, { now }),
    });
    if (!parsed) parsed = extractive.globalFrom(rows, { windowLabel, priorMemory, now });
    if (!parsed) return false;

    const nowIso = _sqlTime(now);
    const newCount = _newSince(rows, prior);
    await db.addChatTimelineEvents('channel', subjectId, _stampAdditions(parsed.timeline, nowIso, now));
    await db.upsertChatAiSummary({
        scope: 'channel', subject_id: subjectId, window: 'rolling',
        overview: _clip(parsed.recent_overview || '', 2000),
        memory_json: _clip(parsed.memory || priorMemory, MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: (prior ? (prior.message_count || 0) : 0) + newCount,
        window_message_count: rows.length,
        last_message_id: Number(channel.max_id) || (rows[rows.length - 1] || {}).id || 0,
        window_label: windowLabel,
        window_start: windowStart,
        window_end: nowIso,
        people: _people(rows),
        topics_json: JSON.stringify(_topics(rows)),
    });
    console.log(`[ChatAI] channel ${subjectId} refreshed (${newCount} new, ${rows.length} consenting, window=${windowLabel})`);
    return true;
}

async function _channelPass() {
    const staleCutoff = _sqlTime(Date.now() - ROOM_STALE_MS);
    const sinceTs = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try { candidates = await db.getChannelsNeedingInsight({ threshold: CHANNEL_MSG_THRESHOLD, staleCutoffIso: staleCutoff, sinceTs, limit: CHANNEL_MAX_PER_TICK }); }
    catch (e) { console.warn('[ChatAI] channel discovery failed:', e.message); return; }
    for (const channel of candidates) {
        try { await _refreshChannel(channel); }
        catch (e) { console.warn(`[ChatAI] channel ${channel.channel_id} refresh failed:`, e.message); }
    }
}

// ── PER-USER ─────────────────────────────────────────────────────────────────
async function _refreshUser(uid, maxId) {
    const prior = await db.getChatAiSummary('user', uid, 'rolling');
    const now = Date.now();

    const dayStart = _sqlTime(now - 24 * 60 * 60 * 1000);
    let dayRows = await db.getChatMessagesForAi({ sinceTs: dayStart, userId: uid, order: 'asc', limit: MAX_BATCH_MESSAGES });
    let has24h = dayRows.length > 0;
    if (!dayRows.length) dayRows = await db.getChatMessagesForAi({ userId: uid, order: 'desc', limit: 80 });
    if (!dayRows.length) return false;

    const uname = dayRows[dayRows.length - 1].username || `user#${uid}`;
    const priorMemory = prior ? (prior.memory_json || '') : '';
    const totalSeen = (prior ? (prior.message_count || 0) : 0);

    let parsed = await aiClient.structured(WORKFLOW_PROFILE, {
        subject_kind: 'user', name: _clip(uname, 120), recent_24h: has24h, seen: totalSeen, prior_memory: _clip(priorMemory, USER_MEMORY_MAX_CHARS),
        messages: _msgData(dayRows, { now }),
    });
    if (!parsed) parsed = extractive.profileFrom(dayRows, { name: uname, subjectKind: 'user', priorMemory, has24h, seen: totalSeen, now });
    if (!parsed) return false;

    const newCount = await db.countChatMessagesSince(prior ? (prior.last_message_id || 0) : 0, uid);
    const nowIso = _sqlTime(now);
    const _lastRow = dayRows[dayRows.length - 1] || {};
    const activityTs = _lastRow.timestamp || _lastRow.created_at || nowIso;
    await db.upsertChatAiSummary({
        scope: 'user', subject_id: uid, window: 'rolling',
        overview: JSON.stringify({
            today: _clip(parsed.overview_24h || '', 1200),
            alltime: _clip(parsed.overview_alltime || '', 1200),
            has_24h: has24h,
        }),
        memory_json: _clip(parsed.memory || priorMemory, USER_MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, activityTs, now),
        message_count: totalSeen + newCount,
        window_message_count: dayRows.length,
        last_message_id: maxId || await db.getMaxChatMessageId(),
        window_label: has24h ? 'past 24h' : 'recent',
        window_start: has24h ? dayStart : null,
        window_end: nowIso,
    });
    console.log(`[ChatAI] user ${uid} (${uname}) refreshed (${newCount} new, 24h=${has24h})`);
    return true;
}

async function _userPass() {
    const staleCutoff = _sqlTime(Date.now() - USER_STALE_MS);
    const sinceTs = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try {
        candidates = await db.getUsersNeedingChatAi({ threshold: USER_MSG_THRESHOLD, staleCutoffIso: staleCutoff, sinceTs, limit: USER_MAX_PER_TICK });
    } catch (e) { console.warn('[ChatAI] user discovery failed:', e.message); return; }
    for (const c of candidates) {
        if (!c.uid) continue;
        try { await _refreshUser(c.uid, c.max_id); }
        catch (e) { console.warn(`[ChatAI] user ${c.uid} refresh failed:`, e.message); }
    }
}

// ── PER RELAY-USER (external platform chatters bridged in) ────────────────────
async function _refreshRelayUser(ru) {
    const prior = await db.getChatAiSummary('relay', ru.id, 'rolling');
    const now = Date.now();
    const dayStart = _sqlTime(now - 24 * 60 * 60 * 1000);

    let dayRows = await db.getRelayChatMessagesForAi({ platform: ru.platform, rawUsername: ru.username, sinceTs: dayStart, order: 'asc', limit: MAX_BATCH_MESSAGES });
    let has24h = dayRows.length > 0;
    if (!dayRows.length) dayRows = await db.getRelayChatMessagesForAi({ platform: ru.platform, rawUsername: ru.username, order: 'desc', limit: 80 });
    if (!dayRows.length) return false;

    const uname = ru.display_name || ru.username;
    const priorMemory = prior ? (prior.memory_json || '') : '';

    let parsed = await aiClient.structured(WORKFLOW_PROFILE, {
        subject_kind: 'relay', name: _clip(uname, 120), platform: _clip(ru.platform, 40), recent_24h: has24h, prior_memory: _clip(priorMemory, USER_MEMORY_MAX_CHARS),
        messages: _msgData(dayRows, { now }),
    });
    if (!parsed) parsed = extractive.profileFrom(dayRows, { name: uname, subjectKind: 'relay', priorMemory, has24h, seen: ru.message_count || 0, now });
    if (!parsed) return false;

    const nowIso = _sqlTime(now);
    await db.upsertChatAiSummary({
        scope: 'relay', subject_id: ru.id, window: 'rolling',
        overview: JSON.stringify({
            today: _clip(parsed.overview_24h || '', 1200),
            alltime: _clip(parsed.overview_alltime || '', 1200),
            has_24h: has24h,
        }),
        memory_json: _clip(parsed.memory || priorMemory, USER_MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: ru.message_count || 0,
        window_message_count: dayRows.length,
        last_message_id: await db.getMaxChatMessageId(),
        window_label: has24h ? 'past 24h' : 'recent',
        window_start: has24h ? dayStart : null,
        window_end: nowIso,
    });
    console.log(`[ChatAI] relay ${ru.platform}:${ru.username} refreshed (24h=${has24h}, ${dayRows.length} msgs)`);
    return true;
}

async function _relayPass() {
    const lookbackIso = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try { candidates = await db.getRelayUsersNeedingChatAi({ lookbackIso, threshold: 8, limit: USER_MAX_PER_TICK }); }
    catch (e) { console.warn('[ChatAI] relay discovery failed:', e.message); return; }
    for (const ru of candidates) {
        if (!ru.id) continue;
        try { await _refreshRelayUser(ru); }
        catch (e) { console.warn(`[ChatAI] relay ${ru.id} refresh failed:`, e.message); }
    }
}

// ── PER ANON (not-logged-in chatters, keyed by their stable anon_id) ──────────
async function _refreshAnon(anonId) {
    const subjectId = db.anonSubjectId(anonId);
    if (!subjectId) return false;
    const prior = await db.getChatAiSummary('anon', subjectId, 'rolling');
    const now = Date.now();
    const dayStart = _sqlTime(now - 24 * 60 * 60 * 1000);

    let dayRows = await db.getAnonChatMessagesForAi({ anonId, sinceTs: dayStart, order: 'asc', limit: MAX_BATCH_MESSAGES });
    let has24h = dayRows.length > 0;
    if (!dayRows.length) dayRows = await db.getAnonChatMessagesForAi({ anonId, order: 'desc', limit: 80 });
    if (!dayRows.length) return false;

    const priorMemory = prior ? (prior.memory_json || '') : '';
    let parsed = await aiClient.structured(WORKFLOW_PROFILE, {
        subject_kind: 'anon', name: _clip(anonId, 120), recent_24h: has24h, prior_memory: _clip(priorMemory, USER_MEMORY_MAX_CHARS),
        messages: _msgData(dayRows, { now }),
    });
    if (!parsed) parsed = extractive.profileFrom(dayRows, { name: anonId, subjectKind: 'anon', priorMemory, has24h, seen: 0, now });
    if (!parsed) return false;

    const nowIso = _sqlTime(now);
    await db.upsertChatAiSummary({
        scope: 'anon', subject_id: subjectId, window: 'rolling',
        overview: JSON.stringify({
            today: _clip(parsed.overview_24h || '', 1200),
            alltime: _clip(parsed.overview_alltime || '', 1200),
            has_24h: has24h,
        }),
        memory_json: _clip(parsed.memory || priorMemory, USER_MEMORY_MAX_CHARS),
        timeline_json: _mergeTimeline(prior ? prior.timeline_json : '[]', parsed.timeline, nowIso, now),
        message_count: dayRows.length,
        window_message_count: dayRows.length,
        last_message_id: await db.getMaxChatMessageId(),
        window_label: has24h ? 'past 24h' : 'recent',
        window_start: has24h ? dayStart : null,
        window_end: nowIso,
    });
    console.log(`[ChatAI] anon ${anonId} refreshed (24h=${has24h}, ${dayRows.length} msgs)`);
    return true;
}

async function _anonPass() {
    const staleCutoff = _sqlTime(Date.now() - USER_STALE_MS);
    const sinceTs = _sqlTime(Date.now() - USER_DISCOVERY_LOOKBACK_DAYS * 86400000);
    let candidates = [];
    try {
        candidates = await db.getAnonsNeedingChatAi({ threshold: USER_MSG_THRESHOLD, staleCutoffIso: staleCutoff, sinceTs, limit: USER_MAX_PER_TICK });
    } catch (e) { console.warn('[ChatAI] anon discovery failed:', e.message); return; }
    for (const c of candidates) {
        if (!c.anon_id) continue;
        try { await _refreshAnon(c.anon_id); }
        catch (e) { console.warn(`[ChatAI] anon ${c.anon_id} refresh failed:`, e.message); }
    }
}

// ── Poller ───────────────────────────────────────────────────────────────────
async function _tick() {
    if (_tickInFlight) return;
    _tickInFlight = true;
    try {
        if (!config.ai.enabled) return;            // the job's switch (off in dev and tests)
        try { await _refreshGlobal(); }
        catch (e) { console.warn('[ChatAI] global refresh failed:', e.message); }

        // Rooms and Live channels (part 2): their own cadence, one or two a pass, only when new messages.
        if (Date.now() - _lastRoomPass >= ROOM_PASS_EVERY_MS) {
            _lastRoomPass = Date.now();
            await _roomPass();
            await _channelPass();
        }

        if (Date.now() - _lastUserPass >= USER_PASS_EVERY_MS) {
            _lastUserPass = Date.now();
            await _userPass();
            await _relayPass();
            await _anonPass();
        }
    } catch (e) {
        console.warn('[ChatAI] tick error:', e.message);
    } finally {
        _tickInFlight = false;
    }
}

// One-time: backfill the growing timeline log from the existing summary JSON.
async function _seedTimelineEvents() {
    try {
        if ((await db.getChatTimelineEvents({ scope: 'global', limit: 1 }) || []).length) return;
        const row = await db.getChatAiSummary('global', 0, 'global');
        if (!row) return;
        let tl = []; try { tl = JSON.parse(row.timeline_json || '[]'); } catch { tl = []; }
        const cleaned = _cleanTimeline(tl);
        if (cleaned.length) { await db.addChatTimelineEvents('global', 0, cleaned); console.log(`[ChatAI] Seeded ${cleaned.length} timeline event(s)`); }
    } catch { /* */ }
}

function start() {
    if (_running) return;
    if (!config.ai.enabled) return;               // off under the drill/test switches and in dev
    _running = true;
    _seedTimelineEvents().catch(() => {});
    _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[AI] Chat-AI job started (global overview/timeline + per-chatter insights)');
}

function stop() {
    _running = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── Public read helpers (used by the routes) ─────────────────────────────────
function _parseOverviews(row) {
    let overviews = { today: '', alltime: '', has_24h: false };
    try { overviews = { ...overviews, ...JSON.parse(row.overview || '{}') }; } catch { /* */ }
    let timeline = [];
    try { timeline = _cleanTimeline(JSON.parse(row.timeline_json || '[]')); } catch { /* */ }
    return {
        overview_24h: overviews.today || '',
        overview_alltime: overviews.alltime || '',
        has_24h: !!overviews.has_24h,
        memory: row.memory_json || '',
        timeline,
        message_count: row.message_count || 0,
        updated_at: row.updated_at || null,
    };
}

async function getGlobalInsight() {
    const row = await db.getChatAiSummary('global', 0, 'global');
    if (!row) return null;
    let timeline = [];
    try { timeline = _cleanTimeline(JSON.parse(row.timeline_json || '[]')); } catch { /* */ }
    return {
        overview: row.overview || '',
        memory: row.memory_json || '',
        timeline,
        window_label: row.window_label || '',
        message_count: row.message_count || 0,
        window_message_count: row.window_message_count || 0,
        updated_at: row.updated_at || null,
    };
}

async function getUserInsight(userId) {
    const row = await db.getChatAiSummary('user', userId, 'rolling');
    return row ? _parseOverviews(row) : null;
}

async function getRelayUserInsight(relayId) {
    const row = await db.getChatAiSummary('relay', relayId, 'rolling');
    return row ? _parseOverviews(row) : null;
}

async function getAnonInsight(anonId) {
    const row = await db.getChatAiSummary('anon', db.anonSubjectId(anonId), 'rolling');
    return row ? _parseOverviews(row) : null;
}

module.exports = {
    start, stop, _tick, _msgData, _topics, _people, _refreshRoom, _refreshChannel, WORKFLOW_GLOBAL,
    getGlobalInsight, getUserInsight, getRelayUserInsight, getAnonInsight,
    WORKFLOW_PROFILE,
};
