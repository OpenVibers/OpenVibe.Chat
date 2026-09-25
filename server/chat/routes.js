/**
 * OpenVibe.Chat — Chat API Routes (moved from OpenVibe.Live server/chat/routes.js, W6)
 *
 * Same paths, bodies and responses as Live's /api/chat. Messages are Chat's; authors, streams,
 * slots, cosmetics, tags, settings and profile cards are Live's and come through live-context.
 * 
 * POST /api/chat/send                  - Post a message to global chat (bots; API tokens need the chat scope)
 * GET  /api/chat/:streamId/history   - Get chat history for a stream
 * GET  /api/chat/:streamId/users     - Get users in chat
 * GET  /api/chat/search              - Search chat messages
 * GET  /api/chat/user/:userId/history - Get a user's chat history
 * GET  /api/chat/user/:username/profile - Get user profile card data
 */
const express = require('express');
const db = require('../db/database');
const ctx = require('../live-context');
const { optionalAuth, requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const historyStore = require('./history-store');

const router = express.Router();

// ── Staff reading other people's logs is audited (WS-I task 7) ───────────────
// A staff member viewing, searching or exporting someone else's chat logs is recorded like any other
// moderation action (moderation_actions → chat.moderation.action → the network audit log, ADR-022).
// A person reading their own lines, or a streamer their own stream's, is not.
function auditLogAccess(req, action_type, { scope_type = 'site', scope_id = null, target_user_id = null, details = {} } = {}) {
    try {
        db.logModerationAction({ scope_type, scope_id, actor_user_id: req.user.id, target_user_id, action_type, details });
    } catch (err) {
        console.warn('[Chat] log access audit failed:', err.message);
    }
}
// A CSV cell: quoted when needed, and text (not a formula) when it starts with = + - @ in a spreadsheet.
function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}


// Chat-internal columns (the author's Network subject) are not part of Live's API.
function publicRows(rows) {
    if (Array.isArray(rows)) for (const r of rows) { if (r) delete r.subject_id; }
    return rows;
}

/** Load the cosmetics/tags of every author in these rows (one batched call for the misses). */
async function loadDecor(rows) {
    const ids = (rows || []).map((m) => m && m.user_id).filter(Boolean);
    if (ids.length) { try { await ctx.ensureDecor(ids); } catch { /* history still renders */ } }
}

/**
 * Attach each author's CURRENT cosmetics (name/particle/hat effects) + tag to
 * history rows, so historical messages render with the same effects as live ones
 * (chat_messages doesn't persist cosmetics). Cached per user_id within the batch.
 */
function enrichMessagesWithCosmetics(messages) {
    // Live's monetization/cosmetics + game/tags, through live-context (see loadDecor).
    const cosmetics = { getCosmeticProfile: (id) => ctx.getCosmeticProfile(id) };
    const tags = { getTagProfile: (id) => ctx.getTagProfile(id) };
    if (!Array.isArray(messages)) return messages;
    const cache = new Map();
    for (const m of messages) {
        if (!m || !m.user_id) continue;
        let prof = cache.get(m.user_id);
        if (!prof) {
            prof = {};
            try { if (cosmetics) Object.assign(prof, cosmetics.getCosmeticProfile(m.user_id) || {}); } catch { /* */ }
            try { if (tags) prof.tag = tags.getTagProfile(m.user_id) || null; } catch { /* */ }
            cache.set(m.user_id, prof);
        }
        if (prof.nameFX) m.nameFX = prof.nameFX;
        if (prof.particleFX) m.particleFX = prof.particleFX;
        if (prof.hatFX) m.hatFX = prof.hatFX;
        if (prof.tag) m.tag = prof.tag;
    }
    return messages;
}

const MIN_SELF_DELETE_MINUTES = 3;
const MAX_SELF_DELETE_MINUTES = 10080;
const GIF_ALLOWED_PROVIDERS = new Set(['tenor', 'giphy']);

function getGifProviderConfig(provider) {
    if (provider === 'giphy') {
        return {
            key: ctx.getSetting('gif_giphy_api_key') || '',
            trendingUrl: 'https://api.giphy.com/v1/gifs/trending',
            searchUrl: 'https://api.giphy.com/v1/gifs/search',
        };
    }
    return {
        key: ctx.getSetting('gif_tenor_api_key') || '',
        trendingUrl: 'https://tenor.googleapis.com/v2/featured',
        searchUrl: 'https://tenor.googleapis.com/v2/search',
    };
}

function normalizeGifProvider(provider) {
    const normalized = String(provider || 'tenor').trim().toLowerCase();
    return GIF_ALLOWED_PROVIDERS.has(normalized) ? normalized : 'tenor';
}

function mapGifResults(provider, payload) {
    if (provider === 'giphy') {
        const items = Array.isArray(payload?.data) ? payload.data : [];
        return items.map((item) => {
            const tiny = item?.images?.fixed_width_small?.url || item?.images?.preview_gif?.url || item?.images?.fixed_width?.url || '';
            const full = item?.images?.original?.url || item?.images?.fixed_width?.url || tiny;
            return {
                id: item?.id || null,
                preview_url: tiny,
                full_url: full,
                title: item?.title || item?.slug || 'GIF',
                provider: 'giphy',
                source_url: item?.url || full,
            };
        }).filter((item) => item.preview_url && item.full_url);
    }

    const items = Array.isArray(payload?.results) ? payload.results : [];
    return items.map((item) => {
        const tiny = item?.media_formats?.tinygif?.url || item?.media_formats?.gif?.url || '';
        const full = item?.media_formats?.gif?.url || tiny;
        return {
            id: item?.id || null,
            preview_url: tiny,
            full_url: full,
            title: item?.content_description || item?.title || 'GIF',
            provider: 'tenor',
            source_url: item?.itemurl || full,
        };
    }).filter((item) => item.preview_url && item.full_url);
}

function normalizeAutoDeleteMinutes(value) {
    const mins = parseInt(value, 10);
    if (!Number.isFinite(mins) || mins < MIN_SELF_DELETE_MINUTES) return 0;
    return Math.min(MAX_SELF_DELETE_MINUTES, mins);
}

router.get('/gif/providers', optionalAuth, async (req, res) => {
    await ctx.ensureSettings();
    res.json({
        providers: {
            tenor: !!ctx.getSetting('gif_tenor_api_key'),
            giphy: !!ctx.getSetting('gif_giphy_api_key'),
        },
        defaultProvider: ctx.getSetting('gif_tenor_api_key') ? 'tenor' : (ctx.getSetting('gif_giphy_api_key') ? 'giphy' : null),
    });
});

router.get('/gif/trending', optionalAuth, async (req, res) => {
    try {
        const provider = normalizeGifProvider(req.query.provider);
        await ctx.ensureSettings();
        const config = getGifProviderConfig(provider);
        if (!config.key) return res.status(503).json({ error: `${provider} API key not configured` });

        const url = new URL(config.trendingUrl);
        if (provider === 'giphy') {
            url.searchParams.set('api_key', config.key);
            url.searchParams.set('limit', '30');
            url.searchParams.set('rating', 'pg-13');
        } else {
            url.searchParams.set('key', config.key);
            url.searchParams.set('limit', '30');
            url.searchParams.set('media_filter', 'tinygif,gif');
        }

        const upstream = await fetch(url, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } });
        if (!upstream.ok) return res.status(502).json({ error: `GIF provider request failed (${upstream.status})` });
        const payload = await upstream.json();
        res.json({ provider, results: mapGifResults(provider, payload) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load GIFs' });
    }
});

router.get('/gif/search', optionalAuth, async (req, res) => {
    try {
        const provider = normalizeGifProvider(req.query.provider);
        const query = String(req.query.q || '').trim();
        if (query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

        await ctx.ensureSettings();
        const config = getGifProviderConfig(provider);
        if (!config.key) return res.status(503).json({ error: `${provider} API key not configured` });

        const url = new URL(config.searchUrl);
        if (provider === 'giphy') {
            url.searchParams.set('api_key', config.key);
            url.searchParams.set('q', query);
            url.searchParams.set('limit', '30');
            url.searchParams.set('rating', 'pg-13');
        } else {
            url.searchParams.set('key', config.key);
            url.searchParams.set('q', query);
            url.searchParams.set('limit', '30');
            url.searchParams.set('media_filter', 'tinygif,gif');
        }

        const upstream = await fetch(url, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } });
        if (!upstream.ok) return res.status(502).json({ error: `GIF provider request failed (${upstream.status})` });
        const payload = await upstream.json();
        res.json({ provider, results: mapGifResults(provider, payload) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to search GIFs' });
    }
});

/**
 * Hydrate reply_to context onto an array of message rows.
 * Each row must have reply_to_id (from DB). Adds a reply_to object
 * with { id, username, user_id, message } for the parent message.
 */
function hydrateReplies(messages) {
    const replyIds = [...new Set(messages.map(m => m.reply_to_id).filter(Boolean))];
    if (!replyIds.length) return messages;
    const placeholders = replyIds.map(() => '?').join(',');
    const parents = db.all(
        `SELECT id, username, user_id, message
         FROM chat_messages
         WHERE id IN (${placeholders})
           AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`,
        replyIds
    );
    const parentMap = new Map(parents.map(p => [p.id, p]));
    return messages.map(m => {
        if (m.reply_to_id && parentMap.has(m.reply_to_id)) {
            const p = parentMap.get(m.reply_to_id);
            m.reply_to = {
                id: p.id,
                username: p.username,
                user_id: p.user_id,
                message: p.message.length > 100 ? p.message.slice(0, 100) + '…' : p.message,
            };
        }
        return m;
    });
}

// ── Post to global chat over REST (bots; the browser never falls back to it: C-06) ──
router.post('/send', requireAuth, async (req, res) => {
    try {
        const text = (req.body.message || '').trim();
        // 6000 = the absolute ceiling any channel/admin can configure (see chat-server handleChatMessage).
        if (!text || text.length > 6000) {
            return res.status(400).json({ error: 'Invalid message' });
        }

        // Ban check
        if (ctx.isUserBanned(req.user.id, null)) {
            return res.status(403).json({ error: 'You are banned from chat' });
        }

        const chatServer = require('./chat-server');
        try { await ctx.ensureDecor([req.user.id]); } catch { /* non-critical */ }

        // Word filter
        const wordFilter = require('./word-filter');
        const filterResult = wordFilter.check(text);
        const filtered = filterResult.safe ? text : filterResult.filtered;

        if (wordFilter.isSpam(filtered)) {
            return res.status(400).json({ error: 'Message blocked: detected as spam' });
        }

        const username = req.user.display_name || req.user.username;
        const autoDeleteMinutes = normalizeAutoDeleteMinutes(req.body.auto_delete_minutes);
        const autoDeleteAt = autoDeleteMinutes
            ? new Date(Date.now() + autoDeleteMinutes * 60 * 1000).toISOString()
            : null;

        // Reply-to support
        const replyToId = req.body.reply_to_id ? parseInt(req.body.reply_to_id) : null;
        let replyTo = null;
        if (replyToId) {
            const parent = db.getChatMessageById(replyToId);
            if (parent && !parent.is_deleted) {
                replyTo = {
                    id: parent.id,
                    username: parent.username,
                    user_id: parent.user_id,
                    message: parent.message.length > 100 ? parent.message.slice(0, 100) + '…' : parent.message,
                };
            }
        }

        const chatMsg = {
            type: 'chat',
            username,
            core_username: req.user.username,
            user_id: req.user.id,
            anon_id: null,
            role: req.user.role || 'user',
            message: filtered,
            stream_id: null,
            is_global: true,
            avatar_url: req.user.avatar_url || null,
            profile_color: req.user.profile_color || '#999',
            filtered: !filterResult.safe,
            timestamp: new Date().toISOString(),
            auto_delete_at: autoDeleteAt,
        };

        // Attach cosmetics: Live's REST fallback required '../game/cosmetics', a module Live does
        // not have, so it never attached any — kept that way (the WebSocket path does attach them).

        // Attach tag
        try {
            const tagProfile = ctx.getTagProfile(req.user.id);
            if (tagProfile) chatMsg.tag = tagProfile;
        } catch { /* non-critical */ }

        // Save to database
        let savedId = null;
        try {
            const result = db.saveChatMessage({
                stream_id: null,
                user_id: req.user.id,
                anon_id: null,
                username,
                message: filtered,
                message_type: 'chat',
                is_global: true,
                reply_to_id: replyToId,
                auto_delete_at: autoDeleteAt,
            });
            savedId = result.lastInsertRowid;
        } catch { /* non-critical */ }

        // Attach message ID and reply context to broadcast
        if (savedId) chatMsg.id = Number(savedId);
        if (replyTo) chatMsg.reply_to = replyTo;

        // Broadcast to all global chat clients
        chatServer.broadcastGlobal(chatMsg);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Chat] REST send error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ── Search Chat Messages (admin or self) ─────────────────────
router.get('/search', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');
        const query = req.query.q || '';
        const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
        const streamId = req.query.stream_id ? parseInt(req.query.stream_id) : null;

        // Admin / global_mod can search anyone; others search only their own
        const effectiveUserId = permissions.canViewOtherUserLogs(req.user) ? userId : req.user.id;

        const result = db.searchChatMessages({
            query, userId: effectiveUserId, streamId, limit, offset,
        });
        if (effectiveUserId !== req.user.id) {
            auditLogAccess(req, 'chat_log_search', { scope_type: streamId ? 'stream' : 'site', scope_id: streamId, target_user_id: effectiveUserId,
                details: { query: String(query).slice(0, 100), results: result.messages.length } });
        }
        publicRows(result.messages);

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// ── User Chat History ────────────────────────────────────────
router.get('/user/:userId/history', requireAuth, (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const offset = parseInt(req.query.offset || '0');

        // Admin / global_mod can view anyone; others view only their own
        if (!permissions.canViewOtherUserLogs(req.user) && req.user.id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = db.getUserChatHistory(userId, limit, offset);
        if (userId !== req.user.id && offset === 0) auditLogAccess(req, 'chat_log_view', { target_user_id: userId, details: { total: result.total } });
        publicRows(result.messages);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// ── User Profile Card ────────────────────────────────────────
router.get('/user/:username/profile', optionalAuth, async (req, res) => {
    // The profile card is all Live data (account, coins, game stats): Live builds it with the
    // same rules (private fields only for the user themselves).
    try {
        const profile = await ctx.effects.userProfile(req.params.username, req.user ? req.user.id : null);
        res.json(profile);
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message || 'User not found' });
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// ── Chat-relay (external) user info: join date (first message) etc. ──
router.get('/relay-user/:platform/:username', optionalAuth, (req, res) => {
    try {
        const r = db.getRelayUser(req.params.platform, req.params.username);
        res.json({ relayUser: r || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get relay user' });
    }
});

// Anonymous chatter info: first-seen (anon-number assignment) + first chat + count.
router.get('/anon/:anonId', optionalAuth, async (req, res) => {
    try {
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        // When the number was assigned is Live's (anon_ip_mappings); the chat counts are ours.
        const num = db.anonSubjectId(anonId);
        const firstSeen = num ? await ctx.anonFirstSeenByNum(num) : null;
        res.json({ anon: db.getAnonMeta(anonId, firstSeen) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get anon info' });
    }
});

// An anonymous chatter's chat-message history — same gate as native logs.
router.get('/anon/:anonId/logs', requireAuth, (req, res) => {
    try {
        if (!permissions.canViewOtherUserLogs(req.user)) return res.status(403).json({ error: 'Not authorized' });
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const query = String(req.query.q || '').trim();
        const r = db.getAnonChatHistory(anonId, { limit, offset, query });
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get anon user logs' });
    }
});

// A relay (external-platform) user's chat-message history — same gate as native logs.
router.get('/relay-user/:platform/:username/logs', requireAuth, (req, res) => {
    try {
        if (!permissions.canViewOtherUserLogs(req.user)) return res.status(403).json({ error: 'Not authorized' });
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const query = String(req.query.q || '').trim();
        const r = db.getRelayUserChatHistory(req.params.platform, req.params.username, { limit, offset, query });
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get relay user logs' });
    }
});

// ── Global Chat History (all streams) ────────────────────────
// Patterns behind the viewer-side "Friendly global chat" setting (server/chat/moderation-utils.js is
// the single source; the client compiles these).
router.get('/filters/friendly', (req, res) => {
    const { FRIENDLY_FILTER_CATEGORIES } = require('./moderation-utils');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ version: 1, categories: FRIENDLY_FILTER_CATEGORIES.map(({ key, label, patterns }) => ({ key, label, patterns })) });
});

router.get('/global/history', optionalAuth, async (req, res) => {
    try {
        const limit = req.query.limit;
        const before = req.query.before;
        const afterId = req.query.after_id;
        const channelUsername = String(req.query.username || '').trim();
        // after_id = cursor read: only what the caller has not seen (oldest→newest, PK range scan).
        // Anything else = a page: the newest rows, optionally before a timestamp.
        const out = afterId != null
            ? historyStore.delta('global', { afterId, limit, channelUsername })
            : historyStore.page('global', { limit, before, channelUsername });
        await loadDecor(out.messages);
        out.messages = publicRows(enrichMessagesWithCosmetics(hydrateReplies(out.messages.map((x) => ({ ...x })))));
        res.json(out);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get global chat history' });
    }
});

// ── Chat Replay (for VOD/clip playback sync) ────────────────
router.get('/:streamId/replay', optionalAuth, (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        if (!streamId) return res.status(400).json({ error: 'Invalid stream ID' });

        const from = req.query.from || null;  // ISO timestamp
        const to = req.query.to || null;      // ISO timestamp

        const messages = publicRows(db.getChatReplay(streamId, from, to));
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat replay' });
    }
});

// ── Chat History ─────────────────────────────────────────────
// Loads history for a streamer's chat. By default this spans ALL of that
// broadcaster's stream sessions (not just the one slot/session being viewed),
// so viewers keep context when a stream restarts or the streamer runs multiple
// slots. Each message carries its source stream (title/slug/live) so the client
// can label it and let viewers hop between the streamer's live slots.
// Pass ?scope=stream to restrict to the single session (legacy behavior).
router.get('/:streamId/history', optionalAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '500'), 500);
        const before = req.query.before; // ISO timestamp for pagination
        const scope = req.query.scope || 'streamer';

        // Resolve which broadcaster this stream belongs to.
        const stream = await ctx.ensureStream(req.params.streamId);
        const broadcasterId = stream ? stream.user_id : null;
        const spanStreamer = scope !== 'stream' && broadcasterId;

        // COALESCE the channel name from the source stream's owner (live rows) OR the
        // message's channel_user_id (offline rows) so the streamer/channel tag renders
        // in history for both. cu = the broadcaster resolved from channel_user_id.
        const select = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
                          u.username AS core_username,
                          s.title AS source_stream_title, s.managed_stream_id AS source_managed_id,
                          s.is_live AS source_is_live, ms.slug AS source_slug,
                          COALESCE(bu.username, cu.username) AS source_channel`;
        let sql;
        const params = [];
        if (spanStreamer) {
            // Span by channel_user_id (LEFT JOIN streams) so OFFLINE messages
            // (stream_id NULL) survive when the streamer goes live — the old INNER
            // JOIN on streams dropped them.
            sql = `${select}
                   FROM chat_messages cm
                   LEFT JOIN ctx_users u ON cm.user_id = u.id
                   LEFT JOIN ctx_streams s ON cm.stream_id = s.id
                   LEFT JOIN ctx_managed_streams ms ON s.managed_stream_id = ms.id
                   LEFT JOIN ctx_users bu ON s.user_id = bu.id
                   LEFT JOIN ctx_users cu ON cm.channel_user_id = cu.id
                   WHERE cm.channel_user_id = ? AND cm.is_deleted = 0
                     AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
            params.push(broadcasterId);
        } else {
            sql = `${select}
                   FROM chat_messages cm
                   LEFT JOIN ctx_users u ON cm.user_id = u.id
                   LEFT JOIN ctx_streams s ON cm.stream_id = s.id
                   LEFT JOIN ctx_managed_streams ms ON s.managed_stream_id = ms.id
                   LEFT JOIN ctx_users bu ON s.user_id = bu.id
                   LEFT JOIN ctx_users cu ON cm.channel_user_id = cu.id
                   WHERE cm.stream_id = ? AND cm.is_deleted = 0
                     AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
            params.push(req.params.streamId);
        }

        // after_id: cursor read (oldest→newest, primary-key range scan) for reopen/reconnect.
        // Otherwise a page: the newest rows, optionally before a timestamp.
        const afterId = req.query.after_id != null ? Math.max(0, parseInt(req.query.after_id, 10) || 0) : null;
        if (afterId != null) {
            sql += ` AND cm.id > ? ORDER BY cm.id ASC LIMIT ?`;
            params.push(afterId, limit + 1);
        } else {
            if (before) {
                sql += ` AND cm.timestamp < ?`;
                params.push(before);
            }
            sql += ` ORDER BY cm.timestamp DESC LIMIT ?`;
            params.push(limit);
        }

        let rows = db.all(sql, params);
        let complete = true;
        if (afterId != null) { complete = rows.length <= limit; rows = rows.slice(0, limit); } else rows.reverse();
        const latest_id = rows.reduce((m, x) => (x.id > m ? x.id : m), 0) || (afterId || 0);
        await loadDecor(rows);
        const messages = publicRows(enrichMessagesWithCosmetics(hydrateReplies(rows)));

        // Currently-live slots for this broadcaster — lets the client render a
        // "hop between live streams" affordance.
        let liveSlots = [];
        let channel = null;
        if (broadcasterId) {
            try {
                const owner = ctx.getUserById(broadcasterId);
                channel = owner ? owner.username : null;
                liveSlots = (ctx.getManagedStreamsByUserId(broadcasterId) || [])
                    .filter(ms => ms.is_currently_live)
                    .map(ms => ({
                        managed_stream_id: ms.id,
                        slug: ms.slug,
                        title: ms.title,
                        live_session_id: ms.live_session_id,
                    }));
            } catch { /* non-critical */ }
        }
        res.json({
            messages, latest_id, complete, liveSlots, channel,
            activeStreamId: parseInt(req.params.streamId) || null,
            activeManagedId: stream ? (stream.managed_stream_id || null) : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get chat history' });
    }
});

// Persistent per-streamer chat history keyed by the broadcaster's USER id — spans
// every live slot AND offline periods (channel_user_id), so it works when the
// streamer has no active session. Used by the channel page (online + offline).
router.get('/channel/:userId/history', optionalAuth, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (!userId) return res.status(400).json({ error: 'Bad user id' });
        const room = `channel:${userId}`;
        const out = req.query.after_id != null
            ? historyStore.delta(room, { afterId: req.query.after_id, limit: req.query.limit })
            : historyStore.page(room, { limit: req.query.limit, before: req.query.before });
        await loadDecor(out.messages);
        out.messages = publicRows(enrichMessagesWithCosmetics(hydrateReplies(out.messages.map((x) => ({ ...x })))));
        let liveSlots = [], channel = null;
        try {
            const owner = ctx.getUserById(userId);
            channel = owner ? owner.username : null;
            liveSlots = (ctx.getManagedStreamsByUserId(userId) || [])
                .filter(ms => ms.is_currently_live)
                .map(ms => ({ managed_stream_id: ms.id, slug: ms.slug, title: ms.title, live_session_id: ms.live_session_id }));
        } catch { /* non-critical */ }
        res.json({ ...out, liveSlots, channel, activeStreamId: null, activeManagedId: null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get channel chat history' });
    }
});

// ── Chat User Count ──────────────────────────────────────────
router.get('/:streamId/users', (req, res) => {
    const chatServer = require('./chat-server');
    const count = chatServer.getStreamViewerCount(parseInt(req.params.streamId));
    res.json({ count });
});

// ── Chat Log Management ─────────────────────────────────────

// Preview count of messages in a time range
router.post('/admin/purge/preview', requireAuth, async (req, res) => {
    try {
        const { streamId, from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        // Must be admin or stream owner
        let effectiveStreamId = streamId || null;
        if (!permissions.can(req.user, 'staff.moderation.purge')) {
            if (streamId) {
                const stream = await ctx.ensureStream(streamId);
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                // Non-admin without streamId: scope to their most recent stream
                const userStreams = ctx.getStreamsByUserId(req.user.id, 1);
                if (!userStreams?.length) {
                    return res.json({ count: 0 });
                }
                effectiveStreamId = userStreams[0].id;
            }
        }

        const count = db.countChatMessagesByTimeRange(effectiveStreamId, from, to);
        res.json({ count });
    } catch (e) {
        console.error('[Chat] Purge preview error:', e.message);
        res.status(500).json({ error: 'Failed to count messages' });
    }
});

// Delete messages in a time range (soft delete)
router.delete('/admin/purge', requireAuth, async (req, res) => {
    try {
        const { streamId, from, to } = req.body;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        let effectiveStreamId = streamId || null;
        if (!permissions.can(req.user, 'staff.moderation.purge')) {
            if (streamId) {
                const stream = await ctx.ensureStream(streamId);
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                // Non-admin without streamId: scope to their most recent stream
                const userStreams = ctx.getStreamsByUserId(req.user.id, 1);
                if (!userStreams?.length) {
                    return res.json({ deleted: 0 });
                }
                effectiveStreamId = userStreams[0].id;
            }
        }

        const result = db.deleteChatMessagesByTimeRange(effectiveStreamId, from, to, req.user.display_name || req.user.username);

        // Broadcast delete event to live chat
        try {
            const chatServer = require('./chat-server');
            const payload = { type: 'purge', streamId: effectiveStreamId, from, to, by: req.user.display_name };
            if (effectiveStreamId) {
                chatServer.broadcastToStream(effectiveStreamId, payload);
            } else {
                chatServer.broadcastGlobal(payload);
            }
        } catch { /* chat server may not be initialized */ }

        console.log(`[Chat] Purged messages: stream=${effectiveStreamId || 'global'} from=${from} to=${to} by=${req.user.username} changes=${result?.changes || 0}`);
        res.json({ deleted: result?.changes || 0 });
    } catch (e) {
        console.error('[Chat] Purge error:', e.message);
        res.status(500).json({ error: 'Failed to purge messages' });
    }
});

// Get paginated chat logs with filters
router.get('/admin/logs', requireAuth, async (req, res) => {
    try {
        const { streamId, username, search, from, to, messageType, page, limit, includeDeleted } = req.query;

        // Must be admin or stream owner
        let effectiveStreamId = streamId ? parseInt(streamId) : undefined;
        if (!permissions.can(req.user, 'staff.moderation.purge')) {
            if (streamId) {
                const stream = await ctx.ensureStream(parseInt(streamId));
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                // Non-admin without streamId: scope to their most recent stream
                const userStreams = ctx.getStreamsByUserId(req.user.id, 1);
                if (!userStreams?.length) {
                    return res.json({ rows: [], total: 0, page: 1, limit: 50, totalPages: 0 });
                }
                effectiveStreamId = userStreams[0].id;
            }
        }

        const result = db.getChatLogs({
            streamId: effectiveStreamId,
            username, search, from, to, messageType,
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 50, 200),
            includeDeleted: includeDeleted === 'true' && permissions.can(req.user, 'staff.moderation.purge'),
        });
        // Staff browsing beyond their own stream: the first page of each view is recorded.
        if (permissions.can(req.user, 'staff.moderation.purge') && (parseInt(page) || 1) === 1) {
            const own = effectiveStreamId && (ctx.getStreamsByUserId(req.user.id, 50) || []).some((st) => st.id === effectiveStreamId);
            if (!own) auditLogAccess(req, 'chat_log_view', { scope_type: effectiveStreamId ? 'stream' : 'site', scope_id: effectiveStreamId || null,
                details: { username: username || null, search: search ? String(search).slice(0, 100) : null, from: from || null, to: to || null, include_deleted: includeDeleted === 'true', total: result.total } });
        }
        publicRows(result.rows);
        res.json(result);
    } catch (e) {
        console.error('[Chat] Logs error:', e.message);
        res.status(500).json({ error: 'Failed to get chat logs' });
    }
});

// Export chat logs as CSV or JSON
router.get('/admin/logs/export', requireAuth, async (req, res) => {
    try {
        const { streamId, username, search, from, to, messageType, format } = req.query;

        if (!permissions.can(req.user, 'staff.moderation.purge')) {
            if (streamId) {
                const stream = await ctx.ensureStream(parseInt(streamId));
                if (!stream || stream.user_id !== req.user.id) {
                    return res.status(403).json({ error: 'Not authorized' });
                }
            } else {
                return res.status(403).json({ error: 'Only admins can export all chat logs' });
            }
        }

        // Get all matching rows (up to 50k)
        const result = db.getChatLogs({
            streamId: streamId ? parseInt(streamId) : undefined,
            username, search, from, to, messageType,
            page: 1, limit: 50000,
        });
        if (permissions.can(req.user, 'staff.moderation.purge')) {
            const own = streamId && (ctx.getStreamsByUserId(req.user.id, 50) || []).some((st) => st.id === parseInt(streamId));
            if (!own) auditLogAccess(req, 'chat_log_export', { scope_type: streamId ? 'stream' : 'site', scope_id: streamId ? parseInt(streamId) : null,
                details: { format: format === 'csv' ? 'csv' : 'json', rows: result.rows.length, username: username || null, search: search ? String(search).slice(0, 100) : null, from: from || null, to: to || null } });
        }
        publicRows(result.rows);

        if (format === 'csv') {
            const header = 'id,timestamp,username,message,message_type,stream_id,is_global,source_platform\n';
            const csvRows = result.rows.map(r => [r.id, r.timestamp, r.username || '', r.message || '', r.message_type || '', r.stream_id || '', r.is_global || 0, r.source_platform || ''].map(csvCell).join(','));
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="chat-logs-${Date.now()}.csv"`);
            res.send(header + csvRows.join('\n'));
        } else {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="chat-logs-${Date.now()}.json"`);
            res.json(result.rows);
        }
    } catch (e) {
        console.error('[Chat] Export error:', e.message);
        res.status(500).json({ error: 'Failed to export chat logs' });
    }
});

// ── Your own chat, to keep (WS-I task 7) ─────────────────────────────────────
// Every message you sent that is still visible (not deleted, not expired), newest first, as JSON or
// CSV. Up to 100,000 lines; `truncated` says when there were more.
router.get('/me/export', requireAuth, (req, res) => {
    try {
        const MAX = 100000, PAGE = 5000;
        const rows = [];
        let total = 0;
        for (let offset = 0; offset < MAX; offset += PAGE) {
            const r = db.getUserChatHistory(req.user.id, PAGE, offset);
            total = r.total;
            rows.push(...r.messages);
            if (r.messages.length < PAGE) break;
        }
        const lines = rows.slice(0, MAX).map((m) => ({ id: m.id, timestamp: m.timestamp, message: m.message, message_type: m.message_type || 'chat', stream_id: m.stream_id || null, stream_title: m.stream_title || null, is_global: !!m.is_global }));
        const stamp = new Date().toISOString().slice(0, 10);
        res.set('Cache-Control', 'private, no-store');
        if (req.query.format === 'csv') {
            const header = 'id,timestamp,message,message_type,stream_id,stream_title,is_global\n';
            res.set('Content-Disposition', `attachment; filename="my-chat-${stamp}.csv"`);
            return res.type('text/csv').send(header + lines.map((l) => [l.id, l.timestamp, l.message, l.message_type, l.stream_id || '', l.stream_title || '', l.is_global ? 1 : 0].map(csvCell).join(',')).join('\n'));
        }
        res.set('Content-Disposition', `attachment; filename="my-chat-${stamp}.json"`);
        res.json({ username: req.user.username, exported_at: new Date().toISOString(), total, truncated: total > lines.length, messages: lines });
    } catch (e) {
        console.error('[Chat] Own export error:', e.message);
        res.status(500).json({ error: 'Failed to export your chat' });
    }
});

module.exports = router;
