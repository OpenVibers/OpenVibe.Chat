/**
 * OpenVibe.Chat — Live's internal read API for the chat tables Chat owns (plan T3).
 *
 * Live keeps only its own features; what it needs from the tables Chat now writes it asks here,
 * loopback only, with a service token for audience openvibe.chat carrying `chat.moderation.read`:
 *
 *   GET /internal/moderation/channels/:channelId             { ok, settings, moderator_ids }
 *   GET /internal/moderation/users/:userId/channels          { ok, channels: [{ channel_id, title, owner_user_id, owner_username }] }
 *   GET /internal/moderation/channels/:channelId/emote-count { ok, count }
 *
 * The answers are the contracts chat.channel-moderation-result@1, chat.moderated-channels-result@1
 * and chat.emote-count-result@1. `settings` is every channel_moderation_settings column, with
 * Live's defaults when the channel has no row. `channelId` is a channels.id for the settings and
 * moderator reads; for the emote count it is the channel owner's Live user id (the emotes rows are
 * keyed by the streamer), the same value Live's db.countChannelEmotes() takes.
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const ctx = require('../live-context');
const serviceAuth = require('../net/service-auth');

const router = express.Router();
const guard = serviceAuth.guard('chat.moderation.read');

router.get('/channels/:channelId', guard, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        if (!channelId) return res.status(400).json({ ok: false, error: 'Invalid channel ID' });
        const settings = db.getChannelModerationSettingsRow(channelId) || ctx.defaultModerationSettings(channelId);
        const moderator_ids = db.getChannelModeratorIds(channelId);
        res.json({ ok: true, settings, moderator_ids });
    } catch (err) {
        console.error('[Moderation] channel read:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to load channel moderation' });
    }
});

router.get('/users/:userId/channels', guard, (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        if (!userId) return res.status(400).json({ ok: false, error: 'Invalid user ID' });
        const channels = db.getChannelsByModerator(userId).map((c) => ({
            channel_id: Number(c.channel_id),
            title: c.title == null ? null : String(c.title),
            owner_user_id: c.owner_user_id == null ? null : Number(c.owner_user_id),
            owner_username: c.owner_username == null ? null : String(c.owner_username),
        }));
        res.json({ ok: true, channels });
    } catch (err) {
        console.error('[Moderation] moderated channels read:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to load moderated channels' });
    }
});

router.get('/channels/:channelId/emote-count', guard, (req, res) => {
    try {
        const raw = parseInt(req.params.channelId, 10);
        if (!raw) return res.status(400).json({ ok: false, error: 'Invalid channel ID' });
        // A channels.id resolves to its owner's user id (the emotes' key); a user id is used as it is.
        const ownerId = (ctx.getChannelById(raw) || {}).user_id || raw;
        res.json({ ok: true, count: db.countChannelEmotes(ownerId) });
    } catch (err) {
        console.error('[Moderation] emote count:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to count emotes' });
    }
});

module.exports = router;
