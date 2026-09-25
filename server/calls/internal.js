/**
 * OpenVibe.Chat — Live's stream lifecycle hooks for calls (Live CALLS_AUTHORITY=chat,
 * server/streaming/calls-authority.js). Loopback only, never routed by nginx; the same service-token
 * guard and capability as Live's other calls into Chat (bridge/live-bridge.js):
 *
 *   POST   /internal/calls/stream-channel             capability chat.live_bridge.write
 *       { stream_id, mode, user_id } → { ok, channel }   go-live with call mode, or the mode changed
 *       (a new mode ends the call in progress, as in Live). The stream is read from Live first, so
 *       its title and live state are current when viewers join.
 *   DELETE /internal/calls/stream-channel/:streamId   capability chat.live_bridge.write
 *       → { ok, removed }   the stream ended (or was force-ended): its call ends, the channel goes.
 *
 * While CHAT_CALLS is off both answer 409 and change nothing, so a Live switched too early learns
 * why (Live logs it) instead of creating channels nobody can reach.
 */
'use strict';

const express = require('express');
const config = require('../config');
const ctx = require('../live-context');
const serviceAuth = require('../net/service-auth');
const callServer = require('./call-server');
const { MODES } = require('./routes');

const CAPABILITY = 'chat.live_bridge.write';
const STREAM_LOOKUP_MS = 2500;

function createInternalRouter() {
    const router = express.Router();
    router.use(serviceAuth.guard(CAPABILITY));
    router.use((req, res, next) => {
        if (!config.calls.enabled) return res.status(409).json({ error: 'Calls are not served by Chat (CHAT_CALLS is not set)', code: 'calls.off' });
        next();
    });

    router.post('/stream-channel', async (req, res) => {
        const b = req.body || {};
        const streamId = Number(b.stream_id);
        const userId = Number(b.user_id);
        const mode = b.mode;
        if (!Number.isInteger(streamId) || streamId <= 0) return res.status(400).json({ error: 'stream_id required' });
        if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user_id required' });
        if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
        try {
            // Bounded: a slow Live must not hold Live's own go-live; the projection answers meanwhile.
            const stream = await Promise.race([ctx.refreshStream(streamId), new Promise((r) => setTimeout(() => r(null), STREAM_LOOKUP_MS).unref?.())])
                || ctx.getStreamById(streamId);
            const ch = callServer.createStreamChannel(streamId, mode, userId, stream);
            res.json({ ok: true, channel: callServer._publicChannel(ch) });
        } catch (err) {
            console.error('[Calls] stream-channel:', err.message);
            res.status(500).json({ error: 'Failed to create the stream voice channel' });
        }
    });

    router.delete('/stream-channel/:streamId', (req, res) => {
        const streamId = Number(req.params.streamId);
        if (!Number.isInteger(streamId) || streamId <= 0) return res.status(400).json({ error: 'stream id required' });
        try {
            res.json({ ok: true, removed: callServer.removeStreamChannel(streamId) });
        } catch (err) {
            console.error('[Calls] stream-channel:', err.message);
            res.status(500).json({ error: 'Failed to remove the stream voice channel' });
        }
    });

    return router;
}

module.exports = { createInternalRouter, CAPABILITY };
