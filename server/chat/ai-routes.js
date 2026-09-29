/**
 * ai-routes.js — read API for chat AI insight, Chat's (/api/chat/ai/…, nginx sends /api/chat here).
 *
 * Live's server/ai/chat-ai-routes.js, moved (plan T3 step 2): the same six paths, query parameters,
 * response shapes, error codes and caching headers, reading Chat's own chat_ai_summaries /
 * chat_timeline_events (via the chat-ai job's read helpers) and Chat's ctx_* projections.
 *
 *   GET /global                    → { insight } (or null)
 *   GET /timeline                  → { events, hasMore }   ?before=ms&since=ms&q=&limit=
 *   GET /user/:id                  → { insight, streamer, user }
 *   GET /anon/:anonId              → { insight, user }      (anon id like "anon12345")
 *   GET /relay/:platform/:username → { insight, user }
 *   GET /timeline/:username        → the channel timeline shell
 *
 * Visibility is Live's: these six are public reads (Live put no auth in front of them; the UI only
 * offers the insight cards to staff). No Cache-Control, as Live.
 *
 * The captions and VOD-transcript routes in Live's file are Live's stream features (whisper, VOD
 * moments) and stay there.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const ctx = require('../live-context');
const chatAi = require('../ai/chat-ai');

router.get('/global', (req, res) => {
    try {
        const insight = chatAi.getGlobalInsight();
        res.json({ insight: insight || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load global chat insight' });
    }
});

// Browsable/searchable global timeline. Query: before=<ms>, since=<ms>, q=<search>, limit=<n>.
router.get('/timeline', (req, res) => {
    try {
        const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
        const limit = Math.min(60, Math.max(1, num(req.query.limit) || 25));
        const events = db.getChatTimelineEvents({
            scope: 'global', subjectId: 0,
            before: num(req.query.before), since: num(req.query.since),
            q: req.query.q || null, limit,
        });
        res.json({ events, hasMore: events.length >= limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

router.get('/user/:id', (req, res) => {
    try {
        const uid = parseInt(req.params.id, 10);
        if (!Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid user id' });
        const user = ctx.getUserById(uid);
        const insight = chatAi.getUserInsight(uid);
        // `streamer` (who they are as a broadcaster: overview + stream memories) is Live's stream
        // feature, not chat; Chat answers null for it (see README, For Opus). The key is kept so
        // the response shape matches Live's.
        res.json({
            insight: insight || null,
            streamer: null,
            user: user ? { id: user.id, username: user.username, display_name: user.display_name } : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user chat insight' });
    }
});

// An anonymous chatter's insight, keyed by their stable anon_id ("anon<N>").
router.get('/anon/:anonId', (req, res) => {
    try {
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        const insight = chatAi.getAnonInsight(anonId);
        res.json({ insight: insight || null, user: { anon_id: anonId, username: anonId } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load anon chat insight' });
    }
});

// A bridged external (relay) chatter's insight, keyed by platform + username.
router.get('/relay/:platform/:username', (req, res) => {
    try {
        const ru = db.getRelayUser(req.params.platform, req.params.username);
        if (!ru) return res.json({ insight: null, user: null });
        const insight = chatAi.getRelayUserInsight(ru.id);
        res.json({
            insight: insight || null,
            user: { platform: ru.platform, username: ru.display_name || ru.username, message_count: ru.message_count || 0, first_seen: ru.first_seen || null },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load relay chat insight' });
    }
});

// The channel page's AI timeline shell. Live's route fuses its streamer AI timeline (stream
// overviews, VOD moments, combined overview, session titles) with the chatter insight; the streamer
// half is Live's stream feature and Chat cannot build it (README, For Opus). Chat serves the chat
// half with Live's exact keys so the endpoint and the simple consumer keep working.
router.get('/timeline/:username', (req, res) => {
    try {
        const uname = String(req.params.username || '').trim();
        const user = ctx.getUserByUsername(uname);
        if (!user) return res.status(404).json({ error: 'Channel not found' });
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
        let chatInsight = null;
        try { chatInsight = chatAi.getUserInsight(user.id) || null; } catch { chatInsight = null; }
        res.json({
            username: user.username,
            display_name: user.display_name || user.username,
            overview: undefined,     // Live's streamer overview — Live's feature (For Opus)
            chatInsight,
            combinedOverview: null,
            sessionCount: 0,
            momentCount: 0,
            generatedAt: null,
            index: undefined,
            sessions: [],
            offset, limit,
            hasMore: false,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load AI timeline' });
    }
});

module.exports = router;
