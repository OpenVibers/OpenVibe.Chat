/**
 * OpenVibe.Chat — TTS API Routes (moved from OpenVibe.Live server/chat/tts-routes.js, W6)
 *
 * TTS settings stay rows of Live's site_settings in this wave: reads come through live-context,
 * writes go to Live (which re-checks admin/owner). Preview clips are stashed here; clips Live
 * stashed (arena voice, the mod voice preview) are fetched from Live under the same URL.
 *
 * Public routes (authenticated users):
 *   GET  /api/tts/voices          — List available voices
 *   GET  /api/tts/settings        — Get TTS config for client
 *
 * Admin routes:
 *   GET  /api/tts/admin/settings  — Full TTS config with API keys
 *   PUT  /api/tts/admin/settings  — Update TTS config
 *
 * The room's TTS and sound queue (./audio-queue.js) — the broadcaster and moderators of the room
 * (channel mods, global mods, admins). The room is `stream_id`, or `channel_user_id` for offline
 * channel chat (query string for GET, body for POST):
 *   GET  /api/tts/queue            — { room, playing, queued, recent }
 *   POST /api/tts/queue/skip       — { id? } skip that request, else the one playing (else the next)
 *   POST /api/tts/queue/clear      — skip everything playing or waiting
 *   POST /api/tts/queue/:id/report — { state: 'played' | 'failed', error? } the playing client's
 *                                    report that its clip ended or could not play
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireAuth, requireAdmin } = require('../auth/auth');
const permissions = require('../auth/permissions');
const { isOwner } = permissions;
const ttsEngine = require('./tts-engine');
const audioQueue = require('./audio-queue');
const db = require('../db/database');
const ctx = require('../live-context');
const config = require('../config');

// ── Same-origin preview clips (Live used its arena voice cache; Chat keeps its own) ──
const CLIP_DIR = path.join(config.cacheDir, 'tts-clips');
const CLIP_TTL_MS = 24 * 60 * 60 * 1000;
const CLIP_EXT = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm' };
function stashClip(audioBase64, mimeType) {
    try {
        const buf = Buffer.from(String(audioBase64 || ''), 'base64');
        if (!buf.length) return null;
        fs.mkdirSync(CLIP_DIR, { recursive: true });
        const file = `c-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${CLIP_EXT[mimeType] || 'mp3'}`;
        const full = path.join(CLIP_DIR, file);
        if (!fs.existsSync(full)) fs.writeFileSync(full, buf);
        return { file };
    } catch { return null; }
}
function cachedClip(file) {
    const name = path.basename(String(file || ''));
    if (!/^c-[0-9a-f]{32}\.(mp3|wav|ogg|webm)$/.test(name)) return null;
    const full = path.join(CLIP_DIR, name);
    try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs > CLIP_TTL_MS) return null;
    } catch { return null; }
    const ext = name.split('.').pop();
    return { path: full, mimeType: Object.keys(CLIP_EXT).find((k) => CLIP_EXT[k] === ext) || 'audio/mpeg' };
}

// TTS credential fields/keys are owner-only. Admins may still manage the
// non-secret TTS config (enabled, provider, limits, default voice).
const TTS_SECRET_FIELDS = ['googleApiKey', 'googleServiceAccount', 'awsAccessKeyId', 'awsSecretAccessKey'];
const TTS_SECRET_KEYS = new Set([
    'tts_google_api_key', 'tts_google_service_account',
    'tts_aws_access_key_id', 'tts_aws_secret_access_key',
]);
function maskTtsSecret(v) {
    if (!v) return v;
    const s = String(v);
    return s.length <= 8 ? '••••••••' : '••••' + s.slice(-4);
}

// ── Public: Get available voices ──────────────────────────────
router.get('/voices', (req, res) => {
    try {
        const voices = ttsEngine.getAvailableVoices();
        res.json({ voices });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Public: Get TTS settings for client ───────────────────────
router.get('/settings', async (req, res) => {
    try {
        await ctx.ensureSettings();
        const settings = ttsEngine.getTTSSettings();
        // Don't expose API keys to the client
        res.json({
            enabled: settings.enabled,
            provider: settings.provider,
            googleConfigured: !!(settings.googleApiKey || settings.googleServiceAccount),
            pollyConfigured: !!settings.awsAccessKeyId,
            espeakAvailable: !!ttsEngine.detectEspeak(),
            maxLength: settings.maxLength,
            maxQueuePerUser: settings.maxQueuePerUser,
            maxQueueGlobal: settings.maxQueueGlobal,
            defaultVoice: settings.defaultVoice,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Get full TTS config ────────────────────────────────
router.get('/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        await ctx.ensureSettings();
        const settings = ttsEngine.getTTSSettings();
        // Mask credential fields for non-owners.
        if (!isOwner(req.user)) {
            for (const f of TTS_SECRET_FIELDS) {
                if (settings[f]) settings[f] = maskTtsSecret(settings[f]);
            }
            settings._secretsRedacted = true;
        }
        res.json({ settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Update TTS config ──────────────────────────────────
router.put('/admin/settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const allowed = [
            'tts_enabled', 'tts_provider',
            'tts_google_api_key', 'tts_google_service_account',
            'tts_aws_access_key_id', 'tts_aws_secret_access_key', 'tts_aws_region',
            'tts_max_length', 'tts_max_queue_per_user', 'tts_max_queue_global',
            'tts_default_voice',
        ];
        const updates = req.body.settings || req.body;
        const owner = isOwner(req.user);
        let count = 0;
        const accepted = {};
        for (const [key, value] of Object.entries(updates)) {
            if (!allowed.includes(key)) continue;
            // Credential keys are owner-only.
            if (TTS_SECRET_KEYS.has(key) && !owner) continue;
            // Never overwrite a stored secret with a masked placeholder.
            if (TTS_SECRET_KEYS.has(key) && typeof value === 'string' && /^••••/.test(value)) continue;
            accepted[key] = value;
            count++;
        }
        // site_settings is Live's: Live writes them (and applies the same admin/owner rules again).
        if (count) await ctx.setSettings(accepted, req.user.id);
        ttsEngine.invalidateSettingsCache();
        res.json({ success: true, updated: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Test voice synthesis ───────────────────────────────
router.post('/admin/test', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { voiceId, text } = req.body;
        const result = await ttsEngine.synthesize(text || 'This is a TTS test from OpenVibe.Live', voiceId);
        if (!result) return res.status(400).json({ error: 'Voice unavailable or TTS disabled' });
        // Same-origin URL alongside the base64: plays under media-src 'self' even where the
        // browser (or an overzealous shield) refuses blob:/data: audio.
        try { const stashed = stashClip(result.audio, result.mimeType); if (stashed) result.url = `/api/tts/audio/${stashed.file}`; } catch { /* base64 still works */ }
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── The room's TTS and sound queue ────────────────────────────
/**
 * Resolve the room a queue request names and check the caller may control it: the broadcaster
 * (stream or channel owner), the channel's moderators, global mods and admins. Sends the error and
 * returns null when not.
 */
async function queueRoom(req, res) {
    const src = req.method === 'GET' ? req.query : (req.body || {});
    const streamId = parseInt(src.stream_id, 10) || null;
    const channelUserId = streamId ? null : (parseInt(src.channel_user_id, 10) || null);
    if (!streamId && !channelUserId) { res.status(400).json({ error: 'stream_id or channel_user_id is required' }); return null; }
    let allowed = false;
    let channel = null;
    if (streamId) {
        const stream = await ctx.ensureStream(streamId).catch(() => null);
        if (!stream) { res.status(404).json({ error: 'No such stream' }); return null; }
        channel = stream.channel_id ? ctx.getChannelById(stream.channel_id) : ctx.getChannelByUserId(stream.user_id);
        if (channel) await ctx.ensurePolicy(channel.id).catch(() => {});   // channel moderators
        allowed = permissions.canModerateStream(req.user, streamId);
    } else {
        channel = ctx.getChannelByUserId(channelUserId);
        if (channel) await ctx.ensurePolicy(channel.id).catch(() => {});
        allowed = req.user.id === channelUserId || permissions.isGlobalModOrAbove(req.user)
            || (!!channel && permissions.isChannelMod(req.user, channel.id));
    }
    if (!allowed) { res.status(403).json({ error: 'Only the broadcaster and moderators can manage the TTS and sound queue' }); return null; }
    return { room: audioQueue.roomKey({ streamId, channelUserId }), streamId, channelUserId, channel };
}

function logQueueAction(req, r, action, details) {
    try {
        db.logModerationAction({
            scope_type: r.channel ? 'channel' : 'site',
            scope_id: r.channel ? r.channel.id : undefined,
            actor_user_id: req.user.id,
            action_type: action,
            details: { stream_id: r.streamId, channel_user_id: r.channelUserId, ...details },
        });
    } catch { /* non-critical */ }
}

router.get('/queue', requireAuth, async (req, res) => {
    try {
        const r = await queueRoom(req, res);
        if (!r) return;
        res.json(audioQueue.list(r.room, { recent: req.query.recent }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queue/skip', requireAuth, async (req, res) => {
    try {
        const r = await queueRoom(req, res);
        if (!r) return;
        const id = parseInt(req.body && req.body.id, 10) || null;
        const skipped = audioQueue.skip(r.room, { id, actor: `user:${req.user.username}` });
        if (!skipped) return res.status(id ? 404 : 409).json({ error: id ? 'No such request waiting or playing' : 'Nothing to skip' });
        logQueueAction(req, r, 'tts_skip', { request_id: skipped.id, kind: skipped.kind });
        res.json({ skipped: { id: skipped.id, kind: skipped.kind, requested_by: skipped.requested_by }, queue: audioQueue.list(r.room) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queue/clear', requireAuth, async (req, res) => {
    try {
        const r = await queueRoom(req, res);
        if (!r) return;
        const ids = audioQueue.clear(r.room, { actor: `user:${req.user.username}` });
        if (ids.length) logQueueAction(req, r, 'tts_clear', { request_ids: ids });
        res.json({ cleared: ids, queue: audioQueue.list(r.room) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queue/:id/report', requireAuth, async (req, res) => {
    try {
        const r = await queueRoom(req, res);
        if (!r) return;
        const state = String((req.body && req.body.state) || '');
        if (state !== 'played' && state !== 'failed') return res.status(400).json({ error: "state must be 'played' or 'failed'" });
        const ok = audioQueue.report(r.room, parseInt(req.params.id, 10), state, { error: req.body && req.body.error, actor: `user:${req.user.username}` });
        if (!ok) return res.status(409).json({ error: 'That request is not playing' });
        res.json({ ok: true, queue: audioQueue.list(r.room) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cached one-off clips (admin tests, previews) — streamed same-origin so no blob:/data: is needed.
router.get('/audio/:file', async (req, res) => {
    try {
        const hit = cachedClip(req.params.file);
        if (hit) {
            res.set({ 'Content-Type': hit.mimeType, 'Cache-Control': 'private, max-age=86400' });
            return fs.createReadStream(hit.path).pipe(res);
        }
        // Not ours: Live's arena voice cache (mod voice previews, arena clips).
        const live = await ctx.fetchTtsAudio(path.basename(String(req.params.file || '')));
        if (!live) return res.status(404).json({ error: 'No such clip' });
        res.set({ 'Content-Type': live.mimeType, 'Cache-Control': 'private, max-age=86400' });
        res.end(live.body);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
