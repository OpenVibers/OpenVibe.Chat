/**
 * OpenVibe.Chat — the internal read API Live calls instead of reading its mirrored copy of Chat's
 * tables (plan T3 J4b, design §1d N1–N5). Loopback only, a service token for audience
 * openvibe.chat, one capability per route (openvibe-contracts 0.95.0):
 *
 *   POST /internal/chat/stats                         chat.stats.read             chat.stats-request@1 → chat.stats-result@1
 *   GET  /internal/chat/messages                      chat.messages.read          → chat.messages-page@1
 *   GET  /internal/chat/timeline                      chat.analysis.read          → chat.timeline-result@1
 *   GET  /internal/chat/moderation/pending-ip         chat.moderation.queue.read  → chat.moderation-queue-result@1 { pending_ip }
 *   GET  /internal/chat/moderation/relay-users        chat.moderation.queue.read  → { relay_users }
 *   GET  /internal/chat/moderation/relay-users/:id    chat.moderation.queue.read  → { relay_user }
 *   GET  /internal/chat/moderation/tts-override       chat.moderation.queue.read  → { tts_override }
 *   GET  /internal/chat/sounds(/count)                chat.sounds.read            → chat.sounds-result@1 { count } | { sounds }
 *   POST /internal/chat/sounds/asset                  chat.sounds.write           chat.sound-asset-request@1 → chat.ingress-ack@1
 *
 * Every parameter is validated (unknown ones are 400) and bound; deleted messages are never read.
 * Times in requests are epoch ms; chat_messages.timestamp is UTC 'YYYY-MM-DD HH:MM:SS' text, so a
 * window compares text and keeps the timestamp indexes.
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const serviceAuth = require('../net/service-auth');

const MESSAGE_TYPES = ['chat', 'system', 'donation', 'command', 'tts', 'channel-sound', 'soundboard', 'clip'];
const MAX_MESSAGES = 500;
const MAX_ROWS = 500;
const MAX_BUCKETS = 10_000;

const bad = (message) => { const e = new Error(message); e.status = 400; throw e; };
const id = (v) => Number.isSafeInteger(v) && v > 0;
const ms = (v) => Number.isSafeInteger(v) && v >= 0;
const sqlTime = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const num = (v) => (v == null ? null : Number(v));
const text = (v) => (v == null ? null : String(v));

/** Query string → validated values; anything not in `spec` is 400. */
function query(req, spec) {
    const out = {};
    for (const [k, raw] of Object.entries(req.query)) {
        const kind = spec[k];
        if (!kind || typeof raw !== 'string') bad(`Invalid parameter ${k}`);
        if (kind === 'id' || kind === 'ms') {
            const v = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
            if (!(kind === 'id' ? id(v) : ms(v))) bad(`Invalid ${k}`);
            out[k] = v;
        } else if (kind === 'flag') {
            if (raw !== '1' && raw !== '0') bad(`Invalid ${k}`);
            out[k] = raw === '1';
        } else if (kind === 'types') {
            const types = raw.split(',');
            if (!types.every((t) => MESSAGE_TYPES.includes(t))) bad(`Invalid ${k}`);
            out[k] = types;
        } else {
            if (!raw || raw.length > kind) bad(`Invalid ${k}`);
            out[k] = raw;
        }
    }
    return out;
}

function limit(v, dflt, max) { return v == null ? dflt : Math.min(v, max); }

function route(name, fn) {
    return async (req, res) => {
        try {
            res.json({ ok: true, ...await fn(req) });
        } catch (err) {
            if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
            console.error(`[ChatReads] ${name}:`, err);
            res.status(503).json({ ok: false, error: 'Chat read unavailable' });
        }
    };
}

// ── N1: stats ──
const CHATTER = `COALESCE('u:' || user_id, 'a:' || anon_id, source_platform || ':' || username)`;
const STATS_FIELDS = ['kind', 'user_id', 'stream_id', 'channel_user_id', 'since', 'until', 'limit'];

function statsFilter(b) {
    const where = ['is_deleted = 0'];
    const params = [];
    for (const k of ['user_id', 'stream_id', 'channel_user_id']) if (b[k] != null) { where.push(`${k} = ?`); params.push(b[k]); }
    if (b.since != null) { where.push('timestamp >= ?'); params.push(sqlTime(b.since)); }
    if (b.until != null) { where.push('timestamp < ?'); params.push(sqlTime(b.until)); }
    return { where: where.join(' AND '), params };
}

async function stats(req) {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !STATS_FIELDS.includes(k))) bad('Invalid fields');
    if (!['site', 'user', 'stream', 'channel-top'].includes(b.kind)) bad('Invalid kind');
    for (const k of ['user_id', 'stream_id', 'channel_user_id']) if (b[k] != null && !id(b[k])) bad(`Invalid ${k}`);
    for (const k of ['since', 'until']) if (b[k] != null && !ms(b[k])) bad(`Invalid ${k}`);
    if (b.limit != null && !(Number.isSafeInteger(b.limit) && b.limit >= 1 && b.limit <= 50)) bad('Invalid limit');
    if (b.kind === 'user' && b.user_id == null) bad('kind user needs user_id');
    if (b.kind === 'stream' && b.stream_id == null) bad('kind stream needs stream_id');
    if (b.kind === 'channel-top' && b.user_id != null) bad('kind channel-top takes stream_id or channel_user_id');
    const { where, params } = statsFilter(b);
    if (b.kind !== 'channel-top') {
        const r = await db.get(
            `SELECT COUNT(*) AS messages, COUNT(DISTINCT ${CHATTER}) AS chatters,
                    COUNT(*) FILTER (WHERE message_type = 'soundboard') AS sounds
             FROM chat_messages WHERE ${where}`, params);
        const out = { messages: Number(r.messages), chatters: Number(r.chatters) };
        if (b.kind === 'stream') out.sounds = Number(r.sounds);
        return out;
    }
    // Registered chatters group by user id; anonymous and relayed ones by name. System lines are no one's.
    const rows = await db.all(
        `SELECT t.user_id, COALESCE(u.username, t.username) AS username, u.display_name, u.avatar_url, u.profile_color, t.count
         FROM (SELECT user_id, MAX(username) AS username, COUNT(*) AS count, MAX(id) AS last_id
               FROM chat_messages
               WHERE ${where} AND message_type <> 'system' AND ${CHATTER} IS NOT NULL
               GROUP BY user_id, CASE WHEN user_id IS NULL THEN ${CHATTER} END) t
         LEFT JOIN ctx_users u ON u.id = t.user_id
         ORDER BY t.count DESC, t.last_id DESC LIMIT ?`, [...params, b.limit || 10]);
    return {
        top_chatters: rows.map((r) => ({
            user_id: num(r.user_id), username: String(r.username || ''), display_name: text(r.display_name),
            avatar_url: text(r.avatar_url), profile_color: text(r.profile_color), count: Number(r.count),
        })),
    };
}

// ── N2: messages ──
const MESSAGE_FILTERS = { channel_user_id: 'id', stream_id: 'id', user_id: 'id', anon_id: 80, username: 120, id: 'id' };
const MESSAGE_COLUMNS = 'id, user_id, anon_id, username, message, message_type, is_global, stream_id, channel_user_id, source_platform, reply_to_id, timestamp';

function messageRow(r) {
    return {
        id: Number(r.id), user_id: num(r.user_id), anon_id: text(r.anon_id), username: text(r.username),
        message: String(r.message), message_type: r.message_type || 'chat', is_global: Number(r.is_global) ? 1 : 0,
        stream_id: num(r.stream_id), channel_user_id: num(r.channel_user_id), source_platform: text(r.source_platform),
        reply_to_id: num(r.reply_to_id), timestamp: String(r.timestamp || ''),
    };
}

async function messages(req) {
    const q = query(req, { ...MESSAGE_FILTERS, after_id: 'id', before_id: 'id', limit: 'id', tail: 'flag', types: 'types' });
    const filters = Object.keys(MESSAGE_FILTERS).filter((k) => q[k] != null);
    if (filters.length !== 1) bad('Give exactly one of channel_user_id, stream_id, user_id, anon_id, username or id');
    const where = [`${filters[0]} = ?`, 'is_deleted = 0'];
    const params = [q[filters[0]]];
    if (q.types) { where.push(`message_type IN (${q.types.map(() => '?').join(', ')})`); params.push(...q.types); }
    const max = await db.get(`SELECT MAX(id) AS max_id FROM chat_messages WHERE ${where.join(' AND ')}`, params);
    const max_id = num(max && max.max_id);
    if (q.tail) return { messages: [], max_id };
    const page = [...where];
    const pageParams = [...params];
    if (q.after_id != null) { page.push('id > ?'); pageParams.push(q.after_id); }
    if (q.before_id != null) { page.push('id < ?'); pageParams.push(q.before_id); }
    // after_id pages forward (oldest first); otherwise newest first, back from before_id.
    const order = q.after_id != null ? 'ASC' : 'DESC';
    const rows = await db.all(
        `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE ${page.join(' AND ')} ORDER BY id ${order} LIMIT ?`,
        [...pageParams, limit(q.limit, 100, MAX_MESSAGES)]);
    return { messages: rows.map(messageRow), max_id };
}

// ── N3: timeline ──
async function timeline(req) {
    const q = query(req, { channel_user_id: 'id', stream_id: 'id', since: 'ms', until: 'ms', bucket_ms: 'id' });
    if ((q.channel_user_id == null) === (q.stream_id == null)) bad('Give channel_user_id or stream_id');
    if (q.since == null || q.bucket_ms == null) bad('since and bucket_ms are required');
    const until = q.until == null ? Date.now() : q.until;
    if (until <= q.since) bad('until must be after since');
    if (q.bucket_ms < 1000 || (until - q.since) / q.bucket_ms > MAX_BUCKETS) bad('Invalid bucket_ms');
    const col = q.channel_user_id != null ? 'channel_user_id' : 'stream_id';
    // Buckets start at since: bucket n covers [since + n·bucket_ms, since + (n+1)·bucket_ms).
    const rows = await db.all(
        `SELECT n, COUNT(*) AS count, MAX(id) AS max_id FROM (
            SELECT id, floor((extract(epoch FROM ov_ts(timestamp)) * 1000 - ?) / ?)::bigint AS n
            FROM chat_messages
            WHERE ${col} = ? AND is_deleted = 0 AND timestamp >= ? AND timestamp < ?) m
         WHERE n IS NOT NULL AND n >= 0 GROUP BY n ORDER BY n`,
        [q.since, q.bucket_ms, q[col], sqlTime(q.since), sqlTime(until)]);
    return {
        buckets: rows.map((r) => ({ t: q.since + Number(r.n) * q.bucket_ms, count: Number(r.count) })),
        max_id: rows.length ? Math.max(...rows.map((r) => Number(r.max_id))) : null,
    };
}

// ── N4: moderation queues ──
function pendingIpRow(r) {
    return {
        id: Number(r.id), channel_id: Number(r.channel_id), stream_id: num(r.stream_id), ip_address: String(r.ip_address),
        user_id: num(r.user_id), anon_id: text(r.anon_id), username: text(r.username), message: String(r.message),
        status: r.status || 'pending', reviewed_by: num(r.reviewed_by), created_at: text(r.created_at),
    };
}
function relayUserRow(r) {
    return {
        id: Number(r.id), channel_id: num(r.channel_id), platform: String(r.platform), external_username: String(r.external_username),
        action: r.action || 'hide', reason: text(r.reason), created_by: num(r.created_by),
        created_by_username: text(r.created_by_username), created_at: text(r.created_at),
    };
}
const RELAY_SELECT = `SELECT h.*, u.username AS created_by_username
    FROM hidden_relay_users h LEFT JOIN ctx_users u ON u.id = h.created_by`;

async function pendingIp(req) {
    const q = query(req, { channel_id: 'id', limit: 'id' });
    if (q.channel_id == null) bad('channel_id is required');
    const rows = await db.all(
        `SELECT * FROM pending_ip_messages WHERE channel_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`,
        [q.channel_id, limit(q.limit, 50, MAX_ROWS)]);
    return { pending_ip: rows.map(pendingIpRow) };
}

async function relayUsers(req) {
    const q = query(req, { channel_id: 'id', limit: 'id' });
    if (q.channel_id == null) bad('channel_id is required');
    const rows = await db.all(
        `${RELAY_SELECT} WHERE h.channel_id = ? OR h.channel_id IS NULL ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
        [q.channel_id, limit(q.limit, 100, MAX_ROWS)]);
    return { relay_users: rows.map(relayUserRow) };
}

async function relayUser(req) {
    query(req, {});
    const relayId = /^\d{1,16}$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!id(relayId)) bad('Invalid id');
    const row = await db.get(`${RELAY_SELECT} WHERE h.id = ?`, [relayId]);
    return { relay_user: row ? relayUserRow(row) : null };
}

async function ttsOverride(req) {
    const q = query(req, { identity_key: 120 });
    const key = String(q.identity_key || '').trim().toLowerCase();
    if (!key) bad('identity_key is required');
    const r = await db.get('SELECT * FROM tts_voice_overrides WHERE identity_key = ?', [key]);
    return {
        tts_override: r ? {
            identity_key: String(r.identity_key), voice: text(r.voice), pitch: num(r.pitch), speed: num(r.speed),
            gap: num(r.gap) || 0, set_by: num(r.set_by), updated_at: text(r.updated_at),
        } : null,
    };
}

// ── N5: channel sounds ──
function soundRow(r) {
    return {
        id: Number(r.id), channel_owner_id: Number(r.channel_owner_id), command: String(r.command), url: String(r.url),
        mime: text(r.mime), duration_seconds: num(r.duration_seconds), created_by: num(r.created_by),
        created_by_name: text(r.created_by_name), media_url: text(r.media_url), media_asset_id: num(r.media_asset_id),
    };
}

async function countSounds(ownerId) {
    if (ownerId == null) bad('channel_owner_id is required');
    const r = await db.get('SELECT COUNT(*) AS n FROM channel_sounds WHERE channel_owner_id = ?', [ownerId]);
    return { count: Number(r.n) };
}
const soundCount = (req) => countSounds(query(req, { channel_owner_id: 'id' }).channel_owner_id);

/** ?channel_owner_id → { count }; ?pending_asset=1 → { sounds } not yet uploaded to Media (oldest first). */
async function sounds(req) {
    const q = query(req, { channel_owner_id: 'id', pending_asset: 'flag', after_id: 'id', limit: 'id' });
    if (!q.pending_asset) {
        if (q.after_id != null || q.limit != null) bad('after_id and limit page pending_asset=1');
        return countSounds(q.channel_owner_id);
    }
    const where = ['media_asset_id IS NULL'];
    const params = [];
    if (q.channel_owner_id != null) { where.push('channel_owner_id = ?'); params.push(q.channel_owner_id); }
    if (q.after_id != null) { where.push('id > ?'); params.push(q.after_id); }
    const rows = await db.all(`SELECT * FROM channel_sounds WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
        [...params, limit(q.limit, 100, MAX_ROWS)]);
    return { sounds: rows.map(soundRow) };
}

/** Live's asset sync uploaded the file to Media: record where. Repeating the same write is a no-op 200. */
async function soundAsset(req) {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['id', 'media_url', 'media_asset_id'].includes(k))) bad('Invalid fields');
    if (!id(b.id) || !id(b.media_asset_id) || typeof b.media_url !== 'string' || !b.media_url || b.media_url.length > 2048) bad('Invalid sound asset');
    const r = await db.run('UPDATE channel_sounds SET media_url = ?, media_asset_id = ? WHERE id = ?', [b.media_url, b.media_asset_id, b.id]);
    if (!r.changes) { const e = new Error('Sound not found'); e.status = 404; throw e; }
    return {};
}

const router = express.Router();
router.post('/stats', serviceAuth.guard('chat.stats.read'), route('stats', stats));
router.get('/messages', serviceAuth.guard('chat.messages.read'), route('messages', messages));
router.get('/timeline', serviceAuth.guard('chat.analysis.read'), route('timeline', timeline));
const queue = serviceAuth.guard('chat.moderation.queue.read');
router.get('/moderation/pending-ip', queue, route('pending-ip', pendingIp));
router.get('/moderation/relay-users', queue, route('relay-users', relayUsers));
router.get('/moderation/relay-users/:id', queue, route('relay-user', relayUser));
router.get('/moderation/tts-override', queue, route('tts-override', ttsOverride));
router.get('/sounds', serviceAuth.guard('chat.sounds.read'), route('sounds', sounds));
router.get('/sounds/count', serviceAuth.guard('chat.sounds.read'), route('sound-count', soundCount));
router.post('/sounds/asset', serviceAuth.guard('chat.sounds.write'), route('sound-asset', soundAsset));

module.exports = router;
