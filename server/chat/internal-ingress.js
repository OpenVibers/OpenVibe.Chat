/** Typed, service-token ingress for writes that Live still originates. */
'use strict';

const crypto = require('crypto');
const express = require('express');
const { isIP } = require('net');
const db = require('../db/database');
const ctx = require('../live-context');
const dm = require('./dm');
const serviceAuth = require('../net/service-auth');

const locks = new Map();
const int = (v) => Number.isSafeInteger(v) && v > 0;
const str = (v, max = 2000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const optionalId = (v) => v == null || int(v);
const bool = (v) => v == null || typeof v === 'boolean';
const bad = (message) => { const e = new Error(message); e.status = 400; throw e; };
const missing = (message) => { const e = new Error(message); e.status = 404; throw e; };
function fields(v, allowed) {
    if (!obj(v) || Object.keys(v).some((k) => !allowed.includes(k))) bad('Invalid fields');
}
function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (obj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
    return v;
}
function hash(v) { return crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex'); }

// Reserve the key before the domain write, in the same transaction. A concurrent process waits
// on the unique index and returns the committed result; a failed write rolls the key back.
async function once(req, family, body, write, deliver) {
    const principal = req.principal.sub;
    const key = body.key;
    const bodyHash = hash(body);
    const lockKey = `${principal}|${family}|${key}`;
    while (locks.has(lockKey)) await locks.get(lockKey);
    let unlock;
    locks.set(lockKey, new Promise((resolve) => { unlock = resolve; }));
    try {
        const result = await db.tx(async () => {
            const inserted = await db.run(
                `INSERT INTO chat_ingress_applied (principal, family, key, body_hash, result, applied_at)
                 VALUES (?, ?, ?, ?, '{}', ?) ON CONFLICT DO NOTHING`,
                [principal, family, key, bodyHash, Date.now()]
            );
            if (!inserted.changes) {
                const old = await db.get('SELECT body_hash, result FROM chat_ingress_applied WHERE principal = ? AND family = ? AND key = ?', [principal, family, key]);
                if (!old || old.body_hash !== bodyHash) { const e = new Error('Idempotency key reused with a different body'); e.status = 409; throw e; }
                return JSON.parse(old.result);
            }
            const value = await write();
            await db.run('UPDATE chat_ingress_applied SET result = ? WHERE principal = ? AND family = ? AND key = ?', [JSON.stringify(value), principal, family, key]);
            return value;
        });
        // The claim prevents two Chat processes from broadcasting the same retry at once. A
        // crashed process leaves a lease that another retry can reclaim after five minutes.
        const claimed = await db.run(
            `UPDATE chat_ingress_applied SET delivered = 2, delivery_claimed_at = ?
             WHERE principal = ? AND family = ? AND key = ?
               AND (delivered = 0 OR (delivered = 2 AND delivery_claimed_at < ?))`,
            [Date.now(), principal, family, key, Date.now() - 5 * 60_000]
        );
        if (claimed.changes) {
            try {
                await deliver(result);
                await db.run('UPDATE chat_ingress_applied SET delivered = 1 WHERE principal = ? AND family = ? AND key = ?', [principal, family, key]);
            } catch (err) {
                await db.run('UPDATE chat_ingress_applied SET delivered = 0 WHERE principal = ? AND family = ? AND key = ? AND delivered = 2', [principal, family, key]).catch(() => {});
                throw err;
            }
        } else {
            // Another process holds the claim, or one crashed holding it: the caller must retry
            // rather than take a 200 for a broadcast that may never happen.
            const row = await db.get('SELECT delivered FROM chat_ingress_applied WHERE principal = ? AND family = ? AND key = ?', [principal, family, key]);
            if (Number(row?.delivered) !== 1) { const e = new Error('Delivery in progress; retry with the same key'); e.status = 503; throw e; }
        }
        return result;
    } finally { locks.delete(lockKey); unlock(); }
}

function endpoint(family, validate, write, deliver) {
    return async (req, res) => {
        try {
            const body = req.body;
            if (!obj(body) || !str(body.key, 160) || !/^[A-Za-z0-9:._-]+$/.test(body.key)) bad('A valid idempotency key is required');
            validate(body);
            const result = await once(req, family, body, () => write(body, req), (saved) => deliver(body, saved, req));
            const { rows, ...publicResult } = result;
            res.json({ ok: true, ...publicResult });
        } catch (err) {
            if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
            console.error(`[ChatIngress] ${family}:`, err);
            res.status(503).json({ ok: false, error: 'Chat ingress unavailable; retry with the same key' });
        }
    };
}

const ROLES = ['admin', 'global_mod', 'streamer', 'user', 'anon', 'external'];
function validateMessage(b) {
    fields(b, ['key', 'stream_id', 'channel_user_id', 'user_id', 'anon_id', 'username', 'message', 'message_type', 'is_global', 'reply_to_id', 'source_platform', 'auto_delete_at', 'metadata', 'mirror', 'dm', 'tts', 'frame', 'first_chat_key']);
    if (!str(b.message) || !b.message.trim() || !str(b.username, 120)) bad('Invalid message or username');
    if (b.auto_delete_at != null && (!str(b.auto_delete_at, 40) || !Number.isFinite(Date.parse(b.auto_delete_at)))) bad('Invalid expiry');
    if (b.dm) {
        fields(b.dm, ['to_user_id']);
        if (!int(b.user_id) || !int(b.dm.to_user_id) || b.stream_id != null || b.channel_user_id != null || b.mirror || b.tts || b.frame) bad('Invalid DM');
    } else {
        if (!optionalId(b.stream_id) || !optionalId(b.channel_user_id) || !optionalId(b.user_id) || !optionalId(b.reply_to_id)) bad('Invalid message ID');
        if (b.anon_id != null && !str(b.anon_id, 80)) bad('Invalid anonymous ID');
        if (b.message_type != null && !['chat', 'system', 'donation', 'command', 'tts', 'channel-sound', 'soundboard', 'clip'].includes(b.message_type)) bad('Invalid message type');
        if (b.mirror != null && typeof b.mirror !== 'boolean') bad('Invalid mirror flag');
        if (b.is_global != null && typeof b.is_global !== 'boolean') bad('Invalid global flag');
        if (b.source_platform != null && !str(b.source_platform, 80)) bad('Invalid source platform');
        if (b.first_chat_key != null && (!str(b.first_chat_key, 160) || !/^(?:user|anon|ext):./.test(b.first_chat_key))) bad('Invalid first-chat key');
        if (b.metadata != null && (!obj(b.metadata) || JSON.stringify(b.metadata).length > 8192)) bad('Invalid metadata');
        if (b.frame != null) {
            const f = b.frame;
            fields(f, ['role', 'profile_color', 'avatar_url', 'is_ai', 'is_bot', 'filtered', 'core_username', 'display_name']);
            if ((f.role != null && !ROLES.includes(f.role)) || (f.profile_color != null && !/^#[0-9a-fA-F]{3,8}$/.test(f.profile_color))
                || (f.avatar_url != null && !str(f.avatar_url, 500)) || !bool(f.is_ai) || !bool(f.is_bot) || !bool(f.filtered)
                || (f.core_username != null && !str(f.core_username, 120)) || (f.display_name != null && !str(f.display_name, 120))) bad('Invalid frame');
        }
        if (b.tts != null) {
            fields(b.tts, ['voice', 'identity_key', 'key']);
            if (b.tts.voice != null && !str(b.tts.voice, 80)) bad('Invalid TTS voice');
            if (b.tts.identity_key != null && !str(b.tts.identity_key, 120)) bad('Invalid TTS identity');
            if (b.tts.key != null && !str(b.tts.key, 160)) bad('Invalid TTS key');
            if (!b.stream_id && !b.channel_user_id) bad('TTS needs a room');
        }
    }
}

// The keys chat-server's welcome check reads (`user:`/`anon:`) and Live's relay saves (`ext:` +
// the prefixed username it stores relay lines under). Only chat lines use up a welcome.
function firstChatKey(b) {
    if (b.first_chat_key) return b.first_chat_key;
    if ((b.message_type || 'chat') !== 'chat') return null;
    if (b.source_platform) return `ext:${b.username}`;
    if (b.user_id) return `user:${b.user_id}`;
    return b.anon_id ? `anon:${b.anon_id}` : null;
}

async function writeMessage(b) {
    if (b.dm) {
        if (await dm.isBlockedEither(b.user_id, b.dm.to_user_id)) { const e = new Error('DM participants are blocked'); e.status = 403; throw e; }
        if (!await ctx.getUserById(b.user_id) || !await ctx.getUserById(b.dm.to_user_id)) { const e = new Error('DM participant not found'); e.status = 404; throw e; }
        const conversationId = await dm.getOrCreateDirect(b.user_id, b.dm.to_user_id);
        const message = await dm.sendMessage(conversationId, b.user_id, b.message);
        if (!message) bad('Invalid message');
        return { id: Number(message.id), conversation_id: Number(conversationId), to_user_id: b.dm.to_user_id };
    }
    if (b.stream_id && !await ctx.ensureStream(b.stream_id)) missing('Stream not found');
    const saved = await db.saveChatMessage({ ...b, is_global: b.is_global ?? (!b.stream_id && !b.channel_user_id) });
    const id = Number(saved.lastInsertRowid);
    const channelUserId = b.channel_user_id || (b.stream_id ? (await ctx.getStreamById(b.stream_id))?.user_id : null) || null;
    const chatterKey = firstChatKey(b);
    if (channelUserId && chatterKey) await db.recordFirstChat(chatterKey, channelUserId);
    return { id, stream_id: b.stream_id || null, channel_user_id: channelUserId };
}

async function deliverMessage(chatServer, b, result) {
    if (b.dm) {
        // The same message shape as dm-routes: the saved row plus the sender's account fields.
        // A retry after the row was deleted has nothing left to deliver.
        const row = await db.get('SELECT * FROM dm_messages WHERE id = ?', [result.id]);
        if (!row) return;
        const { sender_subject_id, ...message } = row;
        const sender = await ctx.getUserById(b.user_id);
        Object.assign(message, { username: sender?.username, display_name: sender?.display_name, avatar_url: sender?.avatar_url, profile_color: sender?.profile_color });
        const frame = { type: 'dm', conversation_id: result.conversation_id, message };
        await chatServer.sendDm(b.dm.to_user_id, frame);
        await chatServer.sendDm(b.user_id, frame);
        return;
    }
    const frame = { type: 'chat', id: result.id, stream_id: result.stream_id, channel_user_id: result.channel_user_id,
        user_id: b.user_id || null, anon_id: b.anon_id || null, username: b.username, message: b.message,
        message_type: b.message_type || 'chat', is_global: b.is_global ?? (!result.stream_id && !result.channel_user_id),
        reply_to_id: b.reply_to_id || null, auto_delete_at: b.auto_delete_at || null, metadata: b.metadata || null,
        source_platform: b.source_platform || null, timestamp: new Date().toISOString(), ...(b.frame || {}) };
    if (result.channel_user_id || result.stream_id) await chatServer.broadcastToChannelRoom(result.channel_user_id, result.stream_id, frame);
    else await chatServer.broadcastGlobal(frame);
    if (b.mirror && result.stream_id) {
        await chatServer.forwardToGlobal(result.stream_id, frame);
        await chatServer.forwardToStreamerRooms(result.stream_id, frame);
    } else if (b.mirror && result.channel_user_id) await chatServer.forwardToGlobalByChannel(result.channel_user_id, frame);
    if (b.tts) await chatServer.synthesizeAndBroadcastTTS(result.stream_id, b.username, b.message, b.tts.voice || null, b.source_platform || null, b.tts.identity_key || null, result.channel_user_id, b.tts.key || `m${result.id}`);
}

const TARGETS = new Set(['stream', 'channel', 'owner-streams', 'global', 'all', 'user']);
const FRAMES = new Set(['chat', 'system', 'donation', 'goal-update', 'goal-reached', 'update', 'voice-channels', 'alert', 'channel-sound', 'server_restart',
    'media_queue_update', 'media_now_playing', 'redemption', 'vibe-coding', 'vc-call-invite', 'vc-call-response']);
// Transient call frames for one user's sockets; nothing is persisted.
const CALL_FRAME = ['type', 'channelId', 'channelName', 'fromUserId', 'fromUsername', 'fromDisplayName', 'fromAvatarUrl', 'createdAt'];
function validateCallFrame(f) {
    fields(f, f.type === 'vc-call-response' ? [...CALL_FRAME, 'status'] : CALL_FRAME);
    if (!str(f.channelId, 120) || (f.channelName != null && !str(f.channelName, 120)) || !int(f.fromUserId) || !str(f.fromUsername, 120)
        || (f.fromDisplayName != null && !str(f.fromDisplayName, 120)) || (f.fromAvatarUrl != null && !str(f.fromAvatarUrl, 500))
        || !int(f.createdAt)) bad('Invalid call frame');
    if (f.type === 'vc-call-response' && !['accepted', 'declined', 'busy', 'no-answer', 'canceled'].includes(f.status)) bad('Invalid call response');
}
function validateEvent(b) {
    fields(b, ['key', 'target', 'frame']);
    fields(b.target, ['kind', 'id']);
    if (!TARGETS.has(b.target.kind) || (['stream', 'channel', 'owner-streams', 'user'].includes(b.target.kind) ? !int(b.target.id) : b.target.id != null)) bad('Invalid target');
    if (!obj(b.frame) || !FRAMES.has(b.frame.type) || JSON.stringify(b.frame).length > 16384 || Object.keys(b.frame).some((k) => /^(?:__proto__|constructor|prototype)$/.test(k))) bad('Invalid frame');
    if (['system', 'server_restart'].includes(b.frame.type) && !str(b.frame.message, 4000)) bad('Invalid frame message');
    // The transient news card (Live news-service): a chat frame that is never saved, so only news.
    if (b.frame.type === 'chat') {
        fields(b.frame, ['type', 'message_type', 'username', 'message', 'url', 'news_source', 'timestamp', 'source_platform', 'system']);
        if (b.frame.message_type !== 'news' || !str(b.frame.username, 120) || !str(b.frame.message, 4000) || (b.frame.url != null && !str(b.frame.url, 500))
            || (b.frame.news_source != null && !str(b.frame.news_source, 120)) || (b.frame.source_platform != null && b.frame.source_platform !== 'news')
            || !bool(b.frame.system) || !str(b.frame.timestamp, 40) || !Number.isFinite(Date.parse(b.frame.timestamp))) bad('Invalid news card');
        if (b.target.kind !== 'stream') bad('News target must be a stream');
    }
    if (b.frame.type === 'alert' && (!int(b.frame.streamerId) || !optionalId(b.frame.streamId) || !['goal', 'donation'].includes(b.frame.kind))) bad('Invalid alert');
    if (b.frame.type === 'voice-channels' && (!Array.isArray(b.frame.channels) || b.frame.channels.length > 128)) bad('Invalid voice channels');
    if (b.frame.type === 'channel-sound' && (!int(b.frame.streamId) || !str(b.frame.command, 120) || (b.frame.userId != null && !int(b.frame.userId)) || (b.frame.anonId != null && !str(b.frame.anonId, 80)) || (b.frame.args != null && (!Array.isArray(b.frame.args) || b.frame.args.length > 20 || b.frame.args.some((a) => !str(a, 120)))) || (b.frame.relay != null && (!obj(b.frame.relay) || !str(b.frame.relay.username, 120))))) bad('Invalid channel sound');
    if (b.frame.type === 'alert' && (b.target.kind !== 'channel' || b.target.id !== b.frame.streamerId)) bad('Alert target must be its channel owner');
    if (b.frame.type === 'channel-sound' && (b.target.kind !== 'stream' || b.target.id !== b.frame.streamId)) bad('Sound target must be its stream');
    if (b.frame.type === 'voice-channels' && b.target.kind !== 'all') bad('Voice channels target must be all');
    if (b.frame.type === 'media_queue_update' && !obj(b.frame.state)) bad('Invalid media queue');
    if (b.frame.type === 'media_now_playing' && b.frame.request !== null && !obj(b.frame.request)) bad('Invalid media request');
    if (b.frame.type.startsWith('media_') && b.target.kind !== 'owner-streams') bad('Media target must be the owner streams');
    if (b.frame.type === 'redemption' && (!str(b.frame.username, 120) || !str(b.frame.reward_title, 200) || !Number.isFinite(b.frame.cost) || (b.frame.user_input != null && typeof b.frame.user_input !== 'string'))) bad('Invalid redemption');
    if (b.frame.type === 'vibe-coding' && (!int(b.frame.managed_stream_id) || !obj(b.frame.event))) bad('Invalid vibe-coding event');
    if (['redemption', 'vibe-coding'].includes(b.frame.type) && b.target.kind !== 'stream') bad('Stream event target must be a stream');
    const call = b.frame.type.startsWith('vc-call-');
    if (call) validateCallFrame(b.frame);
    if (call !== (b.target.kind === 'user')) bad('Only call frames target a user');
}
async function deliverEvent(chatServer, b) {
    const { kind, id } = b.target;
    const f = b.frame;
    if (f.type === 'alert') return require('./alert-sounds').playAlertSound(chatServer, f.streamerId, f.streamId || null, f.kind);
    if (f.type === 'channel-sound') {
        const stream = await ctx.ensureStream(f.streamId);
        if (!stream) missing('Stream not found');
        const client = { streamId: f.streamId, user: f.userId ? await ctx.getUserById(f.userId) : null, anonId: f.anonId || null };
        return chatServer.triggerChannelSound(null, client, stream, f.command, Array.isArray(f.args) ? f.args : [], f.relay || null);
    }
    if (kind === 'stream') { if (!await ctx.ensureStream(id)) missing('Stream not found'); return chatServer.broadcastToStream(id, f); }
    if (kind === 'channel') return chatServer.broadcastToChannelRoom(id, null, f);
    if (kind === 'owner-streams') {
        for (const stream of await ctx.getLiveStreamsByUserId(id) || []) await chatServer.broadcastToStream(stream.id, f);
        return;
    }
    if (kind === 'user') return chatServer.sendDm(id, f);
    if (kind === 'global') return chatServer.broadcastGlobal(f);
    return chatServer.broadcastAll(f);
}

async function broadcastDeletes(chatServer, rows) {
    const rooms = new Map();
    for (const row of rows) {
        const streamId = row.stream_id || null;
        const channelUserId = row.channel_user_id || (streamId ? (await ctx.getStreamById(streamId))?.user_id : null) || null;
        const key = `${streamId || ''}|${channelUserId || ''}`;
        if (!rooms.has(key)) rooms.set(key, { streamId, channelUserId, ids: [] });
        rooms.get(key).ids.push(Number(row.id));
    }
    for (const { streamId, channelUserId, ids } of rooms.values()) {
        const frame = { type: 'delete-messages', ids };
        if (streamId || channelUserId) await chatServer.broadcastToChannelRoom(channelUserId, streamId, frame);
        if (streamId) await chatServer.forwardToGlobal(streamId, frame);
        else if (channelUserId) await chatServer.forwardToGlobalByChannel(channelUserId, frame);
        else await chatServer.broadcastGlobal(frame);
    }
}

const MOD_FIELDS = {
    'delete-message': ['id', 'deleted_by'],
    'delete-user-messages': ['user_id', 'stream_id', 'deleted_by'],
    'delete-anon-messages': ['anon_id', 'stream_id', 'deleted_by'],
    'delete-relay-messages': ['username', 'stream_id', 'deleted_by'],
    'delete-by-range': ['stream_id', 'from', 'to', 'deleted_by'],
    'review-pending-ip': ['id', 'status', 'reviewed_by', 'channel_id'],
    'approve-ip-messages': ['channel_id', 'ip', 'reviewed_by'],
    'deny-ip-messages': ['channel_id', 'ip', 'reviewed_by'],
    'relay-hide': ['channel_id', 'platform', 'external_username', 'reason', 'created_by', 'mode'],
    'relay-unhide': ['id', 'channel_id', 'platform', 'external_username'],
    'relay-record': ['platform', 'username'],
    'tts-voice-override': ['identity_key', 'params', 'set_by'],
    disconnect: ['user_id', 'ip', 'stream_id'],
    log: ['scope_type', 'scope_id', 'actor_user_id', 'target_user_id', 'action_type', 'details'],
};
function validateModeration(b) {
    const allowed = MOD_FIELDS[b.action];
    if (!allowed) bad('Unknown moderation action');
    fields(b, ['key', 'action', ...allowed]);
    if (['delete-message', 'review-pending-ip', 'relay-unhide'].includes(b.action) && b.id != null && !int(b.id)) bad('Invalid ID');
    for (const name of ['user_id', 'stream_id', 'channel_id', 'reviewed_by', 'actor_user_id', 'target_user_id', 'created_by', 'set_by']) if (b[name] != null && !int(b[name])) bad(`Invalid ${name}`);
    // chat_messages.deleted_by is text: Live sends the moderator's id or username.
    if (b.deleted_by != null && !int(b.deleted_by) && !str(b.deleted_by, 120)) bad('Invalid deleted_by');
    if (b.action === 'relay-hide' && b.reason != null && !str(b.reason, 500)) bad('Invalid reason');
    const deleteSubject = { 'delete-message': () => int(b.id), 'delete-user-messages': () => int(b.user_id), 'delete-anon-messages': () => str(b.anon_id, 80), 'delete-relay-messages': () => str(b.username, 120) }[b.action];
    if (deleteSubject && !deleteSubject()) bad('Missing delete subject');
    if (b.action === 'delete-by-range' && (!str(b.from, 40) || !str(b.to, 40) || !Number.isFinite(Date.parse(b.from)) || !Number.isFinite(Date.parse(b.to)))) bad('Invalid time range');
    if (b.action === 'review-pending-ip' && (!int(b.id) || !['approved', 'denied'].includes(b.status))) bad('Invalid review');
    if (['approve-ip-messages', 'deny-ip-messages'].includes(b.action) && (!int(b.channel_id) || !isIP(b.ip))) bad('Invalid IP review');
    if (b.action.startsWith('relay-') && b.action !== 'relay-unhide' && (!str(b.platform, 80) || !str(b.external_username || b.username, 120))) bad('Invalid relay identity');
    if (b.action === 'relay-hide' && b.mode != null && !['hide', 'ban'].includes(b.mode)) bad('Invalid relay action');
    if (b.action === 'relay-unhide' && !int(b.id) && (!str(b.platform, 80) || !str(b.external_username, 120))) bad('Invalid relay identity');
    if (b.action === 'tts-voice-override' && (!str(b.identity_key, 120) || (b.params != null && (!obj(b.params) || Object.keys(b.params).some((k) => !['voice', 'pitch', 'speed', 'gap'].includes(k)) || !str(b.params.voice, 80) || ['pitch', 'speed', 'gap'].some((k) => b.params[k] != null && (!Number.isFinite(b.params[k]) || b.params[k] < 0 || b.params[k] > 10)))))) bad('Invalid TTS override');
    if (b.action === 'disconnect' && ((!int(b.user_id) && !isIP(b.ip)) || (b.ip != null && !isIP(b.ip)))) bad('Invalid disconnect target');
    if (b.action === 'log' && (!str(b.action_type, 120) || (b.scope_type != null && !['site', 'channel', 'stream', 'room'].includes(b.scope_type)) || (b.scope_id != null && !(b.scope_type === 'room' ? str(b.scope_id, 120) : int(b.scope_id))) || (b.details != null && (!obj(b.details) || JSON.stringify(b.details).length > 8192)))) bad('Invalid moderation log');
}

async function writeModeration(b) {
    let rows = [];
    const deletedBy = b.deleted_by == null ? null : String(b.deleted_by);
    if (b.action.startsWith('delete-')) {
        if (b.action === 'delete-message') rows = await db.all('SELECT id, stream_id, channel_user_id FROM chat_messages WHERE id = ? AND is_deleted = 0', [b.id]);
        else if (b.action === 'delete-user-messages') rows = await db.all(`SELECT id, stream_id, channel_user_id FROM chat_messages WHERE user_id = ? AND is_deleted = 0${b.stream_id ? ' AND stream_id = ?' : ''}`, b.stream_id ? [b.user_id, b.stream_id] : [b.user_id]);
        else if (b.action === 'delete-anon-messages') rows = await db.all(`SELECT id, stream_id, channel_user_id FROM chat_messages WHERE anon_id = ? AND is_deleted = 0${b.stream_id ? ' AND stream_id = ?' : ''}`, b.stream_id ? [b.anon_id, b.stream_id] : [b.anon_id]);
        else if (b.action === 'delete-relay-messages') rows = await db.all(`SELECT id, stream_id, channel_user_id FROM chat_messages WHERE username = ? AND is_deleted = 0${b.stream_id ? ' AND stream_id = ?' : ''}`, b.stream_id ? [b.username, b.stream_id] : [b.username]);
        else if (b.action === 'delete-by-range') {
            const where = b.stream_id ? 'stream_id = ?' : 'is_global = 1';
            rows = await db.all(`SELECT id, stream_id, channel_user_id FROM chat_messages WHERE ${where} AND timestamp >= datetime(?) AND timestamp <= datetime(?) AND is_deleted = 0`, b.stream_id ? [b.stream_id, b.from, b.to] : [b.from, b.to]);
        }
        if (b.action === 'delete-message' && rows.length) await db.deleteChatMessage(b.id, deletedBy);
        if (b.action === 'delete-user-messages') await db.deleteUserChatMessages(b.user_id, { streamId: b.stream_id, deletedBy });
        if (b.action === 'delete-anon-messages') await db.deleteAnonChatMessages(b.anon_id, { streamId: b.stream_id, deletedBy });
        if (b.action === 'delete-relay-messages') await db.deleteRelayUserMessages(b.username, { streamId: b.stream_id, deletedBy });
        if (b.action === 'delete-by-range') await db.deleteChatMessagesByTimeRange(b.stream_id || null, b.from, b.to, deletedBy);
        return { ids: rows.map((r) => Number(r.id)), rows };
    }
    let result;
    if (b.action === 'review-pending-ip') result = await db.reviewPendingIpMessage(b.id, { status: b.status, reviewedBy: b.reviewed_by, channelId: b.channel_id });
    else if (b.action === 'approve-ip-messages') result = await db.approveAllFromIp(b.channel_id, b.ip, b.reviewed_by);
    else if (b.action === 'deny-ip-messages') result = await db.denyAllFromIp(b.channel_id, b.ip, b.reviewed_by);
    else if (b.action === 'relay-hide') result = await db.hideRelayUser({ channelId: b.channel_id, platform: b.platform, externalUsername: b.external_username, action: b.mode || 'hide', reason: b.reason, createdBy: b.created_by });
    else if (b.action === 'relay-unhide') result = b.id ? await db.unhideRelayUser(b.id) : await db.unhideRelayUserByIdentity(b.channel_id, b.platform, b.external_username);
    else if (b.action === 'relay-record') result = await db.recordRelayUser(b.platform, b.username);
    else if (b.action === 'tts-voice-override') result = b.params ? await db.setTtsVoiceOverride(b.identity_key, b.params, b.set_by) : await db.deleteTtsVoiceOverride(b.identity_key);
    else if (b.action === 'log') result = await db.logModerationAction(b);
    return { changes: result?.changes || 0, id: result?.lastInsertRowid ? Number(result.lastInsertRowid) : null };
}

async function deliverModeration(chatServer, b, result) {
    if (result.rows) return broadcastDeletes(chatServer, result.rows);
    if (b.action === 'disconnect') { await ctx.invalidateBans(); return chatServer.disconnectUser({ userId: b.user_id, ip: b.ip, streamId: b.stream_id }); }
    if (['approve-ip-messages', 'deny-ip-messages', 'review-pending-ip'].includes(b.action) && b.channel_id) ctx.invalidateApprovals(b.channel_id);
}

function validateInvalidate(b) {
    fields(b, ['key', 'user', 'user_data', 'approvals', 'bans', 'channel']);
    if (b.user == null && b.approvals == null && b.bans !== true && b.channel == null) bad('No cache hint');
    if (!optionalId(b.user) || !optionalId(b.approvals) || !optionalId(b.channel) || (b.bans != null && typeof b.bans !== 'boolean')) bad('Invalid cache hint');
    if (b.user_data != null) {
        fields(b.user_data, ['id', 'username', 'display_name', 'role', 'avatar_url', 'profile_color']);
        if (!int(b.user) || b.user_data.id !== b.user || !str(b.user_data.username, 120) || (b.user_data.display_name != null && !str(b.user_data.display_name, 120))) bad('Invalid user update');
    }
}
async function deliverInvalidate(chatServer, b) {
    if (b.user_data) await chatServer.sendUserUpdate(b.user, b.user_data);
    else if (b.user) { ctx.invalidateUser(b.user); await ctx.ensureUsers([b.user]).catch(() => {}); }
    if (b.channel) await ctx.invalidateChannel(b.channel);
    if (b.approvals) ctx.invalidateApprovals(b.approvals);
    if (b.bans) await ctx.invalidateBans();
}

function createInternalIngress({ chatServer }) {
    const r = express.Router();
    r.post('/messages', serviceAuth.guard('chat.message.send'), endpoint('messages', validateMessage, writeMessage, (b, result) => deliverMessage(chatServer, b, result)));
    r.post('/events', serviceAuth.guard('chat.event.publish'), endpoint('events', validateEvent, async () => ({}), (b) => deliverEvent(chatServer, b)));
    r.post('/moderation', serviceAuth.guard('chat.moderation.write'), endpoint('moderation', validateModeration, writeModeration, (b, result) => deliverModeration(chatServer, b, result)));
    r.post('/invalidate', serviceAuth.guard('chat.cache.invalidate'), endpoint('invalidate', validateInvalidate, async () => ({}), (b) => deliverInvalidate(chatServer, b)));
    r.get('/presence', serviceAuth.guard('chat.presence.read'), async (req, res) => {
        res.json(await require('./presence').snapshot(chatServer));
    });
    return r;
}

module.exports = { createInternalIngress };
