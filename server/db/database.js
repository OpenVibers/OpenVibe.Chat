/**
 * OpenVibe.Chat — database access (PostgreSQL through openvibe-sdk/db; every helper is async).
 *
 * The chat functions below are OpenVibe.Live's (server/db/database.js) moved as they were:
 * same names, same arguments, same SQL, so Live's forwarded calls (server/bridge/) and the moved
 * chat modules behave exactly as before. What changed:
 *   - Live-owned rows (users, streams) are read from the ctx_* projections that
 *     server/live-context.js maintains, never from Live's database.
 *   - New rows record the author's Network subject (subject_id columns) next to the Live id.
 *   - Writes that are events (a chat message, a DM, a moderation action) add their envelope to
 *     events_outbox in the same transaction (server/events/outbox.js).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { createDb } = require('openvibe-sdk/db');
const config = require('../config');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', '..', 'data', 'pglite');

let db = null;
let _idTables = null;   // tables with an `id` column: an INSERT into one returns it (lastInsertRowid)
const _stmts = new Map();

// Tables Chat writes from the cutover on; Live reads them through Chat's internal read API.
const CHAT_TABLES = {
    chat_messages: ['id'],
    dm_conversations: ['id'],
    dm_participants: ['id'],
    dm_messages: ['id'],
    dm_blocks: ['id'],
    tts_voice_overrides: ['identity_key'],
    channel_sounds: ['id'],
    relay_users: ['id'],
    hidden_relay_users: ['id'],
    pending_ip_messages: ['id'],
    stream_first_chats: ['chatter_key', 'channel_user_id'],
    moderation_actions: ['id'],
};

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer (the runtime role, DML only); migrations run
 * first as the owner on DATABASE_DIRECT_URL. Outside production without DATABASE_URL: an embedded PGlite
 * database in data/pglite (CHAT_PGLITE_DIR overrides it; one process). Timestamps stay SQLite-format text
 * (ov_now(), datetime() in migrations/0001_initial.sql).
 */
async function openDb(cfg = config, { log = console } = {}) {
    if (!cfg.db.url) {
        if (cfg.nodeEnv === 'production') throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh chat)');
        const dir = process.env.CHAT_PGLITE_DIR || DEV_PGLITE;
        if (cfg.nodeEnv !== 'test') log.warn(`[DB] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const d = createDb({ pglite: dir, service: 'chat', log });
        await d.migrate({ dir: MIGRATIONS, log: quiet(log) });
        return d;
    }
    if (!cfg.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: cfg.db.directUrl, service: 'chat-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log: quiet(log) }); } finally { await owner.close(); }
    return createDb({ url: cfg.db.url, service: 'chat', max: cfg.db.max, log });
}
function quiet(log) { return { log() {}, info() {}, warn: (...a) => log.warn(...a), error: (...a) => log.error(...a) }; }

/** Open the process-wide database once, at boot (server/index.js, scripts). */
async function initDb(cfg = config, opts) {
    if (!db && globalThis.__ovChatTestDb) db = globalThis.__ovChatTestDb;   // tests (test/helpers/pg-preload.mjs)
    if (!db) db = await openDb(cfg, opts);
    if (!_idTables) {
        const rows = await db.many(`SELECT table_name FROM information_schema.columns
                                    WHERE table_schema = current_schema() AND column_name = 'id'`);
        _idTables = new Set(rows.map((r) => r.table_name));
    }
    return db;
}

/** The process-wide database (openvibe-sdk/db) initDb() opened. */
function getDb() {
    if (!db && globalThis.__ovChatTestDb) db = globalThis.__ovChatTestDb;
    if (!db) throw new Error('the database is not open: await initDb() at boot');
    return db;
}

/** Tests and tools: use this handle as the process-wide database (null forgets it). */
function setDb(handle) { db = handle; _stmts.clear(); }

// An INSERT into a table with an `id` column returns it, preserving the run() result shape.
const INSERT_INTO = /^\s*INSERT\s+INTO\s+([a-z_]+)/i;
function withReturning(sql) {
    if (/\bRETURNING\b/i.test(sql)) return sql;
    const m = INSERT_INTO.exec(sql);
    return m && _idTables && _idTables.has(m[1].toLowerCase()) ? `${sql} RETURNING id` : sql;
}

function stmt(sql) {
    let s = _stmts.get(sql);
    if (!s) {
        s = getDb().prepare(withReturning(sql));
        if (_stmts.size > 500) _stmts.clear();
        _stmts.set(sql, s);
    }
    return s;
}

/** → { changes, lastInsertRowid } (callers pass it on, some into answers). */
async function run(sql, params = []) {
    const r = await stmt(sql).run(...(Array.isArray(params) ? params : [params]));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
}

async function get(sql, params = []) {
    return stmt(sql).get(...(Array.isArray(params) ? params : [params]));
}

async function all(sql, params = []) {
    return stmt(sql).all(...(Array.isArray(params) ? params : [params]));
}

/** fn runs in one transaction; db calls inside it join it (openvibe-sdk/db ambient transactions). */
async function transaction(fn) {
    return await getDb().tx(async () => await fn());
}

async function close() {
    const d = db;
    db = null;
    _stmts.clear();
    if (d && d !== globalThis.__ovChatTestDb) { try { await d.close(); } catch { /* */ } }
}

// ── Subjects ──────────────────────────────────────────────────
// Live user id → Network subject (usr_…) from the ctx_users projection. New rows carry it so a
// later wave can drop Live ids.
async function subjectFor(userId) {
    if (!userId) return null;
    try { return (await get('SELECT subject_id FROM ctx_users WHERE id = ?', [userId]))?.subject_id || null; } catch { return null; }
}

function _outbox() { return require('../events/outbox'); }
function _ctx() { return require('../live-context'); }

// Ids per chat.message.deleted event (OpenVibe.Events takes up to 1000 per redaction directive).
const DELETED_EVENT_IDS = 500;

/**
 * Announce deleted messages: one chat.message.deleted per DELETED_EVENT_IDS ids, in the caller's
 * transaction. Public like chat.message.created, and it carries only ids (never the text, the
 * author or who deleted it). payload.redacts asks OpenVibe.Events to turn the stored
 * chat.message.created of each id into a tombstone, so the text stops being replayable there.
 */
async function _announceDeleted(ids) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    for (let i = 0; i < list.length; i += DELETED_EVENT_IDS) {
        const part = list.slice(i, i + DELETED_EVENT_IDS);
        await _outbox().enqueue({
            event_type: 'chat.message.deleted',
            visibility: 'public',
            subject: { type: 'chat_message', id: String(part[0]) },
            payload: {
                message_ids: part,
                redacts: { subject_type: 'chat_message', subject_ids: part.map(String) },
            },
        });
    }
}

// ── Chat messages ─────────────────────────────────────────────

// The welcome identity a save records, keyed the way the first-chat read checks it: an explicit
// ingress key wins, only chat lines otherwise count, and relayed lines live under ext:<username>.
function firstChatKey({ message_type, source_platform, user_id, anon_id, username, first_chat_key }) {
    if (first_chat_key) return first_chat_key;
    if ((message_type || 'chat') !== 'chat') return null;
    if (source_platform) return `ext:${username}`;
    if (user_id) return `user:${user_id}`;
    return anon_id ? `anon:${anon_id}` : null;
}

async function saveChatMessage({ stream_id, channel_user_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id, source_platform, auto_delete_at, metadata, first_chat_key }) {
    // channel_user_id = the broadcaster's user id — set for all channel/stream
    // messages so a streamer's chat history survives across sessions AND offline
    // periods (independent of the live-session stream row's lifetime).
    let chanUid = channel_user_id || null;
    if (!chanUid && stream_id) { try { chanUid = (await _ctx().getStreamById(stream_id))?.user_id || null; } catch { /* ignore */ } }
    const metaStr = metadata == null ? null : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    const subject = await subjectFor(user_id);
    // Every save path records the chatter's first chat in the resolved channel here, so a
    // channel-only line (a PowerChat or offline room with no stream) counts too. Only chat lines
    // take a welcome (see firstChatKey); the record joins the row's transaction.
    const chatterKey = firstChatKey({ message_type, source_platform, user_id, anon_id, username, first_chat_key });
    return await transaction(async () => {
        const res = await run(
            `INSERT INTO chat_messages (stream_id, channel_user_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id, source_platform, auto_delete_at, metadata, subject_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [stream_id, chanUid, user_id || null, anon_id || null, username, message, message_type || 'chat', is_global ? 1 : 0, reply_to_id || null, source_platform || null, auto_delete_at || null, metaStr, subject]
        );
        res.first_chat = !!(chatterKey && chanUid) && await recordFirstChat(chatterKey, chanUid);
        await _outbox().enqueue({
            event_type: 'chat.message.created',
            visibility: 'public',
            actorSubject: subject,
            subject: { type: 'chat_message', id: String(res.lastInsertRowid) },
            payload: {
                message_id: Number(res.lastInsertRowid),
                room: stream_id || chanUid ? { type: 'channel', channel_user_id: chanUid, stream_id: stream_id || null } : { type: 'global' },
                message_type: message_type || 'chat',
                user_id: user_id || null,
                user_subject: subject,
                anon_id: anon_id || null,
                username: username || null,
                text: String(message || '').slice(0, 2000),
                source_platform: source_platform || null,
                reply_to_id: reply_to_id || null,
            },
        });
        return res;
    });
}

async function searchChatMessages({ query, userId, anonId, username, streamId, limit = 50, offset = 0 }) {
    let sql = `SELECT cm.*, u.display_name, u.username as u_username, u.role, u.avatar_url, u.profile_color
               FROM chat_messages cm
               LEFT JOIN ctx_users u ON cm.user_id = u.id
               WHERE cm.is_deleted = 0
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > ov_now())`;
    const params = [];

    if (query) {
        sql += ` AND cm.message ILIKE ?`;
        params.push(`%${query}%`);
    }
    if (userId) {
        sql += ` AND cm.user_id = ?`;
        params.push(userId);
    }
    if (anonId) {
        sql += ` AND cm.anon_id = ?`;
        params.push(anonId);
    }
    if (username) {
        sql += ` AND LOWER(u.username) ILIKE ?`;
        params.push(`%${username.toLowerCase()}%`);
    }
    if (streamId) {
        sql += ` AND cm.stream_id = ?`;
        params.push(streamId);
    }

    const countSql = sql.replace(/SELECT cm\.\*.*FROM/, 'SELECT COUNT(*) as c FROM');
    const total = (await get(countSql, params))?.c || 0;

    sql += ` ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return { messages: await all(sql, params), total };
}

async function getUserChatHistory(userId, limit = 50, offset = 0) {
    const sql = `SELECT cm.*, s.title as stream_title
                 FROM chat_messages cm
                 LEFT JOIN ctx_streams s ON cm.stream_id = s.id
                 WHERE cm.user_id = ? AND cm.is_deleted = 0
                   AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > ov_now())
                 ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    const messages = await all(sql, [userId, limit, offset]);
    const total = (await get(
        `SELECT COUNT(*) as c FROM chat_messages
         WHERE user_id = ? AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > ov_now())`,
        [userId]
    ))?.c || 0;
    return { messages, total };
}

async function getChatReplay(streamId, fromTime, toTime) {
    let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name
               FROM chat_messages cm
               LEFT JOIN ctx_users u ON cm.user_id = u.id
               WHERE cm.stream_id = ? AND cm.is_deleted = 0 AND cm.message_type = 'chat'
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > ov_now())`;
    const params = [streamId];
    if (fromTime) { sql += ` AND cm.timestamp >= ?`; params.push(fromTime); }
    if (toTime) { sql += ` AND cm.timestamp <= ?`; params.push(toTime); }
    sql += ` ORDER BY cm.timestamp ASC`;
    return await all(sql, params);
}

/**
 * Get a single chat message by ID.
 */
async function getChatMessageById(id) {
    return chatMessageRow(await get('SELECT * FROM chat_messages WHERE id = ?', [id]));
}

/** Shallow-merge a JSON patch into chat_messages.metadata (e.g. an async translation). */
async function mergeChatMessageMetadata(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return;
    const row = await get('SELECT metadata FROM chat_messages WHERE id = ?', [id]);
    if (!row) return;
    let meta = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
    return await run('UPDATE chat_messages SET metadata = ? WHERE id = ?', [JSON.stringify({ ...meta, ...patch }), id]);
}

/**
 * Soft-delete a chat message by ID. Sets is_deleted=1 and records who deleted it. Every delete below
 * also announces chat.message.deleted in the same transaction (_announceDeleted).
 */
async function deleteChatMessage(id, deletedBy = null) {
    return await transaction(async () => {
        const res = await run(
            'UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = ov_now() WHERE id = ?',
            [deletedBy, id]
        );
        if (res.changes) await _announceDeleted([id]);
        return res;
    });
}

/**
 * Soft-delete ALL chat messages from a specific user, optionally scoped to a stream.
 * Returns the list of deleted message IDs for real-time broadcast.
 */
async function deleteUserChatMessages(userId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'user_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'user_id = ? AND is_deleted = 0';
    const params = streamId ? [userId, streamId] : [userId];
    return await transaction(async () => {
        const ids = (await all(`SELECT id FROM chat_messages WHERE ${condition} ORDER BY id`, params)).map(m => m.id);
        if (ids.length === 0) return [];
        await _softDeleteIds(ids, deletedBy);
        return ids;
    });
}

/**
 * Soft-delete ALL chat messages from a specific anon_id, optionally scoped to stream.
 */
async function deleteAnonChatMessages(anonId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'anon_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'anon_id = ? AND is_deleted = 0';
    const params = streamId ? [anonId, streamId] : [anonId];
    return await transaction(async () => {
        const ids = (await all(`SELECT id FROM chat_messages WHERE ${condition} ORDER BY id`, params)).map(m => m.id);
        if (ids.length === 0) return [];
        await _softDeleteIds(ids, deletedBy);
        return ids;
    });
}

/**
 * Soft-delete ALL messages from a relayed external username (e.g. "[Twitch] foobar")
 */
async function deleteRelayUserMessages(username, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'username = ? AND stream_id = ? AND is_deleted = 0'
        : 'username = ? AND is_deleted = 0';
    const params = streamId ? [username, streamId] : [username];
    return await transaction(async () => {
        const ids = (await all(`SELECT id FROM chat_messages WHERE ${condition} ORDER BY id`, params)).map(m => m.id);
        if (ids.length === 0) return [];
        await _softDeleteIds(ids, deletedBy);
        return ids;
    });
}

/** Mark `ids` deleted (in chunks, under SQLite's variable limit) and announce them. In a transaction. */
async function _softDeleteIds(ids, deletedBy) {
    for (let i = 0; i < ids.length; i += DELETED_EVENT_IDS) {
        const part = ids.slice(i, i + DELETED_EVENT_IDS);
        await run(
            `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = ov_now() WHERE id IN (${part.map(() => '?').join(',')})`,
            [deletedBy, ...part]
        );
    }
    await _announceDeleted(ids);
}

async function deleteExpiredChatMessages(limit = 500) {
    const rows = await all(
        `SELECT id, stream_id
         FROM chat_messages
         WHERE is_deleted = 0
           AND auto_delete_at IS NOT NULL
           -- Compared raw, not through datetime(): wrapping the column in a function makes the
           -- index on auto_delete_at unusable, and this sweep runs every 30 seconds against the
           -- biggest table on the site. Values are stored in the same 'YYYY-MM-DD HH:MM:SS' shape
           -- ov_now() produces, so a string comparison sorts identically.
           AND auto_delete_at <= ov_now()
         ORDER BY auto_delete_at ASC
         LIMIT ?`,
        [Math.max(1, Number(limit) || 500)]
    );
    if (!rows.length) return [];

    const ids = rows.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    await transaction(async () => {
        await run(
            `UPDATE chat_messages
             SET is_deleted = 1, deleted_at = ov_now()
             WHERE id IN (${placeholders})`,
            ids
        );
        await _announceDeleted(ids);
    });
    return rows;
}

// Time ranges (purge, its preview, the log filter): the dashboard sends ISO instants ('…T…Z') and
// rows keep SQLite's 'YYYY-MM-DD HH:MM:SS'. Compared as TEXT, 'T' sorts after ' ', so a range
// matched nothing on its first day and all of its last; datetime(?) reads both forms as UTC.
async function deleteChatMessagesByTimeRange(streamId, fromTime, toTime, deletedBy) {
    // Global chat is is_global = 1. The ids are read first, in the same transaction, to announce them.
    const where = streamId
        ? 'stream_id = ? AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0'
        : 'is_global = 1 AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0';
    const params = streamId ? [streamId, fromTime, toTime] : [fromTime, toTime];
    return await transaction(async () => {
        const ids = (await all(`SELECT id FROM chat_messages WHERE ${where} ORDER BY id`, params)).map(m => m.id);
        const res = await run(
            `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = ov_now() WHERE ${where}`,
            [deletedBy, ...params]
        );
        await _announceDeleted(ids);
        // The ids too, so the purge reaches every surface that showed them (not only the stream's sockets).
        return Object.assign(res, { ids });
    });
}

async function countChatMessagesByTimeRange(streamId, fromTime, toTime) {
    let row;
    if (streamId) {
        row = await get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE stream_id = ? AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0`,
            [streamId, fromTime, toTime]
        );
    } else {
        row = await get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE is_global = 1 AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0`,
            [fromTime, toTime]
        );
    }
    return row?.cnt || 0;
}

async function getChatLogs({ streamId, username, search, from, to, messageType, page = 1, limit = 50, includeDeleted = false } = {}) {
    const conditions = [];
    const params = [];

    if (streamId) { conditions.push('stream_id = ?'); params.push(streamId); }
    if (username) { conditions.push('username ILIKE ?'); params.push(`%${username}%`); }
    if (search) { conditions.push('message ILIKE ?'); params.push(`%${search}%`); }
    if (from) { conditions.push('timestamp >= datetime(?)'); params.push(from); }
    if (to) { conditions.push('timestamp <= datetime(?)'); params.push(to); }
    if (messageType) { conditions.push('message_type = ?'); params.push(messageType); }
    if (!includeDeleted) { conditions.push('is_deleted = 0'); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const countRow = await get(`SELECT COUNT(*) as total FROM chat_messages ${where}`, params);
    const total = countRow?.total || 0;
    const rows = (await all(
        `SELECT * FROM chat_messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    )).map(chatMessageRow);

    return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

async function getRecentChatActivity(streamId, minutes) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const row = await get(
        `SELECT COUNT(*) as cnt FROM chat_messages
         WHERE stream_id = ? AND timestamp >= ? AND is_deleted = 0 AND is_global = 0 AND message_type = 'chat'`,
        [streamId, cutoff]
    );
    return row?.cnt || 0;
}

/**
 * A user was renamed in Live (admin edit): chat_messages.username stores the display name at
 * creation time, so Live rewrote its rows in the same request. Chat does the same for its own.
 */
async function renameUserChatMessages(userId, newChatName) {
    return await run('UPDATE chat_messages SET username = ? WHERE user_id = ?', [newChatName, userId]);
}

// ── Relay (external platform) chatters ───────────────────────

// Record a chat-relay (external platform) user's activity; keeps the earliest
// first_seen as their "join date". Keyed case-insensitively by platform+username.
async function recordRelayUser(platform, username) {
    if (!platform || !username) return;
    const key = String(username).toLowerCase();
    try {
        await run(`INSERT INTO relay_users (platform, username, display_name, first_seen, last_seen, message_count)
             VALUES (?, ?, ?, ov_now(), ov_now(), 1)
             ON CONFLICT(platform, username) DO UPDATE SET
                last_seen = ov_now(),
                message_count = relay_users.message_count + 1,
                display_name = excluded.display_name`,
            [String(platform).toLowerCase(), key, String(username)]);
    } catch { /* non-critical */ }
}
async function getRelayUser(platform, username) {
    if (!platform || !username) return null;
    // rowid is a stable integer id for a relay user (no dedicated id column); used to key
    // their chat-AI insight in chat_ai_summaries.
    return await get('SELECT * FROM relay_users WHERE platform = ? AND username = ?',
        [String(platform).toLowerCase(), String(username).toLowerCase()]) || null;
}

// Relay chat messages are stored with a "[Label] name" username + source_platform and a
// NULL user_id. Match a specific relay user by the trailing "] name" (LIKE is
// case-insensitive for ASCII in SQLite), scoped to their platform.
function _likeEscape(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }
const _RELAY_MATCH = `cm.user_id IS NULL AND cm.source_platform = ? AND cm.username ILIKE ? ESCAPE '\\'`;
function _relayMatchParams(platform, rawUsername) {
    return [String(platform).toLowerCase(), '%] ' + _likeEscape(String(rawUsername))];
}

// A relay user's message history (for the "Chat Logs" viewer).
async function getRelayUserChatHistory(platform, rawUsername, { limit = 50, offset = 0, query = '' } = {}) {
    let where = `${_RELAY_MATCH} AND cm.is_deleted = 0`;
    const params = _relayMatchParams(platform, rawUsername);
    if (query) { where += ' AND cm.message ILIKE ?'; params.push('%' + query + '%'); }
    const total = (await get(`SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${where}`, params))?.c || 0;
    const rows = await all(
        `SELECT cm.id, cm.username, cm.message, cm.message_type, cm.timestamp, cm.stream_id,
                cm.source_platform, s.title AS stream_title
         FROM chat_messages cm LEFT JOIN ctx_streams s ON cm.stream_id = s.id
         WHERE ${where} ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`,
        [...params, Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
    );
    return { messages: rows, total };
}

/**
 * Hide or ban a relayed external user.
 */
async function hideRelayUser({ channelId, platform, externalUsername, action = 'hide', reason, createdBy }) {
    return await run(
        `INSERT INTO hidden_relay_users (channel_id, platform, external_username, action, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [channelId || null, platform, externalUsername, action, reason || null, createdBy]
    );
}

/**
 * Check if a relayed user is hidden/banned.
 * Checks both channel-scoped and site-wide entries (channel_id IS NULL).
 */
async function isRelayUserHidden(channelId, platform, externalUsername) {
    return !!await get(
        `SELECT 1 FROM hidden_relay_users
         WHERE platform = ? AND external_username = ? AND (channel_id = ? OR channel_id IS NULL)`,
        [platform, externalUsername, channelId]
    );
}

/**
 * Unhide/unban a relayed external user.
 */
async function unhideRelayUser(id) {
    return await run('DELETE FROM hidden_relay_users WHERE id = ?', [id]);
}

/**
 * Unhide/unban a relayed external user by identity (platform + external username +
 * channel). Scoped to a single relay identity — never touches a registered
 * openvibelive account of the same name. `channel_id IS ?` matches NULL safely.
 */
async function unhideRelayUserByIdentity(channelId, platform, externalUsername) {
    return await run(
        'DELETE FROM hidden_relay_users WHERE platform = ? AND external_username = ? AND channel_id IS NOT DISTINCT FROM ?',
        [platform, externalUsername, channelId || null]
    );
}

// ── Anonymous chatters ───────────────────────────────────────
// Anon messages have user_id NULL and a stable anon_id = "anon<N>" (which also equals
// their username).
function anonSubjectId(anonId) {
    const m = /^anon(\d+)$/i.exec(String(anonId || ''));
    return m ? parseInt(m[1], 10) : 0;
}

// Anon meta for the context menu: first-seen (when their anon number was assigned — Live's
// anon_ip_mappings, passed in by the caller) and first-chat (their earliest chat message), plus
// total message count.
async function getAnonMeta(anonId, firstSeenAt = null) {
    const num = anonSubjectId(anonId);
    const firstChat = (await get(
        `SELECT MIN(timestamp) AS t FROM chat_messages
         WHERE anon_id = ? AND user_id IS NULL AND is_deleted = 0`, [String(anonId)]
    ))?.t || null;
    const count = (await get(
        `SELECT COUNT(*) AS c FROM chat_messages
         WHERE anon_id = ? AND user_id IS NULL AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > ov_now())`, [String(anonId)]
    ))?.c || 0;
    return {
        anon_id: anonId,
        anon_num: num || null,
        first_seen: firstSeenAt || firstChat, // fall back to first chat for legacy rows
        first_chat: firstChat,
        message_count: count,
    };
}

// An anon's message history (for the "Chat Logs" viewer).
async function getAnonChatHistory(anonId, { limit = 50, offset = 0, query = '' } = {}) {
    let where = `cm.anon_id = ? AND cm.user_id IS NULL AND cm.is_deleted = 0
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > ov_now())`;
    const params = [String(anonId)];
    if (query) { where += ' AND cm.message ILIKE ?'; params.push('%' + query + '%'); }
    const total = (await get(`SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${where}`, params))?.c || 0;
    const rows = await all(
        `SELECT cm.id, cm.username, cm.anon_id, cm.message, cm.message_type, cm.timestamp, cm.stream_id,
                s.title AS stream_title
         FROM chat_messages cm LEFT JOIN ctx_streams s ON cm.stream_id = s.id
         WHERE ${where} ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`,
        [...params, Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
    );
    return { messages: rows, total };
}

// ── First chats ──────────────────────────────────────────────

/**
 * Check if a chatter has ever chatted in this streamer's channel.
 * @param {string} chatterKey - e.g. "user:42" or "anon:anon3" or "ext:[Twitch] foo"
 * @param {number} channelUserId - the streamer's user ID
 * @returns {boolean} true if this is their first time
 */
async function isFirstChatInChannel(chatterKey, channelUserId) {
    const row = await get(
        'SELECT 1 FROM stream_first_chats WHERE chatter_key = ? AND channel_user_id = ?',
        [chatterKey, channelUserId]
    );
    return !row;
}

/**
 * Record that a chatter has chatted in a streamer's channel.
 * @returns {boolean} true when this was their first time (the row is new)
 */
async function recordFirstChat(chatterKey, channelUserId) {
    const r = await run(
        'INSERT INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [chatterKey, channelUserId]
    );
    return r.changes > 0;
}

// ── Moderation log ───────────────────────────────────────────

/**
 * Log a moderation action for auditing.
 * Used by canvas, chat moderation, bans, etc.
 */
async function logModerationAction({ scope_type, scope_id, actor_user_id, target_user_id, action_type, details }) {
    const actorSubject = await subjectFor(actor_user_id);
    return await transaction(async () => {
        const res = await run(`
            INSERT INTO moderation_actions (scope_type, scope_id, actor_user_id, target_user_id, action_type, details, actor_subject_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [scope_type || 'site', scope_id || null, actor_user_id || null, target_user_id || null, action_type, JSON.stringify(details || {}), actorSubject]);
        await _outbox().enqueue({
            event_type: 'chat.moderation.action',
            visibility: 'internal',
            actorSubject,
            subject: { type: 'moderation_action', id: String(res.lastInsertRowid) },
            payload: {
                action_id: Number(res.lastInsertRowid),
                action_type,
                scope_type: scope_type || 'site',
                scope_id: scope_id || null,
                actor_user_id: actor_user_id || null,
                actor_subject: actorSubject,
                target_user_id: target_user_id || null,
                target_subject: await subjectFor(target_user_id),
                details: details || {},
            },
        });
        return res;
    });
}

// ── IP approval queue ────────────────────────────────────────

/**
 * Hold a message for IP approval.
 */
async function holdMessageForApproval({ channelId, streamId, ip, userId, anonId, username, message }) {
    return await run(
        `INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, user_id, anon_id, username, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [channelId, streamId, ip, userId || null, anonId || null, username, message]
    );
}

/**
 * Approve or deny a pending IP message. If approved, auto-approve the IP too (approved_ips is
 * Live's table: the approval goes through live-context).
 */
async function reviewPendingIpMessage(id, { status, reviewedBy, channelId }) {
    // Scoped to the channel the caller was authorised for, so a message id from another channel's
    // queue matches nothing.
    const scoped = channelId != null;
    const res = scoped
        ? await run('UPDATE pending_ip_messages SET status = ?, reviewed_by = ? WHERE id = ? AND channel_id = ?', [status, reviewedBy, id, channelId])
        : await run('UPDATE pending_ip_messages SET status = ?, reviewed_by = ? WHERE id = ?', [status, reviewedBy, id]);
    if (!res.changes) return;
    if (status === 'approved') {
        const msg = await get('SELECT * FROM pending_ip_messages WHERE id = ?', [id]);
        if (msg) _ctx().approveIp(channelId || msg.channel_id, msg.ip_address, reviewedBy, 'manual');
    }
}

/**
 * Bulk-approve all pending messages from a specific IP in a channel.
 */
async function approveAllFromIp(channelId, ip, reviewedBy) {
    _ctx().approveIp(channelId, ip, reviewedBy, 'manual');
    return await run(
        "UPDATE pending_ip_messages SET status = 'approved', reviewed_by = ? WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
        [reviewedBy, channelId, ip]
    );
}

/**
 * Deny all pending messages from a specific IP in a channel.
 */
async function denyAllFromIp(channelId, ip, reviewedBy) {
    return await run(
        "UPDATE pending_ip_messages SET status = 'denied', reviewed_by = ? WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
        [reviewedBy, channelId, ip]
    );
}

// ── Per-user TTS voice overrides (admin-set) ─────────────────
async function getTtsVoiceOverride(identityKey) {
    try {
        const k = String(identityKey || '').trim().toLowerCase();
        if (!k) return null;
        const r = await get('SELECT voice, pitch, speed, gap FROM tts_voice_overrides WHERE identity_key = ?', [k]);
        if (!r) return null;
        return { voice: r.voice, pitch: r.pitch, speed: r.speed, gap: r.gap || 0 };
    } catch { return null; }
}
async function setTtsVoiceOverride(identityKey, params, setBy) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return false;
    await run(`INSERT INTO tts_voice_overrides (identity_key, voice, pitch, speed, gap, set_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ov_now())
         ON CONFLICT(identity_key) DO UPDATE SET voice=excluded.voice, pitch=excluded.pitch,
             speed=excluded.speed, gap=excluded.gap, set_by=excluded.set_by, updated_at=ov_now()`,
        [k, params.voice, params.pitch, params.speed, params.gap || 0, setBy || null]);
    return true;
}
async function deleteTtsVoiceOverride(identityKey) {
    try { await run('DELETE FROM tts_voice_overrides WHERE identity_key = ?', [String(identityKey || '').trim().toLowerCase()]); return true; } catch { return false; }
}

// ── Channel sound commands (viewer-uploadable) ───────────────
async function createChannelSound({ channel_owner_id, command, url, mime = 'audio/mpeg', duration_seconds = 0, created_by = null, created_by_name = '', emote_code = '' }) {
    return await run(
        `INSERT INTO channel_sounds (channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, emote_code, created_by_subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, emote_code || '', await subjectFor(created_by)]
    );
}
// Update the shared emote_code for all sounds under a command (an emote is per-command).
async function setChannelSoundEmote(ownerId, command, emoteCode) {
    return await run('UPDATE channel_sounds SET emote_code = ? WHERE channel_owner_id = ? AND command = ?',
        [emoteCode || '', ownerId, String(command || '').toLowerCase()]);
}

async function getChannelSounds(ownerId) {
    return await all(
        'SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND is_approved = 1 ORDER BY command',
        [ownerId]
    );
}

async function getChannelSoundByCommand(ownerId, command) {
    // A command may have multiple uploaded sounds — pick one at random each play.
    return await get(
        'SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND command = ? AND is_approved = 1 ORDER BY RANDOM() LIMIT 1',
        [ownerId, String(command || '').toLowerCase()]
    );
}

async function getChannelSoundById(id) {
    return await get('SELECT * FROM channel_sounds WHERE id = ?', [id]);
}

async function countChannelSounds(ownerId) {
    const row = await get('SELECT COUNT(*) as count FROM channel_sounds WHERE channel_owner_id = ?', [ownerId]);
    return row ? row.count : 0;
}

async function countChannelSoundsByUploader(ownerId, uploaderId) {
    const row = await get('SELECT COUNT(*) as count FROM channel_sounds WHERE channel_owner_id = ? AND created_by = ?', [ownerId, uploaderId]);
    return row ? row.count : 0;
}

async function deleteChannelSound(id) {
    return await run('DELETE FROM channel_sounds WHERE id = ?', [id]);
}

// Rename a whole !command group (a command may hold several sounds).
async function renameChannelSoundCommand(ownerId, oldCommand, newCommand) {
    return await run('UPDATE channel_sounds SET command = ? WHERE channel_owner_id = ? AND command = ?',
        [String(newCommand || '').toLowerCase(), ownerId, String(oldCommand || '').toLowerCase()]);
}

// Sounds attach emotes BY CODE — keep those references alive when an emote
// is renamed so the streamer's emote+sound combos don't silently break.
async function updateChannelSoundEmoteRefs(ownerId, oldCode, newCode) {
    return await run('UPDATE channel_sounds SET emote_code = ? WHERE channel_owner_id = ? AND emote_code = ?',
        [newCode || '', ownerId, oldCode]);
}

// ── The six staged tables: reads for the public APIs and Live's internal read API (T3) ──
// Same SQL and shapes as Live's database.js helpers of the same name; usernames come from the
// ctx_users projection instead of Live's users table.

async function isChannelModerator(userId, channelId) {
    return !!await get('SELECT 1 FROM channel_moderators WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
}

/** The channel_moderation_settings row as it is, or null when the channel has none (defaults are Live's). */
async function getChannelModerationSettingsRow(channelId) {
    return await get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [Number(channelId)]) || null;
}

/** A channel's moderators, with names, oldest first (Live's getChannelModerators). */
async function getChannelModerators(channelId) {
    return await all(`
        SELECT cm.id, cm.user_id, cm.added_by, cm.created_at,
               u.username, u.display_name, u.avatar_url,
               a.username as added_by_username
        FROM channel_moderators cm
        LEFT JOIN ctx_users u ON cm.user_id = u.id
        LEFT JOIN ctx_users a ON cm.added_by = a.id
        WHERE cm.channel_id = ?
        ORDER BY cm.created_at ASC, cm.id ASC
    `, [channelId]);
}

/** The channel's moderator user ids, oldest first (Live's policy answer carries the same list). */
async function getChannelModeratorIds(channelId) {
    return (await all('SELECT user_id FROM channel_moderators WHERE channel_id = ? ORDER BY created_at ASC, id ASC', [channelId])).map((r) => r.user_id);
}

/**
 * The channels a user moderates (Live's getChannelsByModerator). Channel title and owner come from
 * the ctx_channels / ctx_users projections; the extra `id` alias is what the dashboard reads.
 */
async function getChannelsByModerator(userId) {
    return await all(`
        SELECT cm.channel_id, cm.channel_id AS id, c.title,
               c.user_id AS user_id, c.user_id AS owner_user_id, u.username AS owner_username
        FROM channel_moderators cm
        LEFT JOIN ctx_channels c ON cm.channel_id = c.id
        LEFT JOIN ctx_users u ON c.user_id = u.id
        WHERE cm.user_id = ?
        ORDER BY cm.created_at ASC, cm.id ASC
    `, [userId]);
}

/** Custom emotes marked global (Live's getGlobalEmotes). */
async function getGlobalEmotes() {
    return await all(`SELECT e.*, u.username FROM emotes e
        LEFT JOIN ctx_users u ON e.user_id = u.id
        WHERE e.is_global = 1 AND e.is_approved = 1 ORDER BY code`);
}

/** A channel's emotes: ones targeted at the owner, plus the owner's own legacy uploads. */
async function getChannelEmotes(userId) {
    return await all(
        `SELECT e.*, u.username, up.username AS uploader_username, up.display_name AS uploader_display_name
           FROM emotes e
           LEFT JOIN ctx_users u ON e.user_id = u.id
           LEFT JOIN ctx_users up ON e.user_id = up.id
          WHERE ((e.channel_owner_id = ?) OR (e.channel_owner_id IS NULL AND e.user_id = ?))
            AND e.is_approved = 1
          ORDER BY code`,
        [userId, userId]
    );
}

/** How many emotes a channel holds (Live's countChannelEmotes; ownerId is the streamer's user id). */
async function countChannelEmotes(ownerId) {
    return (await get(
        'SELECT COUNT(*) as count FROM emotes WHERE (channel_owner_id = ?) OR (channel_owner_id IS NULL AND user_id = ?)',
        [ownerId, ownerId]
    ))?.count || 0;
}

/** The channel's emote with this code, any uploader (Live's getChannelEmoteByCode). */
async function getChannelEmoteByCode(ownerId, code) {
    return await get(
        `SELECT * FROM emotes
          WHERE code = ? AND ((channel_owner_id = ?) OR (channel_owner_id IS NULL AND user_id = ?))
          LIMIT 1`,
        [code, ownerId, ownerId]
    );
}

/** One emote by id, with its uploader's name (Live's getEmoteById). */
async function getEmoteById(id) {
    return await get('SELECT e.*, u.username FROM emotes e LEFT JOIN ctx_users u ON e.user_id = u.id WHERE e.id = ?', [id]);
}

/** A user's own emotes (Live's getEmotesByUser). */
async function getEmotesByUser(userId) {
    return await all('SELECT * FROM emotes WHERE user_id = ? ORDER BY code', [userId]);
}

/** Moderation actions with actor/target names (Live's getModerationActions). */
// Two columns SQLite declared INTEGER hold ids or names (its type affinity took both): moderation_actions.scope_id
// (a channel/stream id or a room slug) and chat_messages.deleted_by (a user id, or the name a purge records). The
// PostgreSQL columns are text; an id reads back as a number wherever a row leaves Chat, as it did.
function _idBack(r, col) {
    return r && typeof r[col] === 'string' && /^-?\d{1,15}$/.test(r[col]) ? { ...r, [col]: Number(r[col]) } : r;
}
function moderationRow(r) { return _idBack(r, 'scope_id'); }
function chatMessageRow(r) { return _idBack(r, 'deleted_by'); }

async function getModerationActions({ scopeType, scope_type, scopeId, scope_id, actor_user_id, target_user_id, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    const st = scopeType || scope_type;
    const si = scopeId || scope_id;
    if (st) { conditions.push('ma.scope_type = ?'); params.push(st); }
    if (si) { conditions.push('ma.scope_id = ?'); params.push(si); }
    if (actor_user_id) { conditions.push('ma.actor_user_id = ?'); params.push(actor_user_id); }
    if (target_user_id) { conditions.push('ma.target_user_id = ?'); params.push(target_user_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return (await all(`
        SELECT ma.*, actor.username AS actor_username, target.username AS target_username
        FROM moderation_actions ma
        LEFT JOIN ctx_users actor ON ma.actor_user_id = actor.id
        LEFT JOIN ctx_users target ON ma.target_user_id = target.id
        ${where}
        ORDER BY ma.created_at DESC
        LIMIT ? OFFSET ?
    `, params)).map(moderationRow);
}

/**
 * A channel's chat messages matching a search (Live's searchChannelChatMessages): one of the
 * channel's streams, or its offline room (channel_user_id), never another channel's room.
 */
async function searchChannelChatMessages(channel, { query, userId, limit = 50, offset = 0 } = {}) {
    const conditions = [
        '(cm.channel_user_id = ? OR cm.stream_id IN (SELECT id FROM ctx_streams WHERE channel_id = ? OR user_id = ?))',
        'cm.is_deleted = 0',
        '(cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > ov_now())',
    ];
    const params = [channel.user_id, channel.id, channel.user_id];
    if (query) { conditions.push('cm.message ILIKE ?'); params.push(`%${query}%`); }
    if (userId) { conditions.push('cm.user_id = ?'); params.push(userId); }
    params.push(limit, offset);
    return {
        messages: await all(`
            SELECT cm.*, u.username, u.display_name, u.avatar_url
            FROM chat_messages cm
            LEFT JOIN ctx_users u ON cm.user_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY cm.timestamp DESC
            LIMIT ? OFFSET ?
        `, params),
    };
}

// ── The six tables' writes (channel moderators, settings, emotes, tags, chat AI) ──
// Chat has been the only writer of these six since the C-04 cutover, so there is no authority gate
// any more. Until Live N+1 is deployed, Live's current release still calls these functions over the
// bridge (op `db`) and reads both halves of the answer: `value` — what Live's function of the same
// name returns (its callers keep working) — and `mirror` — the rows as they are now, in the Live
// mirror's change shape, which Live applies to its own copy at once. Past Live N+1 nothing reads
// either half; the callers here use `.value` only.
function _writeResult(value, table, rows = [], deletedPks = []) {
    const plainValue = value && typeof value === 'object' && 'changes' in value && 'lastInsertRowid' in value
        ? { changes: value.changes, lastInsertRowid: Number(value.lastInsertRowid) } : value;
    return {
        value: plainValue === undefined ? null : plainValue,
        mirror: [
            ...deletedPks.map((pk) => ({ table, op: 'delete', pk })),
            ...rows.filter(Boolean).map((row) => ({ table, op: 'upsert', row })),
        ],
    };
}

// Channel moderators, settings and alert sounds (Live's /api/channels, the dashboard, /slow).
async function addChannelModerator(channelId, userId, addedBy) {
    const out = await transaction(async () => {
        const res = await run('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [channelId, userId, addedBy]);
        return _writeResult(res, 'channel_moderators', await all('SELECT * FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]));
    });
    await _ctx().invalidateChannel(channelId);
    return out;
}

async function removeChannelModerator(channelId, userId) {
    const out = await transaction(async () => {
        const gone = await all('SELECT id FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
        const res = await run('DELETE FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
        return _writeResult(res, 'channel_moderators', [], gone.map((r) => ({ id: r.id })));
    });
    await _ctx().invalidateChannel(channelId);
    return out;
}

// Live's upsertChannelModerationSettings, clamps and all.
async function upsertChannelModerationSettings(channelId, fields) {
    const out = await transaction(async () => {
        const existing = await get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId]);
        if (existing) {
            const updates = [];
            const params = [];
            const set = (col, v) => { updates.push(`${col} = ?`); params.push(v); };
            if (fields.slow_mode_seconds !== undefined) set('slow_mode_seconds', fields.slow_mode_seconds);
            if (fields.followers_only !== undefined) set('followers_only', fields.followers_only ? 1 : 0);
            if (fields.emote_only !== undefined) set('emote_only', fields.emote_only ? 1 : 0);
            if (fields.allow_anonymous !== undefined) set('allow_anonymous', fields.allow_anonymous ? 1 : 0);
            if (fields.links_allowed !== undefined) set('links_allowed', fields.links_allowed ? 1 : 0);
            if (fields.gifs_enabled !== undefined) set('gifs_enabled', fields.gifs_enabled ? 1 : 0);
            if (fields.account_age_gate_hours !== undefined) set('account_age_gate_hours', Number(fields.account_age_gate_hours) || 0);
            if (fields.caps_percentage_limit !== undefined) set('caps_percentage_limit', Number(fields.caps_percentage_limit) || 0);
            if (fields.aggressive_filter !== undefined) set('aggressive_filter', fields.aggressive_filter ? 1 : 0);
            if (fields.max_message_length !== undefined) set('max_message_length', Math.max(50, Number(fields.max_message_length) || 500));
            if (fields.slur_filter_enabled !== undefined) set('slur_filter_enabled', fields.slur_filter_enabled ? 1 : 0);
            if (fields.slur_filter_use_builtin !== undefined) set('slur_filter_use_builtin', fields.slur_filter_use_builtin ? 1 : 0);
            if (fields.slur_filter_terms !== undefined) set('slur_filter_terms', String(fields.slur_filter_terms || '').slice(0, 4000));
            if (fields.slur_filter_regexes !== undefined) set('slur_filter_regexes', String(fields.slur_filter_regexes || '').slice(0, 8000));
            if (fields.slur_filter_nudge_message !== undefined) set('slur_filter_nudge_message', String(fields.slur_filter_nudge_message || '').slice(0, 800));
            if (fields.slur_filter_disabled_categories !== undefined) set('slur_filter_disabled_categories', String(fields.slur_filter_disabled_categories || '[]').slice(0, 200));
            if (fields.ip_approval_mode !== undefined) set('ip_approval_mode', fields.ip_approval_mode ? 1 : 0);
            if (fields.soundboard_enabled !== undefined) set('soundboard_enabled', fields.soundboard_enabled ? 1 : 0);
            if (fields.soundboard_allow_pitch !== undefined) set('soundboard_allow_pitch', fields.soundboard_allow_pitch ? 1 : 0);
            if (fields.soundboard_allow_speed !== undefined) set('soundboard_allow_speed', fields.soundboard_allow_speed ? 1 : 0);
            if (fields.soundboard_banned_ids !== undefined) set('soundboard_banned_ids', String(fields.soundboard_banned_ids || '').slice(0, 4000));
            if (fields.viewer_auto_delete_enabled !== undefined) set('viewer_auto_delete_enabled', fields.viewer_auto_delete_enabled ? 1 : 0);
            if (fields.viewer_delete_all_enabled !== undefined) set('viewer_delete_all_enabled', fields.viewer_delete_all_enabled ? 1 : 0);
            if (fields.custom_emotes_enabled !== undefined) set('custom_emotes_enabled', fields.custom_emotes_enabled ? 1 : 0);
            if (fields.custom_sounds_enabled !== undefined) set('custom_sounds_enabled', fields.custom_sounds_enabled ? 1 : 0);
            if (fields.max_sound_seconds !== undefined) set('max_sound_seconds', Math.min(30, Math.max(1, Number(fields.max_sound_seconds) || 10)));
            if (fields.uploads_mods_only !== undefined) set('uploads_mods_only', fields.uploads_mods_only ? 1 : 0);
            if (fields.mods_can_edit_about !== undefined) set('mods_can_edit_about', fields.mods_can_edit_about ? 1 : 0);
            if (fields.emote_scale !== undefined) set('emote_scale', Math.min(300, Math.max(50, Number(fields.emote_scale) || 100)));
            if (fields.emote_size_min !== undefined) set('emote_size_min', Math.min(200, Math.max(25, Number(fields.emote_size_min) || 50)));
            if (fields.emote_size_max !== undefined) set('emote_size_max', Math.min(400, Math.max(50, Number(fields.emote_size_max) || 200)));
            if (fields.sounds_mods_only !== undefined) set('sounds_mods_only', fields.sounds_mods_only ? 1 : 0);
            if (fields.sound_min_speed !== undefined) set('sound_min_speed', Math.min(1, Math.max(0.1, Number(fields.sound_min_speed) || 0.5)));
            if (fields.sound_max_speed !== undefined) set('sound_max_speed', Math.min(5, Math.max(1, Number(fields.sound_max_speed) || 3.0)));
            if (fields.sound_min_pitch_cents !== undefined) set('sound_min_pitch_cents', Math.min(0, Math.max(-2400, Math.round(Number(fields.sound_min_pitch_cents) || -1200))));
            if (fields.sound_max_pitch_cents !== undefined) set('sound_max_pitch_cents', Math.max(0, Math.min(2400, Math.round(Number(fields.sound_max_pitch_cents) || 1200))));
            if (updates.length > 0) {
                updates.push('updated_at = ov_now()');
                params.push(channelId);
                await run(`UPDATE channel_moderation_settings SET ${updates.join(', ')} WHERE channel_id = ?`, params);
            }
        } else {
            const b = (v, dflt) => (v !== undefined ? (v ? 1 : 0) : dflt);
            await run(
                `INSERT INTO channel_moderation_settings (
                    channel_id, slow_mode_seconds, followers_only, emote_only,
                    allow_anonymous, links_allowed, gifs_enabled, account_age_gate_hours,
                    caps_percentage_limit, aggressive_filter, max_message_length,
                    slur_filter_enabled, slur_filter_use_builtin, slur_filter_terms, slur_filter_regexes, slur_filter_nudge_message, slur_filter_disabled_categories,
                    ip_approval_mode, soundboard_enabled, soundboard_allow_pitch, soundboard_allow_speed, soundboard_banned_ids,
                    viewer_auto_delete_enabled, viewer_delete_all_enabled,
                    custom_emotes_enabled, custom_sounds_enabled, max_sound_seconds, uploads_mods_only, emote_scale,
                    emote_size_min, emote_size_max, sounds_mods_only, mods_can_edit_about
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    channelId,
                    fields.slow_mode_seconds || 0,
                    fields.followers_only ? 1 : 0,
                    fields.emote_only ? 1 : 0,
                    b(fields.allow_anonymous, 1),
                    b(fields.links_allowed, 1),
                    b(fields.gifs_enabled, 1),
                    Number(fields.account_age_gate_hours) || 0,
                    Number(fields.caps_percentage_limit) || 0,
                    fields.aggressive_filter ? 1 : 0,
                    Math.max(50, Number(fields.max_message_length) || 500),
                    fields.slur_filter_enabled ? 1 : 0,
                    b(fields.slur_filter_use_builtin, 1),
                    String(fields.slur_filter_terms || '').slice(0, 4000),
                    String(fields.slur_filter_regexes || '').slice(0, 8000),
                    String(fields.slur_filter_nudge_message || '').slice(0, 800),
                    String(fields.slur_filter_disabled_categories || '[]').slice(0, 200),
                    fields.ip_approval_mode ? 1 : 0,
                    b(fields.soundboard_enabled, 1),
                    b(fields.soundboard_allow_pitch, 1),
                    b(fields.soundboard_allow_speed, 1),
                    String(fields.soundboard_banned_ids || '').slice(0, 4000),
                    b(fields.viewer_auto_delete_enabled, 1),
                    b(fields.viewer_delete_all_enabled, 1),
                    b(fields.custom_emotes_enabled, 1),
                    b(fields.custom_sounds_enabled, 1),
                    Math.min(30, Math.max(1, Number(fields.max_sound_seconds) || 10)),
                    fields.uploads_mods_only ? 1 : 0,
                    Math.min(300, Math.max(50, Number(fields.emote_scale) || 100)),
                    Math.min(200, Math.max(25, Number(fields.emote_size_min) || 50)),
                    Math.min(400, Math.max(50, Number(fields.emote_size_max) || 200)),
                    fields.sounds_mods_only ? 1 : 0,
                    fields.mods_can_edit_about ? 1 : 0,
                ]
            );
        }
        // tts_max_length and sub_only, as Live: after the UPDATE or the fresh INSERT.
        if (fields.tts_max_length !== undefined) {
            await run('UPDATE channel_moderation_settings SET tts_max_length = ? WHERE channel_id = ?', [Math.min(1000, Math.max(10, Number(fields.tts_max_length) || 200)), channelId]);
        }
        if (fields.sub_only !== undefined) await run('UPDATE channel_moderation_settings SET sub_only = ? WHERE channel_id = ?', [fields.sub_only ? 1 : 0, channelId]);
        const row = await get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId]);
        return _writeResult(row, 'channel_moderation_settings', [row]);
    });
    await _ctx().invalidateChannel(channelId);
    return out;
}

// Donation / goal alert sounds live on the settings row (url = the file's path in the sounds dir).
async function setChannelAlertSound(channelId, kind, url, mime) {
    const out = await transaction(async () => {
        if (!await get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId])) {
            await run('INSERT INTO channel_moderation_settings (channel_id) VALUES (?)', [channelId]);
        }
        const col = kind === 'goal' ? 'goal_sound' : 'donation_sound';
        const res = await run(`UPDATE channel_moderation_settings SET ${col}_url = ?, ${col}_mime = ? WHERE channel_id = ?`, [url || null, mime || null, channelId]);
        return _writeResult(res, 'channel_moderation_settings', [await get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId])]);
    });
    await _ctx().invalidateChannel(channelId);
    return out;
}

// Emotes (Live's /api/emotes; media_url/media_asset_id are OpenVibe.Media's copy — Live's
// asset-sync filled them onto the shared rows, Chat uploads through its own Media token now).
async function createEmote({ user_id, code, url, animated = false, width = 28, height = 28, is_global = false, channel_owner_id = null, size = 100, media_url = null, media_asset_id = null }) {
    return await transaction(async () => {
        const res = await run(
            `INSERT INTO emotes (user_id, code, url, animated, width, height, is_global, channel_owner_id, size, media_url, media_asset_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, code, url, animated ? 1 : 0, width, height, is_global ? 1 : 0, channel_owner_id || null, Math.min(400, Math.max(25, parseInt(size, 10) || 100)), media_url || null, media_asset_id || null]
        );
        return _writeResult(res, 'emotes', [await get('SELECT * FROM emotes WHERE id = ?', [res.lastInsertRowid])]);
    });
}

async function updateEmote(id, { code, size } = {}) {
    const sets = [];
    const params = [];
    if (code !== undefined) { sets.push('code = ?'); params.push(code); }
    if (size !== undefined) { sets.push('size = ?'); params.push(Math.min(400, Math.max(25, parseInt(size, 10) || 100))); }
    if (!sets.length) return _writeResult({ changes: 0 }, 'emotes');
    return await transaction(async () => {
        const res = await run(`UPDATE emotes SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        return _writeResult(res, 'emotes', [await get('SELECT * FROM emotes WHERE id = ?', [id])]);
    });
}

async function deleteEmote(id) {
    return await transaction(async () => {
        const had = await get('SELECT id FROM emotes WHERE id = ?', [id]);
        const res = await run('DELETE FROM emotes WHERE id = ?', [id]);
        return _writeResult(res, 'emotes', [], had ? [{ id: had.id }] : []);
    });
}

/** The emote's copy on OpenVibe.Media (Live's asset-sync). */
async function setEmoteMedia(id, mediaUrl, mediaAssetId) {
    return await transaction(async () => {
        const res = await run('UPDATE emotes SET media_url = ?, media_asset_id = ? WHERE id = ?', [mediaUrl || null, mediaAssetId || null, id]);
        return _writeResult(res, 'emotes', [await get('SELECT * FROM emotes WHERE id = ?', [id])]);
    });
}

// User tags (owned chat tags; Live has had no writer since its game tags went read-only).
async function grantUserTag(userId, tagId, source = 'shop') {
    return await transaction(async () => {
        const res = await run('INSERT INTO user_tags (user_id, tag_id, source) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [userId, String(tagId), source || 'shop']);
        return _writeResult(res, 'user_tags', [await get('SELECT * FROM user_tags WHERE user_id = ? AND tag_id = ?', [userId, String(tagId)])]);
    });
}

async function revokeUserTag(userId, tagId) {
    return await transaction(async () => {
        const gone = await all('SELECT id FROM user_tags WHERE user_id = ? AND tag_id = ?', [userId, String(tagId)]);
        const res = await run('DELETE FROM user_tags WHERE user_id = ? AND tag_id = ?', [userId, String(tagId)]);
        return _writeResult(res, 'user_tags', [], gone.map((r) => ({ id: r.id })));
    });
}

// Chat AI (Live's server/ai/chat-ai.js): rolling summaries and the append-only timeline.
async function upsertChatAiSummary(sfx) {
    const {
        scope, subject_id = 0, window, overview = '', memory_json = '', timeline_json = '[]',
        message_count = 0, window_message_count = 0, last_message_id = 0,
        window_label = '', window_start = null, window_end = null,
    } = sfx || {};
    return await transaction(async () => {
        const res = await run(
            `INSERT INTO chat_ai_summaries
                (scope, subject_id, "window", overview, memory_json, timeline_json, message_count,
                 window_message_count, last_message_id, window_label, window_start, window_end, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ov_now())
             ON CONFLICT(scope, subject_id, "window") DO UPDATE SET
                overview = excluded.overview,
                memory_json = excluded.memory_json,
                timeline_json = excluded.timeline_json,
                message_count = excluded.message_count,
                window_message_count = excluded.window_message_count,
                last_message_id = excluded.last_message_id,
                window_label = excluded.window_label,
                window_start = excluded.window_start,
                window_end = excluded.window_end,
                updated_at = ov_now()`,
            [scope, subject_id || 0, window, overview, memory_json, timeline_json, message_count,
                window_message_count, last_message_id, window_label, window_start, window_end]
        );
        return _writeResult(res, 'chat_ai_summaries', [await get('SELECT * FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? AND "window" = ?', [scope, subject_id || 0, window])]);
    });
}

async function addChatTimelineEvents(scope, subjectId, events) {
    if (!Array.isArray(events) || !events.length) return _writeResult(0, 'chat_timeline_events');
    return await transaction(async () => {
        let n = 0;
        const ids = [];
        for (const e of events) {
            if (!e || !e.label || !e.ts) continue;
            try {
                const res = await run('INSERT INTO chat_timeline_events (scope, subject_id, ts, label, detail) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
                    [scope || 'global', subjectId || 0, e.ts, String(e.label).slice(0, 120), String(e.detail || '').slice(0, 400)]);
                if (res.changes) ids.push(Number(res.lastInsertRowid));
                n++;   // Live counts every event it tried, the duplicates included
            } catch { /* */ }
        }
        return _writeResult(n, 'chat_timeline_events', (await Promise.all(ids.map(async (id) => await get('SELECT * FROM chat_timeline_events WHERE id = ?', [id])))));
    });
}

// ── Chat AI reads (the job and its routes) ────────────────────
// Live's server/db/database.js helpers, moved: same SQL, but Live's `users`/`streams` joins read
// the ctx_* projections here (Live's rows are not in this database).
const _CHAT_AI_WHERE = `cm.is_deleted = 0 AND cm.message_type != 'system'
    AND COALESCE(cm.source_platform,'') != 'ai'
    AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > ov_now())`;

async function getChatAiSummary(scope, subjectId, window) {
    return await get('SELECT * FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? AND "window" = ?',
        [scope, subjectId || 0, window]) || null;
}
async function getChatAiSummaries(scope, subjectId) {
    return await all('SELECT * FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? ORDER BY "window"',
        [scope, subjectId || 0]);
}
// Paginated + searchable timeline browse. `before` = epoch ms (exclusive upper bound); `q`
// filters label/detail; `since` = epoch ms lower bound (for period jumps). Newest first.
async function getChatTimelineEvents({ scope = 'global', subjectId = 0, before = null, since = null, q = null, limit = 25 } = {}) {
    const conds = ['scope = ?', 'subject_id = ?'];
    const params = [scope, subjectId || 0];
    if (before) { conds.push("ts < to_char(to_timestamp(?) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"); params.push(Math.floor(before / 1000)); }
    if (since) { conds.push("ts >= to_char(to_timestamp(?) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"); params.push(Math.floor(since / 1000)); }
    if (q && String(q).trim()) { const like = '%' + String(q).trim().slice(0, 60) + '%'; conds.push('(label ILIKE ? OR detail ILIKE ?)'); params.push(like, like); }
    params.push(Math.min(60, Math.max(1, limit)));
    try {
        return await all(`SELECT id, ts, label, detail FROM chat_timeline_events WHERE ${conds.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`, params) || [];
    } catch { return []; }
}

async function getMaxChatMessageId() {
    return (await get('SELECT MAX(id) AS m FROM chat_messages'))?.m || 0;
}
// Count analyzable messages newer than a high-water id (optionally for one user).
async function countChatMessagesSince(afterId, userId = null) {
    let sql = `SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${_CHAT_AI_WHERE} AND cm.id > ?`;
    const params = [afterId || 0];
    if (userId) { sql += ' AND cm.user_id = ?'; params.push(userId); }
    return (await get(sql, params))?.c || 0;
}
// Fetch analyzable messages for AI batching (with the channel/broadcaster label).
async function getChatMessagesForAi({ afterId = null, sinceTs = null, userId = null, limit = 400, order = 'asc' } = {}) {
    let sql = `SELECT cm.id, cm.user_id, cm.username, cm.message, cm.message_type, cm.timestamp,
                      cm.stream_id, cm.channel_user_id, cm.is_global,
                      ch.username AS channel_username, ch.display_name AS channel_display
               FROM chat_messages cm
               LEFT JOIN ctx_users ch ON cm.channel_user_id = ch.id
               WHERE ${_CHAT_AI_WHERE}`;
    const params = [];
    if (afterId != null) { sql += ' AND cm.id > ?'; params.push(afterId); }
    if (sinceTs != null) { sql += ' AND cm.timestamp >= ?'; params.push(sinceTs); }
    if (userId) { sql += ' AND cm.user_id = ?'; params.push(userId); }
    sql += ` ORDER BY cm.id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, limit)));
    const rows = await all(sql, params);
    return order === 'desc' ? rows.reverse() : rows;
}
// Timestamp of the Nth-most-recent analyzable message — drives the adaptive overview window.
async function getNthRecentChatTs(n, userId = null) {
    let sql = `SELECT cm.timestamp AS ts FROM chat_messages cm WHERE ${_CHAT_AI_WHERE}`;
    const params = [];
    if (userId) { sql += ' AND cm.user_id = ?'; params.push(userId); }
    sql += ' ORDER BY cm.id DESC LIMIT 1 OFFSET ?';
    params.push(Math.max(0, (n | 0) - 1));
    return (await get(sql, params))?.ts || null;
}

// Users with enough new chat activity (or a stale summary) to warrant an AI refresh.
async function getUsersNeedingChatAi({ threshold = 15, staleCutoffIso, sinceTs, limit = 3 } = {}) {
    const sql = `
        SELECT cm.user_id AS uid,
               MAX(cm.id) AS max_id,
               CAST(SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) AS BIGINT) AS new_msgs,
               COALESCE(cs.last_message_id, 0) AS hw,
               cs.updated_at AS last_update
        FROM chat_messages cm
        LEFT JOIN chat_ai_summaries cs
          ON cs.scope = 'user' AND cs.subject_id = cm.user_id AND cs."window" = 'rolling'
        WHERE ${_CHAT_AI_WHERE} AND cm.user_id IS NOT NULL AND cm.timestamp >= ?
        GROUP BY cm.user_id, cs.last_message_id, cs.updated_at
        HAVING SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) > 0
           AND ( SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) >= ? OR cs.last_message_id IS NULL OR cs.updated_at IS NULL OR cs.updated_at < ? )
        ORDER BY (cs.updated_at IS NULL) DESC, new_msgs DESC
        LIMIT ?`;
    return await all(sql, [sinceTs, threshold, staleCutoffIso, Math.max(1, limit)]);
}

// Relay messages for AI batching (mirrors getChatMessagesForAi).
async function getRelayChatMessagesForAi({ platform, rawUsername, sinceTs = null, limit = 300, order = 'asc' } = {}) {
    let sql = `SELECT cm.id, cm.username, cm.message, cm.message_type, cm.timestamp, cm.source_platform
               FROM chat_messages cm
               WHERE ${_CHAT_AI_WHERE} AND ${_RELAY_MATCH}`;
    const params = _relayMatchParams(platform, rawUsername);
    if (sinceTs != null) { sql += ' AND cm.timestamp >= ?'; params.push(sinceTs); }
    sql += ` ORDER BY cm.id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, limit)));
    const rows = await all(sql, params);
    return order === 'desc' ? rows.reverse() : rows;
}

// Relay users with new activity since their last AI summary (or never summarised).
async function getRelayUsersNeedingChatAi({ lookbackIso, threshold = 8, limit = 2 } = {}) {
    return await all(`
        SELECT r.id, r.platform, r.username, r.display_name, r.message_count, r.last_seen,
               cs.updated_at AS last_update
        FROM relay_users r
        LEFT JOIN chat_ai_summaries cs
          ON cs.scope = 'relay' AND cs."window" = 'rolling' AND cs.subject_id = r.id
        WHERE r.last_seen >= ?
          AND r.message_count >= ?
          AND (cs.updated_at IS NULL OR cs.updated_at < r.last_seen)
        ORDER BY (cs.updated_at IS NULL) DESC, r.last_seen DESC
        LIMIT ?`, [lookbackIso, threshold, Math.max(1, limit)]);
}

// Anon messages for AI batching (mirrors getChatMessagesForAi / getRelayChatMessagesForAi).
async function getAnonChatMessagesForAi({ anonId, sinceTs = null, limit = 300, order = 'asc' } = {}) {
    let sql = `SELECT cm.id, cm.username, cm.message, cm.message_type, cm.timestamp
               FROM chat_messages cm
               WHERE ${_CHAT_AI_WHERE} AND cm.user_id IS NULL AND cm.anon_id = ?`;
    const params = [String(anonId)];
    if (sinceTs != null) { sql += ' AND cm.timestamp >= ?'; params.push(sinceTs); }
    sql += ` ORDER BY cm.id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, limit)));
    const rows = await all(sql, params);
    return order === 'desc' ? rows.reverse() : rows;
}

// Anons with enough new chat activity (or a stale summary) to warrant an AI refresh.
async function getAnonsNeedingChatAi({ threshold = 12, staleCutoffIso, sinceTs, limit = 2 } = {}) {
    const sql = `
        SELECT cm.anon_id AS anon_id,
               MAX(cm.id) AS max_id,
               CAST(SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) AS BIGINT) AS new_msgs
        FROM chat_messages cm
        LEFT JOIN chat_ai_summaries cs
          ON cs.scope = 'anon' AND cs."window" = 'rolling'
         AND cs.subject_id = CASE WHEN cm.anon_id ~ '^anon[0-9]{1,15}$' THEN CAST(SUBSTR(cm.anon_id, 5) AS BIGINT) END
        WHERE ${_CHAT_AI_WHERE} AND cm.user_id IS NULL AND cm.anon_id IS NOT NULL
          AND cm.anon_id ILIKE 'anon%' AND cm.timestamp >= ?
        GROUP BY cm.anon_id, cs.last_message_id, cs.updated_at
        HAVING SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) > 0
           AND ( SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) >= ? OR cs.last_message_id IS NULL OR cs.updated_at IS NULL OR cs.updated_at < ? )
        ORDER BY (cs.updated_at IS NULL) DESC, new_msgs DESC
        LIMIT ?`;
    return await all(sql, [sinceTs, threshold, staleCutoffIso, Math.max(1, limit)]);
}

// ── Meta ─────────────────────────────────────────────────────
async function getMeta(key) { return (await get('SELECT value FROM chat_meta WHERE key = ?', [key]))?.value ?? null; }
async function setMeta(key, value) { return await run('INSERT INTO chat_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value == null ? null : String(value)]); }

module.exports = {
    CHAT_TABLES,
    moderationRow,
    chatMessageRow,
    openDb,
    getDb,
    initDb,
    setDb,
    close,
    run,
    get,
    all,
    transaction,
    tx: transaction,
    subjectFor,
    getMeta,
    setMeta,
    // chat messages
    saveChatMessage,
    searchChatMessages,
    getUserChatHistory,
    getChatReplay,
    getChatMessageById,
    mergeChatMessageMetadata,
    deleteChatMessage,
    deleteUserChatMessages,
    deleteAnonChatMessages,
    deleteRelayUserMessages,
    deleteExpiredChatMessages,
    deleteChatMessagesByTimeRange,
    countChatMessagesByTimeRange,
    getChatLogs,
    getRecentChatActivity,
    renameUserChatMessages,
    // relay + anon chatters
    recordRelayUser,
    getRelayUser,
    getRelayUserChatHistory,
    hideRelayUser,
    isRelayUserHidden,
    unhideRelayUser,
    unhideRelayUserByIdentity,
    anonSubjectId,
    getAnonMeta,
    getAnonChatHistory,
    // first chats, moderation, IP approval queue
    isFirstChatInChannel,
    recordFirstChat,
    logModerationAction,
    holdMessageForApproval,
    reviewPendingIpMessage,
    approveAllFromIp,
    denyAllFromIp,
    // TTS overrides + channel sounds
    getTtsVoiceOverride,
    setTtsVoiceOverride,
    deleteTtsVoiceOverride,
    createChannelSound,
    setChannelSoundEmote,
    getChannelSounds,
    getChannelSoundByCommand,
    getChannelSoundById,
    countChannelSounds,
    countChannelSoundsByUploader,
    deleteChannelSound,
    renameChannelSoundCommand,
    updateChannelSoundEmoteRefs,
    // the six staged tables: reads for the public APIs and Live's internal read API (T3)
    isChannelModerator,
    getChannelModerationSettingsRow,
    getChannelModerators,
    getChannelModeratorIds,
    getChannelsByModerator,
    getGlobalEmotes,
    getChannelEmotes,
    countChannelEmotes,
    getChannelEmoteByCode,
    getEmoteById,
    getEmotesByUser,
    getModerationActions,
    searchChannelChatMessages,
    // The six tables Chat owns (C-04 done): moderators, settings, emotes, tags, chat AI
    addChannelModerator,
    removeChannelModerator,
    upsertChannelModerationSettings,
    setChannelAlertSound,
    createEmote,
    updateEmote,
    deleteEmote,
    setEmoteMedia,
    grantUserTag,
    revokeUserTag,
    upsertChatAiSummary,
    addChatTimelineEvents,
    // chat AI (Live's server/ai/chat-ai.js, moved): the job's selection/read helpers and the routes' reads
    getChatAiSummary,
    getChatAiSummaries,
    getChatTimelineEvents,
    getMaxChatMessageId,
    countChatMessagesSince,
    getChatMessagesForAi,
    getNthRecentChatTs,
    getUsersNeedingChatAi,
    getRelayChatMessagesForAi,
    getRelayUsersNeedingChatAi,
    getAnonChatMessagesForAi,
    getAnonsNeedingChatAi,
};
