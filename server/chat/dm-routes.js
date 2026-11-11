/**
 * OpenVibe.Chat — DM REST API Routes (moved from OpenVibe.Live server/chat/dm-routes.js, W6)
 *
 * GET  /api/dm/conversations          — list conversations
 * POST /api/dm/conversations          — create or get 1-on-1 / group
 * GET  /api/dm/conversations/:id      — get conversation details + participants
 * GET  /api/dm/conversations/:id/messages — paginated messages
 * POST /api/dm/conversations/:id/messages — send a message
 * POST /api/dm/conversations/:id/read — mark conversation read
 * POST /api/dm/conversations/:id/participants — add participant to group
 * DELETE /api/dm/conversations/:id/participants/:userId — remove participant
 * PATCH /api/dm/conversations/:id     — rename group
 * GET  /api/dm/unread                 — total unread count
 * GET  /api/dm/users/search           — search users for new-message picker
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const dm = require('./dm');
const contacts = require('./contacts');
const ctx = require('../live-context');
const prefStores = require('../prefs/stores');
const database = require('../db/database');
const presence = require('../presence');
const { idParam } = require('./route-params');

/**
 * The target's chat.dm_settings (Network user module): does this person accept a new direct
 * conversation, or being added to a group? When Network cannot answer, the defaults (yes) apply.
 */
async function dmSettingsOf(target) {
    const subject = (target && target.subject_id) || await require('../db/database').subjectFor(target && target.id);
    return await prefStores.settingsOf(prefStores.dm, subject);
}

// Chat-internal columns (the Network subject next to Live's ids) are not part of Live's API.
function publicMessage(m) {
    if (m) { delete m.sender_subject_id; delete m.edit_history; }
    return m;
}

/** Attach the Network presence view to every person in these conversations (one read, cached 30 s). */
async function withPresence(viewerSubject, conversations) {
    await presence.attachTo(viewerSubject, conversations.flatMap((c) => (Array.isArray(c && c.participants) ? c.participants : [])));
    return conversations;
}

// All DM routes require authentication
router.use(requireAuth);

// A view choice is private to the signed-in participant and this conversation.
router.get('/conversations/:id/view', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !await dm.isParticipant(id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
    const saved = await database.get('SELECT view FROM dm_view_preferences WHERE user_id = ? AND conversation_id = ?', [req.user.id, id]);
    const participants = await dm.getParticipants(id);
    const defaults = await prefStores.settingsOf(prefStores.preferences, req.user.subject_id);
    const kind = participants.length <= 2 ? 'one_to_one' : 'group';
    const view = saved?.view || (defaults.view_defaults && defaults.view_defaults[kind]) || (kind === 'one_to_one' ? 'bubbles' : 'room');
    res.set('Cache-Control', 'private, no-store').json({ conversation_id: id, view });
});
router.put('/conversations/:id/view', async (req, res) => {
    const id = Number(req.params.id), view = req.body && req.body.view;
    if (!Number.isSafeInteger(id) || !await dm.isParticipant(id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
    if (view !== 'bubbles' && view !== 'room') return res.status(400).json({ error: 'view must be bubbles or room' });
    await database.run('INSERT INTO dm_view_preferences (user_id, conversation_id, view, updated_at) VALUES (?, ?, ?, ov_now()) ON CONFLICT (user_id, conversation_id) DO UPDATE SET view = EXCLUDED.view, updated_at = ov_now()', [req.user.id, id, view]);
    res.set('Cache-Control', 'private, no-store').json({ conversation_id: id, view });
});

// Ids are validated before the handler (and its queries) see them, one rule per param name.
router.param('id', idParam('invalid conversation id'));
router.param('userId', idParam('invalid user id'));
router.param('msgId', idParam('invalid message id'));

// Per-actor limits (net/actor-limits.js), after requireAuth: reads take the defaults at app.js; each
// write below has its own number. The per-person DM limits further down (10 messages a minute, 5 new
// conversations an hour) keep deciding what is sent; these cap the requests, refused ones included.
// Starting a conversation checks every invitee with Live and the Network: 10 a minute, 60 an hour.
const startLimit = limits('chat.dm.conversation.create', { minute: 10, hour: 60 });
// Sending: three times the message limit, so a person retrying a refused send is not locked out.
const sendLimit = limits('chat.dm.message.send', { minute: 30, hour: 900 });
// Marking read clears the person's DM notifications on the Network: once per conversation opened.
const readLimit = limits('chat.dm.read_mark', { minute: 60, hour: 1200 });
// Group membership, renames and blocks: a person does a few at a time.
const manageLimit = limits('chat.dm.manage', { minute: 20, hour: 200 });
// Deleting their own messages: one at a time, by hand.
const deleteLimit = limits('chat.dm.message.delete', { minute: 60, hour: 600 });

// ── Per-user rate limiting (in-memory sliding window) ────────
const _rateBuckets = new Map();
const RATE_MSG_MAX = 10, RATE_MSG_WINDOW = 60_000;       // 10 messages / 60s
const RATE_CONV_MAX = 5, RATE_CONV_WINDOW = 3_600_000;   // 5 new conversations / hour
const MAX_GROUP_SIZE = 20;

function _checkRate(userId, bucket, max, windowMs) {
    if (!_rateBuckets.has(userId)) _rateBuckets.set(userId, { messages: [], convos: [] });
    const u = _rateBuckets.get(userId);
    const now = Date.now(), cutoff = now - windowMs;
    u[bucket] = u[bucket].filter(t => t > cutoff);
    if (u[bucket].length >= max) return false;
    u[bucket].push(now);
    return true;
}
setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [uid, b] of _rateBuckets) {
        b.messages = b.messages.filter(t => t > cutoff);
        b.convos = b.convos.filter(t => t > cutoff);
        if (!b.messages.length && !b.convos.length) _rateBuckets.delete(uid);
    }
}, 300_000);

// List conversations for current user
router.get('/conversations', async (req, res) => {
    try {
        const conversations = await dm.getConversations(req.user.id);
        // Attach participant info to each conversation
        for (const conv of conversations) {
            conv.participants = await dm.getParticipants(conv.id);
        }
        await withPresence(req.user.subject_id, conversations);
        res.json({ conversations });
    } catch (err) {
        console.error('[DM] List conversations error:', err.message);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// Create or get a conversation
router.post('/conversations', startLimit, async (req, res) => {
    try {
        const { user_ids, name } = req.body;
        if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
            return res.status(400).json({ error: 'user_ids array required' });
        }
        const participantIds = [...new Set([req.user.id, ...user_ids.map(Number).filter(Boolean)])];
        if (participantIds.length < 2) {
            return res.status(400).json({ error: 'Need at least one other user' });
        }
        if (participantIds.length > MAX_GROUP_SIZE) {
            return res.status(400).json({ error: `Groups are limited to ${MAX_GROUP_SIZE} members` });
        }

        // Rate limit conversation creation
        if (!_checkRate(req.user.id, 'convos', RATE_CONV_MAX, RATE_CONV_WINDOW)) {
            return res.status(429).json({ error: 'Too many new conversations. Try again later.' });
        }

        // New account restriction
        const accountCheck = await dm.isAccountTooNew(req.user.id, 5);
        if (accountCheck.tooNew) {
            return res.status(403).json({ error: `Your account is too new to start conversations. Please wait ${accountCheck.minutesRemaining} more minute(s).` });
        }

        // Validate all target users exist, aren't banned, aren't blocked (accounts are Live's)
        try { await ctx.ensureUsers(participantIds); } catch { /* the projection answers below */ }
        for (const uid of participantIds) {
            if (uid === req.user.id) continue;
            const target = await ctx.getUserById(uid);
            if (!target) return res.status(400).json({ error: 'User not found' });
            if (target.is_banned) return res.status(400).json({ error: 'Cannot message banned users' });
            if (await dm.isBlockedEither(req.user.id, uid)) {
                return res.status(403).json({ error: 'Cannot start a conversation with this user' });
            }
            // Their message settings: a new direct conversation, or a group, only if they accept one.
            const wants = await dmSettingsOf(target);
            if (participantIds.length === 2 && wants.new_conversations === 'nobody' && !await dm.findDirectConversation(req.user.id, uid)) {
                return res.status(403).json({ error: `${target.display_name || target.username} is not accepting new conversations`, code: 'dm.not_accepting' });
            }
            if (participantIds.length > 2 && wants.group_invites === false) {
                return res.status(403).json({ error: `${target.display_name || target.username} cannot be added to group conversations`, code: 'dm.no_group_invites' });
            }
        }

        let conversationId;
        if (participantIds.length === 2) {
            const otherId = participantIds.find(id => id !== req.user.id);
            conversationId = await dm.getOrCreateDirect(req.user.id, otherId);
        } else {
            const safeName = name ? String(name).replace(/<[^>]*>/g, '').replace(/[\\`'"<>(){};:/\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) : null;
            conversationId = await dm.createConversation(req.user.id, participantIds, safeName);
        }

        const conversation = await dm.getConversation(conversationId);
        conversation.participants = await dm.getParticipants(conversationId);
        await withPresence(req.user.subject_id, [conversation]);
        res.json({ conversation });
    } catch (err) {
        console.error('[DM] Create conversation error:', err.message);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

// Get conversation details
router.get('/conversations/:id', async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const conversation = await dm.getConversation(convId);
        if (!conversation) return res.status(404).json({ error: 'Not found' });
        conversation.participants = await dm.getParticipants(convId);
        await withPresence(req.user.subject_id, [conversation]);
        res.json({ conversation });
    } catch (err) {
        console.error('[DM] Get conversation error:', err.message);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// Get messages (paginated)
router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const after = parseInt(req.query.after) || null;
        if (after != null) {
            const messages = (await dm.getMessages(convId, limit, null, after)).map(publicMessage);
            return res.json({ messages });
        }
        const page = await dm.getMessagesPage(convId, { limit, before: req.query.before ?? null });
        res.json({ ...page, messages: page.messages.map(publicMessage) });
    } catch (err) {
        console.error('[DM] Get messages error:', err.message);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// Send a message
router.post('/conversations/:id/messages', sendLimit, async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }

        // Per-user message rate limit
        if (!_checkRate(req.user.id, 'messages', RATE_MSG_MAX, RATE_MSG_WINDOW)) {
            return res.status(429).json({ error: 'Slow down! You\'re sending messages too fast.' });
        }

        // Block check for 1-on-1 conversations
        const conv = await dm.getConversation(convId);
        if (conv && !conv.is_group) {
            const participants = await dm.getParticipants(convId);
            const other = participants.find(p => p.id !== req.user.id);
            if (other && await dm.isBlockedEither(req.user.id, other.id)) {
                return res.status(403).json({ error: 'Cannot send messages in this conversation' });
            }
        }

        const { message } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Message required' });
        }

        const msg = publicMessage(await dm.sendMessage(convId, req.user.id, message, { reply_to_id: req.body && req.body.reply_to_id }));
        if (!msg) return res.status(400).json({ error: 'Failed to send' });

        // Attach sender info
        const sender = await ctx.getUserById(req.user.id);
        msg.username = sender?.username;
        msg.display_name = sender?.display_name;
        msg.avatar_url = sender?.avatar_url;
        msg.profile_color = sender?.profile_color;

        // Real-time delivery via chat WebSocket. A recipient in DND (Network presence) gets the message
        // with `silent: true` and no Network push: Chat's own ping respects their chosen state.
        try {
            const chatServer = require('./chat-server');
            const participants = await dm.getParticipants(convId);
            const others = participants.filter(p => p.id !== req.user.id);
            // One Network read per recipient, in parallel; cached 30 s each. A group is at most 20 people.
            const own = await Promise.all(others.map((p) => (p.subject_id ? presence.self(p.subject_id) : null)));
            const dnd = new Set(others.filter((p, i) => own[i] && own[i].state === 'dnd').map((p) => p.id));
            for (const p of others) {
                await chatServer.sendDm(p.id, {
                    type: 'dm',
                    conversation_id: convId,
                    message: msg,
                    ...(dnd.has(p.id) ? { silent: true } : {}),
                });
            }
            // Push notifications to other participants (for when they're offline) — Live's
            // utils/notify pushes them to the Network; the preview stays generic there.
            const notifyIds = others.filter(p => !dnd.has(p.id)).map(p => p.id);
            if (notifyIds.length) {
                ctx.effects.notifyDm({ recipient_ids: notifyIds, sender_id: req.user.id, conversation_id: convId });
            }
        } catch { /* non-critical */ }

        res.json({ message: msg });
    } catch (err) {
        console.error('[DM] Send message error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Mark conversation read
router.post('/conversations/:id/read', readLimit, async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        await dm.markRead(convId, req.user.id);

        // Clear matching DM notifications on the Network (through Live's utils/notify)
        try {
            ctx.effects.markDmRead(req.user.id, convId);
        } catch { /* non-critical */ }

        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Mark read error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Add participant to group
router.post('/conversations/:id/participants', manageLimit, async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });

        // Validate target user exists, isn't banned, isn't blocked (accounts are Live's)
        try { await ctx.ensureUsers([user_id]); } catch { /* the projection answers below */ }
        const target = await ctx.getUserById(user_id);
        if (!target) return res.status(400).json({ error: 'User not found' });
        if (target.is_banned) return res.status(400).json({ error: 'Cannot add banned users' });
        // A private 1:1 stays private: adding a third person would hand them the whole history.
        const conv = await dm.getConversation(convId);
        if (!conv || !conv.is_group) {
            return res.status(400).json({ error: 'Start a group conversation to add people' });
        }
        // Nobody already in the group should end up talking to someone they blocked (or who blocked them).
        const members = await dm.getParticipants(convId) || [];
        let blocked = false;
        for (const p of members) if (await dm.isBlockedEither(p.user_id || p.id, user_id)) { blocked = true; break; }
        if (blocked) {
            return res.status(403).json({ error: 'Cannot add this user' });
        }
        if ((await dmSettingsOf(target)).group_invites === false) {
            return res.status(403).json({ error: `${target.display_name || target.username} cannot be added to group conversations`, code: 'dm.no_group_invites' });
        }

        // Group size limit
        if (await dm.getParticipantCount(convId) >= MAX_GROUP_SIZE) {
            return res.status(400).json({ error: `Group is full (max ${MAX_GROUP_SIZE} members)` });
        }

        await dm.addParticipant(convId, user_id);
        const participants = await dm.getParticipants(convId);

        // Notify all participants about the new member
        try {
            const chatServer = require('./chat-server');
            for (const p of participants) {
                await chatServer.sendDm(p.id, {
                    type: 'dm-participant-added',
                    conversation_id: convId,
                    user_id,
                    participants,
                });
            }
        } catch { /* non-critical */ }

        res.json({ participants });
    } catch (err) {
        console.error('[DM] Add participant error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Remove participant from group
router.delete('/conversations/:id/participants/:userId', manageLimit, async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const targetUserId = parseInt(req.params.userId);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        // Can only remove self (leave) or be the creator
        const conv = await dm.getConversation(convId);
        if (targetUserId !== req.user.id && conv?.created_by !== req.user.id) {
            return res.status(403).json({ error: 'Only the creator can remove others' });
        }
        await dm.removeParticipant(convId, targetUserId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Remove participant error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Rename group conversation
router.patch('/conversations/:id', manageLimit, async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        let { name } = req.body;
        if (name) {
            name = String(name).replace(/<[^>]*>/g, '').replace(/[\\`'"<>(){};:/\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
        }
        await dm.renameConversation(convId, name || null);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Rename error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Total unread count
router.get('/unread', async (req, res) => {
    try {
        const total = await dm.getTotalUnread(req.user.id);
        res.json({ unread: total });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// Search users for new-message picker
router.get('/users/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ users: [] });
        const users = await dm.searchUsers(q, req.user.id);
        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ── Friends and requests (the side column on Home) ─────────────

// The people you talk to: your friends and the requests that wait for you.
router.get('/contacts', async (req, res) => {
    try {
        const list = await contacts.of(req.user.id);
        res.set('Cache-Control', 'private, no-store').json(list);
    } catch (err) {
        console.error('[Contacts] List error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Ask someone to be a friend (or accept them, when they asked first).
router.post('/contacts', manageLimit, async (req, res) => {
    try {
        const username = String((req.body && req.body.username) || '').trim();
        if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'That is not a username' });
        const target = await ctx.getUserByUsername(username) || await ctx.ensureUserByUsername(username).catch(() => null);
        if (!target) return res.status(404).json({ error: 'Nobody on OpenVibe goes by that name' });
        if (Number(target.id) === Number(req.user.id)) return res.status(400).json({ error: 'That is you' });
        if (await dm.hasBlocked(req.user.id, target.id) || await dm.hasBlocked(target.id, req.user.id)) {
            return res.status(403).json({ error: 'You cannot add this person' });
        }
        const status = await contacts.add(req.user.id, target.id);
        res.json({ ok: true, status });
    } catch (err) {
        console.error('[Contacts] Add error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Accept a request.
router.post('/contacts/:userId/accept', manageLimit, async (req, res) => {
    try {
        const ok = await contacts.accept(req.user.id, Number(req.params.userId));
        if (!ok) return res.status(404).json({ error: 'No request from that person' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Contacts] Accept error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// Drop a friend or a request.
router.delete('/contacts/:userId', manageLimit, async (req, res) => {
    try {
        await contacts.remove(req.user.id, Number(req.params.userId));
        res.json({ ok: true });
    } catch (err) {
        console.error('[Contacts] Remove error:', err.message);
        res.status(500).json({ error: 'Failed' });
    }
});

// ── Block & message management ───────────────────────────────

// Block a user
router.post('/blocks/:userId', manageLimit, async (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        if (!targetId || targetId === req.user.id) {
            return res.status(400).json({ error: 'Invalid user' });
        }
        await dm.blockUser(req.user.id, targetId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Block error:', err.message);
        res.status(500).json({ error: 'Failed to block user' });
    }
});

// Unblock a user
router.delete('/blocks/:userId', manageLimit, async (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        await dm.unblockUser(req.user.id, targetId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Unblock error:', err.message);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// List blocked users
router.get('/blocks', async (req, res) => {
    try {
        const blocked = await dm.getBlockedUsers(req.user.id);
        res.json({ blocked });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load blocked users' });
    }
});

// Check if a specific user is blocked
router.get('/blocks/check/:userId', async (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        res.json({ blocked: await dm.hasBlocked(req.user.id, targetId) });
    } catch {
        res.json({ blocked: false });
    }
});

// Delete own message
router.delete('/conversations/:id/messages/:msgId', deleteLimit, async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const msgId = parseInt(req.params.msgId);
        if (!await dm.isParticipant(convId, req.user.id)) {
            return res.status(403).json({ error: 'Not a participant' });
        }
        const deleted = await dm.deleteMessage(msgId, req.user.id);
        if (!deleted) return res.status(403).json({ error: 'Cannot delete this message' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Delete message error:', err.message);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

router.patch('/conversations/:id/messages/:msgId', sendLimit, async (req, res) => {
    const convId = Number(req.params.id), msgId = Number(req.params.msgId);
    if (!await dm.isParticipant(convId, req.user.id)) return res.status(403).json({ error: 'Not a participant' });
    try {
        const message = publicMessage(await dm.editMessage(convId, msgId, req.user.id, req.body && req.body.message));
        if (!message) return res.status(404).json({ error: 'No such message' });
        const participants = await dm.getParticipants(convId);
        for (const p of participants) await require('./chat-server').sendDm(p.id, { type: 'dm_edited', conversation_id: convId, message });
        return res.json({ message });
    } catch (err) { return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to edit message' }); }
});

router.get('/conversations/:id/messages/:msgId/edits', async (req, res) => {
    if (!['admin', 'global_mod'].includes(req.user.role)) return res.status(403).json({ error: 'Moderators only' });
    const row = await database.get('SELECT edit_history FROM dm_messages WHERE id = ? AND conversation_id = ?', [Number(req.params.msgId), Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'No such message' });
    return res.set('Cache-Control', 'private, no-store').json({ versions: row.edit_history || [] });
});

module.exports = router;
