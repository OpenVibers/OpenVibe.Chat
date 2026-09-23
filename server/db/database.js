/**
 * OpenVibe.Chat — database access (better-sqlite3).
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

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;
let _dbPath = null;
const _stmts = new Map();

// Tables Chat writes from the cutover on; Live keeps a read mirror of each (server/bridge/live-mirror.js).
const CHAT_TABLES = {
    chat_messages: ['id'],
    dm_conversations: ['id'],
    dm_participants: ['id'],
    dm_messages: ['id'],
    dm_blocks: ['id'],
    tts_voice_overrides: ['identity_key'],
    channel_sounds: ['id'],
    relay_users: ['platform', 'username'],
    hidden_relay_users: ['id'],
    pending_ip_messages: ['id'],
    stream_first_chats: ['chatter_key', 'channel_user_id'],
    moderation_actions: ['id'],
};
// Chat-target tables Live still writes in this wave: imported here, read through live-context.
const STAGED_TABLES = {
    channel_moderators: 'written by Live /api/channels (channel-mod-routes) until that route moves',
    channel_moderation_settings: 'written by Live /api/channels and the dashboard; /slow and alert sounds go through Live',
    emotes: 'written by Live /api/emotes and its Media asset-sync',
    user_tags: 'written by Live game/tags (shop); chat reads tags through live-context',
    chat_ai_summaries: 'written by Live server/ai/chat-ai.js',
    chat_timeline_events: 'written by Live server/ai/chat-ai.js',
};

function getDb() {
    if (!db) {
        _dbPath = path.resolve(config.dbPath);
        fs.mkdirSync(path.dirname(_dbPath), { recursive: true });
        db = new Database(_dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
        try {
            db.pragma('synchronous = NORMAL');
            db.pragma('cache_size = -65536');
            db.pragma('temp_store = MEMORY');
        } catch (e) { console.warn('[DB] pragma tuning:', e.message); }
    }
    return db;
}

function stmt(sql) {
    let s = _stmts.get(sql);
    if (!s) {
        s = getDb().prepare(sql);
        if (_stmts.size > 500) _stmts.clear();
        _stmts.set(sql, s);
    }
    return s;
}

function run(sql, params = []) {
    return stmt(sql).run(...(Array.isArray(params) ? params : [params]));
}

function get(sql, params = []) {
    return stmt(sql).get(...(Array.isArray(params) ? params : [params]));
}

function all(sql, params = []) {
    return stmt(sql).all(...(Array.isArray(params) ? params : [params]));
}

function transaction(fn) {
    return getDb().transaction(fn)();
}

function close() {
    if (db) { try { db.close(); } catch { /* */ } }
    db = null;
    _stmts.clear();
}

/**
 * Create the schema. opts.captureMirror installs this connection's TEMP triggers that record
 * every change to Chat's tables for the Live mirror — the service does; the importer does not,
 * so imported rows (which came from Live) are never sent back.
 */
const ADDED_COLUMNS = [
    ['emotes', 'media_url', 'TEXT'],          // Live: emote images synced to OpenVibe.Media
    ['emotes', 'media_asset_id', 'INTEGER'],
];

function initDb({ captureMirror = false } = {}) {
    const d = getDb();
    d.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    // Columns Live added after a Chat database was created (CREATE TABLE IF NOT EXISTS does not add them).
    for (const [table, column, type] of ADDED_COLUMNS) {
        const have = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
        if (!have) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    const upsertAuth = d.prepare('INSERT INTO table_authority (table_name, authority, note) VALUES (?, ?, ?) ON CONFLICT(table_name) DO UPDATE SET authority = excluded.authority, note = excluded.note');
    for (const t of Object.keys(CHAT_TABLES)) upsertAuth.run(t, 'chat', 'Chat writes; Live keeps a read mirror');
    for (const [t, note] of Object.entries(STAGED_TABLES)) upsertAuth.run(t, 'live', note);
    if (captureMirror) installMirrorTriggers();
    return d;
}

function installMirrorTriggers() {
    const d = getDb();
    for (const [table, pk] of Object.entries(CHAT_TABLES)) {
        const obj = (alias) => `json_object(${pk.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`;
        d.exec(`
            CREATE TEMP TRIGGER IF NOT EXISTS mirror_${table}_ins AFTER INSERT ON main.${table}
            BEGIN INSERT INTO live_mirror_outbox (tbl, op, pk) VALUES ('${table}', 'upsert', ${obj('NEW')}); END;
            CREATE TEMP TRIGGER IF NOT EXISTS mirror_${table}_upd AFTER UPDATE ON main.${table}
            BEGIN INSERT INTO live_mirror_outbox (tbl, op, pk) VALUES ('${table}', 'upsert', ${obj('NEW')}); END;
            CREATE TEMP TRIGGER IF NOT EXISTS mirror_${table}_del AFTER DELETE ON main.${table}
            BEGIN INSERT INTO live_mirror_outbox (tbl, op, pk) VALUES ('${table}', 'delete', ${obj('OLD')}); END;
        `);
    }
}

// ── Subjects ──────────────────────────────────────────────────
// Live user id → Network subject (usr_…) from the ctx_users projection. New rows carry it so a
// later wave can drop Live ids.
function subjectFor(userId) {
    if (!userId) return null;
    try { return get('SELECT subject_id FROM ctx_users WHERE id = ?', [userId])?.subject_id || null; } catch { return null; }
}

function _outbox() { return require('../events/outbox'); }
function _ctx() { return require('../live-context'); }

// ── Chat messages ─────────────────────────────────────────────

function saveChatMessage({ stream_id, channel_user_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id, source_platform, auto_delete_at, metadata }) {
    // channel_user_id = the broadcaster's user id — set for all channel/stream
    // messages so a streamer's chat history survives across sessions AND offline
    // periods (independent of the live-session stream row's lifetime).
    let chanUid = channel_user_id || null;
    if (!chanUid && stream_id) { try { chanUid = _ctx().getStreamById(stream_id)?.user_id || null; } catch { /* ignore */ } }
    const metaStr = metadata == null ? null : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    const subject = subjectFor(user_id);
    return transaction(() => {
        const res = run(
            `INSERT INTO chat_messages (stream_id, channel_user_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id, source_platform, auto_delete_at, metadata, subject_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [stream_id, chanUid, user_id || null, anon_id || null, username, message, message_type || 'chat', is_global ? 1 : 0, reply_to_id || null, source_platform || null, auto_delete_at || null, metaStr, subject]
        );
        _outbox().enqueue({
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

function searchChatMessages({ query, userId, anonId, username, streamId, limit = 50, offset = 0 }) {
    let sql = `SELECT cm.*, u.display_name, u.username as u_username, u.role, u.avatar_url, u.profile_color
               FROM chat_messages cm
               LEFT JOIN ctx_users u ON cm.user_id = u.id
               WHERE cm.is_deleted = 0
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
    const params = [];

    if (query) {
        sql += ` AND cm.message LIKE ?`;
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
        sql += ` AND LOWER(u.username) LIKE ?`;
        params.push(`%${username.toLowerCase()}%`);
    }
    if (streamId) {
        sql += ` AND cm.stream_id = ?`;
        params.push(streamId);
    }

    const countSql = sql.replace(/SELECT cm\.\*.*FROM/, 'SELECT COUNT(*) as c FROM');
    const total = get(countSql, params)?.c || 0;

    sql += ` ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return { messages: all(sql, params), total };
}

function getUserChatHistory(userId, limit = 50, offset = 0) {
    const sql = `SELECT cm.*, s.title as stream_title
                 FROM chat_messages cm
                 LEFT JOIN ctx_streams s ON cm.stream_id = s.id
                 WHERE cm.user_id = ? AND cm.is_deleted = 0
                   AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)
                 ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    const messages = all(sql, [userId, limit, offset]);
    const total = get(
        `SELECT COUNT(*) as c FROM chat_messages
         WHERE user_id = ? AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`,
        [userId]
    )?.c || 0;
    return { messages, total };
}

function getChatReplay(streamId, fromTime, toTime) {
    let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name
               FROM chat_messages cm
               LEFT JOIN ctx_users u ON cm.user_id = u.id
               WHERE cm.stream_id = ? AND cm.is_deleted = 0 AND cm.message_type = 'chat'
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
    const params = [streamId];
    if (fromTime) { sql += ` AND cm.timestamp >= ?`; params.push(fromTime); }
    if (toTime) { sql += ` AND cm.timestamp <= ?`; params.push(toTime); }
    sql += ` ORDER BY cm.timestamp ASC`;
    return all(sql, params);
}

/**
 * Get a single chat message by ID.
 */
function getChatMessageById(id) {
    return get('SELECT * FROM chat_messages WHERE id = ?', [id]);
}

/** Shallow-merge a JSON patch into chat_messages.metadata (e.g. an async translation). */
function mergeChatMessageMetadata(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return;
    const row = get('SELECT metadata FROM chat_messages WHERE id = ?', [id]);
    if (!row) return;
    let meta = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
    return run('UPDATE chat_messages SET metadata = ? WHERE id = ?', [JSON.stringify({ ...meta, ...patch }), id]);
}

/**
 * Soft-delete a chat message by ID. Sets is_deleted=1 and records who deleted it.
 */
function deleteChatMessage(id, deletedBy = null) {
    return run(
        'UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
        [deletedBy, id]
    );
}

/**
 * Soft-delete ALL chat messages from a specific user, optionally scoped to a stream.
 * Returns the list of deleted message IDs for real-time broadcast.
 */
function deleteUserChatMessages(userId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'user_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'user_id = ? AND is_deleted = 0';
    const params = streamId ? [userId, streamId] : [userId];
    const messages = all(`SELECT id FROM chat_messages WHERE ${condition}`, params);
    const ids = messages.map(m => m.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        [deletedBy, ...ids]
    );
    return ids;
}

/**
 * Soft-delete ALL chat messages from a specific anon_id, optionally scoped to stream.
 */
function deleteAnonChatMessages(anonId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'anon_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'anon_id = ? AND is_deleted = 0';
    const params = streamId ? [anonId, streamId] : [anonId];
    const messages = all(`SELECT id FROM chat_messages WHERE ${condition}`, params);
    const ids = messages.map(m => m.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        [deletedBy, ...ids]
    );
    return ids;
}

/**
 * Soft-delete ALL messages from a relayed external username (e.g. "[Twitch] foobar")
 */
function deleteRelayUserMessages(username, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'username = ? AND stream_id = ? AND is_deleted = 0'
        : 'username = ? AND is_deleted = 0';
    const params = streamId ? [username, streamId] : [username];
    const messages = all(`SELECT id FROM chat_messages WHERE ${condition}`, params);
    const ids = messages.map(m => m.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        [deletedBy, ...ids]
    );
    return ids;
}

function deleteExpiredChatMessages(limit = 500) {
    const rows = all(
        `SELECT id, stream_id
         FROM chat_messages
         WHERE is_deleted = 0
           AND auto_delete_at IS NOT NULL
           -- Compared raw, not through datetime(): wrapping the column in a function makes the
           -- index on auto_delete_at unusable, and this sweep runs every 30 seconds against the
           -- biggest table on the site. Values are stored in the same 'YYYY-MM-DD HH:MM:SS' shape
           -- CURRENT_TIMESTAMP produces, so a string comparison sorts identically.
           AND auto_delete_at <= CURRENT_TIMESTAMP
         ORDER BY auto_delete_at ASC
         LIMIT ?`,
        [Math.max(1, Number(limit) || 500)]
    );
    if (!rows.length) return [];

    const ids = rows.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages
         SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders})`,
        ids
    );
    return rows;
}

function deleteChatMessagesByTimeRange(streamId, fromTime, toTime, deletedBy) {
    if (streamId) {
        return run(
            `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP
             WHERE stream_id = ? AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
            [deletedBy, streamId, fromTime, toTime]
        );
    }
    // Global chat (is_global = 1)
    return run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP
         WHERE is_global = 1 AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
        [deletedBy, fromTime, toTime]
    );
}

function countChatMessagesByTimeRange(streamId, fromTime, toTime) {
    let row;
    if (streamId) {
        row = get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE stream_id = ? AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
            [streamId, fromTime, toTime]
        );
    } else {
        row = get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE is_global = 1 AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
            [fromTime, toTime]
        );
    }
    return row?.cnt || 0;
}

function getChatLogs({ streamId, username, search, from, to, messageType, page = 1, limit = 50, includeDeleted = false } = {}) {
    const conditions = [];
    const params = [];

    if (streamId) { conditions.push('stream_id = ?'); params.push(streamId); }
    if (username) { conditions.push('username LIKE ?'); params.push(`%${username}%`); }
    if (search) { conditions.push('message LIKE ?'); params.push(`%${search}%`); }
    if (from) { conditions.push('timestamp >= ?'); params.push(from); }
    if (to) { conditions.push('timestamp <= ?'); params.push(to); }
    if (messageType) { conditions.push('message_type = ?'); params.push(messageType); }
    if (!includeDeleted) { conditions.push('is_deleted = 0'); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const countRow = get(`SELECT COUNT(*) as total FROM chat_messages ${where}`, params);
    const total = countRow?.total || 0;
    const rows = all(
        `SELECT * FROM chat_messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}

function getRecentChatActivity(streamId, minutes) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const row = get(
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
function renameUserChatMessages(userId, newChatName) {
    return run('UPDATE chat_messages SET username = ? WHERE user_id = ?', [newChatName, userId]);
}

// ── Relay (external platform) chatters ───────────────────────

// Record a chat-relay (external platform) user's activity; keeps the earliest
// first_seen as their "join date". Keyed case-insensitively by platform+username.
function recordRelayUser(platform, username) {
    if (!platform || !username) return;
    const key = String(username).toLowerCase();
    try {
        run(`INSERT INTO relay_users (platform, username, display_name, first_seen, last_seen, message_count)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
             ON CONFLICT(platform, username) DO UPDATE SET
                last_seen = CURRENT_TIMESTAMP,
                message_count = message_count + 1,
                display_name = excluded.display_name`,
            [String(platform).toLowerCase(), key, String(username)]);
    } catch { /* non-critical */ }
}
function getRelayUser(platform, username) {
    if (!platform || !username) return null;
    // rowid is a stable integer id for a relay user (no dedicated id column); used to key
    // their chat-AI insight in chat_ai_summaries.
    return get('SELECT rowid AS id, * FROM relay_users WHERE platform = ? AND username = ?',
        [String(platform).toLowerCase(), String(username).toLowerCase()]) || null;
}

// Relay chat messages are stored with a "[Label] name" username + source_platform and a
// NULL user_id. Match a specific relay user by the trailing "] name" (LIKE is
// case-insensitive for ASCII in SQLite), scoped to their platform.
function _likeEscape(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }
const _RELAY_MATCH = `cm.user_id IS NULL AND cm.source_platform = ? AND cm.username LIKE ? ESCAPE '\\'`;
function _relayMatchParams(platform, rawUsername) {
    return [String(platform).toLowerCase(), '%] ' + _likeEscape(String(rawUsername))];
}

// A relay user's message history (for the "Chat Logs" viewer).
function getRelayUserChatHistory(platform, rawUsername, { limit = 50, offset = 0, query = '' } = {}) {
    let where = `${_RELAY_MATCH} AND cm.is_deleted = 0`;
    const params = _relayMatchParams(platform, rawUsername);
    if (query) { where += ' AND cm.message LIKE ?'; params.push('%' + query + '%'); }
    const total = get(`SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${where}`, params)?.c || 0;
    const rows = all(
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
function hideRelayUser({ channelId, platform, externalUsername, action = 'hide', reason, createdBy }) {
    return run(
        `INSERT OR REPLACE INTO hidden_relay_users (channel_id, platform, external_username, action, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [channelId || null, platform, externalUsername, action, reason || null, createdBy]
    );
}

/**
 * Check if a relayed user is hidden/banned.
 * Checks both channel-scoped and site-wide entries (channel_id IS NULL).
 */
function isRelayUserHidden(channelId, platform, externalUsername) {
    return !!get(
        `SELECT 1 FROM hidden_relay_users
         WHERE platform = ? AND external_username = ? AND (channel_id = ? OR channel_id IS NULL)`,
        [platform, externalUsername, channelId]
    );
}

/**
 * Unhide/unban a relayed external user.
 */
function unhideRelayUser(id) {
    return run('DELETE FROM hidden_relay_users WHERE id = ?', [id]);
}

/**
 * Unhide/unban a relayed external user by identity (platform + external username +
 * channel). Scoped to a single relay identity — never touches a registered
 * openvibelive account of the same name. `channel_id IS ?` matches NULL safely.
 */
function unhideRelayUserByIdentity(channelId, platform, externalUsername) {
    return run(
        'DELETE FROM hidden_relay_users WHERE platform = ? AND external_username = ? AND channel_id IS ?',
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
function getAnonMeta(anonId, firstSeenAt = null) {
    const num = anonSubjectId(anonId);
    const firstChat = get(
        `SELECT MIN(timestamp) AS t FROM chat_messages
         WHERE anon_id = ? AND user_id IS NULL AND is_deleted = 0`, [String(anonId)]
    )?.t || null;
    const count = get(
        `SELECT COUNT(*) AS c FROM chat_messages
         WHERE anon_id = ? AND user_id IS NULL AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`, [String(anonId)]
    )?.c || 0;
    return {
        anon_id: anonId,
        anon_num: num || null,
        first_seen: firstSeenAt || firstChat, // fall back to first chat for legacy rows
        first_chat: firstChat,
        message_count: count,
    };
}

// An anon's message history (for the "Chat Logs" viewer).
function getAnonChatHistory(anonId, { limit = 50, offset = 0, query = '' } = {}) {
    let where = `cm.anon_id = ? AND cm.user_id IS NULL AND cm.is_deleted = 0
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
    const params = [String(anonId)];
    if (query) { where += ' AND cm.message LIKE ?'; params.push('%' + query + '%'); }
    const total = get(`SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${where}`, params)?.c || 0;
    const rows = all(
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
function isFirstChatInChannel(chatterKey, channelUserId) {
    const row = get(
        'SELECT 1 FROM stream_first_chats WHERE chatter_key = ? AND channel_user_id = ?',
        [chatterKey, channelUserId]
    );
    return !row;
}

/**
 * Record that a chatter has chatted in a streamer's channel.
 */
function recordFirstChat(chatterKey, channelUserId) {
    run(
        'INSERT OR IGNORE INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?)',
        [chatterKey, channelUserId]
    );
}

// ── Moderation log ───────────────────────────────────────────

/**
 * Log a moderation action for auditing.
 * Used by canvas, chat moderation, bans, etc.
 */
function logModerationAction({ scope_type, scope_id, actor_user_id, target_user_id, action_type, details }) {
    const actorSubject = subjectFor(actor_user_id);
    return transaction(() => {
        const res = run(`
            INSERT INTO moderation_actions (scope_type, scope_id, actor_user_id, target_user_id, action_type, details, actor_subject_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [scope_type || 'site', scope_id || null, actor_user_id || null, target_user_id || null, action_type, JSON.stringify(details || {}), actorSubject]);
        _outbox().enqueue({
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
                target_subject: subjectFor(target_user_id),
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
function holdMessageForApproval({ channelId, streamId, ip, userId, anonId, username, message }) {
    return run(
        `INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, user_id, anon_id, username, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [channelId, streamId, ip, userId || null, anonId || null, username, message]
    );
}

/**
 * Approve or deny a pending IP message. If approved, auto-approve the IP too (approved_ips is
 * Live's table: the approval goes through live-context).
 */
function reviewPendingIpMessage(id, { status, reviewedBy, channelId }) {
    // Scoped to the channel the caller was authorised for, so a message id from another channel's
    // queue matches nothing.
    const scoped = channelId != null;
    const res = scoped
        ? run('UPDATE pending_ip_messages SET status = ?, reviewed_by = ? WHERE id = ? AND channel_id = ?', [status, reviewedBy, id, channelId])
        : run('UPDATE pending_ip_messages SET status = ?, reviewed_by = ? WHERE id = ?', [status, reviewedBy, id]);
    if (!res.changes) return;
    if (status === 'approved') {
        const msg = get('SELECT * FROM pending_ip_messages WHERE id = ?', [id]);
        if (msg) _ctx().approveIp(channelId || msg.channel_id, msg.ip_address, reviewedBy, 'manual');
    }
}

/**
 * Bulk-approve all pending messages from a specific IP in a channel.
 */
function approveAllFromIp(channelId, ip, reviewedBy) {
    _ctx().approveIp(channelId, ip, reviewedBy, 'manual');
    return run(
        "UPDATE pending_ip_messages SET status = 'approved', reviewed_by = ? WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
        [reviewedBy, channelId, ip]
    );
}

/**
 * Deny all pending messages from a specific IP in a channel.
 */
function denyAllFromIp(channelId, ip, reviewedBy) {
    return run(
        "UPDATE pending_ip_messages SET status = 'denied', reviewed_by = ? WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
        [reviewedBy, channelId, ip]
    );
}

// ── Per-user TTS voice overrides (admin-set) ─────────────────
function getTtsVoiceOverride(identityKey) {
    try {
        const k = String(identityKey || '').trim().toLowerCase();
        if (!k) return null;
        const r = get('SELECT voice, pitch, speed, gap FROM tts_voice_overrides WHERE identity_key = ?', [k]);
        if (!r) return null;
        return { voice: r.voice, pitch: r.pitch, speed: r.speed, gap: r.gap || 0 };
    } catch { return null; }
}
function setTtsVoiceOverride(identityKey, params, setBy) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return false;
    run(`INSERT INTO tts_voice_overrides (identity_key, voice, pitch, speed, gap, set_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(identity_key) DO UPDATE SET voice=excluded.voice, pitch=excluded.pitch,
             speed=excluded.speed, gap=excluded.gap, set_by=excluded.set_by, updated_at=CURRENT_TIMESTAMP`,
        [k, params.voice, params.pitch, params.speed, params.gap || 0, setBy || null]);
    return true;
}
function deleteTtsVoiceOverride(identityKey) {
    try { run('DELETE FROM tts_voice_overrides WHERE identity_key = ?', [String(identityKey || '').trim().toLowerCase()]); return true; } catch { return false; }
}

// ── Channel sound commands (viewer-uploadable) ───────────────
function createChannelSound({ channel_owner_id, command, url, mime = 'audio/mpeg', duration_seconds = 0, created_by = null, created_by_name = '', emote_code = '' }) {
    return run(
        `INSERT INTO channel_sounds (channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, emote_code, created_by_subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, emote_code || '', subjectFor(created_by)]
    );
}
// Update the shared emote_code for all sounds under a command (an emote is per-command).
function setChannelSoundEmote(ownerId, command, emoteCode) {
    return run('UPDATE channel_sounds SET emote_code = ? WHERE channel_owner_id = ? AND command = ?',
        [emoteCode || '', ownerId, String(command || '').toLowerCase()]);
}

function getChannelSounds(ownerId) {
    return all(
        'SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND is_approved = 1 ORDER BY command',
        [ownerId]
    );
}

function getChannelSoundByCommand(ownerId, command) {
    // A command may have multiple uploaded sounds — pick one at random each play.
    return get(
        'SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND command = ? AND is_approved = 1 ORDER BY RANDOM() LIMIT 1',
        [ownerId, String(command || '').toLowerCase()]
    );
}

function getChannelSoundById(id) {
    return get('SELECT * FROM channel_sounds WHERE id = ?', [id]);
}

function countChannelSounds(ownerId) {
    const row = get('SELECT COUNT(*) as count FROM channel_sounds WHERE channel_owner_id = ?', [ownerId]);
    return row ? row.count : 0;
}

function countChannelSoundsByUploader(ownerId, uploaderId) {
    const row = get('SELECT COUNT(*) as count FROM channel_sounds WHERE channel_owner_id = ? AND created_by = ?', [ownerId, uploaderId]);
    return row ? row.count : 0;
}

function deleteChannelSound(id) {
    return run('DELETE FROM channel_sounds WHERE id = ?', [id]);
}

// Rename a whole !command group (a command may hold several sounds).
function renameChannelSoundCommand(ownerId, oldCommand, newCommand) {
    return run('UPDATE channel_sounds SET command = ? WHERE channel_owner_id = ? AND command = ?',
        [String(newCommand || '').toLowerCase(), ownerId, String(oldCommand || '').toLowerCase()]);
}

// Sounds attach emotes BY CODE — keep those references alive when an emote
// is renamed so the streamer's emote+sound combos don't silently break.
function updateChannelSoundEmoteRefs(ownerId, oldCode, newCode) {
    return run('UPDATE channel_sounds SET emote_code = ? WHERE channel_owner_id = ? AND emote_code = ?',
        [newCode || '', ownerId, oldCode]);
}

// ── Meta ─────────────────────────────────────────────────────
function getMeta(key) { return get('SELECT value FROM chat_meta WHERE key = ?', [key])?.value ?? null; }
function setMeta(key, value) { return run('INSERT INTO chat_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value == null ? null : String(value)]); }

module.exports = {
    CHAT_TABLES,
    STAGED_TABLES,
    getDb,
    initDb,
    installMirrorTriggers,
    close,
    run,
    get,
    all,
    transaction,
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
};
