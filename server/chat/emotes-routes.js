/**
 * OpenVibe.Chat — Emote API (moved from OpenVibe.Live server/emotes/routes.js, plan T3 step 1)
 *
 * Same paths, bodies, responses, limits and error messages as Live's /api/emotes, so Live's
 * frontend (public/js/emotes.js, chat.js, channel-uploads.js, obs/chat.html) works unchanged once
 * nginx sends /api/emotes here. The rows live in Chat's own emotes table.
 *
 *   GET    /api/emotes/global          - Global custom emotes
 *   GET    /api/emotes/channel/:userId - Channel emotes for a streamer
 *   GET    /api/emotes/mine            - My emotes (auth required)
 *   POST   /api/emotes                 - Upload a custom emote (auth required)
 *   PATCH  /api/emotes/:id             - Rename / resize an emote (auth required)
 *   DELETE /api/emotes/:id             - Delete an emote (auth required)
 *   GET    /api/emotes/file/:filename  - Legacy image file (no local files: 404)
 *   GET    /api/emotes/{ffz,bttv,7tv}  - Cached provider proxies
 *   GET    /api/emotes/defaults        - Built-in emote collection
 *   GET/PUT /api/emotes/sources        - Per-channel emote source preferences (auth)
 *   GET    /api/emotes/search          - Search FFZ emotes
 *   GET    /api/emotes/all/:streamId   - All emotes available in a stream context
 *
 * Uploaded bytes go to OpenVibe.Media with Chat's own service token; the row stores media_url and
 * media_asset_id, and responses use media_url (existing Live rows already carry one). Chat is the
 * emotes table's only writer (C-04 done).
 */
'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../db/database');
const ctx = require('../live-context');
const config = require('../config');
const media = require('../media/client');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };
const ALLOWED_MIME = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif'];

/** The image type a buffer's first bytes say it is (PNG, GIF, WebP, JPEG, AVIF); null for anything else. */
function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('latin1', 8, 12))) return 'image/avif';
    return null;
}

// Bytes are held in memory only long enough to reach Media; nothing is written to Chat's disk.
const emoteUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.emotes.maxSizeKb * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
        cb(new Error('Only PNG, GIF, WebP, AVIF, and JPEG images are allowed'));
    },
});

// Per-user emote-upload rate limit (sliding window), Live's values: 40 uploads / 15 min per account.
const EMOTE_UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const EMOTE_UPLOAD_MAX = 40;
const _emoteUploadTimes = new Map();
function emoteUploadRateLimited(userId) {
    const now = Date.now();
    const arr = (_emoteUploadTimes.get(userId) || []).filter((t) => now - t < EMOTE_UPLOAD_WINDOW_MS);
    if (arr.length >= EMOTE_UPLOAD_MAX) { _emoteUploadTimes.set(userId, arr); return true; }
    arr.push(now);
    _emoteUploadTimes.set(userId, arr);
    return false;
}

const fileUrl = (e) => e.media_url || `/api/emotes/file/${path.basename(e.url)}`;

// ══════════════════════════════════════════════════════════════
//  FFZ / BTTV / 7TV CACHE
// ══════════════════════════════════════════════════════════════

let ffzCache = { data: null, ts: 0 };
let bttvCache = { data: null, ts: 0 };
let sevenTvCache = { data: null, ts: 0 };
const ffzSearchCache = new Map();

async function fetchJSON(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'OpenVibe.Chat/1.0 (emote-proxy)' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function parseFfzSets(data) {
    const emotes = [];
    const sets = data.sets || {};
    for (const setId of Object.keys(sets)) {
        const set = sets[setId];
        for (const e of (set.emoticons || [])) {
            if (e.hidden) continue;
            if (e.modifier) continue;
            emotes.push({
                id: `ffz-${e.id}`,
                code: e.name,
                url: e.urls['2'] || e.urls['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
                url_1x: e.urls['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
                url_2x: e.urls['2'] || e.urls['1'],
                url_4x: e.urls['4'] || e.urls['2'] || e.urls['1'],
                width: e.width || 28,
                height: e.height || 28,
                animated: false,
                source: 'ffz',
            });
        }
    }
    return emotes;
}

function parseBttvEmotes(data) {
    return (Array.isArray(data) ? data : []).map((e) => ({
        id: `bttv-${e.id}`,
        code: e.code,
        url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url_1x: `https://cdn.betterttv.net/emote/${e.id}/1x`,
        url_2x: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url_4x: `https://cdn.betterttv.net/emote/${e.id}/3x`,
        width: 28,
        height: 28,
        animated: e.imageType === 'gif' || e.animated === true,
        source: 'bttv',
    }));
}

function parse7tvEmotes(data) {
    const emotes = data?.emotes || [];
    return emotes.map((e) => {
        const host = e.data?.host;
        const baseUrl = host?.url || '';
        const files = host?.files || [];
        const f2x = files.find((f) => f.name === '2x.webp') || files.find((f) => f.name === '2x.avif') || files.find((f) => f.name === '1x.webp') || files[0];
        const f1x = files.find((f) => f.name === '1x.webp') || files.find((f) => f.name === '1x.avif') || files[0];
        const f4x = files.find((f) => f.name === '4x.webp') || files.find((f) => f.name === '3x.webp') || f2x;
        return {
            id: `7tv-${e.id}`,
            code: e.name,
            url: f2x ? `https:${baseUrl}/${f2x.name}` : '',
            url_1x: f1x ? `https:${baseUrl}/${f1x.name}` : '',
            url_2x: f2x ? `https:${baseUrl}/${f2x.name}` : '',
            url_4x: f4x ? `https:${baseUrl}/${f4x.name}` : '',
            width: f2x?.width || 28,
            height: f2x?.height || 28,
            animated: !!(e.data?.animated),
            source: '7tv',
        };
    }).filter((e) => e.url);
}

// Live's built-in emote collection (popular community emotes, provider CDN URLs).
const DEFAULT_EMOTES = [
    { id: 'def-lul',       code: 'LUL',       url: 'https://cdn.frankerfacez.com/emote/38010/2',   source: 'defaults', animated: false },
    { id: 'def-lulw',      code: 'LULW',      url: 'https://cdn.frankerfacez.com/emote/139407/2',  source: 'defaults', animated: false },
    { id: 'def-kekw',      code: 'KEKW',      url: 'https://cdn.frankerfacez.com/emote/381875/2',  source: 'defaults', animated: false },
    { id: 'def-omegalul',  code: 'OMEGALUL',  url: 'https://cdn.frankerfacez.com/emote/128054/2',  source: 'defaults', animated: false },
    { id: 'def-pepehands', code: 'PepeHands', url: 'https://cdn.frankerfacez.com/emote/231552/2',  source: 'defaults', animated: false },
    { id: 'def-copium',    code: 'Copium',    url: 'https://cdn.frankerfacez.com/emote/540942/2',  source: 'defaults', animated: false },
    { id: 'def-monkas',    code: 'monkaS',    url: 'https://cdn.frankerfacez.com/emote/130762/2',  source: 'defaults', animated: false },
    { id: 'def-ez',        code: 'EZ',        url: 'https://cdn.frankerfacez.com/emote/425688/2',  source: 'defaults', animated: false },
    { id: 'def-pog',       code: 'Pog',       url: 'https://cdn.frankerfacez.com/emote/210748/2',  source: 'defaults', animated: false },
    { id: 'def-poggers',   code: 'Poggers',   url: 'https://cdn.frankerfacez.com/emote/214681/2',  source: 'defaults', animated: false },
    { id: 'def-pogu',      code: 'PogU',      url: 'https://cdn.betterttv.net/emote/5e4e7a1f08b4447d56a92967/2x', source: 'defaults', animated: false },
    { id: 'def-peped',     code: 'PepeD',     url: 'https://cdn.betterttv.net/emote/5b1740221c5a6065a7bad4b5/2x', source: 'defaults', animated: true },
    { id: 'def-catjam',    code: 'catJAM',    url: 'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/2x', source: 'defaults', animated: true },
    { id: 'def-sadge',     code: 'Sadge',     url: 'https://cdn.betterttv.net/emote/5e0fa9d40550d42106b8a489/2x', source: 'defaults', animated: false },
    { id: 'def-pepega',    code: 'Pepega',    url: 'https://cdn.betterttv.net/emote/5aca62163e290877a25481ad/2x', source: 'defaults', animated: false },
    { id: 'def-5head',     code: '5Head',     url: 'https://cdn.betterttv.net/emote/5d6096974932b21d9c332904/2x', source: 'defaults', animated: false },
    { id: 'def-widehard',  code: 'widepeepohappy', url: 'https://cdn.betterttv.net/emote/5e1a76dd8af14b5f1b438c04/2x', source: 'defaults', animated: false },
    { id: 'def-monkaw',    code: 'monkaW',    url: 'https://cdn.betterttv.net/emote/59ca6551b27c823d5b1fd872/2x', source: 'defaults', animated: false },
    { id: 'def-pepelaugh', code: 'PepeLaugh', url: 'https://cdn.betterttv.net/emote/5c548025009a2e73916b3a37/2x', source: 'defaults', animated: false },
    { id: 'def-modtime',   code: 'modCheck',  url: 'https://cdn.betterttv.net/emote/5d7eefb7c0652668c9e4d394/2x', source: 'defaults', animated: true },
    { id: 'def-clap',      code: 'CLAP',      url: 'https://cdn.betterttv.net/emote/55b6f480e66682f576dd94f5/2x', source: 'defaults', animated: false },
    { id: 'def-gg',        code: 'GGEZ',      url: 'https://cdn.frankerfacez.com/emote/703645/2',  source: 'defaults', animated: false },
    { id: 'def-based',     code: 'BASED',     url: 'https://cdn.frankerfacez.com/emote/768564/2',  source: 'defaults', animated: false },
    { id: 'def-peepo',     code: 'peepoHappy', url: 'https://cdn.betterttv.net/emote/5a16ee718c22a247ead62d4a/2x', source: 'defaults', animated: false },
    { id: 'def-mods',      code: 'MODS',      url: 'https://cdn.betterttv.net/emote/603451b77c74605395f3295d/2x', source: 'defaults', animated: true },
].map((e) => ({ ...e, width: 28, height: 28 }));

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/global', async (req, res) => {
    try {
        const emotes = (await db.getGlobalEmotes()).map((e) => ({
            id: `custom-${e.id}`,
            code: e.code,
            url: fileUrl(e),
            animated: !!e.animated,
            width: e.width,
            height: e.height,
            source: 'custom',
            owner: e.username,
        }));
        res.json({ emotes });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load global emotes' });
    }
});

router.get('/channel/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const emotes = (await db.getChannelEmotes(userId)).map((e) => ({
            id: `custom-${e.id}`,
            emote_id: e.id,
            code: e.code,
            url: fileUrl(e),
            animated: !!e.animated,
            width: e.width,
            height: e.height,
            source: 'channel',
            owner: e.username,
            uploader: e.uploader_display_name || e.uploader_username || e.username,
            uploader_id: e.user_id,
        }));
        res.json({ emotes });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel emotes' });
    }
});

router.get('/mine', requireAuth, async (req, res) => {
    try {
        const emotes = (await db.getEmotesByUser(req.user.id)).map((e) => ({
            id: e.id,
            code: e.code,
            url: fileUrl(e),
            animated: !!e.animated,
            width: e.width,
            height: e.height,
            is_global: !!e.is_global,
            created_at: e.created_at,
        }));
        res.json({ emotes, count: await db.countChannelEmotes(req.user.id), max: config.emotes.maxPerChannel });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emotes' });
    }
});

router.post('/', requireAuth, emoteUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

        if (emoteUploadRateLimited(req.user.id)) {
            return res.status(429).json({ error: 'Too many emote uploads — please wait a bit before uploading more.' });
        }

        const code = (req.body.code || '').trim();
        if (!code || code.length < 2 || code.length > 32) {
            return res.status(400).json({ error: 'Emote code must be 2-32 characters' });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(code)) {
            return res.status(400).json({ error: 'Emote code can only contain letters, numbers, and underscores' });
        }

        // Optional target channel: channel_id = the streamer's user id; stream_id resolves to its owner.
        let channelOwnerId = parseInt(req.body.channel_id) || null;
        if (!channelOwnerId && req.body.stream_id) {
            channelOwnerId = (await ctx.ensureStream(parseInt(req.body.stream_id)))?.user_id || null;
        }
        const isChannelUpload = channelOwnerId && channelOwnerId !== req.user.id;

        if (isChannelUpload) {
            const channel = await ctx.ensureChannelForUser(channelOwnerId);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
            await ctx.ensurePolicy(channel.id);
            const settings = await ctx.getChannelModerationSettings(channel.id);
            const isMod = await permissions.canModerateChannel(req.user, channel.id);
            if (!settings.custom_emotes_enabled && !isMod) {
                return res.status(403).json({ error: 'This streamer has disabled viewer emote uploads.' });
            }
            if (settings.uploads_mods_only && !isMod) {
                return res.status(403).json({ error: 'Only channel mods can upload emotes here.' });
            }
            if (await db.countChannelEmotes(channelOwnerId) >= config.emotes.maxPerChannel) {
                return res.status(400).json({ error: `This channel is full (${config.emotes.maxPerChannel} emotes max) — the streamer needs to remove some first.` });
            }
            if (await db.getChannelEmoteByCode(channelOwnerId, code)) {
                return res.status(409).json({ error: `This channel already has an emote named "${code}".` });
            }
        } else {
            if (await db.countChannelEmotes(req.user.id) >= config.emotes.maxPerChannel) {
                return res.status(400).json({ error: `Your channel is full (${config.emotes.maxPerChannel} emotes max) — remove some to add more.` });
            }
            const existing = await db.get('SELECT id FROM emotes WHERE user_id = ? AND code = ? AND channel_owner_id IS NULL', [req.user.id, code]);
            if (existing) return res.status(409).json({ error: `You already have an emote named "${code}"` });
        }

        // The declared type must match the bytes: Media serves the object with this type.
        if (sniffImage(req.file.buffer) !== req.file.mimetype) return res.status(400).json({ error: 'That file is not the image type it claims to be' });
        const animated = req.file.mimetype === 'image/gif' || req.file.mimetype === 'image/webp';
        const isGlobal = req.body.is_global === 'true' && permissions.can(req.user, 'staff.assets.manage');

        let sizeMin = 25, sizeMax = 400;
        if (channelOwnerId) {
            const channel = await ctx.ensureChannelForUser(channelOwnerId);
            const st = channel ? await ctx.getChannelModerationSettings(channel.id) : null;
            if (st) { sizeMin = st.emote_size_min || 50; sizeMax = st.emote_size_max || 200; }
        }
        const size = Math.min(sizeMax, Math.max(sizeMin, parseInt(req.body.size) || 100));

        const uploaded = await media.uploadObject(req.file.buffer, { filename: req.file.originalname, mimeType: req.file.mimetype });
        const result = await db.createEmote({
            user_id: req.user.id,
            code,
            url: uploaded.url,
            animated,
            width: parseInt(req.body.width) || 28,
            height: parseInt(req.body.height) || 28,
            is_global: isGlobal,
            channel_owner_id: isChannelUpload ? channelOwnerId : null,
            size,
            media_url: uploaded.url,
            media_asset_id: uploaded.id,
        });

        if (isChannelUpload) {
            try { await require('./chat-server').broadcastToOwnerStreams(channelOwnerId, { type: 'emotes-updated' }); } catch { /* */ }
        }
        res.json({
            emote: {
                id: result.value.lastInsertRowid,
                code,
                url: uploaded.url,
                animated,
                channel_id: isChannelUpload ? channelOwnerId : undefined,
            },
        });
    } catch (err) {
        console.error('[Emotes] Upload error:', err);
        if (err && /UNIQUE constraint/i.test(err.message || '')) {
            const code = String((req.body && req.body.code) || '').trim();
            return res.status(409).json({ error: `This channel already has an emote named "${code}" — pick a different code for this channel.` });
        }
        res.status(500).json({ error: 'Failed to upload emote' });
    }
});

// Multer error handler (Live's status codes and messages).
router.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large (max ${config.emotes.maxSizeKb}KB)` });
    }
    if (err.message && err.message.includes('Only')) {
        return res.status(400).json({ error: err.message });
    }
    console.error('[Emotes] Middleware error:', err);
    res.status(500).json({ error: 'Emote upload failed' });
});

router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const emote = await db.getEmoteById(req.params.id);
        if (!emote) return res.status(404).json({ error: 'Emote not found' });
        let allowed = emote.user_id === req.user.id || permissions.can(req.user, 'staff.assets.manage');
        if (!allowed) {
            const ownerId = emote.channel_owner_id || emote.user_id;
            const channel = await ctx.ensureChannelForUser(ownerId);
            if (channel && await permissions.canModerateChannel(req.user, channel.id)) allowed = true;
        }
        if (!allowed) return res.status(403).json({ error: 'Not your emote' });

        const patch = {};
        if (req.body.code !== undefined) {
            const code = String(req.body.code || '').trim();
            if (!code || code.length < 2 || code.length > 32) {
                return res.status(400).json({ error: 'Emote code must be 2-32 characters' });
            }
            if (!/^[a-zA-Z0-9_]+$/.test(code)) {
                return res.status(400).json({ error: 'Emote code can only contain letters, numbers, and underscores' });
            }
            const scopeOwner = emote.channel_owner_id || emote.user_id;
            const clash = (await db.getChannelEmotes(scopeOwner) || [])
                .find((e) => e.id !== emote.id && String(e.code).toLowerCase() === code.toLowerCase());
            if (clash) return res.status(409).json({ error: `An emote named "${clash.code}" already exists in this channel.` });
            patch.code = code;
        }
        if (req.body.size !== undefined) {
            let sizeMin = 25, sizeMax = 400;
            const ownerId = emote.channel_owner_id || emote.user_id;
            const channel = await ctx.ensureChannelForUser(ownerId);
            const st = channel ? await ctx.getChannelModerationSettings(channel.id) : null;
            if (st) { sizeMin = st.emote_size_min || 50; sizeMax = st.emote_size_max || 200; }
            patch.size = Math.min(sizeMax, Math.max(sizeMin, parseInt(req.body.size) || 100));
        }
        if (patch.code === undefined && patch.size === undefined) {
            return res.status(400).json({ error: 'Nothing to change' });
        }

        await db.updateEmote(emote.id, patch);
        if (patch.code && patch.code !== emote.code) {
            try { await db.updateChannelSoundEmoteRefs(emote.channel_owner_id || emote.user_id, emote.code, patch.code); } catch { /* */ }
        }
        if (emote.channel_owner_id) {
            try { await require('./chat-server').broadcastToOwnerStreams(emote.channel_owner_id, { type: 'emotes-updated' }); } catch { /* */ }
        }
        res.json({ message: 'Emote updated', code: patch.code ?? emote.code, size: patch.size ?? emote.size });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update emote' });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const emote = await db.getEmoteById(req.params.id);
        if (!emote) return res.status(404).json({ error: 'Emote not found' });
        let allowed = emote.user_id === req.user.id || permissions.can(req.user, 'staff.assets.manage');
        if (!allowed) {
            const ownerId = emote.channel_owner_id || emote.user_id;
            const channel = await ctx.ensureChannelForUser(ownerId);
            if (channel && await permissions.canModerateChannel(req.user, channel.id)) allowed = true;
        }
        if (!allowed) return res.status(403).json({ error: 'Not your emote' });

        await db.deleteEmote(emote.id);
        await media.deleteObject(emote.media_asset_id);
        if (emote.channel_owner_id) {
            try { await require('./chat-server').broadcastToOwnerStreams(emote.channel_owner_id, { type: 'emotes-updated' }); } catch { /* */ }
        }
        res.json({ message: 'Emote deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete emote' });
    }
});

// Legacy image files: Chat keeps none. Bytes live on OpenVibe.Media now; a row that still lacks a
// media_url has no file here either, so this answers 404 for everything (Live's frontend only uses
// this path for rows without media_url, which are served from the provider/Media URLs instead).
router.get('/file/:filename', (req, res) => {
    res.status(404).json({ error: 'Emote file not found' });
});

// ── FFZ / BTTV / 7TV (cached proxies) ────────────────────────
router.get('/ffz', async (req, res) => {
    try {
        const now = Date.now();
        if (ffzCache.data && (now - ffzCache.ts) < config.emotes.ffzCacheTtl * 1000) {
            return res.json({ emotes: ffzCache.data, cached: true });
        }
        const data = await fetchJSON('https://api.frankerfacez.com/v1/set/global');
        const emotes = parseFfzSets(data);
        ffzCache = { data: emotes, ts: now };
        res.json({ emotes, cached: false });
    } catch (err) {
        if (ffzCache.data) return res.json({ emotes: ffzCache.data, cached: true, stale: true });
        res.status(502).json({ error: 'Failed to fetch FFZ emotes', emotes: [] });
    }
});

router.get('/bttv', async (req, res) => {
    try {
        const now = Date.now();
        if (bttvCache.data && (now - bttvCache.ts) < config.emotes.bttvCacheTtl * 1000) {
            return res.json({ emotes: bttvCache.data, cached: true });
        }
        const data = await fetchJSON('https://api.betterttv.net/3/cached/emotes/global');
        const emotes = parseBttvEmotes(data);
        bttvCache = { data: emotes, ts: now };
        res.json({ emotes, cached: false });
    } catch (err) {
        if (bttvCache.data) return res.json({ emotes: bttvCache.data, cached: true, stale: true });
        res.status(502).json({ error: 'Failed to fetch BTTV emotes', emotes: [] });
    }
});

router.get('/7tv', async (req, res) => {
    try {
        const now = Date.now();
        if (sevenTvCache.data && (now - sevenTvCache.ts) < config.emotes.sevenTvCacheTtl * 1000) {
            return res.json({ emotes: sevenTvCache.data, cached: true });
        }
        const data = await fetchJSON('https://7tv.io/v3/emote-sets/global');
        const emotes = parse7tvEmotes(data);
        sevenTvCache = { data: emotes, ts: now };
        res.json({ emotes, cached: false });
    } catch (err) {
        if (sevenTvCache.data) return res.json({ emotes: sevenTvCache.data, cached: true, stale: true });
        res.status(502).json({ error: 'Failed to fetch 7TV emotes', emotes: [] });
    }
});

router.get('/defaults', (req, res) => {
    res.json({ emotes: DEFAULT_EMOTES });
});

// ── Emote source preferences (stored on Live's channels row) ──
router.get('/sources', requireAuth, async (req, res) => {
    try {
        const channel = await ctx.ensureChannelForUser(req.user.id);
        res.json({ sources: ctx.emoteSources(channel && channel.emote_sources) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emote sources' });
    }
});

router.put('/sources', requireAuth, async (req, res) => {
    try {
        const sources = {};
        for (const key of ['defaults', 'custom', 'ffz', 'bttv', '7tv']) {
            sources[key] = req.body[key] !== false && req.body[key] !== 'false';
        }
        await ctx.setChannelEmoteSources(req.user.id, sources);
        res.json({ sources, message: 'Emote sources updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update emote sources' });
    }
});

// ── Search FFZ emotes ────────────────────────────────────────
router.get('/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) return res.json({ emotes: [] });

        const cacheKey = q.toLowerCase();
        const cached = ffzSearchCache.get(cacheKey);
        const now = Date.now();
        if (cached && (now - cached.ts) < config.emotes.ffzCacheTtl * 1000) {
            return res.json({ emotes: cached.data, cached: true });
        }

        const data = await fetchJSON(`https://api.frankerfacez.com/v1/emotes?q=${encodeURIComponent(q)}&per_page=50&sort=count-desc`);
        const emotes = (data.emoticons || []).filter((e) => !e.hidden && !e.modifier).map((e) => ({
            id: `ffz-${e.id}`,
            code: e.name,
            url: e.urls?.['2'] || e.urls?.['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
            url_1x: e.urls?.['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
            url_2x: e.urls?.['2'] || e.urls?.['1'],
            animated: false,
            source: 'ffz',
            usage_count: e.usage_count || 0,
        }));

        ffzSearchCache.set(cacheKey, { data: emotes, ts: now });
        if (ffzSearchCache.size > 200) {
            const oldest = [...ffzSearchCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
            for (const [key] of oldest) ffzSearchCache.delete(key);
        }
        res.json({ emotes, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'Search failed', emotes: [] });
    }
});

// ── All emotes for a stream context ──────────────────────────
router.get('/all/:streamId', optionalAuth, async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = streamId ? await ctx.ensureStream(streamId) : null;
        let streamUserId = stream ? stream.user_id : null;
        if (!streamUserId && req.query.channel) {
            try { const u = await ctx.ensureUserByUsername(String(req.query.channel)); if (u) streamUserId = u.id; } catch { /* */ }
        }

        let sources = { defaults: true, custom: true, ffz: true, bttv: true, '7tv': true };
        let channel = null;
        if (streamUserId) {
            channel = await ctx.ensureChannelForUser(streamUserId);
            if (channel && channel.emote_sources) sources = ctx.emoteSources(channel.emote_sources);
        }

        const defaults = sources.defaults !== false ? DEFAULT_EMOTES : [];

        let globalCustom = [];
        let channelEmotes = [];
        if (sources.custom !== false) {
            globalCustom = (await db.getGlobalEmotes()).map((e) => ({
                id: `custom-${e.id}`,
                code: e.code,
                url: fileUrl(e),
                animated: !!e.animated,
                width: e.width,
                height: e.height,
                size: e.size || 100,
                source: 'custom',
                owner: e.username,
            }));

            if (streamUserId) {
                channelEmotes = (await db.getChannelEmotes(streamUserId)).filter((e) => !e.is_global).map((e) => ({
                    id: `custom-${e.id}`,
                    emote_id: e.id,
                    code: e.code,
                    url: fileUrl(e),
                    animated: !!e.animated,
                    width: e.width,
                    height: e.height,
                    size: e.size || 100,
                    source: 'channel',
                    owner: e.username,
                    uploader: e.uploader_display_name || e.uploader_username || e.username,
                    uploader_id: e.user_id,
                }));
            }
        }

        let ffzEmotes = [];
        if (sources.ffz !== false) {
            ffzEmotes = ffzCache.data || [];
            if (!ffzEmotes.length) {
                try {
                    const data = await fetchJSON('https://api.frankerfacez.com/v1/set/global');
                    ffzEmotes = parseFfzSets(data);
                    ffzCache = { data: ffzEmotes, ts: Date.now() };
                } catch { /* use empty */ }
            }
        }

        let bttvEmotes = [];
        if (sources.bttv !== false) {
            bttvEmotes = bttvCache.data || [];
            if (!bttvEmotes.length) {
                try {
                    const data = await fetchJSON('https://api.betterttv.net/3/cached/emotes/global');
                    bttvEmotes = parseBttvEmotes(data);
                    bttvCache = { data: bttvEmotes, ts: Date.now() };
                } catch { /* use empty */ }
            }
        }

        let sevenTvEmotes = [];
        if (sources['7tv'] !== false) {
            sevenTvEmotes = sevenTvCache.data || [];
            if (!sevenTvEmotes.length) {
                try {
                    const data = await fetchJSON('https://7tv.io/v3/emote-sets/global');
                    sevenTvEmotes = parse7tvEmotes(data);
                    sevenTvCache = { data: sevenTvEmotes, ts: Date.now() };
                } catch { /* use empty */ }
            }
        }

        let emoteScale = 100;
        if (channel) {
            const st = await ctx.getChannelModerationSettings(channel.id);
            if (st && st.emote_scale) emoteScale = Number(st.emote_scale) || 100;
        }

        res.json({
            defaults,
            channel: channelEmotes,
            global: globalCustom,
            ffz: ffzEmotes,
            bttv: bttvEmotes,
            '7tv': sevenTvEmotes,
            sources,
            emote_scale: emoteScale,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emotes' });
    }
});

module.exports = router;
