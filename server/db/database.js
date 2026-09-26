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
// Chat-target tables whose writer moves per table (roadmap C-04, docs/staged-tables-cutover.md).
// table_authority says who writes each one: 'live' (the default) — Live writes, and every change
// it makes reaches this copy over the bridge (applyStagedChanges); 'chat' — the staged writes
// below are the only writers, Live's writers call them over the bridge and the Live mirror copies
// the table back. The notes say who wrote them before the move.
const STAGED_TABLES = {
    channel_moderators: 'Live /api/channels (channel-mod-routes) while at live',
    channel_moderation_settings: 'Live /api/channels, the dashboard, /slow and alert sounds while at live',
    emotes: 'Live /api/emotes and its Media asset-sync while at live',
    user_tags: 'no writer since Live’s game tags went read-only; data only',
    chat_ai_summaries: 'Live server/ai/chat-ai.js while at live',
    chat_timeline_events: 'Live server/ai/chat-ai.js while at live',
};
// Their primary keys (the mirror and Live's changes address rows by them).
const STAGED_KEYS = {
    channel_moderators: ['id'],
    channel_moderation_settings: ['channel_id'],
    emotes: ['id'],
    user_tags: ['id'],
    chat_ai_summaries: ['id'],
    chat_timeline_events: ['id'],
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
    ['ctx_users', 'subject_id', 'TEXT'],      // older Chat databases; auth/network-session.js looks users up by it
    ['channel_moderation_settings', 'sub_only', 'INTEGER DEFAULT 0'],   // sub-only chat (WS-I task 6), Live has it too
];

function initDb({ captureMirror = false } = {}) {
    const d = getDb();
    d.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    // Columns Live added after a Chat database was created (CREATE TABLE IF NOT EXISTS does not add them).
    for (const [table, column, type] of ADDED_COLUMNS) {
        const have = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
        if (!have) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    // auth/network-session.js resolves a verified Network token to its user by subject.
    d.exec('CREATE INDEX IF NOT EXISTS idx_ctx_users_subject ON ctx_users(subject_id)');
    const upsertAuth = d.prepare('INSERT INTO table_authority (table_name, authority, note) VALUES (?, ?, ?) ON CONFLICT(table_name) DO UPDATE SET authority = excluded.authority, note = excluded.note');
    for (const t of Object.keys(CHAT_TABLES)) upsertAuth.run(t, 'chat', 'Chat writes; Live keeps a read mirror');
    // A staged table keeps the authority it was handed (a restart never moves it back).
    const seedStaged = d.prepare("INSERT INTO table_authority (table_name, authority, note) VALUES (?, 'live', ?) ON CONFLICT(table_name) DO UPDATE SET note = excluded.note");
    for (const [t, note] of Object.entries(STAGED_TABLES)) seedStaged.run(t, note);
    _authority.at = 0;
    if (captureMirror) installMirrorTriggers();
    return d;
}

function installMirrorTriggers() {
    const d = getDb();
    const tables = [
        ...Object.entries(CHAT_TABLES).map(([table, pk]) => [table, pk, '']),
        // A staged table is mirrored only while Chat writes it (read at each change, so a handoff
        // made by another process counts at once).
        ...Object.entries(STAGED_KEYS).map(([table, pk]) => [table, pk, `WHEN (SELECT authority FROM main.table_authority WHERE table_name = '${table}') = 'chat'`]),
    ];
    for (const [table, pk, when] of tables) {
        const obj = (alias) => `json_object(${pk.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`;
        d.exec(`
            CREATE TEMP TRIGGER IF NOT EXISTS mirror_${table}_ins AFTER INSERT ON main.${table} ${when}
            BEGIN INSERT INTO live_mirror_outbox (tbl, op, pk) VALUES ('${table}', 'upsert', ${obj('NEW')}); END;
            CREATE TEMP TRIGGER IF NOT EXISTS mirror_${table}_upd AFTER UPDATE ON main.${table} ${when}
            BEGIN INSERT INTO live_mirror_outbox (tbl, op, pk) VALUES ('${table}', 'upsert', ${obj('NEW')}); END;
            CREATE TEMP TRIGGER IF NOT EXISTS mirror_${table}_del AFTER DELETE ON main.${table} ${when}
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

// Ids per chat.message.deleted event (OpenVibe.Events takes up to 1000 per redaction directive).
const DELETED_EVENT_IDS = 500;

/**
 * Announce deleted messages: one chat.message.deleted per DELETED_EVENT_IDS ids, in the caller's
 * transaction. Public like chat.message.created, and it carries only ids (never the text, the
 * author or who deleted it). payload.redacts asks OpenVibe.Events to turn the stored
 * chat.message.created of each id into a tombstone, so the text stops being replayable there.
 */
function _announceDeleted(ids) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    for (let i = 0; i < list.length; i += DELETED_EVENT_IDS) {
        const part = list.slice(i, i + DELETED_EVENT_IDS);
        _outbox().enqueue({
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
 * Soft-delete a chat message by ID. Sets is_deleted=1 and records who deleted it. Every delete below
 * also announces chat.message.deleted in the same transaction (_announceDeleted).
 */
function deleteChatMessage(id, deletedBy = null) {
    return transaction(() => {
        const res = run(
            'UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
            [deletedBy, id]
        );
        if (res.changes) _announceDeleted([id]);
        return res;
    });
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
    return transaction(() => {
        const ids = all(`SELECT id FROM chat_messages WHERE ${condition}`, params).map(m => m.id);
        if (ids.length === 0) return [];
        _softDeleteIds(ids, deletedBy);
        return ids;
    });
}

/**
 * Soft-delete ALL chat messages from a specific anon_id, optionally scoped to stream.
 */
function deleteAnonChatMessages(anonId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'anon_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'anon_id = ? AND is_deleted = 0';
    const params = streamId ? [anonId, streamId] : [anonId];
    return transaction(() => {
        const ids = all(`SELECT id FROM chat_messages WHERE ${condition}`, params).map(m => m.id);
        if (ids.length === 0) return [];
        _softDeleteIds(ids, deletedBy);
        return ids;
    });
}

/**
 * Soft-delete ALL messages from a relayed external username (e.g. "[Twitch] foobar")
 */
function deleteRelayUserMessages(username, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'username = ? AND stream_id = ? AND is_deleted = 0'
        : 'username = ? AND is_deleted = 0';
    const params = streamId ? [username, streamId] : [username];
    return transaction(() => {
        const ids = all(`SELECT id FROM chat_messages WHERE ${condition}`, params).map(m => m.id);
        if (ids.length === 0) return [];
        _softDeleteIds(ids, deletedBy);
        return ids;
    });
}

/** Mark `ids` deleted (in chunks, under SQLite's variable limit) and announce them. In a transaction. */
function _softDeleteIds(ids, deletedBy) {
    for (let i = 0; i < ids.length; i += DELETED_EVENT_IDS) {
        const part = ids.slice(i, i + DELETED_EVENT_IDS);
        run(
            `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${part.map(() => '?').join(',')})`,
            [deletedBy, ...part]
        );
    }
    _announceDeleted(ids);
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
    transaction(() => {
        run(
            `UPDATE chat_messages
             SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders})`,
            ids
        );
        _announceDeleted(ids);
    });
    return rows;
}

// Time ranges (purge, its preview, the log filter): the dashboard sends ISO instants ('…T…Z') and
// rows keep SQLite's 'YYYY-MM-DD HH:MM:SS'. Compared as TEXT, 'T' sorts after ' ', so a range
// matched nothing on its first day and all of its last; datetime(?) reads both forms as UTC.
function deleteChatMessagesByTimeRange(streamId, fromTime, toTime, deletedBy) {
    // Global chat is is_global = 1. The ids are read first, in the same transaction, to announce them.
    const where = streamId
        ? 'stream_id = ? AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0'
        : 'is_global = 1 AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0';
    const params = streamId ? [streamId, fromTime, toTime] : [fromTime, toTime];
    return transaction(() => {
        const ids = all(`SELECT id FROM chat_messages WHERE ${where}`, params).map(m => m.id);
        const res = run(
            `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE ${where}`,
            [deletedBy, ...params]
        );
        _announceDeleted(ids);
        // The ids too, so the purge reaches every surface that showed them (not only the stream's sockets).
        return Object.assign(res, { ids });
    });
}

function countChatMessagesByTimeRange(streamId, fromTime, toTime) {
    let row;
    if (streamId) {
        row = get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE stream_id = ? AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0`,
            [streamId, fromTime, toTime]
        );
    } else {
        row = get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE is_global = 1 AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0`,
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
    if (from) { conditions.push('timestamp >= datetime(?)'); params.push(from); }
    if (to) { conditions.push('timestamp <= datetime(?)'); params.push(to); }
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

// ── Staged tables (roadmap C-04) ──────────────────────────────
// Who writes each one is table_authority (STAGED_TABLES above). The reads are cached for a second:
// a handoff made by another process (scripts/table-authority.js) counts within that.
const _authority = { at: 0, map: new Map() };
function tableAuthority(table) {
    if (Date.now() - _authority.at > 1000) {
        _authority.map = new Map(all('SELECT table_name, authority FROM table_authority').map((r) => [r.table_name, r.authority]));
        _authority.at = Date.now();
    }
    return _authority.map.get(table) || (CHAT_TABLES[table] ? 'chat' : 'live');
}
function setTableAuthority(table, authority) {
    if (!STAGED_KEYS[table]) throw new Error(`${table} is not a staged table`);
    if (authority !== 'live' && authority !== 'chat') throw new Error('authority is live or chat');
    run('UPDATE table_authority SET authority = ? WHERE table_name = ?', [authority, table]);
    _authority.at = 0;
    return tableAuthority(table);
}
/** { table: authority } for the staged tables. */
function stagedAuthorities() {
    return Object.fromEntries(Object.keys(STAGED_KEYS).map((t) => [t, tableAuthority(t)]));
}
/** Changes of this table still queued for Live (the mirror drains them). */
function mirrorPending(table) {
    return get('SELECT COUNT(*) AS n FROM live_mirror_outbox WHERE tbl = ?', [table])?.n || 0;
}

const _colCache = new Map();
function _columns(table) {
    if (!_colCache.has(table)) _colCache.set(table, new Set(getDb().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    return _colCache.get(table);
}

/** A staged write refuses while Live still writes the table: one writer at a time. */
function _assertChatWrites(table) {
    if (tableAuthority(table) === 'chat') return;
    const err = new Error(`${table} is written by Live (table_authority live)`);
    err.code = 'table.not_chat';
    throw err;
}

/**
 * What a staged write returns over the bridge: `value` — what Live's function of the same name
 * returns (its callers keep working), and `mirror` — the rows as they are now, in the Live mirror's
 * change shape, so Live's copy is right at once (the mirror sends the same rows again later).
 */
function _staged(value, table, rows = [], deletedPks = []) {
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
function addChannelModerator(channelId, userId, addedBy) {
    _assertChatWrites('channel_moderators');
    const out = transaction(() => {
        const res = run('INSERT OR IGNORE INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)', [channelId, userId, addedBy]);
        return _staged(res, 'channel_moderators', all('SELECT * FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]));
    });
    _ctx().invalidateChannel(channelId);
    return out;
}

function removeChannelModerator(channelId, userId) {
    _assertChatWrites('channel_moderators');
    const out = transaction(() => {
        const gone = all('SELECT id FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
        const res = run('DELETE FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
        return _staged(res, 'channel_moderators', [], gone.map((r) => ({ id: r.id })));
    });
    _ctx().invalidateChannel(channelId);
    return out;
}

// Live's upsertChannelModerationSettings, clamps and all.
function upsertChannelModerationSettings(channelId, fields) {
    _assertChatWrites('channel_moderation_settings');
    const out = transaction(() => {
        const existing = get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId]);
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
                updates.push('updated_at = CURRENT_TIMESTAMP');
                params.push(channelId);
                run(`UPDATE channel_moderation_settings SET ${updates.join(', ')} WHERE channel_id = ?`, params);
            }
        } else {
            const b = (v, dflt) => (v !== undefined ? (v ? 1 : 0) : dflt);
            run(
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
            run('UPDATE channel_moderation_settings SET tts_max_length = ? WHERE channel_id = ?', [Math.min(1000, Math.max(10, Number(fields.tts_max_length) || 200)), channelId]);
        }
        if (fields.sub_only !== undefined) run('UPDATE channel_moderation_settings SET sub_only = ? WHERE channel_id = ?', [fields.sub_only ? 1 : 0, channelId]);
        const row = get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId]);
        return _staged(row, 'channel_moderation_settings', [row]);
    });
    _ctx().invalidateChannel(channelId);
    return out;
}

// Donation / goal alert sounds live on the settings row (url = the file's path in the sounds dir).
function setChannelAlertSound(channelId, kind, url, mime) {
    _assertChatWrites('channel_moderation_settings');
    const out = transaction(() => {
        if (!get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId])) {
            run('INSERT INTO channel_moderation_settings (channel_id) VALUES (?)', [channelId]);
        }
        const col = kind === 'goal' ? 'goal_sound' : 'donation_sound';
        const res = run(`UPDATE channel_moderation_settings SET ${col}_url = ?, ${col}_mime = ? WHERE channel_id = ?`, [url || null, mime || null, channelId]);
        return _staged(res, 'channel_moderation_settings', [get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId])]);
    });
    _ctx().invalidateChannel(channelId);
    return out;
}

// Emotes (Live's /api/emotes; media_url/media_asset_id from its Media asset-sync).
function createEmote({ user_id, code, url, animated = false, width = 28, height = 28, is_global = false, channel_owner_id = null, size = 100 }) {
    _assertChatWrites('emotes');
    return transaction(() => {
        const res = run(
            `INSERT INTO emotes (user_id, code, url, animated, width, height, is_global, channel_owner_id, size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, code, url, animated ? 1 : 0, width, height, is_global ? 1 : 0, channel_owner_id || null, Math.min(400, Math.max(25, parseInt(size, 10) || 100))]
        );
        return _staged(res, 'emotes', [get('SELECT * FROM emotes WHERE id = ?', [res.lastInsertRowid])]);
    });
}

function updateEmote(id, { code, size } = {}) {
    _assertChatWrites('emotes');
    const sets = [];
    const params = [];
    if (code !== undefined) { sets.push('code = ?'); params.push(code); }
    if (size !== undefined) { sets.push('size = ?'); params.push(Math.min(400, Math.max(25, parseInt(size, 10) || 100))); }
    if (!sets.length) return _staged({ changes: 0 }, 'emotes');
    return transaction(() => {
        const res = run(`UPDATE emotes SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        return _staged(res, 'emotes', [get('SELECT * FROM emotes WHERE id = ?', [id])]);
    });
}

function deleteEmote(id) {
    _assertChatWrites('emotes');
    return transaction(() => {
        const had = get('SELECT id FROM emotes WHERE id = ?', [id]);
        const res = run('DELETE FROM emotes WHERE id = ?', [id]);
        return _staged(res, 'emotes', [], had ? [{ id: had.id }] : []);
    });
}

/** The emote's copy on OpenVibe.Media (Live's asset-sync). */
function setEmoteMedia(id, mediaUrl, mediaAssetId) {
    _assertChatWrites('emotes');
    return transaction(() => {
        const res = run('UPDATE emotes SET media_url = ?, media_asset_id = ? WHERE id = ?', [mediaUrl || null, mediaAssetId || null, id]);
        return _staged(res, 'emotes', [get('SELECT * FROM emotes WHERE id = ?', [id])]);
    });
}

// User tags (owned chat tags; Live has had no writer since its game tags went read-only).
function grantUserTag(userId, tagId, source = 'shop') {
    _assertChatWrites('user_tags');
    return transaction(() => {
        const res = run('INSERT OR IGNORE INTO user_tags (user_id, tag_id, source) VALUES (?, ?, ?)', [userId, String(tagId), source || 'shop']);
        return _staged(res, 'user_tags', [get('SELECT * FROM user_tags WHERE user_id = ? AND tag_id = ?', [userId, String(tagId)])]);
    });
}

function revokeUserTag(userId, tagId) {
    _assertChatWrites('user_tags');
    return transaction(() => {
        const gone = all('SELECT id FROM user_tags WHERE user_id = ? AND tag_id = ?', [userId, String(tagId)]);
        const res = run('DELETE FROM user_tags WHERE user_id = ? AND tag_id = ?', [userId, String(tagId)]);
        return _staged(res, 'user_tags', [], gone.map((r) => ({ id: r.id })));
    });
}

// Chat AI (Live's server/ai/chat-ai.js): rolling summaries and the append-only timeline.
function upsertChatAiSummary(sfx) {
    _assertChatWrites('chat_ai_summaries');
    const {
        scope, subject_id = 0, window, overview = '', memory_json = '', timeline_json = '[]',
        message_count = 0, window_message_count = 0, last_message_id = 0,
        window_label = '', window_start = null, window_end = null,
    } = sfx || {};
    return transaction(() => {
        const res = run(
            `INSERT INTO chat_ai_summaries
                (scope, subject_id, window, overview, memory_json, timeline_json, message_count,
                 window_message_count, last_message_id, window_label, window_start, window_end, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(scope, subject_id, window) DO UPDATE SET
                overview = excluded.overview,
                memory_json = excluded.memory_json,
                timeline_json = excluded.timeline_json,
                message_count = excluded.message_count,
                window_message_count = excluded.window_message_count,
                last_message_id = excluded.last_message_id,
                window_label = excluded.window_label,
                window_start = excluded.window_start,
                window_end = excluded.window_end,
                updated_at = CURRENT_TIMESTAMP`,
            [scope, subject_id || 0, window, overview, memory_json, timeline_json, message_count,
                window_message_count, last_message_id, window_label, window_start, window_end]
        );
        return _staged(res, 'chat_ai_summaries', [get('SELECT * FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? AND window = ?', [scope, subject_id || 0, window])]);
    });
}

function addChatTimelineEvents(scope, subjectId, events) {
    _assertChatWrites('chat_timeline_events');
    if (!Array.isArray(events) || !events.length) return _staged(0, 'chat_timeline_events');
    return transaction(() => {
        let n = 0;
        const ids = [];
        for (const e of events) {
            if (!e || !e.label || !e.ts) continue;
            try {
                const res = run('INSERT OR IGNORE INTO chat_timeline_events (scope, subject_id, ts, label, detail) VALUES (?, ?, ?, ?, ?)',
                    [scope || 'global', subjectId || 0, e.ts, String(e.label).slice(0, 120), String(e.detail || '').slice(0, 400)]);
                if (res.changes) ids.push(Number(res.lastInsertRowid));
                n++;   // Live counts every event it tried, the duplicates included
            } catch { /* */ }
        }
        return _staged(n, 'chat_timeline_events', ids.map((id) => get('SELECT * FROM chat_timeline_events WHERE id = ?', [id])));
    });
}

/**
 * Live's changes to a staged table it still writes (its capture, relayed over the bridge): the rows
 * as they are in Live now, or a delete. Applied only while the table is at 'live' — once Chat writes
 * it, Live's copy is the mirror and never flows back. REPLACE: the authority's row wins over
 * whatever holds its key or one of its unique columns here.
 */
function applyStagedChanges(changes) {
    const out = { applied: 0, skipped: [] };
    transaction(() => {
        for (const c of Array.isArray(changes) ? changes : []) {
            const pk = STAGED_KEYS[c && c.table];
            if (!pk) { out.skipped.push({ table: c && c.table, reason: 'not a staged table' }); continue; }
            if (tableAuthority(c.table) !== 'live') { out.skipped.push({ table: c.table, reason: 'Chat writes this table (table_authority chat)' }); continue; }
            const have = _columns(c.table);
            try {
                if (c.op === 'delete' && c.pk) {
                    run(`DELETE FROM ${c.table} WHERE ${pk.map((k) => `${k} = ?`).join(' AND ')}`, pk.map((k) => c.pk[k]));
                } else if (c.op === 'upsert' && c.row && pk.every((k) => c.row[k] != null)) {
                    const cols = Object.keys(c.row).filter((k) => have.has(k) && /^[a-z_]+$/.test(k));
                    run(`INSERT OR REPLACE INTO ${c.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => c.row[k]));
                } else { out.skipped.push({ table: c.table, reason: 'bad change' }); continue; }
                out.applied++;
            } catch (err) {
                out.skipped.push({ table: c.table, pk: c.pk || (c.row && Object.fromEntries(pk.map((k) => [k, c.row[k]]))), reason: err.message });
            }
        }
    });
    for (const c of Array.isArray(changes) ? changes : []) {
        if (c && (c.table === 'channel_moderators' || c.table === 'channel_moderation_settings')) {
            const ch = (c.row && c.row.channel_id) || (c.pk && c.pk.channel_id);
            if (ch) _ctx().invalidateChannel(ch);
        }
    }
    return out;
}

/**
 * Hash of a list of rows over `columns` (Live's server/chat/chat-tables-sync.js computes the same):
 * sha256 of the JSON array of rows, each row the array of its values in column order.
 */
function sliceHash(columns, rows) {
    const body = JSON.stringify(rows.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c]))));
    return require('crypto').createHash('sha256').update(body).digest('hex');
}

/**
 * One slice of a staged table for Live's dual read: the rows whose columns equal `where` (null-safe),
 * ordered by key → { count, hash, columns, rows (when 50 or fewer) }. `columns` limits the hash to
 * the ones Live has too.
 */
function stagedSlice(table, where = {}, columns = null) {
    const pk = STAGED_KEYS[table];
    if (!pk) throw new Error(`${table} is not a staged table`);
    const have = _columns(table);
    const keys = Object.keys(where || {});
    if (keys.some((k) => !have.has(k))) throw new Error(`unknown column in ${table}`);
    const cols = (Array.isArray(columns) && columns.length ? columns.filter((c) => have.has(c)) : [...have]).sort();
    const rows = all(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${keys.map((k) => `${k} IS ?`).join(' AND ') || '1'} ORDER BY ${pk.join(', ')}`, keys.map((k) => where[k]));
    return { count: rows.length, hash: sliceHash(cols, rows), columns: cols, rows: rows.length <= 50 ? rows : undefined };
}

// ── Meta ─────────────────────────────────────────────────────
function getMeta(key) { return get('SELECT value FROM chat_meta WHERE key = ?', [key])?.value ?? null; }
function setMeta(key, value) { return run('INSERT INTO chat_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value == null ? null : String(value)]); }

module.exports = {
    CHAT_TABLES,
    STAGED_TABLES,
    STAGED_KEYS,
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
    // staged tables (C-04): authority, Live's changes, dual-read slices, and the writes once Chat owns them
    tableAuthority,
    setTableAuthority,
    stagedAuthorities,
    mirrorPending,
    applyStagedChanges,
    stagedSlice,
    sliceHash,
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
};
