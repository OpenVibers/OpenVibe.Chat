/**
 * OpenVibe.Chat — the call REST routes, on Live's paths (mounted at /api/streams; nginx sends
 * exactly these there at the calls cutover, docs/calls-cutover.md). Moved from OpenVibe.Live
 * server/streaming/routes.js with the same requests, answers and errors:
 *
 *   GET    /voice-channels                     { channels }            (private calls: creator, invitees, staff)
 *   GET    /voice-channels/:channelId          { channel } | 404
 *   POST   /voice-channels                     201 { channel } | 400 (one channel per person)
 *   DELETE /voice-channels/:channelId          { deleted: true } | 403
 *   POST   /voice-channels/call-user           { invited, reusedChannel, channel } — rings a person
 *   POST   /voice-channels/call-user/respond   { ok: true } — the callee's answer, relayed to the caller
 *   PUT    /:id/call                           { call_mode, channelId, participants, participant_count } (the streamer)
 *   GET    /:id/call                           the same, for anyone
 *
 * What changed: accounts and streams come from live-context; the stream's call mode is the mode of
 * its channel here (Chat owns it; Live's streams.call_mode is no longer read); the ring is a row of
 * `calls` (./lifecycle.js) — a callee who never answers is missed after CALL_RING_TIMEOUT_MS and the
 * caller gets the same `vc-call-response` (status no-answer) the callee's browser sends when it gives
 * up; Live's cross-site VC_CALL_INVITE notification is asked of Live (notify/call-invite).
 */
'use strict';

const express = require('express');
const config = require('../config');
const ctx = require('../live-context');
const dm = require('../chat/dm');
const chatServer = require('../chat/chat-server');
const { requireAuth, optionalAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const callServer = require('./call-server');
const lifecycle = require('./lifecycle');

const router = express.Router();

// Per-actor limits (net/actor-limits.js), after requireAuth: reads take the defaults at app.js.
// Creating and closing voice channels, and a streamer switching a stream's call: pushed to every
// socket, done by hand a few at a time.
const channelLimit = limits('chat.call.manage', { minute: 20, hour: 200 });
// Ringing someone: above the six rings a minute below, which keeps deciding; refusals count.
const ringLimit = limits('chat.call.ring', { minute: 20, hour: 200 });
// Answering a ring: once per ring received.
const answerLimit = limits('chat.call.answer', { minute: 30, hour: 300 });
const MODES = ['mic', 'mic+cam', 'cam+mic'];

/* ── Voice Channels (global, non-stream) ───────────────────── */

router.get('/voice-channels', optionalAuth, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store'); // private calls differ per viewer; the list is pushed anyway
        res.json({ channels: await callServer.listChannels(req.user || null) });
    } catch (err) {
        console.error('[Calls]', err.message);
        res.status(500).json({ error: 'Failed to list voice channels' });
    }
});

router.get('/voice-channels/:channelId', optionalAuth, async (req, res) => {
    try {
        const ch = await callServer.getChannel(req.params.channelId, req.user || null);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        res.json({ channel: ch });
    } catch (err) {
        console.error('[Calls]', err.message);
        res.status(500).json({ error: 'Failed to get voice channel' });
    }
});

router.post('/voice-channels', requireAuth, channelLimit, (req, res) => {
    try {
        const { name, mode, maxParticipants } = req.body || {};
        const ch = callServer.createChannel({ name, mode, createdBy: req.user.id, maxParticipants });
        res.status(201).json({ channel: ch });
    } catch (err) {
        if (err.code === 'CHANNEL_LIMIT') return res.status(400).json({ error: err.message });
        console.error('[Calls]', err.message);
        res.status(500).json({ error: 'Failed to create voice channel' });
    }
});

router.delete('/voice-channels/:channelId', requireAuth, channelLimit, async (req, res) => {
    try {
        const ok = await callServer.deleteChannel(req.params.channelId, req.user);
        if (!ok) return res.status(403).json({ error: 'Cannot delete this channel' });
        res.json({ deleted: true });
    } catch (err) {
        console.error('[Calls]', err.message);
        res.status(500).json({ error: 'Failed to delete voice channel' });
    }
});

/** A person by id or login: the projection, else Live. */
async function findUser(id, username) {
    let user = null;
    if (id > 0) {
        user = await ctx.getUserById(id);
        if (!user) { await ctx.ensureUsers([id]).catch(() => {}); user = await ctx.getUserById(id); }
    }
    if (!user && username) user = await ctx.ensureUserByUsername(username);
    return user || null;
}

/** The caller hears "no answer" when their ring times out (the frame the callee's browser sends). */
async function tellCallerNoAnswer(row, channelName, target) {
    await chatServer.sendDm(row.created_by, {
        type: 'vc-call-response',
        status: 'no-answer',
        channelId: row.channel_id,
        channelName,
        fromUserId: target.id,
        fromUsername: target.username,
        fromDisplayName: target.display_name || target.username || 'Someone',
        fromAvatarUrl: target.avatar_url || null,
        createdAt: Date.now(),
    });
}

const _callUserRate = new Map(); // userId → [timestamps]
router.post('/voice-channels/call-user', requireAuth, ringLimit, async (req, res) => {
    let call = null;
    try {
        // Six calls a minute per account: a ring is a notification on someone else's screen.
        const now = Date.now();
        const recent = (_callUserRate.get(req.user.id) || []).filter((t) => now - t < 60000);
        if (recent.length >= 6) return res.status(429).json({ error: 'Slow down — try again in a minute' });
        recent.push(now); _callUserRate.set(req.user.id, recent);
        const targetUserId = Number(req.body?.user_id || 0);
        const targetUsername = String(req.body?.username || '').trim();

        const targetUser = await findUser(targetUserId, targetUsername);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        if (targetUser.id === req.user.id) return res.status(400).json({ error: 'You cannot call yourself' });
        try { if (dm.isBlockedEither && await dm.isBlockedEither(req.user.id, targetUser.id)) return res.status(403).json({ error: 'You cannot call this user' }); } catch { /* */ }

        // Reuse caller's existing temp channel if present; otherwise create a private one — a
        // 1:1 call is not something the whole site should see listed and be able to walk into.
        const existing = (await callServer.listChannels(req.user) || []).find(ch => !ch.permanent && !ch.streamId && ch.createdBy === req.user.id) || null;
        const channel = existing || callServer.createChannel({
            name: `${req.user.display_name || req.user.username}'s call`,
            mode: 'mic+cam',
            createdBy: req.user.id,
            maxParticipants: 8,
            isPrivate: true,
        });
        call = await lifecycle.openDirect({ callerId: req.user.id, targetId: targetUser.id, channelId: channel.id });
        if (!callServer.invite(channel.id, targetUser.id)) throw new Error('the call channel is gone');

        const callerName = req.user.display_name || req.user.username || 'Someone';
        const payload = {
            type: 'vc-call-invite',
            channelId: channel.id,
            channelName: channel.name,
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName: callerName,
            fromAvatarUrl: req.user.avatar_url || null,
            createdAt: Date.now(),
        };

        // Real-time invite for online users via existing chat WS connections.
        await chatServer.sendDm(targetUser.id, payload);

        // Persistent cross-site notification for offline users / later join (Live pushes it).
        ctx.effects.notifyCallInvite({
            caller_id: req.user.id,
            target_id: targetUser.id,
            channel_id: channel.id,
            channel_name: channel.name,
        });

        await lifecycle.ring(call.id, { timeoutMs: config.calls.ringTimeoutMs, onTimeout: async (row) => await tellCallerNoAnswer(row, channel.name, targetUser) });

        return res.json({ invited: true, reusedChannel: !!existing, channel });
    } catch (err) {
        if (err.code === 'CHANNEL_LIMIT') return res.status(400).json({ error: err.message });
        if (call) { try { await lifecycle.fail(call.id, `invite_failed: ${err.message}`); } catch { /* */ } }
        console.error('[Calls]', err.message);
        return res.status(500).json({ error: 'Failed to call user' });
    }
});

router.post('/voice-channels/call-user/respond', requireAuth, answerLimit, async (req, res) => {
    try {
        const callerUserId = Number(req.body?.caller_user_id || 0);
        const channelId = String(req.body?.channel_id || '').trim();
        const channelName = String(req.body?.channel_name || 'Voice Channel').trim() || 'Voice Channel';
        const status = String(req.body?.status || '').trim().toLowerCase();

        const allowed = new Set(['accepted', 'declined', 'busy', 'no-answer', 'canceled']);
        if (!callerUserId) return res.status(400).json({ error: 'caller_user_id is required' });
        if (!channelId) return res.status(400).json({ error: 'channel_id is required' });
        if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid response status' });
        if (callerUserId === req.user.id) return res.status(400).json({ error: 'Invalid caller target' });
        // Only an invited user can answer, and only to the caller who owns that channel.
        const ch = await callServer.getChannel(channelId, req.user);
        if (!ch || ch.createdBy !== callerUserId || !callServer.hasInvite(channelId, req.user.id)) return res.status(403).json({ error: 'No such invite' });

        try { await lifecycle.respond({ callerId: callerUserId, targetId: req.user.id, channelId, status }); } catch (err) { console.warn('[Calls] lifecycle:', err.message); }

        const fromDisplayName = req.user.display_name || req.user.username || 'Someone';
        await chatServer.sendDm(callerUserId, {
            type: 'vc-call-response',
            status,
            channelId,
            channelName,
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName,
            fromAvatarUrl: req.user.avatar_url || null,
            createdAt: Date.now(),
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error('[Calls]', err.message);
        return res.status(500).json({ error: 'Failed to send call response' });
    }
});

// ── Group Call: Enable / Disable / Get Status ────────────────

function callStatus(streamId, callMode) {
    const channelId = `stream-${streamId}`;
    return {
        call_mode: callMode,
        channelId: callMode ? channelId : null,
        participants: callServer.getParticipants(channelId),
        participant_count: callServer.getParticipantCount(channelId),
    };
}

router.put('/:id/call', requireAuth, channelLimit, async (req, res) => {
    try {
        // Ownership and live state from Live now, not a cached copy.
        const stream = await ctx.refreshStream(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) {
            return res.status(400).json({ error: 'Stream is not live' });
        }

        const { call_mode } = req.body || {};
        const validModes = [...MODES, null];
        if (!validModes.includes(call_mode)) {
            return res.status(400).json({ error: 'Invalid call mode. Use: mic, mic+cam, cam+mic, or null to disable' });
        }

        // Create or remove stream voice channel
        if (call_mode) {
            await callServer.createStreamChannel(stream.id, call_mode, stream.user_id, stream);
        } else {
            await callServer.removeStreamChannel(stream.id);
        }

        res.json(callStatus(stream.id, call_mode));
    } catch (err) {
        console.error('[Calls] Call mode error:', err.message);
        res.status(500).json({ error: 'Failed to update call mode' });
    }
});

router.get('/:id/call', optionalAuth, async (req, res) => {
    try {
        const stream = await ctx.getStreamById(req.params.id) || await ctx.ensureStream(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        const ch = callServer.channels.get(`stream-${stream.id}`);
        res.json(callStatus(stream.id, ch ? ch.mode : null));
    } catch (err) {
        console.error('[Calls]', err.message);
        res.status(500).json({ error: 'Failed to get call status' });
    }
});

module.exports = router;
module.exports.MODES = MODES;
