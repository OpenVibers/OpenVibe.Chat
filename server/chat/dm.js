/**
 * OpenVibe.Chat — Direct Message System (moved from OpenVibe.Live server/chat/dm.js, W6)
 *
 * Facebook Messenger-style DMs: 1-on-1 and group conversations,
 * persisted to SQLite, real-time delivery via WebSocket, with
 * read receipts and unread counts.
 *
 * Tables:
 *   dm_conversations  — conversation metadata
 *   dm_participants   — who's in each conversation
 *   dm_messages       — individual messages
 *
 * People are still Live user ids; names and pictures come from the ctx_users projection
 * (server/live-context.js). New participants, messages and blocks also record the Network
 * subject, and every message adds a chat.dm.created event (visibility subject) to the outbox in
 * the same transaction. Platform blocks (./network-blocks.js) count like dm_blocks everywhere
 * isBlockedEither is asked: new conversations, group invites, 1:1 messages, calls.
 */
const db = require('../db/database');
const outbox = require('../events/outbox');
const networkBlocks = require('./network-blocks');

// ── Schema & Migrations ──────────────────────────────────────

function ensureTables() {
    // The DM tables are created with the rest of Chat's schema (migrations/0001_initial.sql).
    db.getDb();
}

// ── Conversation helpers ─────────────────────────────────────

/**
 * Find an existing 1-on-1 conversation between two users.
 * Returns conversation row or null.
 */
async function findDirectConversation(userIdA, userIdB) {
    return await db.get(`
        SELECT c.* FROM dm_conversations c
        JOIN dm_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
        JOIN dm_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
        WHERE c.is_group = 0
    `, [userIdA, userIdB]) || null;
}

/**
 * Create a new conversation. Returns the new conversation id.
 * participantIds should include the creator.
 */
async function createConversation(createdBy, participantIds, name = null) {
    const isGroup = participantIds.length > 2 ? 1 : 0;
    const result = await db.run(
        `INSERT INTO dm_conversations (name, is_group, created_by) VALUES (?, ?, ?)`,
        [isGroup ? (name || null) : null, isGroup, createdBy]
    );
    const convId = result.lastInsertRowid;
    const insert = db.getDb().prepare(
        `INSERT INTO dm_participants (conversation_id, user_id, subject_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`
    );
    for (const uid of participantIds) {
        await insert.run(convId, uid, await db.subjectFor(uid));
    }
    return convId;
}

/**
 * Get or create a 1-on-1 conversation between two users.
 */
async function getOrCreateDirect(userIdA, userIdB) {
    const existing = await findDirectConversation(userIdA, userIdB);
    if (existing) return existing.id;
    return await createConversation(userIdA, [userIdA, userIdB]);
}

/**
 * Add a participant to an existing group conversation.
 */
async function addParticipant(conversationId, userId) {
    await db.run(
        `INSERT INTO dm_participants (conversation_id, user_id, subject_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        [conversationId, userId, await db.subjectFor(userId)]
    );
    // Mark as group if > 2 participants
    const count = (await db.get(
        `SELECT COUNT(*) as c FROM dm_participants WHERE conversation_id = ?`,
        [conversationId]
    ))?.c || 0;
    if (count > 2) {
        await db.run(`UPDATE dm_conversations SET is_group = 1 WHERE id = ?`, [conversationId]);
    }
}

/**
 * Remove a participant from a group conversation.
 */
async function removeParticipant(conversationId, userId) {
    await db.run(
        `DELETE FROM dm_participants WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Check if a user is a participant in a conversation.
 */
async function isParticipant(conversationId, userId) {
    return !!await db.get(
        `SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Rename a group conversation.
 */
async function renameConversation(conversationId, name) {
    await db.run(`UPDATE dm_conversations SET name = ?, updated_at = ov_now() WHERE id = ?`, [name, conversationId]);
}

/**
 * Get all conversations for a user with last message preview and unread count.
 */
async function getConversations(userId) {
    return await db.all(`
        SELECT
            c.id,
            c.name,
            c.is_group,
            c.updated_at,
            (SELECT dm.message FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
            (SELECT dm.sender_id FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_sender_id,
            (SELECT dm.created_at FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM dm_messages dm WHERE dm.conversation_id = c.id AND dm.created_at > p.last_read_at AND dm.sender_id != ?) AS unread_count
        FROM dm_conversations c
        JOIN dm_participants p ON p.conversation_id = c.id AND p.user_id = ?
        ORDER BY
            COALESCE((SELECT dm.created_at FROM dm_messages dm WHERE dm.conversation_id = c.id ORDER BY dm.created_at DESC LIMIT 1), c.created_at) DESC
    `, [userId, userId]);
}

/**
 * Get participants of a conversation (with user profile info).
 */
async function getParticipants(conversationId) {
    return await db.all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM dm_participants p
        JOIN ctx_users u ON u.id = p.user_id
        WHERE p.conversation_id = ?
    `, [conversationId]);
}

/**
 * Get a single conversation by id (with participant info for the requesting user).
 */
async function getConversation(conversationId) {
    return await db.get(`SELECT * FROM dm_conversations WHERE id = ?`, [conversationId]) || null;
}

// ── Message helpers ──────────────────────────────────────────

/**
 * Send a message in a conversation. Returns the message row.
 */
async function sendMessage(conversationId, senderId, text) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim().slice(0, 2000); // max 2000 chars
    const senderSubject = await db.subjectFor(senderId);
    return await db.tx(async () => {
        const result = await db.run(
            `INSERT INTO dm_messages (conversation_id, sender_id, message, sender_subject_id) VALUES (?, ?, ?, ?)`,
            [conversationId, senderId, trimmed, senderSubject]
        );
        // Touch conversation updated_at
        await db.run(`UPDATE dm_conversations SET updated_at = ov_now() WHERE id = ?`, [conversationId]);
        // Auto-mark read for sender
        await markRead(conversationId, senderId);
        // The event names who is in the conversation, never what was said.
        const participants = await db.all('SELECT user_id, subject_id FROM dm_participants WHERE conversation_id = ?', [conversationId]);
        await outbox.enqueue({
            event_type: 'chat.dm.created',
            visibility: 'subject',
            actorSubject: senderSubject,
            subject: { type: 'dm_message', id: String(result.lastInsertRowid) },
            payload: {
                message_id: Number(result.lastInsertRowid),
                conversation_id: Number(conversationId),
                sender_user_id: senderId,
                sender_subject: senderSubject,
                participants: (await Promise.all(participants.map(async (p) => ({ user_id: p.user_id, subject: p.subject_id || await db.subjectFor(p.user_id) })))),
            },
        });
        return await db.get(`SELECT * FROM dm_messages WHERE id = ?`, [result.lastInsertRowid]);
    });
}

/**
 * Get messages in a conversation (paginated, newest first).
 */
async function getMessages(conversationId, limit = 50, before = null, after = null) {
    if (after) {
        // Fetch messages newer than `after` id (for live polling)
        return await db.all(`
            SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
            FROM dm_messages m
            JOIN ctx_users u ON u.id = m.sender_id
            WHERE m.conversation_id = ? AND m.id > ?
            ORDER BY m.created_at ASC
            LIMIT ?
        `, [conversationId, after, limit]);
    }
    if (before) {
        return await db.all(`
            SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
            FROM dm_messages m
            JOIN ctx_users u ON u.id = m.sender_id
            WHERE m.conversation_id = ? AND m.id < ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `, [conversationId, before, limit]);
    }
    return await db.all(`
        SELECT m.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM dm_messages m
        JOIN ctx_users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
    `, [conversationId, limit]);
}

/**
 * Mark a conversation as read for a user (set last_read_at to now).
 */
async function markRead(conversationId, userId) {
    await db.run(
        `UPDATE dm_participants SET last_read_at = ov_now() WHERE conversation_id = ? AND user_id = ?`,
        [conversationId, userId]
    );
}

/**
 * Get total unread message count across all conversations for a user.
 */
async function getTotalUnread(userId) {
    const row = await db.get(`
        SELECT CAST(COALESCE(SUM(unread), 0) AS BIGINT) as total FROM (
            SELECT COUNT(*) as unread
            FROM dm_messages m
            JOIN dm_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
            WHERE m.created_at > p.last_read_at AND m.sender_id != ?
        ) AS per_conversation
    `, [userId, userId]);
    return row?.total || 0;
}

/**
 * Search users by username/display_name for the "new message" user picker.
 * Excludes the requesting user.
 */
async function searchUsers(query, excludeUserId, limit = 10) {
    if (!query || query.length < 2) return [];
    networkBlocks.ensureSchema();
    const me = await db.subjectFor(excludeUserId) || '';
    return await db.all(`
        SELECT id, username, display_name, avatar_url, profile_color
        FROM ctx_users
        WHERE id != ? AND is_banned = 0
          AND id NOT IN (SELECT blocked_id FROM dm_blocks WHERE blocker_id = ?)
          AND id NOT IN (SELECT blocker_id FROM dm_blocks WHERE blocked_id = ?)
          AND COALESCE(subject_id, '') NOT IN (SELECT blocked_subject FROM network_blocks WHERE blocker_subject = ? AND active = 1)
          AND COALESCE(subject_id, '') NOT IN (SELECT blocker_subject FROM network_blocks WHERE blocked_subject = ? AND active = 1)
          AND (username ILIKE ? OR display_name ILIKE ?)
        LIMIT ?
    `, [excludeUserId, excludeUserId, excludeUserId, me, me, `%${query}%`, `%${query}%`, limit]);
}

// ── Block helpers ────────────────────────────────────────────

/**
 * Check if either user has blocked the other (bidirectional): in Chat's dm_blocks, or on the network
 * (platform blocks, ./network-blocks.js, by Network subject).
 */
async function isBlockedEither(userIdA, userIdB) {
    return !!await db.get(
        `SELECT 1 FROM dm_blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        [userIdA, userIdB, userIdB, userIdA]
    ) || await networkBlocks.eitherBlockedUsers(userIdA, userIdB);
}

/**
 * Check if blocker has blocked blocked (one-directional).
 */
async function hasBlocked(blockerId, blockedId) {
    return !!await db.get(
        `SELECT 1 FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?`,
        [blockerId, blockedId]
    );
}

/**
 * Block a user.
 */
async function blockUser(blockerId, blockedId) {
    await db.run(
        `INSERT INTO dm_blocks (blocker_id, blocked_id, blocker_subject_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        [blockerId, blockedId, await db.subjectFor(blockerId)]
    );
}

/**
 * Unblock a user.
 */
async function unblockUser(blockerId, blockedId) {
    await db.run(
        `DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?`,
        [blockerId, blockedId]
    );
}

/**
 * Get all users blocked by blockerId.
 */
async function getBlockedUsers(blockerId) {
    return await db.all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.profile_color, b.created_at as blocked_at
        FROM dm_blocks b
        JOIN ctx_users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC
    `, [blockerId]);
}

/**
 * Delete a message (only the sender can delete their own message).
 */
async function deleteMessage(messageId, userId) {
    const msg = await db.get(`SELECT * FROM dm_messages WHERE id = ?`, [messageId]);
    if (!msg || msg.sender_id !== userId) return false;
    await db.run(`DELETE FROM dm_messages WHERE id = ?`, [messageId]);
    return true;
}

/**
 * Get the number of participants in a conversation.
 */
async function getParticipantCount(conversationId) {
    const row = await db.get(
        `SELECT COUNT(*) as c FROM dm_participants WHERE conversation_id = ?`,
        [conversationId]
    );
    return row?.c || 0;
}

// ── Anti-spam helpers ────────────────────────────────────────

/**
 * Detect spam patterns in DM message content.
 * Returns { isSpam: boolean, reason: string|null }
 */
function checkMessageSpam(text) {
    if (!text) return { isSpam: false, reason: null };
    const trimmed = text.trim();

    // Excessive caps (>70% caps in messages over 10 chars)
    if (trimmed.length > 10) {
        const alphaChars = trimmed.replace(/[^a-zA-Z]/g, '');
        if (alphaChars.length > 5) {
            const capsRatio = (alphaChars.replace(/[^A-Z]/g, '').length) / alphaChars.length;
            if (capsRatio > 0.7) return { isSpam: true, reason: 'Excessive caps' };
        }
    }

    // Repeated characters (e.g., "aaaaaaa" or "!!!!!!")
    if (/(.)\1{9,}/i.test(trimmed)) {
        return { isSpam: true, reason: 'Repeated characters' };
    }

    // Repeated words (same word 5+ times)
    const words = trimmed.toLowerCase().split(/\s+/);
    if (words.length >= 5) {
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        for (const w of Object.keys(freq)) {
            if (freq[w] >= 5 && freq[w] / words.length > 0.6) {
                return { isSpam: true, reason: 'Repetitive content' };
            }
        }
    }

    // Common spam patterns (URLs in bulk, typical scam patterns)
    const urlCount = (trimmed.match(/https?:\/\//gi) || []).length;
    if (urlCount >= 3) return { isSpam: true, reason: 'Too many URLs' };

    return { isSpam: false, reason: null };
}

/**
 * Check if this message is a duplicate of the user's recent messages.
 * Returns true if the exact same text was sent within the last N seconds.
 */
async function isDuplicateMessage(conversationId, senderId, text, windowSeconds = 30) {
    const row = await db.get(`
        SELECT 1 FROM dm_messages
        WHERE conversation_id = ? AND sender_id = ? AND message = ?
          AND created_at > datetime('now', '-' || ? || ' seconds')
        LIMIT 1
    `, [conversationId, senderId, text.trim().slice(0, 2000), windowSeconds]);
    return !!row;
}

/**
 * Check if a user account is too new to send DMs (minimum account age).
 * Returns { tooNew: boolean, minutesRemaining: number }
 */
async function isAccountTooNew(userId, minMinutes = 5) {
    const user = await db.get(`SELECT created_at FROM ctx_users WHERE id = ?`, [userId]);
    if (!user || !user.created_at) return { tooNew: false, minutesRemaining: 0 };
    const created = new Date(user.created_at.endsWith('Z') ? user.created_at : user.created_at + 'Z');
    const ageMs = Date.now() - created.getTime();
    const ageMinutes = ageMs / 60000;
    if (ageMinutes < minMinutes) {
        return { tooNew: true, minutesRemaining: Math.ceil(minMinutes - ageMinutes) };
    }
    return { tooNew: false, minutesRemaining: 0 };
}

module.exports = {
    ensureTables,
    findDirectConversation,
    createConversation,
    getOrCreateDirect,
    addParticipant,
    removeParticipant,
    isParticipant,
    renameConversation,
    getConversations,
    getParticipants,
    getConversation,
    sendMessage,
    getMessages,
    markRead,
    getTotalUnread,
    searchUsers,
    isBlockedEither,
    hasBlocked,
    blockUser,
    unblockUser,
    getBlockedUsers,
    deleteMessage,
    getParticipantCount,
    checkMessageSpam,
    isDuplicateMessage,
    isAccountTooNew,
};
