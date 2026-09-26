/**
 * OpenVibe.Chat — WebSocket Chat Server (/ws/chat)
 *
 * Moved from OpenVibe.Live server/chat/chat-server.js (Wave 6) with the same protocol: every
 * message type, command, reply and broadcast is Live's. What changed is only where Live-owned
 * data comes from — accounts, streams, channels, bans, cosmetics and every side effect
 * (coins, AI viewers, arena, media queue, hardware, pastes, translation, PowerChat) go through
 * ../live-context.js — and that authentication is a cached call to Live, so a socket's
 * messages are processed in order behind its (async) connect and join.
 *
 * Features:
 * - Anonymous chat with sequential numbering (anon12345)
 * - Global chat + per-stream chat
 * - Word filtering (safe/unsafe mode)
 * - Anti-VPN approval queue
 * - Streamer moderation (ban, timeout, delete)
 * - Chat commands (/help, /tts, /color, etc.)
 * - Rate limiting
 */
const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');
const ctx = require('../live-context');
const { extractWsToken, authenticateWs } = require('../auth/auth');
const session = require('../auth/network-session');
const { clientIpOf } = require('../net/client-ip');
const permissions = require('../auth/permissions');
const wordFilter = require('./word-filter');
const ttsEngine = require('./tts-engine');
const soundboard = require('./soundboard-service');
const audioQueue = require('./audio-queue');
const dm = require('./dm');
const networkBlocks = require('./network-blocks');
const vipBadges = require('../vip/badges');
// Cosmetics and tags are Live's (monetization/cosmetics, game/tags); read through live-context.
const cosmetics = { getCosmeticProfile: (userId) => ctx.getCosmeticProfile(userId) };
const tags = { getTagProfile: (userId) => ctx.getTagProfile(userId) };
// Concurrent chat sockets per address. Generous: one person has several tabs, a school or
// carrier NAT puts many people behind one address; this only stops one host opening thousands.
const MAX_CHAT_SOCKETS_PER_IP = 48;

const DEBUG_DM_DELIVERY = process.env.DEBUG_DM_DELIVERY === '1';

const WS_HEARTBEAT_MS = 30000;
const CHAT_AUTO_DELETE_SWEEP_MS = 30000;
const MIN_CHAT_AUTO_DELETE_MINUTES = 3;
const MAX_CHAT_AUTO_DELETE_MINUTES = 10080;
const MAX_SEND_BACKPRESSURE = 256 * 1024;
const RATE_LIMIT_CACHE_TTL_MS = 10 * 60 * 1000;
const SOUNDBOARD_RATE_LIMIT_MS = 8000;
const SOUNDBOARD_STREAM_MAX_PER_WINDOW = 15;
const SOUNDBOARD_STREAM_WINDOW_MS = 60 * 1000;
const GOTTI_GIF_URL = 'https://media1.tenor.com/m/Y-GsLUQT9LQAAAAd/deez-something-came-in-the-mail-today.gif';
const GOTTI_CAPTION = 'Something came in the mail today... deez nuts. GOTTI!';
// Sub-only mode (WS-I task 6): who may chat is decided in _chatRulesBlock.
const SUB_ONLY_REFUSED = 'This chat is in sub-only mode: only subscribers of this channel can chat.';
const SUB_ONLY_ANON = 'This chat is in sub-only mode: sign in and subscribe to chat.';
// A person's own lines: what someone who blocked them on the network no longer gets (network-blocks.js).
const LINE_FRAMES = new Set(['chat', 'tts', 'tts-audio']);
const DEFAULT_SLUR_NUDGE = 'This streamer enabled Anti-Slur Nudge for this chat. Free speech is still alive, but this lane is closed today. Try a different word and keep it funny.';
// Built-in slur categories and normalization are defined in moderation-utils.js
// (single source of truth — browser-side chat.js mirrors the same patterns).
const {
    CORE_SLUR_CATEGORIES,
    normalizeSlurText: _modNormalizeSlurText,
    normalizeSlurPatternText: _modNormalizeSlurPatternText,
    containsCoreSlur: _modContainsCoreSlur,
    containsRegexSlur: _modContainsRegexSlur,
    containsConfiguredSlur: _modContainsConfiguredSlur,
    compileRegexList: _modCompileRegexList,
} = require('./moderation-utils');

class ChatServer {
    constructor() {
        this.wss = null;
        /** @type {Map<WebSocket, { user: object|null, anonId: string, streamId: number|null, ip: string }>} */
        this.clients = new Map();
        /** @type {Map<string, number>} ip → open sockets */
        this._ipSockets = new Map();
        /** @type {Map<string, number>} IP → unified anon number (warm cache, backed by openvibe.network) */
        this.anonMap = new Map();
        this.nextAnonId = 1;
        this._anonDbLoaded = false;
        /** @type {Map<string, number>} `${ip}:${streamId}` → last message time (rate limiting) */
        this.rateLimits = new Map();
        this.DEFAULT_RATE_LIMIT_MS = 1000; // 1 message per second
        // Slow mode and sub-only mode are the channel's saved settings (slowModeMs, _chatRulesBlock);
        // channelId → { slow, sub } last announced to its room (_channelSettingsSeen).
        this._announcedModes = new Map();
        this._modeWrites = new Map();   // channelId → /slow or /subonly writes running
        /** @type {WeakMap<object, Set<string>|null>} frame → the subjects who blocked its author (_blockersOf) */
        this._blockMemo = new WeakMap();
        ctx.onChannelSettings((channelId, settings) => this._channelSettingsSeen(channelId, settings));
        this.heartbeatInterval = null;
        // TTS and sound requests queue in Chat's database (./audio-queue.js), one room at a time.
        /** @type {Map<string, number>} `${streamId}:${userKey}` → last soundboard trigger */
        this.soundboardRateLimits = new Map();
        /** @type {Map<number, {count: number, windowStart: number}>} streamId → stream-level soundboard rate window */
        this.soundboardStreamLimits = new Map();
        this._autoDeleteSweepInterval = null;
    }

    normalizeIp(ip) {
        let normalized = String(ip || 'unknown').trim();
        if (!normalized) normalized = 'unknown';
        if (normalized === '::1') return '127.0.0.1';
        if (normalized.startsWith('::ffff:')) return normalized.slice(7);
        return normalized;
    }

    /**
     * Extract the real client IP from Express/WS request.
     * Prefers CF-Connecting-IP (set by Cloudflare, unforgeable through proxy),
     * then X-Forwarded-For first entry, then socket remote address.
     */
    /** Admins (the site owner) pass IP / network bans — they may share a home network with a banned person. */
    /**
     * Is this viewer new to OpenVibe.Live? True for an account under a day old — unless the same
     * address has had an anon identity for longer — and for an anon first seen under a day ago.
     * Drives the default of the viewer-side "Friendly global chat" setting only.
     */
    _isNewcomer(client) {
        const DAY = 24 * 3600 * 1000;
        const age = (ts) => { if (!ts) return null; const t = Date.parse(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(ts)) ? '' : 'Z')); return Number.isFinite(t) ? Date.now() - t : null; };
        let anonAge = null;
        try { anonAge = age(ctx.getAnonFirstSeen(this.normalizeIp(client.ip))); } catch { /* */ }
        if (client.user) {
            const userAge = age(client.user.created_at);
            if (userAge == null || userAge >= DAY) return false;
            return !(anonAge != null && anonAge >= DAY);
        }
        return anonAge == null ? false : anonAge < DAY;
    }

    _isBanExemptAdmin(client) { return !!(client && client.user && !client.user.is_banned && permissions.can(client.user, 'staff.limits.exempt')); }

    getClientIp(req) {
        // CF-Connecting-IP / X-Forwarded-For only when nginx's peer is Cloudflare (net/client-ip.js).
        return this.normalizeIp(clientIpOf(req));
    }

    /**
     * Resolve the anon number for an address. Live allocates it exactly as it did in-process
     * (openvibe.network's unified /internal/resolve-anon, falling back to its local
     * anon_ip_mappings), so a person keeps one number across chat, calls and every Live page.
     * Returns a Promise<number>; cached in memory.
     */
    async _resolveUnifiedAnonNum(ip) {
        if (this.anonMap.has(ip)) return this.anonMap.get(ip);
        const r = await ctx.resolveAnon(ip);
        if (!r.temporary) this.anonMap.set(ip, r.num);
        return r.num;
    }

    getAnonIdForIp(ip) {
        const anonKey = this.normalizeIp(ip);
        if (this.anonMap.has(anonKey)) {
            return `anon${this.anonMap.get(anonKey)}`;
        }
        // Connections resolve their number before they are registered (handleConnection), so
        // this is only reached for an address Live could not answer for: use its temporary number.
        const r = ctx.peekAnon(anonKey);
        if (r) { this.anonMap.set(anonKey, r.num); return `anon${r.num}`; }
        const num = 900000000 + (crypto.createHash('sha256').update(anonKey).digest().readUInt32BE(0) % 99999999);
        return `anon${num}`;
    }

    getAnonIdForConnection(ip, streamId = null) {
        const anonKey = this.normalizeIp(ip);
        for (const [, info] of this.clients) {
            if (info.ip !== anonKey || !info.anonId) continue;
            if (streamId == null || info.streamId === streamId) {
                return info.anonId;
            }
        }
        return this.getAnonIdForIp(anonKey);
    }

    /**
     * Attach to an existing HTTP server for WebSocket upgrade
     */
    init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

        // Word filter
        wordFilter.load();

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (!this.wss) return;

            const now = Date.now();
            for (const [ip, lastSeen] of this.rateLimits.entries()) {
                if ((now - lastSeen) > RATE_LIMIT_CACHE_TTL_MS) {
                    this.rateLimits.delete(ip);
                }
            }

            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    try { ws.terminate(); } catch {}
                    return;
                }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            });
        }, WS_HEARTBEAT_MS);

        // ── Viewer snapshot recording (every 60s) ────────────
        if (this._snapshotInterval) clearInterval(this._snapshotInterval);
        this._snapshotInterval = setInterval(() => {
            this._recordViewerSnapshots();
        }, 60_000);

        if (this._autoDeleteSweepInterval) clearInterval(this._autoDeleteSweepInterval);
        this._autoDeleteSweepInterval = setInterval(() => {
            this._sweepExpiredChatMessages();
        }, CHAT_AUTO_DELETE_SWEEP_MS);
        this._sweepExpiredChatMessages();

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        // The TTS and sound queue: how each kind of request is made when its turn comes, and
        // where its frame goes. recover() resumes what a restart interrupted.
        audioQueue.init({
            performers: {
                tts: (row, p) => this._makeTtsAudio(p),
                'channel-sound': (row, p) => this._makeChannelSoundAudio(p),
                soundboard: (row, p) => this._makeSoundboardAudio(p),
            },
            deliver: (row, frame) => this._broadcastTtsPayload(row.stream_id, row.channel_user_id, frame),
        });
        try { audioQueue.recover(); } catch (err) { console.warn('[AudioQueue] recover failed:', err.message); }

        console.log('[Chat] WebSocket chat server initialized');
        return this.wss;
    }

    /**
     * Handle WebSocket upgrade for chat connections
     */
    handleUpgrade(req, socket, head) {
        if (req.url.startsWith('/ws/chat')) {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
            return true;
        }
        return false;
    }

    /**
     * Handle a new chat connection
     */
    handleConnection(ws, req) {
        const ip = this.getClientIp(req);

        // Diagnostic: log IP resolution chain for first few connections
        if (this.anonMap.size < 20) {
            console.log('[Chat] IP resolution — cf-connecting-ip:', req.headers?.['cf-connecting-ip'] || '(none)',
                '| x-forwarded-for:', req.headers?.['x-forwarded-for'] || '(none)',
                '| x-real-ip:', req.headers?.['x-real-ip'] || '(none)',
                '| socket:', req.socket?.remoteAddress || '(none)',
                '| resolved:', ip);
        }

        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const token = extractWsToken(req);
        const streamId = parseInt(urlParams.get('stream')) || null;

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        try { ws._socket?.setNoDelay(true); } catch {}

        // Authentication (and the anon number) is a cached call to Live now. Messages that arrive
        // meanwhile wait, in order, and are handled once the connection is registered.
        const early = [];
        let closedEarly = false;
        const onEarlyMessage = (data) => early.push(data);
        const onEarlyClose = () => { closedEarly = true; };
        ws.on('message', onEarlyMessage);
        ws.on('close', onEarlyClose);
        ws.on('error', onEarlyClose);
        (async () => {
            // Authenticate (optional — anon if no token)
            const user = await authenticateWs(token).catch(() => null);
            if (!user) await this._resolveUnifiedAnonNum(this.normalizeIp(ip)).catch(() => {});
            await ctx.warm({ user, streamId, ip }).catch(() => {});
            ws.off('message', onEarlyMessage);
            ws.off('close', onEarlyClose);
            ws.off('error', onEarlyClose);
            if (closedEarly || ws.readyState !== WebSocket.OPEN) return;
            this._registerConnection(ws, req, { ip, streamId, user, early, tokenIat: user ? session.tokenIat(token) : null });
        })().catch((err) => {
            console.warn('[Chat] connection setup failed:', err.message);
            try { ws.close(1011, 'setup failed'); } catch {}
        });
    }

    /** The rest of Live's handleConnection, once the socket's identity is known. */
    _registerConnection(ws, req, { ip, streamId, user, early, tokenIat = null }) {
        const perIp = this._ipSockets.get(ip) || 0;
        if (ip && ip !== 'unknown' && perIp >= MAX_CHAT_SOCKETS_PER_IP && !permissions.can(user, 'staff.limits.exempt')) {
            ws.close(4029, 'Too many connections');
            return;
        }
        this._ipSockets.set(ip, perIp + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const n = (this._ipSockets.get(ip) || 1) - 1;
            if (n > 0) this._ipSockets.set(ip, n); else this._ipSockets.delete(ip);
        };

        // Generate or reuse anon ID for this IP
        const anonId = user ? null : this.getAnonIdForConnection(ip, streamId);

        const clientInfo = {
            user,
            anonId,
            streamId,
            ip,
            joinedAt: Date.now(),
            // Handle Live can address replies to (arena commands) through the bridge.
            connId: crypto.randomUUID(),
            // When the socket's token was issued (seconds), so a sign-out everywhere can close it.
            tokenIat,
        };
        this.clients.set(ws, clientInfo);

        // Log IP for tracking (Live's ip_log; Live adds the geo enrichment)
        try {
            ctx.effects.logIp({ userId: user?.id, anonId, ip, action: 'chat' });
        } catch (e) { /* non-critical */ }

        // (No verbose welcome message — the client shows a concise "Connected to
        // chat" / "Chatting as X" instead.)

        // Send user count + users list update
        this.broadcastUserCount(streamId);
        this.broadcastUsersList(streamId);

        // ── Message handler ──────────────────────────────────
        // One socket's messages run strictly in order: a join (which may wait on Live for a
        // token or a cold stream) finishes before the chat line typed right after it.
        let chain = Promise.resolve();
        const onData = (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch (err) {
                console.warn('[Chat] Malformed message from', ws._clientIp || 'unknown', ':', err.message);
                return;
            }
            chain = chain.then(() => this.handleMessage(ws, msg)).catch((err) => {
                console.warn('[Chat] message handling failed:', err.message);
            });
        };
        ws.on('message', onData);
        for (const data of early || []) onData(data);

        ws.on('close', () => {
            release();
            this.clients.delete(ws);
            this.broadcastUserCount(streamId);
            this.broadcastUsersList(streamId);
        });

        ws.on('error', (err) => {
            console.warn('[Chat] WebSocket error for', ws._clientIp || 'unknown', ':', err.message);
            release();
            this.clients.delete(ws);
        });
    }

    /**
     * Handle incoming chat message
     */
    async handleMessage(ws, msg) {
        const client = this.clients.get(ws);
        if (!client) return;

        // Rate limiting (only for chat messages, not join/leave)
        if (msg.type === 'chat') {
            const now = Date.now();
            const rateKey = `${client.ip}:${client.streamId || 'global'}`;
            const lastMsg = this.rateLimits.get(rateKey) || 0;
            // Slow mode of the stream that governs the room (an offline/channel-room join has no
            // stream id of its own but posts into the live room).
            const slowStreamId = client.streamId || (client.channelUserId ? this._moderationStreamFor(client) : null);
            const streamSlowMs = this.slowModeMs(slowStreamId);
            // The room's moderators (broadcaster, channel mods, chat staff) are not slowed: they keep
            // the flood limit only, so they can moderate and turn slow mode off again at once.
            const slowExempt = streamSlowMs > 0 && !!client.user && permissions.canModerateStream(client.user, slowStreamId);
            const effectiveLimit = slowExempt ? this.DEFAULT_RATE_LIMIT_MS : Math.max(this.DEFAULT_RATE_LIMIT_MS, streamSlowMs);
            if (now - lastMsg < effectiveLimit) {
                this.sendTo(ws, { type: 'system', message: 'Slow down! You are sending messages too fast.' });
                return;
            }
            this.rateLimits.set(rateKey, now);
        }

        switch (msg.type) {
            case 'chat':
                await this._warmSubOnly(client).catch(() => {});
                this.handleChatMessage(ws, client, msg);
                break;
            case 'self-delete-history':
                this.handleSelfDeleteHistory(ws, client);
                break;
            case 'join':
            case 'join_stream': {
                // (Re-)authenticate if a token is provided
                if (msg.token) {
                    const user = await authenticateWs(msg.token).catch(() => null);
                    if (user) {
                        if (!client.user || client.user.id === user.id) {
                            client.user = user;
                            this._hiddenFromUserList(user);   // warm chat.presence_prefs before the next user list
                            client.tokenIat = session.tokenIat(msg.token);
                            client.anonId = null; // no longer anonymous
                        } else {
                            console.warn(`[Chat] Ignoring token identity mismatch for ${client.user.username} -> ${user.username}`);
                        }
                    }
                }
                const oldStream = client.streamId;
                const nextStreamId = parseInt(msg.streamId || msg.stream_id) || null;
                const requestedChannel = parseInt(msg.channelUserId || msg.channel_user_id) || null;
                // Load what this room's messages will read (stream, channel policy, the viewer's
                // follows and decor, the channel's latest stream) before the socket is moved.
                await ctx.warm({ user: client.user, streamId: nextStreamId, channelUserId: requestedChannel, ip: client.ip }).catch(() => {});
                if (!nextStreamId && requestedChannel) {
                    // Offline channel room: its moderation comes from the channel's latest stream.
                    await ctx.warm({ user: null, streamId: ctx.latestStreamIdForUser(requestedChannel), channelUserId: requestedChannel }).catch(() => {});
                }
                client.streamId = nextStreamId;
                // Channel room: the streamer's stable user id. Lets a viewer stay in
                // the SAME chat room across live-slot switches AND while the streamer
                // is offline. Prefer an explicit channelUserId from the client; else
                // derive it from the live stream's owner.
                let channelUserId = requestedChannel;
                // With a stream, the room is that stream's owner — whatever the client says. Taking the
                // client's value let a viewer join stream A's session while posting into channel B's
                // room, where B's bans and chat rules (checked against the stream) never applied.
                if (client.streamId) {
                    channelUserId = null;
                    try { const s = ctx.getStreamById(client.streamId); if (s) channelUserId = s.user_id; } catch { /* ignore */ }
                }
                client.channelUserId = channelUserId;
                client._modStream = null;
                // Look up this member's VIP badge for the room now, so their first message has it.
                if (client.user && channelUserId) { try { vipBadges.warm(this._subjectOfUser(client.user), db.subjectFor(channelUserId)); } catch { /* */ } }
                // A TTS/sound queue held since a restart plays once its room has listeners again.
                audioQueue.roomJoined(audioQueue.roomKey({ streamId: client.streamId, channelUserId: client.streamId ? null : channelUserId }));
                // Update viewer counts for old and new streams
                if (oldStream !== client.streamId) {
                    if (oldStream) this.broadcastUserCount(oldStream);
                    this.broadcastUserCount(client.streamId);
                }
                // A deploy notice from this boot reaches late joiners too (once per socket; see deploy-notice.js).
                setTimeout(() => { try { require('./deploy-notice').replayTo(ws); } catch { /* optional */ } }, 1200);
                // Send identity confirmation so the client knows who it is
                const displayName = client.user ? (client.user.display_name || client.user.username) : client.anonId;
                const roomStreamId = client.streamId || this._moderationStreamFor(client);
                const streamSlowSec = Math.round(this.slowModeMs(roomStreamId) / 1000);
                const streamSettings = this._getChannelChatSettings(client.streamId);
                this.sendTo(ws, {
                    type: 'auth',
                    authenticated: !!client.user,
                    newcomer: this._isNewcomer(client),
                    username: displayName,
                    core_username: client.user?.username || null,
                    role: client.user ? client.user.role : 'anon',
                    user_id: client.user?.id || null,
                    slowmode_seconds: streamSlowSec,
                    sub_only: !!(roomStreamId && this._getChannelChatSettings(roomStreamId).sub_only),
                    allow_auto_delete: !client.streamId || streamSettings.viewer_auto_delete_enabled !== 0,
                    allow_self_delete_all: !client.streamId || streamSettings.viewer_delete_all_enabled !== 0,
                    gifs_enabled: !client.streamId || streamSettings.gifs_enabled !== 0,
                    custom_emotes_enabled: !client.streamId || streamSettings.custom_emotes_enabled !== 0,
                    custom_sounds_enabled: !client.streamId || streamSettings.custom_sounds_enabled !== 0,
                    uploads_mods_only: !!(client.streamId && streamSettings.uploads_mods_only),
                    max_sound_seconds: client.streamId ? (streamSettings.max_sound_seconds || 10) : 10,
                    emote_scale: client.streamId ? (streamSettings.emote_scale || 100) : 100,
                    soundboard_enabled: !client.streamId || streamSettings.soundboard_enabled !== 0,
                    soundboard_allow_pitch: !client.streamId || streamSettings.soundboard_allow_pitch !== 0,
                    soundboard_allow_speed: !client.streamId || streamSettings.soundboard_allow_speed !== 0,
                    slur_filter_enabled: !!(client.streamId && streamSettings.slur_filter_enabled),
                    slur_filter_use_builtin: streamSettings.slur_filter_use_builtin !== 0,
                    slur_filter_disabled_categories: (() => { try { return JSON.parse(streamSettings.slur_filter_disabled_categories || '[]') || []; } catch { return []; } })(),
                    slur_filter_terms: this._parseSlurFilterTerms(streamSettings.slur_filter_terms),
                    slur_filter_regexes: this._parseRegexLines(streamSettings.slur_filter_regexes),
                    slur_filter_nudge_message: String(streamSettings.slur_filter_nudge_message || ''),
                    min_auto_delete_minutes: MIN_CHAT_AUTO_DELETE_MINUTES,
                    // Language the channel lives in — the client shows "auto-translated for the
                    // streamer" when it isn't English (see server/i18n/translate.js).
                    channel_language: this._channelLanguage(client.channelUserId),
                });
                break;
            }
            case 'leave_stream':
                client.streamId = null;
                break;
            // Chat rooms (server/rooms/, openvibe.chat): a socket follows one room at a time.
            case 'join_room': {
                const rooms = require('../rooms/rooms');
                const room = rooms.bySlug(msg.room);
                const a = room ? rooms.access(room, client.user) : null;
                if (!room || !a.read) { this.sendTo(ws, { type: 'room_error', room: msg.room || null, code: 'rooms.not_found', message: 'No such room' }); break; }
                client.roomId = room.id;
                client.roomSlug = room.slug;
                this.sendTo(ws, { type: 'room_joined', room: room.slug, role: a.role, can: { post: a.post, moderate: a.moderate } });
                break;
            }
            case 'leave_room':
                client.roomId = null;
                client.roomSlug = null;
                break;
            case 'room_message': {
                const rooms = require('../rooms/rooms');
                const room = client.roomId ? rooms.bySlug(client.roomSlug) : null;
                if (!room || room.id !== client.roomId) { this.sendTo(ws, { type: 'room_error', code: 'rooms.not_joined', message: 'Open a room first' }); break; }
                try {
                    const message = rooms.post(room, client.user, msg.message);
                    this.broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
                } catch (err) {
                    this.sendTo(ws, { type: 'room_error', room: room.slug, code: err.code || 'rooms.error', message: err.code ? err.message : 'Your message could not be sent' });
                }
                break;
            }
            case 'get-users':
                this.sendTo(ws, { type: 'users-list', users: this.getUserList(client.streamId) });
                break;
            default:
                break;
        }
    }

    /** The stream whose bans and chat settings govern an offline channel-room chatter (cached 30s). */
    _moderationStreamFor(client) {
        if (!client || !client.channelUserId) return null;
        const now = Date.now();
        if (client._modStream && now - client._modStream.at < 30000) return client._modStream.id;
        let id = null;
        try { id = ctx.latestStreamIdForUser(client.channelUserId); } catch { id = null; }
        client._modStream = { id, at: now };
        return id;
    }

    handleSelfDeleteHistory(ws, client) {
        if (!client) return;

        const canBypass = client.streamId ? permissions.canModerateStream(client.user, client.streamId) : false;
        const chatSettings = this._getChannelChatSettings(client.streamId);
        if (client.streamId && !canBypass && chatSettings.viewer_delete_all_enabled === 0) {
            this.sendTo(ws, { type: 'error', message: 'This streamer has disabled viewer self-delete for this chat.' });
            return;
        }

        let ids = [];
        if (client.user?.id) {
            ids = db.deleteUserChatMessages(client.user.id, {
                streamId: client.streamId || null,
                deletedBy: client.user.id,
            });
        } else if (client.anonId) {
            ids = db.deleteAnonChatMessages(client.anonId, {
                streamId: client.streamId || null,
                deletedBy: null,
            });
        } else {
            this.sendTo(ws, { type: 'error', message: 'Join chat first before deleting history.' });
            return;
        }

        this._broadcastDeletedMessages(client.streamId || null, ids);

        try {
            db.logModerationAction({
                scope_type: client.streamId ? 'stream' : 'site',
                scope_id: client.streamId || undefined,
                actor_user_id: client.user?.id || undefined,
                action_type: 'self_message_delete_all',
                details: {
                    count: ids.length,
                    stream_id: client.streamId || null,
                    anon_id: client.user ? null : client.anonId,
                },
            });
        } catch { /* non-critical */ }

        this.sendTo(ws, {
            type: 'self-delete-result',
            count: ids.length,
            scope: client.streamId ? 'stream' : 'global',
        });
    }

    /**
     * Build a deduplicated list of users in a given stream (or global if null).
     * Returns { logged: [{username, display_name, avatar_url, role}], anonCount: N }
     */
    getUserList(streamId) {
        const seen = new Set();
        const logged = [];
        let anonCount = 0, hiddenCount = 0;
        for (const [, c] of this.clients) {
            if (c.streamId !== streamId) continue;
            if (c.user) {
                if (seen.has(c.user.id)) continue;
                seen.add(c.user.id);
                // chat.presence_prefs: someone who turned off "show my name in user lists" is counted, not named.
                if (this._hiddenFromUserList(c.user)) { hiddenCount++; continue; }
                logged.push({
                    username: c.user.username,
                    display_name: c.user.display_name || c.user.username,
                    avatar_url: c.user.avatar_url || null,
                    role: c.user.role,
                });
            } else if (c.anonId) {
                if (seen.has(c.anonId)) continue;
                seen.add(c.anonId);
                anonCount++;
            }
        }
        // Sort: admins first, then mods, then alphabetical
        const rolePriority = { admin: 0, global_mod: 1, streamer: 2, user: 3 };
        logged.sort((a, b) => (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9) || a.display_name.localeCompare(b.display_name));
        return { logged, anonCount, hiddenCount };
    }

    /**
     * Whether a signed-in user asked not to be named in user lists (Network user module
     * chat.presence_prefs). Synchronous: the cached record, fetched at join; not cached yet → fetch it
     * in the background and name them until it arrives.
     */
    _hiddenFromUserList(user) {
        const subject = this._subjectOfUser(user);
        if (!subject) return false;
        const { presence } = require('../prefs/stores');
        const cached = presence.peek(subject);
        if (cached) return cached.show_in_user_list === false;
        presence.get(subject).catch(() => {});
        return false;
    }

    /**
     * Who of `usernames` is connected to Chat right now, anywhere (global chat, a room, a DM tab):
     * { name: 'online' | 'offline' }. Presence is ephemeral and lives here, in Chat's delivery plane
     * (ADR-005 amendment 1): nothing is stored and no Events topic carries it. Someone who turned off
     * "show my name in user lists" (chat.presence_prefs) reads as offline, and so does anyone whose
     * preference cannot be read within a second: never shown when they may have asked not to be.
     */
    async presenceOf(usernames) {
        const connected = new Map();
        for (const [, c] of this.clients) if (c.user && c.user.username) connected.set(String(c.user.username).toLowerCase(), c.user);
        const { presence } = require('../prefs/stores');
        const out = {};
        for (const name of usernames) {
            const user = connected.get(String(name).toLowerCase());
            let state = 'offline';
            if (user) {
                const subject = this._subjectOfUser(user);
                if (!subject) state = 'online';
                else {
                    let prefs = presence.peek(subject);
                    if (!prefs) {
                        await Promise.race([presence.get(subject).catch(() => {}), new Promise((r) => setTimeout(r, 1000).unref())]);
                        prefs = presence.peek(subject);
                    }
                    if (prefs && prefs.show_in_user_list !== false) state = 'online';
                }
            }
            out[name] = state;
        }
        return out;
    }

    /** Someone changed chat.presence_prefs elsewhere: read it again, then refresh the user lists they are in. */
    presenceChanged(subject) {
        if (!subject) return;
        const { presence } = require('../prefs/stores');
        presence.get(subject).catch(() => {}).then(() => {
            const streams = new Set();
            for (const [, c] of this.clients) if (c.user && this._subjectOfUser(c.user) === subject) streams.add(c.streamId ?? null);
            for (const sid of streams) this.broadcastUsersList(sid);
        });
    }

    _parseSlurFilterTerms(rawTerms) {
        return String(rawTerms || '')
            .split(/[\n,]/)
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 200);
    }

    _parseRegexLines(rawRegexes) {
        return String(rawRegexes || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 300);
    }

    // Normalization and matching are delegated to moderation-utils.js (shared module).
    // These thin wrappers preserve the existing call sites inside this class.
    _normalizeSlurText(input) { return _modNormalizeSlurText(input); }
    _normalizeSlurPatternText(input) { return _modNormalizeSlurPatternText(input); }
    _containsCoreSlur(text, disabledCategories = []) { return _modContainsCoreSlur(text, disabledCategories); }
    _containsRegexSlur(text, regexLines) { return _modContainsRegexSlur(text, regexLines); }
    _containsConfiguredSlur(text, terms) { return _modContainsConfiguredSlur(text, terms); }
    _compileRegexList(patternStrings, opts) { return _modCompileRegexList(patternStrings, opts); }

    /**
     * Handle a chat message
     */
    handleChatMessage(ws, client, msg) {
        let text = (msg.message || '').trim();
        // Absolute upper bound (DoS guard) = the highest value any channel/admin can configure
        // (admins can set a channel up to 6000). The REAL per-channel limit is enforced below at
        // the `max_message_length` check — this must never be lower than that or it silently
        // swallows long messages the channel actually allows.
        if (!text || text.length > 6000) return;

        // ── Ban check ────────────────────────────────────────
        // This has to come before the command dispatch below, not after it. Both command paths
        // return early, so a banned viewer could still run every "!" utility command — queueing
        // and skipping media on the stream they were banned from — and every "/" command,
        // including /me, which puts their text back in the chat they are banned from. A ban means
        // no input of any kind.
        // Offline channel chat has no stream of its own; bans and chat rules come from the channel's
        // most recent stream, so a ban does not stop at the end of a broadcast.
        const modStreamId = client.streamId || this._moderationStreamFor(client);
        if (client.user && ctx.isUserBanned(client.user.id, modStreamId)) {
            this.sendTo(ws, { type: 'system', message: 'You are banned from this chat.' });
            return;
        }
        if (!this._isBanExemptAdmin(client) && ctx.isIpBanned(client.ip, modStreamId)) {
            this.sendTo(ws, { type: 'system', message: 'You are banned from this chat.' });
            return;
        }

        // ── Stream utility commands (!sr, !queue, !nowplaying, !skip) ──
        if (text.startsWith('!')) {
            this.handleBangCommand(ws, client, text);
            return;
        }

        // ── Chat commands ────────────────────────────────────
        if (text.startsWith('/')) {
            this.handleCommand(ws, client, text);
            return;
        }

        // ── IP Approval Mode (Anti-VPN) ─────────────────────
        // modStreamId, not client.streamId: a viewer who joins the channel room without the
        // stream id still posts into the live room (broadcastToChannelRoom).
        if (modStreamId && client.ip) {
            try {
                const stream = ctx.getStreamById(modStreamId);
                const channel = stream?.channel_id ? ctx.getChannelById(stream.channel_id) : (stream ? ctx.getChannelByUserId(stream.user_id) : null);
                if (channel) {
                    const settings = ctx.getChannelModerationSettings(channel.id);
                    if (settings?.ip_approval_mode) {
                        const isStaffBypass = permissions.can(client.user, 'staff.moderation.bypass');
                        const isOwner = client.user && stream && stream.user_id === client.user.id;
                        if (!isStaffBypass && !isOwner) {
                            if (!ctx.isIpApproved(channel.id, client.ip)) {
                                // Auto-approve IPs that have existing non-deleted chat messages in this channel's streams
                                const existing = db.get(
                                    `SELECT 1 FROM chat_messages cm
                                     JOIN ctx_streams s ON cm.stream_id = s.id
                                     WHERE s.channel_id = ? AND cm.is_deleted = 0
                                     AND (cm.user_id = ? OR cm.anon_id = ?)
                                     LIMIT 1`,
                                    [channel.id, client.user?.id || -1, client.anonId || '']
                                );
                                if (existing) {
                                    // This user has chatted before — auto-approve their IP
                                    ctx.approveIp(channel.id, client.ip, null, 'auto_existing');
                                } else {
                                    // Hold the message for streamer approval
                                    const username = client.user ? client.user.display_name : client.anonId;
                                    db.holdMessageForApproval({
                                        channelId: channel.id,
                                        streamId: modStreamId,
                                        ip: client.ip,
                                        userId: client.user?.id || null,
                                        anonId: client.anonId || null,
                                        username,
                                        message: text,
                                    });
                                    this.sendTo(ws, {
                                        type: 'system',
                                        message: 'This channel has IP approval mode enabled. Your message is being held for review by the streamer.',
                                    });
                                    // Notify the streamer that a new IP needs approval
                                    this._notifyStreamerPendingIp(modStreamId, stream.user_id, username, client.ip);
                                    return;
                                }
                            }
                        }
                    }
                }
            } catch { /* non-critical — don't block chat for IP approval errors */ }
        }

        // ── Channel moderation settings ──────────────────────
        if (this._chatRulesBlock(ws, client, text, modStreamId)) return;

        const username = client.user ? client.user.display_name : client.anonId;
        const coreUsername = client.user ? client.user.username : null;
        const role = client.user ? client.user.role : 'anon';

        // Voice channel tagging — clients can tag messages with the voice channel they're in
        const voiceChannelId = (typeof msg.voiceChannelId === 'string' && msg.voiceChannelId) ? msg.voiceChannelId : null;

        // Reply-to support — client sends reply_to_id, we look up the parent message
        const replyToId = msg.reply_to_id ? parseInt(msg.reply_to_id) : null;
        let replyTo = null;
        if (replyToId) {
            try {
                const parent = db.getChatMessageById(replyToId);
                const parentStillVisible = parent && !parent.is_deleted
                    && (!parent.auto_delete_at || new Date(parent.auto_delete_at).getTime() > Date.now());
                if (parentStillVisible) {
                    replyTo = {
                        id: parent.id,
                        username: parent.username,
                        user_id: parent.user_id,
                        message: parent.message.length > 100 ? parent.message.slice(0, 100) + '…' : parent.message,
                    };
                }
            } catch { /* non-critical */ }
        }

        const requestedAutoDeleteMinutes = parseInt(msg.auto_delete_minutes, 10);
        const allowViewerAutoDelete = !client.streamId
            || this._getChannelChatSettings(client.streamId).viewer_auto_delete_enabled !== 0
            || permissions.canModerateStream(client.user, client.streamId);
        const autoDeleteAt = Number.isFinite(requestedAutoDeleteMinutes)
            && requestedAutoDeleteMinutes >= MIN_CHAT_AUTO_DELETE_MINUTES
            && allowViewerAutoDelete
            ? new Date(Date.now() + Math.min(MAX_CHAT_AUTO_DELETE_MINUTES, requestedAutoDeleteMinutes) * 60 * 1000).toISOString()
            : null;

        const chatMsg = {
            type: 'chat',
            username,
            core_username: coreUsername,
            user_id: client.user?.id || null,
            anon_id: client.anonId,
            role,
            message: text,
            stream_id: client.streamId,
            channel_user_id: client.channelUserId || null,
            is_global: !client.streamId && !client.channelUserId,
            avatar_url: client.user?.avatar_url || null,
            profile_color: client.user?.profile_color || '#999',
            filtered: false,
            timestamp: new Date().toISOString(),
            auto_delete_at: autoDeleteAt,
        };

        // Preserve voice channel tag so clients can filter voice-call messages
        if (voiceChannelId) chatMsg.voiceChannelId = voiceChannelId;

        // Attach cosmetic data for chat rendering
        if (client.user?.id) {
            try {
                const cosmeticProfile = cosmetics.getCosmeticProfile(client.user.id);
                if (cosmeticProfile.nameFX) chatMsg.nameFX = cosmeticProfile.nameFX;
                if (cosmeticProfile.particleFX) chatMsg.particleFX = cosmeticProfile.particleFX;
                if (cosmeticProfile.hatFX) chatMsg.hatFX = cosmeticProfile.hatFX;
                if (cosmeticProfile.voiceFX) chatMsg.voiceFX = cosmeticProfile.voiceFX;
            } catch { /* non-critical */ }

            // Attach equipped tag for chat rendering
            try {
                const tagProfile = tags.getTagProfile(client.user.id);
                if (tagProfile) chatMsg.tag = tagProfile;
            } catch { /* non-critical */ }
        }

        // The creator's VIP member badge (a perk bound to `chat badge`). From the cache only: the
        // message never waits on VIP, and a miss is sent without a badge while the lookup runs; a
        // badge found then follows as a chat_vip_badge frame for this message (below).
        let vipBadgePending = null;
        if (client.user?.id && client.channelUserId) {
            try {
                const r = vipBadges.forMessage(this._subjectOfUser(client.user), db.subjectFor(client.channelUserId));
                if (r.badge) chatMsg.vip_badge = r.badge;
                else vipBadgePending = r.pending;
            } catch { /* no badge */ }
        }

        // Save to database
        try {
            const result = db.saveChatMessage({
                stream_id: client.streamId || null,
                channel_user_id: client.channelUserId || null,
                user_id: client.user?.id,
                anon_id: client.anonId,
                username,
                message: text,
                message_type: 'chat',
                is_global: !client.streamId && !client.channelUserId,
                reply_to_id: replyToId,
                auto_delete_at: autoDeleteAt,
                metadata: chatMsg.vip_badge ? { vip_badge: chatMsg.vip_badge } : undefined,
            });
            if (result.lastInsertRowid) chatMsg.id = Number(result.lastInsertRowid);
        } catch (err) {
            // Not saved means not sent: a line everyone saw but history, moderation and replays never
            // have would be a ghost. Tell the sender and stop here.
            console.warn('[Chat] message not saved, not broadcast:', err && err.message);
            this.sendTo(ws, { type: 'error', message: 'Your message could not be sent. Please try again.' });
            return;
        }

        // Attach reply context to broadcast
        if (replyTo) chatMsg.reply_to = replyTo;

        // Live's reactions to a real chat line — OpenCoins chat bonus (logged-in users in a
        // stream), AI chat viewers (stream chat), the PowerChat overlay relay (any channel chat) —
        // are ONE call to Live per message; the coin result comes back for this socket.
        let isChannelMod = false;
        try { isChannelMod = !!(client.user && client.channelUserId && permissions.canModerateChannel(client.user, client.channelUserId)); } catch { /* */ }
        const liveReactions = {
            award: !!(client.user?.id && client.streamId),
            ai: !!client.streamId,
            powerchat: !!client.channelUserId,
        };

        // Welcome first-time chatters in this streamer's channel
        if (client.streamId) {
            try {
                const stream = ctx.getStreamById(client.streamId);
                if (stream?.user_id) {
                    const chatterKey = client.user ? `user:${client.user.id}` : `anon:${client.anonId}`;
                    if (db.isFirstChatInChannel(chatterKey, stream.user_id)) {
                        db.recordFirstChat(chatterKey, stream.user_id);
                        const welcomeName = client.user?.display_name || client.user?.username || client.anonId || 'stranger';
                        this.broadcastToStream(client.streamId, {
                            type: 'system',
                            message: `Welcome ${welcomeName} to the chat! 👋`,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            } catch { /* non-critical */ }
        }

        // Broadcast to appropriate audience
        if (client.streamId || client.channelUserId) {
            // Deliver to the streamer's whole channel room (every live slot + offline
            // viewers) plus the specific stream room. This subsumes cross-slot
            // forwarding so a viewer isn't interrupted when the streamer switches
            // slots or briefly drops offline.
            this.broadcastToChannelRoom(client.channelUserId, client.streamId, chatMsg);
            // Surface on the homepage global feed (tagged with the channel).
            if (client.streamId) this.forwardToGlobal(client.streamId, chatMsg);
            else this.forwardToGlobalByChannel(client.channelUserId, chatMsg);
            // Auto-translate (async): foreign → English for everyone, English → the channel's
            // language for a non-English streamer. Lands as a follow-up 'chat_translation'.
            this._maybeTranslate(chatMsg, client.channelUserId, client.streamId);
            if (vipBadgePending) this._followVipBadge(vipBadgePending, chatMsg, client.channelUserId, client.streamId);
        }
        if (client.streamId) {

            // Trigger server-side TTS synthesis (async, non-blocking).
            // identityKey uses the immutable login handle (or anon id) so the
            // per-user voice is stable even if the display name changes.
            this.synthesizeAndBroadcastTTS(
                client.streamId,
                username,
                text,
                chatMsg.voiceFX,
                null,
                client.user ? `user:${client.user.username}` : `anon:${client.anonId}`,
                null,
                chatMsg.id ? `m${chatMsg.id}` : null
            );

            // Check for 101soundboards links in the message (async, non-blocking)
            this.processSoundboard(ws, client, text);

            // AI chat viewers react to REAL typed chat (streamer or viewers) — sent with the
            // other Live reactions below. Bots inject via broadcastToStream directly, so this
            // path only sees genuine human messages.

        } else if (!client.channelUserId) {
            // Pure global chat (homepage) — offline channel messages were already
            // delivered to the channel room above.
            this.broadcastGlobal(chatMsg);
        } else if (this._channelOwnerInRoom(client.channelUserId)) {
            // OFFLINE channel chat with the channel OWNER present in their own room:
            // synthesize TTS so their "TTS on my channel even when offline" option has
            // audio to play (client-side settings + the one-speaking-tab lock decide
            // whether it's actually audible). Owner absent = skip the synth cost.
            this.synthesizeAndBroadcastTTS(
                null,
                username,
                text,
                chatMsg.voiceFX,
                null,
                client.user ? `user:${client.user.username}` : `anon:${client.anonId}`,
                client.channelUserId,
                chatMsg.id ? `m${chatMsg.id}` : null
            );
        }

        // Merge real chat into the streamer's PowerChat unified overlay (chat:write).
        // Scoped to the CHANNEL, not the live session. This used to sit inside the
        // `if (client.streamId)` block above, so it only fired while the streamer was
        // live — yet viewers can chat in a channel whenever they like, and those
        // messages are already persisted and broadcast channel-wide. The overlay simply
        // never saw them. Chat is a property of the channel; only TTS, soundboards and
        // AI viewers genuinely need a live stream.
        // Relay is per CHANNEL, not per slot: a popout pinned to an expired stream id keeps
        // chatting in the same channel, so Live's slot check (powerchat-platform
        // channelRelayEnabled) follows the channel's current live stream rather than the stale
        // id. Live adds isSubscriber from its subscriptions.
        if (liveReactions.award || liveReactions.ai || liveReactions.powerchat) {
            ctx.effects.chatMessage({
                ...liveReactions,
                stream_id: client.streamId || null,
                channel_user_id: client.channelUserId || null,
                user_id: client.user?.id || null,
                anon_id: client.user ? null : (client.anonId || null),
                username,
                message: text,
                msg_id: chatMsg && chatMsg.id ? chatMsg.id : null,
                is_mod: isChannelMod,
                is_streamer: !!(client.user && client.user.id === client.channelUserId),
                powerchat_chat: {
                    chatterName: username,
                    externalChatterId: client.user?.id ? ('u' + client.user.id) : ('a' + (client.anonId || 'anon')),
                    message: text,
                    avatarUrl: client.user?.avatar_url || undefined,
                    isModerator: isChannelMod,
                },
            }).then((r) => {
                const coinResult = r && r.coin;
                if (coinResult) {
                    this.sendTo(ws, {
                        type: 'coin_earned',
                        coins: coinResult.coins,
                        total: coinResult.total,
                        streamerId: coinResult.streamerId,
                        reason: 'Chat bonus',
                    });
                }
            }).catch(() => { /* non-critical */ });
        }
    }

    /**
     * The channel's chat rules for a line of text a viewer puts in the room (a chat message, and
     * the text of /me and /tts): length, anonymous, links, GIF hosts, followers-only, account age,
     * the anti-slur filter. Tells the sender and returns true when the line is refused.
     */
    _chatRulesBlock(ws, client, text, modStreamId) {
        if (!modStreamId) return false;
        const chatSettings = this._getChannelChatSettings(modStreamId);
        const isStaff = permissions.can(client.user, 'staff.moderation.bypass');
        const canModerateThisStream = permissions.canModerateStream(client.user, modStreamId);

        // Max message length
        const maxLen = Math.max(50, Number(chatSettings.max_message_length || 500));
        if (text.length > maxLen) {
            this.sendTo(ws, { type: 'system', message: `Message too long. Max ${maxLen} characters.` });
            return true;
        }

        // Anonymous not allowed
        if (!client.user && !chatSettings.allow_anonymous) {
            this.sendTo(ws, { type: 'system', message: 'This channel requires a logged-in account to chat.' });
            return true;
        }

        // Sub-only: people with an active subscription to this channel (Live's subscriptions; Network
        // VIP does not count), the streamer, channel moderators and chat staff. Unknown (Live not
        // asked yet, or unreachable) counts as not subscribed; _warmSubOnly asked before this line.
        if (chatSettings.sub_only && !isStaff && !canModerateThisStream) {
            const ownerId = ctx.getStreamById(modStreamId)?.user_id || null;
            const allowed = !!(client.user && ownerId && (Number(ownerId) === Number(client.user.id) || ctx.isSubscriber(client.user.id, ownerId)));
            if (!allowed) {
                this.sendTo(ws, { type: 'system', message: client.user ? SUB_ONLY_REFUSED : SUB_ONLY_ANON });
                return true;
            }
        }

        // Links disabled — exempt [gif:url] tags (validated separately)
        if (chatSettings.links_allowed === 0 && !isStaff) {
            const textWithoutGifs = text.replace(/\[gif:https?:\/\/[^\]]+\]/gi, '');
            if (/(https?:\/\/|www\.)/i.test(textWithoutGifs)) {
                this.sendTo(ws, { type: 'system', message: 'Links are disabled in this channel chat.' });
                return true;
            }
        }

        // Validate [gif:url] — only allow trusted domains
        const gifTagMatch = text.match(/\[gif:(https?:\/\/[^\]]+)\]/i);
        if (gifTagMatch) {
            const ALLOWED_GIF_DOMAINS = ['tenor.com', 'media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'giphy.com', 'media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'];
            try {
                const gifUrl = new URL(gifTagMatch[1]);
                if (!ALLOWED_GIF_DOMAINS.includes(gifUrl.hostname)) {
                    this.sendTo(ws, { type: 'system', message: 'Only Tenor and Giphy GIFs are allowed.' });
                    return true;
                }
            } catch {
                this.sendTo(ws, { type: 'system', message: 'Invalid GIF URL.' });
                return true;
            }
        }

        // Followers only
        if (chatSettings.followers_only && client.user && !isStaff) {
            const stream = ctx.getStreamById(modStreamId);
            if (stream && stream.user_id !== client.user.id && !ctx.isFollowing(client.user.id, stream.user_id)) {
                this.sendTo(ws, { type: 'system', message: 'This chat is currently followers-only.' });
                return true;
            }
        }

        // Account age gate
        if (chatSettings.account_age_gate_hours && client.user && !isStaff) {
            const ageMs = Date.now() - new Date(client.user.created_at).getTime();
            if (ageMs < Number(chatSettings.account_age_gate_hours) * 3600000) {
                this.sendTo(ws, { type: 'system', message: `This chat requires accounts older than ${chatSettings.account_age_gate_hours} hour(s).` });
                return true;
            }
        }

        // Optional per-streamer anti-slur filter
        if (chatSettings.slur_filter_enabled && !isStaff && !canModerateThisStream) {
            const blockedTerms = this._parseSlurFilterTerms(chatSettings.slur_filter_terms);
            const configuredRegexLines = this._parseRegexLines(chatSettings.slur_filter_regexes);
            const hitConfigured = blockedTerms.length && this._containsConfiguredSlur(text, blockedTerms);
            const hitCore = chatSettings.slur_filter_use_builtin !== 0 && this._containsCoreSlur(text, (() => { try { return JSON.parse(chatSettings.slur_filter_disabled_categories || '[]') || []; } catch { return []; } })());
            const hitRegex = configuredRegexLines.length && this._containsRegexSlur(text, configuredRegexLines);
            if (hitConfigured || hitCore || hitRegex) {
                this.sendTo(ws, {
                    type: 'slur-blocked',
                    message: String(chatSettings.slur_filter_nudge_message || '').trim() || DEFAULT_SLUR_NUDGE,
                    streamer_enabled: true,
                });
                return true;
            }
        }
        return false;
    }

    /**
     * IP approval mode for text that is not a plain chat line (/me, /tts): refused until the
     * streamer approves the address (plain chat lines are held for review in handleChatMessage).
     */
    _awaitingIpApproval(ws, client, modStreamId) {
        if (!modStreamId || !client.ip) return false;
        try {
            const stream = ctx.getStreamById(modStreamId);
            const channel = stream?.channel_id ? ctx.getChannelById(stream.channel_id) : (stream ? ctx.getChannelByUserId(stream.user_id) : null);
            if (!channel || !ctx.getChannelModerationSettings(channel.id)?.ip_approval_mode) return false;
            if (client.user && (permissions.isGlobalModOrAbove(client.user) || stream.user_id === client.user.id)) return false;
            if (ctx.isIpApproved(channel.id, client.ip)) return false;
        } catch { return false; }
        this.sendTo(ws, { type: 'system', message: 'This channel has IP approval mode enabled. Commands work once the streamer approves you.' });
        return true;
    }

    /**
     * Before a line is judged in a sub-only room: have the sender's subscription answer. Asks Live
     * (briefly) when there is none yet or when a cached "no" is a few seconds old (they may have just
     * subscribed); a "yes" is served from the cache. Nothing is asked outside sub-only rooms.
     */
    async _warmSubOnly(client) {
        if (!client || !client.user) return;
        const modStreamId = client.streamId || this._moderationStreamFor(client);
        if (!modStreamId || !this._getChannelChatSettings(modStreamId).sub_only) return;
        if (permissions.canModerateStream(client.user, modStreamId)) return;
        const ownerId = ctx.getStreamById(modStreamId)?.user_id || null;
        if (!ownerId || Number(ownerId) === Number(client.user.id)) return;
        const state = ctx.subscriberState(client.user.id, ownerId);
        if (state !== true) await ctx.ensureSubscriber(client.user.id, ownerId, { maxAgeMs: state === false ? 5000 : 0 });
    }

    /** /me and /tts put text in the room: the same rules as a chat line. */
    _commandTextBlocked(ws, client, text) {
        const modStreamId = client.streamId || this._moderationStreamFor(client);
        return this._awaitingIpApproval(ws, client, modStreamId) || this._chatRulesBlock(ws, client, text, modStreamId);
    }

    handleBangCommand(ws, client, text) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();

        // Arena: !hype / !beef / !arena (Live server/arena/arena-chat.js) — chat can only hype; the Arena
        // is pure mic. Live runs the command and answers this socket through the bridge (sendToConn).
        if (ctx.ARENA_COMMANDS.includes(cmd)) { ctx.effects.arenaCommand(client, cmd, parts); return; }

        if (cmd === '!gotti') {
            const username = client.user ? client.user.display_name : client.anonId;
            const coreUsername = client.user ? client.user.username : null;
            const role = client.user ? client.user.role : 'anon';
            const gottiMsg = {
                type: 'gotti',
                username,
                core_username: coreUsername,
                user_id: client.user?.id || null,
                anon_id: client.anonId,
                role,
                stream_id: client.streamId,
                is_global: !client.streamId,
                avatar_url: client.user?.avatar_url || null,
                profile_color: client.user?.profile_color || '#999',
                message: GOTTI_CAPTION,
                gif_url: GOTTI_GIF_URL,
                source_url: 'https://tenor.com/view/deez-something-came-in-the-mail-today-deez-nuts-discord-gif-20388619',
                timestamp: new Date().toISOString(),
            };

            if (client.user?.id) {
                try {
                    const cosmeticProfile = cosmetics.getCosmeticProfile(client.user.id);
                    if (cosmeticProfile.nameFX) gottiMsg.nameFX = cosmeticProfile.nameFX;
                    if (cosmeticProfile.particleFX) gottiMsg.particleFX = cosmeticProfile.particleFX;
                    if (cosmeticProfile.hatFX) gottiMsg.hatFX = cosmeticProfile.hatFX;
                } catch { /* non-critical */ }

                try {
                    const tagProfile = tags.getTagProfile(client.user.id);
                    if (tagProfile) gottiMsg.tag = tagProfile;
                } catch { /* non-critical */ }
            }

            if (client.streamId) {
                this.broadcastToStream(client.streamId, gottiMsg);
                this.forwardToGlobal(client.streamId, gottiMsg);
            } else {
                this.broadcastGlobal(gottiMsg);
            }
            return;
        }

        if (cmd === '!sb') {
            if (!client.streamId) {
                this.sendTo(ws, { type: 'system', message: 'Soundboard commands only work in a stream chat.' });
                return;
            }
            const chatSettings = this._getChannelChatSettings(client.streamId);
            if (chatSettings.soundboard_enabled === 0) {
                this.sendTo(ws, { type: 'system', message: 'This streamer has disabled 101soundboards in chat.' });
                return;
            }
            const sbArgs = text.slice(parts[0].length).trim();
            const parsed = soundboard.parseSoundboardMessage(`!sb ${sbArgs}`, {
                allowPitch: chatSettings.soundboard_allow_pitch !== 0,
                allowSpeed: chatSettings.soundboard_allow_speed !== 0,
            });
            if (!parsed) {
                this.sendTo(ws, { type: 'system', message: 'Usage: !sb <sound-id or 101soundboards URL> [100p|-100p] [0.5-3 speed]' });
                return;
            }
            this.processSoundboard(ws, client, text);
            return;
        }

        if (!client.streamId) {
            this.sendTo(ws, { type: 'system', message: 'Media request commands only work in a stream chat.' });
            return;
        }

        const args = text.slice(parts[0].length).trim();

        try {
            const stream = ctx.getStreamById(client.streamId);
            if (!stream?.user_id) {
                this.sendTo(ws, { type: 'system', message: 'Could not resolve the current stream owner.' });
                return;
            }

            // The media queue is Live's (server/media/media-queue.js: gold payment, playback,
            // the streamer's overlay). Chat keeps the commands and asks Live to act.
            const mediaFailed = (err, fallback) => this.sendTo(ws, { type: 'system', message: (err && err.message) || fallback });

            switch (cmd) {
                case '!sr':
                case '!yt':
                case '!youtube':
                case '!req':
                case '!request': {
                    if (!client.user?.id) {
                        this.sendTo(ws, { type: 'system', message: 'You must be logged in to request media.' });
                        return;
                    }

                    ctx.effects.mediaQueue('add', {
                        streamerId: stream.user_id,
                        streamId: client.streamId,
                        userId: client.user.id,
                        username: client.user.display_name || client.user.username,
                        input: args,
                    }).then(({ request }) => {
                        this.broadcastToStream(client.streamId, {
                            type: 'system',
                            message: `${request.username} added “${request.title}”${request.duration_seconds ? ` (${Math.floor(request.duration_seconds / 60)}m${request.duration_seconds % 60}s)` : ''} to the media queue for ${request.cost} gold.`,
                            timestamp: new Date().toISOString(),
                        });
                        this.sendTo(ws, {
                            type: 'coin_earned',
                            coins: 0,
                            currency: 'gold',
                            total: null, // client refreshes via /api/coins/balance (network wallet)
                            reason: 'Media request purchase',
                        });
                    }).catch((err) => {
                        this.sendTo(ws, { type: 'system', message: err.message || 'Failed to add media request.' });
                    });
                    return;
                }

                case '!queue': {
                    ctx.effects.mediaQueue('state', { streamerId: stream.user_id }).then(({ state }) => {
                        const items = state.queue.slice(0, 3);
                        if (!items.length) {
                            this.sendTo(ws, { type: 'system', message: 'The media queue is empty. Use !sr, !yt, !youtube, !req, or !request with a URL to queue something.' });
                            return;
                        }
                        const summary = items.map((item, index) => `#${index + 1} ${item.title}`).join(' • ');
                        this.sendTo(ws, { type: 'system', message: `Queued: ${summary}` });
                    }).catch((err) => mediaFailed(err, 'Media command failed.'));
                    return;
                }

                case '!np':
                case '!nowplaying':
                case '!watching': {
                    ctx.effects.mediaQueue('state', { streamerId: stream.user_id }).then(({ state }) => {
                        if (state.now_playing) {
                            const np = state.now_playing;
                            const durText = np.duration_seconds ? ` [${Math.floor(np.duration_seconds / 60)}m${np.duration_seconds % 60}s]` : '';
                            this.sendTo(ws, { type: 'system', message: `Now playing: ${np.title}${durText} (requested by ${np.username})` });
                        } else if (state.queue[0]) {
                            this.sendTo(ws, { type: 'system', message: `Nothing is playing yet. Up next: ${state.queue[0].title}` });
                        } else {
                            this.sendTo(ws, { type: 'system', message: 'Nothing is playing right now.' });
                        }
                    }).catch((err) => mediaFailed(err, 'Media command failed.'));
                    return;
                }

                case '!skip': {
                    if (!this.canModerate(client) && client.user?.id !== stream.user_id) {
                        this.sendTo(ws, { type: 'system', message: 'Only the streamer or a moderator can skip media.' });
                        return;
                    }
                    // Live runs finishCurrent(streamer, 'skipped') then startNext(streamer).
                    ctx.effects.mediaQueue('skip', { streamerId: stream.user_id, actorUserId: client.user?.id || null }).then(({ ended, next }) => {
                        if (ended) {
                            this.broadcastToStream(client.streamId, {
                                type: 'system',
                                message: `Skipped: ${ended.title}${next ? ` • Up next: ${next.title}` : ''}`,
                                timestamp: new Date().toISOString(),
                            });
                        } else {
                            this.sendTo(ws, { type: 'system', message: 'Nothing is currently playing.' });
                        }
                    }).catch((err) => mediaFailed(err, 'Media command failed.'));
                    return;
                }

                case '!mediahelp': {
                    this.sendTo(ws, { type: 'system', message: 'Media commands: !sr/!yt/!youtube/!req/!request <url>, !queue, !nowplaying, !skip' });
                    return;
                }

                // ── Cozmo robot commands ───────────────
                // The robot's control socket lives in Live (controls/control-server.js), keyed by
                // the streamer's stream key; Live delivers the command.
                case '!forward':
                case '!backward':
                case '!left':
                case '!right':
                case '!liftup':
                case '!liftdown':
                case '!headup':
                case '!headdown': {
                    const cozmoMap = {
                        '!forward': 'forward', '!backward': 'backward',
                        '!left': 'turn_left', '!right': 'turn_right',
                        '!liftup': 'lift_up', '!liftdown': 'lift_down',
                        '!headup': 'head_up', '!headdown': 'head_down',
                    };
                    this._hardwareCommand(ws, stream, cozmoMap[cmd], client);
                    return;
                }

                case '!say': {
                    if (!args) return;
                    this._hardwareCommand(ws, stream, `say:${args.slice(0, 200)}`, client);
                    return;
                }

                default:
                    // Unknown !command → try a per-channel viewer-uploaded sound clip.
                    // Forward trailing tokens (e.g. "500p", "0.5") as pitch/speed args.
                    this.triggerChannelSound(ws, client, stream, cmd.slice(1), parts.slice(1));
                    return;
            }
        } catch (err) {
            this.sendTo(ws, { type: 'system', message: err.message || 'Media command failed.' });
        }
    }

    /** Send a command to the streamer's hardware client (Live). Silent when the streamer is unknown. */
    _hardwareCommand(ws, stream, command, client) {
        ctx.effects.hardwareCommand(stream.user_id, command, client.user?.display_name || `anon${client.anonId || ''}`).then((r) => {
            if (r && r.ok) return;
            if (r && r.reason === 'no_hardware') this.sendTo(ws, { type: 'system', message: 'No hardware client connected.' });
        }).catch((err) => {
            this.sendTo(ws, { type: 'system', message: err.message || 'Media command failed.' });
        });
    }

    /**
     * Play a per-channel viewer-uploaded sound clip (triggered by !command).
     * Silent no-op when the command is not a registered sound so unknown
     * commands don't spam the chat.
     */
    triggerChannelSound(ws, client, stream, command, args = [], relay = null) {
        try {
            if (!stream?.user_id || !command) return;
            const cmd = String(command).toLowerCase();
            const sound = db.getChannelSoundByCommand(stream.user_id, cmd);
            if (!sound) return; // not a sound command — stay silent

            const chatSettings = this._getChannelChatSettings(client.streamId);
            if (chatSettings.custom_sounds_enabled === 0) {
                if (ws) this.sendTo(ws, { type: 'system', message: 'This streamer has disabled chat sound commands.' });
                return;
            }

            // Pitch/speed args (e.g. "!honk 500p 0.5"), clamped to the channel's limits.
            const mods = soundboard.parseModifiers(args || [], {
                allowPitch: chatSettings.soundboard_allow_pitch !== 0,
                allowSpeed: chatSettings.soundboard_allow_speed !== 0,
                minSpeed: chatSettings.sound_min_speed,
                maxSpeed: chatSettings.sound_max_speed,
                minPitch: chatSettings.sound_min_pitch_rate,
                maxPitch: chatSettings.sound_max_pitch_rate,
            });

            // Banned users can't trigger sounds
            if (client.user && ctx.isUserBanned(client.user.id, client.streamId)) return;
            if (client.ip && !this._isBanExemptAdmin(client) && ctx.isIpBanned(client.ip, client.streamId)) return;

            // Rate limits — reuse the soundboard limiter (per-user + per-stream window)
            const now = Date.now();
            const rateKey = `${client.streamId}:${relay ? `rs${relay.username}` : (client.user ? `u${client.user.id}` : `a${client.anonId}`)}`;
            const lastUsedAt = this.soundboardRateLimits.get(rateKey) || 0;
            if ((now - lastUsedAt) < SOUNDBOARD_RATE_LIMIT_MS) {
                const remaining = Math.ceil((SOUNDBOARD_RATE_LIMIT_MS - (now - lastUsedAt)) / 1000);
                if (ws) this.sendTo(ws, { type: 'system', message: `Wait ${remaining}s before triggering another sound.` });
                return;
            }
            const streamWindow = this.soundboardStreamLimits.get(client.streamId) || { count: 0, windowStart: now };
            if ((now - streamWindow.windowStart) >= SOUNDBOARD_STREAM_WINDOW_MS) {
                streamWindow.count = 0;
                streamWindow.windowStart = now;
            }
            if (streamWindow.count >= SOUNDBOARD_STREAM_MAX_PER_WINDOW) {
                if (ws) this.sendTo(ws, { type: 'system', message: 'Too many sounds are playing right now — try again shortly.' });
                return;
            }

            // The clip is read when its turn in the room's audio queue comes.
            if (!sound.url || !fs.existsSync(sound.url)) return;

            this.soundboardRateLimits.set(rateKey, now);
            streamWindow.count += 1;
            this.soundboardStreamLimits.set(client.streamId, streamWindow);

            const username = relay ? relay.username
                : (client.user ? (client.user.display_name || client.user.username) : (client.anonId || 'someone'));

            // Announce as a RICH chat message (same identity/cosmetics/tag as a normal
            // message) so it shows the user's nametag, badges, avatar and cosmetics —
            // not a plain "x played !command" text line.
            const soundMsg = {
                type: 'chat',
                username,
                core_username: relay ? null : (client.user ? client.user.username : null),
                user_id: client.user?.id || null,
                anon_id: relay ? null : client.anonId,
                role: relay ? (relay.role || 'external') : (client.user ? client.user.role : 'anon'),
                message: `played !${cmd}`,
                message_type: 'channel-sound',
                sound: { command: cmd, pitch: mods.pitch, speed: mods.speed, pitchShift: mods.pitchShift, args: (args || []).join(' '), emoteCode: sound.emote_code || '' },
                stream_id: client.streamId,
                is_global: !client.streamId,
                avatar_url: (relay ? relay.avatar_url : client.user?.avatar_url) || null,
                profile_color: (relay ? relay.profile_color : client.user?.profile_color) || '#999',
                source_platform: relay ? relay.sourcePlatform : undefined,
                timestamp: new Date().toISOString(),
            };
            if (!relay && client.user?.id) {
                try {
                    const cp = cosmetics.getCosmeticProfile(client.user.id);
                    if (cp.nameFX) soundMsg.nameFX = cp.nameFX;
                    if (cp.particleFX) soundMsg.particleFX = cp.particleFX;
                    if (cp.hatFX) soundMsg.hatFX = cp.hatFX;
                } catch { /* non-critical */ }
                try {
                    const tagProfile = tags.getTagProfile(client.user.id);
                    if (tagProfile) soundMsg.tag = tagProfile;
                } catch { /* non-critical */ }
            }
            // Persist the announce so it survives a reload — history rebuilds the
            // rich sound row from metadata (the audio itself is never replayed).
            try {
                const saved = db.saveChatMessage({
                    stream_id: client.streamId || null,
                    channel_user_id: stream.user_id,
                    user_id: client.user?.id,
                    anon_id: relay ? null : client.anonId,
                    username,
                    message: soundMsg.message,
                    message_type: 'channel-sound',
                    is_global: false,
                    source_platform: relay ? relay.sourcePlatform : null,
                    metadata: { sound: soundMsg.sound },
                });
                if (saved.lastInsertRowid) soundMsg.id = Number(saved.lastInsertRowid);
            } catch { /* non-critical */ }
            this.broadcastToStream(client.streamId, soundMsg);
            // Also surface it on the global chat feed / global overlay (with stream_channel).
            this.forwardToGlobal(client.streamId, soundMsg);
            audioQueue.enqueue({
                kind: 'channel-sound',
                streamId: client.streamId,
                requestedBy: username,
                identityKey: relay ? `relay:${relay.username}` : (client.user ? `user:${client.user.username}` : `anon:${client.anonId}`),
                label: `!${cmd}`,
                payload: { username, title: `!${cmd}`, file: sound.url, mimeType: sound.mime || 'audio/mpeg', seconds: Number(sound.duration_seconds) || 0, pitch: mods.pitch, speed: mods.speed, pitchShift: mods.pitchShift },
                dedupeKey: soundMsg.id ? `m${soundMsg.id}` : null,
            });
        } catch (err) {
            console.error('[ChannelSound] trigger error:', err.message);
        }
    }

    /**
     * Handle chat commands
     */
    handleCommand(ws, client, text) {
        const parts = text.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        const argParts = parts.slice(1);

        switch (cmd) {
            case 'ai': {
                // /ai pause|resume|mute <bot>|unmute <bot>|status — channel mods + owner only.
                if (!this.canModerate(client)) { this.sendTo(ws, { type: 'system', message: 'Only moderators can control the AI viewers.' }); return; }
                // Live's ai-chatbot-service.onModCommand answers (AI viewers stay in Live until OpenVibe.AI).
                ctx.effects.aiModCommand(client.channelUserId, client.streamId, parts.slice(1), { by: client.user?.username })
                    .then((reply) => this.sendTo(ws, { type: 'system', message: reply || 'ok' }))
                    .catch((e) => this.sendTo(ws, { type: 'system', message: `AI viewers: ${e.message}` }));
                return;
            }
            case 'help':
                this.sendTo(ws, {
                    type: 'system',
                    message: `Commands: /help, /tts <message>, /color <#hex>, /viewers, /uptime, /me <action>, /paste <content>` +
                        `\nMedia: !sr/!yt/!youtube/!req/!request <url>, !queue, !nowplaying` +
                        (this.canModerate(client)
                            ? `\nMod: /ban <user>, /unban <user>, /timeout <user> [seconds], /clear (screens only), /slow <seconds|off>, /subonly [off], /skiptts [id], /cleartts`
                            : ''),
                });
                break;

            case 'tts':
                if (!args) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /tts <message>' });
                    return;
                }
                if (this._commandTextBlocked(ws, client, args)) return;
                {
                    const ttsMsg = {
                        type: 'tts',
                        username: client.user?.display_name || client.anonId,
                        core_username: client.user?.username || null,
                        user_id: client.user?.id || null,
                        message: args,
                        timestamp: new Date().toISOString(),
                    };
                    // Attach voice cosmetic if equipped
                    let voiceFX = null;
                    if (client.user?.id) {
                        try {
                            const cp = cosmetics.getCosmeticProfile(client.user.id);
                            if (cp.voiceFX) {
                                ttsMsg.voiceFX = cp.voiceFX;
                                voiceFX = cp.voiceFX;
                            }
                        } catch { /* non-critical */ }
                    }
                    this._broadcastToRoom(client, ttsMsg);

                    // Also synthesize server-side TTS for site-wide mode
                    this.synthesizeAndBroadcastTTS(
                        client.streamId,
                        ttsMsg.username,
                        args,
                        voiceFX,
                        null,
                        client.user ? `user:${client.user.username}` : `anon:${client.anonId}`
                    );
                }
                break;

            case 'color':
                if (!client.user) {
                    this.sendTo(ws, { type: 'system', message: 'You must be logged in to change color.' });
                } else if (!args || !/^#[0-9a-fA-F]{6}$/.test(args)) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /color #ff00ff (hex color code)' });
                } else {
                    // users.profile_color is Live's: Live writes it, then this socket uses it at once.
                    ctx.effects.setUserColor(client.user.id, args).then(() => {
                        client.user.profile_color = args;
                        this.sendTo(ws, { type: 'system', message: `Color set to ${args}` });
                    }).catch(() => this.sendTo(ws, { type: 'system', message: 'Could not change your color right now. Try again.' }));
                }
                break;

            case 'viewers': {
                const count = this.getStreamViewerCount(client.streamId);
                this.sendTo(ws, { type: 'system', message: `${count} viewer(s) in chat` });
                break;
            }

            case 'uptime': {
                if (!client.streamId) {
                    this.sendTo(ws, { type: 'system', message: 'Not in a stream chat.' });
                    break;
                }
                try {
                    const stream = ctx.getStreamById(client.streamId);
                    if (stream && stream.started_at) {
                        const start = new Date(stream.started_at.replace(' ', 'T') + 'Z').getTime();
                        const elapsed = Date.now() - start;
                        const hours = Math.floor(elapsed / 3600000);
                        const minutes = Math.floor((elapsed % 3600000) / 60000);
                        const seconds = Math.floor((elapsed % 60000) / 1000);
                        const parts = [];
                        if (hours > 0) parts.push(`${hours}h`);
                        parts.push(`${minutes}m`);
                        parts.push(`${seconds}s`);
                        this.sendTo(ws, { type: 'system', message: `Stream uptime: ${parts.join(' ')}` });
                    } else {
                        this.sendTo(ws, { type: 'system', message: 'Stream is offline.' });
                    }
                } catch {
                    this.sendTo(ws, { type: 'system', message: 'Could not determine uptime.' });
                }
                break;
            }

            case 'w':
            case 'whisper':
            case 'msg': {
                this.sendTo(ws, { type: 'system', message: 'Whispers have been replaced by DMs! Click the message icon in the navbar to open Messenger.' });
                break;
            }

            case 'me': {
                if (!args) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /me <action>' });
                    break;
                }
                if (this._commandTextBlocked(ws, client, args)) break;
                const username = client.user?.display_name || client.anonId;
                this._broadcastToRoom(client, {
                    type: 'chat',
                    username,
                    core_username: client.user?.username || null,
                    user_id: client.user?.id || null,
                    role: client.user?.role || 'anon',
                    message: `* ${username} ${args}`,
                    is_action: true,
                    timestamp: new Date().toISOString(),
                });
                break;
            }

            case 'ban':
                this.handleModAction(ws, client, 'ban', args);
                break;

            case 'unban':
                this.handleModAction(ws, client, 'unban', args);
                break;

            case 'timeout':
                this.handleModAction(ws, client, 'timeout', args);
                break;

            case 'skiptts':
            case 'cleartts': {
                // The room's TTS and sound queue (./audio-queue.js): moderators and the broadcaster.
                // /skiptts [request id] skips the clip playing now (or that request); /cleartts
                // skips everything playing or waiting.
                if (!this.canModerate(client)) { this.sendTo(ws, { type: 'system', message: 'You do not have permission.' }); return; }
                const room = audioQueue.roomKey({ streamId: client.streamId, channelUserId: client.streamId ? null : client.channelUserId });
                if (!room) { this.sendTo(ws, { type: 'system', message: 'No TTS or sounds here.' }); return; }
                const actor = client.user ? `user:${client.user.username}` : null;
                if (cmd === 'skiptts') {
                    const id = parseInt(argParts[0], 10);
                    const skipped = audioQueue.skip(room, { id: Number.isFinite(id) && id > 0 ? id : null, actor });
                    this.sendTo(ws, { type: 'system', message: skipped ? `Skipped ${skipped.kind === 'tts' ? 'TTS' : 'sound'} #${skipped.id}${skipped.requested_by ? ` from ${skipped.requested_by}` : ''}.` : 'Nothing to skip.' });
                    if (skipped) this.logChatModeration(client, 'tts_skip', { request_id: skipped.id, kind: skipped.kind });
                } else {
                    const ids = audioQueue.clear(room, { actor });
                    this.sendTo(ws, { type: 'system', message: ids.length ? `Cleared ${ids.length} TTS/sound request${ids.length === 1 ? '' : 's'}.` : 'The TTS and sound queue is empty.' });
                    if (ids.length) this.logChatModeration(client, 'tts_clear', { request_ids: ids });
                }
                return;
            }

            case 'clear':
                // Twitch semantics: every screen in the room is cleared, nothing is deleted. Removing
                // lines for good is a purge (dashboard) or a delete.
                if (this.canModerate(client)) {
                    this._broadcastToRoom(client, { type: 'clear' });
                    this.sendTo(ws, { type: 'system', message: 'Chat cleared on screen; messages stay in history — use purge to remove them.' });
                    this.logChatModeration(client, client.streamId ? 'clear_chat' : 'clear_global_chat');
                } else {
                    this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
                }
                break;

            case 'slow': {
                if (!this.canModerate(client)) { this.sendTo(ws, { type: 'system', message: 'You do not have permission.' }); break; }
                let seconds;
                if (args === 'off' || args === 'disable' || args === '0') {
                    seconds = 0;
                } else {
                    seconds = parseInt(args);
                    if (!Number.isFinite(seconds) || seconds < 0) seconds = 3;
                }
                this._setChannelModes(ws, client, { slow_mode_seconds: seconds }, 'slow mode')
                    .then((ok) => { if (ok) this.logChatModeration(client, 'slowmode_update', { seconds }); });
                break;
            }

            case 'subonly': {
                // /subonly [on] · /subonly off — the streamer, channel mods and chat staff.
                if (!this.canModerate(client)) { this.sendTo(ws, { type: 'system', message: 'You do not have permission.' }); break; }
                const off = ['off', 'disable', '0', 'false', 'no'].includes(String(args || '').trim().toLowerCase());
                this._setChannelModes(ws, client, { sub_only: off ? 0 : 1 }, 'sub-only mode')
                    .then((ok) => { if (ok) this.logChatModeration(client, 'subonly_update', { enabled: !off }); });
                break;
            }

            case 'paste': {
                // /paste <content> — create a quick paste from chat
                if (!args.trim()) {
                    this.sendTo(ws, { type: 'system', message: 'Usage: /paste <content to share>' });
                    break;
                }
                {
                    const title = `Chat paste by ${client.username || client.displayName || 'anon'}`;
                    const userId = client.userId || client.user?.id || null;
                    // Pastes: Live's pastes-client posts them (OpenVibe.Community / Media per PASTES_AUTHORITY).
                    ctx.effects.createPaste({
                        title,
                        content: args.trim(),
                        language: 'auto',
                        visibility: 'public',
                        user_id: userId || undefined,
                        stream_id: client.streamId || undefined,
                    }).then((paste) => {
                        const siteUrl = process.env.SITE_URL || '';
                        const pasteUrl = `${siteUrl}/p/${paste.slug}`;
                        // Show link to everyone in stream
                        this._broadcastToRoom(client, {
                            type: 'system',
                            message: `📋 ${client.displayName || client.username || 'Anonymous'} shared a paste: ${pasteUrl}`,
                        });
                    }).catch((err) => {
                        console.error('[Chat] /paste error:', err.message);
                        this.sendTo(ws, { type: 'system', message: 'Failed to create paste.' });
                    });
                }
                break;
            }

            default:
                this.sendTo(ws, { type: 'system', message: `Unknown command: /${cmd}. Type /help for a list.` });
        }
    }

    /**
     * Handle mod actions (ban, unban, timeout)
     */
    handleModAction(ws, client, action, args) {
        this._handleModAction(ws, client, action, args).catch((err) => {
            console.warn(`[Chat] /${action} failed:`, err.message);
            this.sendTo(ws, { type: 'system', message: err.status === 403 ? 'You do not have permission.' : `Could not ${action} right now. Try again.` });
        });
    }

    /**
     * The bans table is Live's (OpenVibe.Network policy later): Chat decides as before, Live writes
     * the row (re-checking the moderator) and Chat's ban cache is refreshed before the reply.
     */
    async _handleModAction(ws, client, action, args) {
        if (!this.canModerate(client)) {
            this.sendTo(ws, { type: 'system', message: 'You do not have permission.' });
            return;
        }

        const target = args.split(' ')[0];
        if (!target) return;
        // The stream whose moderators may do this (offline channel rooms: the latest stream).
        const moderationStreamId = client.streamId || this._moderationStreamFor(client);
        // Where the ban applies. In an offline channel room it is that channel's stream: a null
        // stream id is a SITE-WIDE ban row (and /unban with null lifts site-wide rows), which
        // only global chat — where canModerate() already requires global staff — may write.
        const scopeStreamId = client.streamId || (client.channelUserId ? moderationStreamId : null);
        const banEffect = (row) => ctx.effects.ban({ ...row, stream_id: scopeStreamId, actor_user_id: client.user.id, moderation_stream_id: moderationStreamId });
        const scoped = !!scopeStreamId;

        switch (action) {
            case 'ban': {
                const targetUser = await ctx.ensureUserByUsername(target);
                if (targetUser) {
                    // Prevent non-admins from banning admins
                    if (permissions.isGlobalModOrAbove(targetUser) && targetUser.role === 'admin' && !permissions.isAdmin(client.user)) {
                        this.sendTo(ws, { type: 'system', message: 'You cannot ban an admin.' });
                        return;
                    }
                    await banEffect({ action: 'ban', user_id: targetUser.id, reason: 'Banned by moderator', banned_by: client.user.id });
                    this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    this._broadcastToRoom(client, {
                        type: 'system', message: `${target} has been banned.`
                    });
                    this.logChatModeration(client, scoped ? 'channel_ban' : 'site_ban', { username: targetUser.username }, targetUser.id);
                } else {
                    // Ban by anon ID
                    const anonTarget = this.findClientByAnonId(target, client.streamId);
                    if (anonTarget) {
                        await banEffect({ action: 'ban', ip_address: anonTarget.ip, anon_id: target, reason: 'Banned by moderator', banned_by: client.user.id });
                        this.sendTo(ws, { type: 'system', message: `${target} has been banned.` });
                    }
                    this.logChatModeration(client, scoped ? 'channel_anon_ban' : 'site_anon_ban', { anon_id: target });
                }
                break;
            }
            case 'timeout': {
                const duration = parseInt(args.split(' ')[1]) || 300; // Default 5 min
                const targetUser = await ctx.ensureUserByUsername(target);
                const expires = new Date(Date.now() + duration * 1000).toISOString();
                if (targetUser) {
                    await banEffect({ action: 'ban', user_id: targetUser.id, reason: `Timeout ${duration}s`, banned_by: client.user.id, expires_at: expires });
                    this.logChatModeration(client, scoped ? 'channel_timeout' : 'site_timeout', { username: targetUser.username, duration }, targetUser.id);
                }
                this.sendTo(ws, { type: 'system', message: `${target} timed out for ${duration}s.` });
                break;
            }
            case 'unban': {
                const targetUser = await ctx.ensureUserByUsername(target);
                if (targetUser) {
                    await banEffect({ action: 'unban', user_id: targetUser.id });
                    this.logChatModeration(client, scoped ? 'channel_unban' : 'site_unban', { username: targetUser.username }, targetUser.id);
                }
                this.sendTo(ws, { type: 'system', message: `${target} has been unbanned.` });
                break;
            }
        }
    }

    // ── Helper methods ───────────────────────────────────────
    /**
     * Synthesize TTS audio for a chat message and broadcast to stream.
     * Runs asynchronously — does not block message delivery.
     */
    // Is the channel owner connected to their OWN channel room right now? Gates
    // offline-channel TTS synthesis so we never pay for audio nobody will hear.
    _channelOwnerInRoom(channelUserId) {
        if (!channelUserId) return false;
        for (const [ws, client] of this.clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (client.user && Number(client.user.id) === Number(channelUserId)
                && Number(client.channelUserId) === Number(channelUserId)) return true;
        }
        return false;
    }

    // TTS audio delivery: to the stream room while live, to the CHANNEL room for
    // offline channel chat (streamId null).
    _broadcastTtsPayload(streamId, channelUserId, payload) {
        if (streamId) this.broadcastToStream(streamId, payload);
        else if (channelUserId) this.broadcastToChannelRoom(channelUserId, null, payload);
    }

    // streamId may be null for OFFLINE channel chat — pass channelUserId instead and
    // the audio is delivered to the channel room rather than a stream room.
    //
    // Queues the utterance (./audio-queue.js); it is synthesized and sent when its turn comes.
    // Returns the queue's answer ({ queued, id } or { queued: false, reason }) or undefined when
    // the message is not read at all.
    synthesizeAndBroadcastTTS(streamId, username, text, voiceFX, sourcePlatform = null, identityKey = null, channelUserId = null, ttsKey = null) {
        // Queue accounting key: per-stream when live, per-channel when offline.
        const queueKey = streamId || (channelUserId ? `ch:${channelUserId}` : null);
        // Duplicate suppression by MESSAGE IDENTITY, not content: the same chat
        // message synthesized twice (duplicated bridge, double-fired relay) is a dupe;
        // a user legitimately typing the same text again is NOT and must be read
        // again. Callers pass ttsKey (the persisted message id) — the queue keeps it, so a keyed
        // message is queued once per room even across a restart. The content fallback for
        // id-less paths uses a 2s window — wide enough for a racing double delivery, far too
        // narrow to eat a real repeat.
        if (!ttsKey) {
            if (!this._recentTtsDedupe) this._recentTtsDedupe = new Map();
            const dedupeKey = `${queueKey}|${identityKey || username}|${String(text).slice(0, 200)}`;
            const nowMs = Date.now();
            const lastMs = this._recentTtsDedupe.get(dedupeKey);
            if (lastMs && nowMs - lastMs < 2000) { console.log(`[TTS] deduped duplicate synth for ${username} in ${queueKey} (same content <2s)`); return; }
            this._recentTtsDedupe.set(dedupeKey, nowMs);
            if (this._recentTtsDedupe.size > 500) {
                for (const [k, t] of this._recentTtsDedupe) if (nowMs - t > 60000) this._recentTtsDedupe.delete(k);
            }
        }
        try {
            // "." prefix = user opted this message out of TTS — never synthesize or broadcast it.
            if (String(text || '').trimStart().startsWith('.')) return;

            const settings = ttsEngine.getTTSSettings();
            if (!settings.enabled) return;

            const limits = ttsEngine.getQueueLimits();
            const r = audioQueue.enqueue({
                kind: 'tts',
                streamId: streamId || null,
                channelUserId: streamId ? null : channelUserId,
                requestedBy: username || null,
                identityKey: identityKey || null,
                label: String(text || '').slice(0, 300),
                payload: { streamId: streamId || null, channelUserId: channelUserId || null, username, text, voiceFX: voiceFX || null, sourcePlatform: sourcePlatform || null, identityKey: identityKey || null, ttsKey: ttsKey || null },
                dedupeKey: ttsKey ? `tts:${ttsKey}` : null,
                maxRoom: limits.maxGlobal,
                maxPerRequester: limits.maxPerUser,
            });
            if (!r.queued && r.reason === 'duplicate') console.log(`[TTS] deduped duplicate synth for ${username} in ${queueKey} (same message id)`);
            return r;
        } catch (err) {
            console.error('[TTS] queue error:', err.message);
        }
    }

    /** The queue's TTS performer: synthesize now, return the tts-audio frame (./audio-queue.js). */
    async _makeTtsAudio(p) {
        const settings = ttsEngine.getTTSSettings();
        if (!settings.enabled) throw new Error('TTS is disabled');

        // Determine voice ID from equipped cosmetic
        let voiceId = null;
        if (p.voiceFX?.itemId && ttsEngine.VOICE_CATALOG[p.voiceFX.itemId]) {
            voiceId = p.voiceFX.itemId;
        }

        // Honor the channel's configured TTS length (streamers can raise it up to 1200);
        // falls back to the site default when unset. Without this the server synth always
        // truncated at the global 200 even when the channel allowed more.
        let ttsMaxOverride;
        try { ttsMaxOverride = Number(this._getChannelChatSettings(p.streamId).tts_max_length) || undefined; } catch { /* use engine default */ }

        let result;
        if (!voiceId && settings.perUserVoices) {
            // No equipped cosmetic voice → give this chatter a stable per-username voice.
            const idKey = p.identityKey || p.username || 'anon';
            result = await ttsEngine.synthesizeUserVoice(p.text, idKey, p.username, ttsMaxOverride);
        } else {
            result = await ttsEngine.synthesize(p.text, voiceId || settings.defaultVoice, p.username, ttsMaxOverride);
        }
        if (!result) return null;

        return {
            durationMs: audioQueue.estimatePlayMs({ audio: result.audio, mimeType: result.mimeType }),
            frame: {
                type: 'tts-audio',
                username: p.username,
                // Stable sender identity ("user:<login>" / "anon:<id>") so clients can
                // skip their OWN message's TTS locally — senders were hearing their
                // message twice (their tab + the stream audio).
                sender_key: p.identityKey || undefined,
                // Unique per utterance — clients dedupe playback on this, so identical
                // TEXT from separate messages still reads every time.
                ttsKey: p.ttsKey || undefined,
                message: p.text,
                audio: result.audio,
                mimeType: result.mimeType,
                engine: result.engine,
                voiceName: result.voiceName,
                voiceId: result.voiceId,
                fallback: result.fallback || false,
                source_platform: p.sourcePlatform || undefined,
                timestamp: new Date().toISOString(),
            },
        };
    }

    /** The queue's channel !sound performer: read the clip now, return the soundboard-audio frame. */
    async _makeChannelSoundAudio(p) {
        if (!p.file || !fs.existsSync(p.file)) throw new Error('sound file missing');
        const audio = (await fs.promises.readFile(p.file)).toString('base64');
        return {
            durationMs: audioQueue.estimatePlayMs({ audio, mimeType: p.mimeType, seconds: p.seconds, speed: p.speed }),
            frame: {
                type: 'soundboard-audio',
                username: p.username,
                title: p.title,
                audio,
                mimeType: p.mimeType || 'audio/mpeg',
                pitch: p.pitch,
                speed: p.speed,
                pitchShift: p.pitchShift,
                source: 'channel-sound',
                timestamp: new Date().toISOString(),
            },
        };
    }

    /** The queue's 101soundboards performer: the clip (cached since the request), as a soundboard-audio frame. */
    async _makeSoundboardAudio(p) {
        const result = await soundboard.getSoundboardAudio(p.soundId);
        if (!result) return null;
        return {
            durationMs: audioQueue.estimatePlayMs({ audio: result.audio, mimeType: result.mimeType, speed: p.speed }),
            frame: {
                type: 'soundboard-audio',
                username: p.username,
                audio: result.audio,
                mimeType: result.mimeType,
                soundId: result.soundId,
                title: result.title,
                sourceUrl: result.sourceUrl,
                pitch: p.pitch,
                speed: p.speed,
                pitchShift: p.pitchShift,
                timestamp: new Date().toISOString(),
            },
        };
    }

    /**
     * Process a chat message for 101soundboards links or !sb commands.
     * Fetches the audio, caches it, and broadcasts to stream clients.
     */
    async processSoundboard(ws, client, text) {
        try {
            if (!soundboard.isConfigured()) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'Soundboard is not configured on this server.' });
                }
                return;
            }

            const streamId = client?.streamId || null;
            if (!streamId) return;

            const chatSettings = this._getChannelChatSettings(streamId);
            if (chatSettings.soundboard_enabled === 0) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'This streamer has disabled 101soundboards in chat.' });
                }
                return;
            }

            const parsed = soundboard.parseSoundboardMessage(text, {
                allowPitch: chatSettings.soundboard_allow_pitch !== 0,
                allowSpeed: chatSettings.soundboard_allow_speed !== 0,
            });
            if (!parsed) return;

            const bannedIds = new Set(soundboard.normalizeBannedIds(chatSettings.soundboard_banned_ids));
            if (bannedIds.has(String(parsed.soundId))) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'That 101soundboards sound is blocked by this streamer.' });
                }
                return;
            }

            const userKey = client.user?.id ? `user:${client.user.id}` : `anon:${client.anonId || client.ip}`;
            const rateKey = `${streamId}:${userKey}`;
            const lastUsedAt = this.soundboardRateLimits.get(rateKey) || 0;
            const now = Date.now();
            if ((now - lastUsedAt) < SOUNDBOARD_RATE_LIMIT_MS) {
                if (String(text || '').trim().startsWith('!sb')) {
                    const remaining = Math.ceil((SOUNDBOARD_RATE_LIMIT_MS - (now - lastUsedAt)) / 1000);
                    this.sendTo(ws, { type: 'system', message: `Wait ${remaining}s before using another soundboard clip.` });
                }
                return;
            }

            // Per-stream global rate limit (15 sounds/min across all users)
            const streamWindow = this.soundboardStreamLimits.get(streamId) || { count: 0, windowStart: now };
            if ((now - streamWindow.windowStart) >= SOUNDBOARD_STREAM_WINDOW_MS) {
                streamWindow.count = 0;
                streamWindow.windowStart = now;
            }
            if (streamWindow.count >= SOUNDBOARD_STREAM_MAX_PER_WINDOW) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'Too many soundboard clips are playing in this stream right now. Try again soon.' });
                }
                return;
            }
            streamWindow.count++;
            this.soundboardStreamLimits.set(streamId, streamWindow);

            const result = await soundboard.getSoundboardAudio(parsed.soundId);
            if (!result) {
                if (String(text || '').trim().startsWith('!sb')) {
                    this.sendTo(ws, { type: 'system', message: 'Could not load that 101soundboards clip.' });
                }
                return;
            }

            this.soundboardRateLimits.set(rateKey, now);

            const username = client.user?.display_name || client.user?.username || client.anonId || 'anon';
            const coreUsername = client.user?.username || null;
            const role = client.user ? client.user.role : 'anon';

            const sbMsg = {
                type: 'chat',
                username,
                core_username: coreUsername,
                user_id: client.user?.id || null,
                anon_id: client.anonId,
                role,
                stream_id: streamId,
                avatar_url: client.user?.avatar_url || null,
                profile_color: client.user?.profile_color || '#999',
                message_type: 'soundboard',
                message: `played ${result.title}`,
                soundboard: {
                    soundId: result.soundId,
                    title: result.title,
                    sourceUrl: result.sourceUrl,
                    pitch: parsed.pitch,
                    speed: parsed.speed,
                    pitchShift: parsed.pitchShift,
                },
                timestamp: new Date().toISOString(),
            };
            // Persist so the announce survives a reload (rebuilt from metadata).
            try {
                const saved = db.saveChatMessage({
                    stream_id: streamId,
                    user_id: client.user?.id,
                    anon_id: client.anonId,
                    username,
                    message: sbMsg.message,
                    message_type: 'soundboard',
                    is_global: false,
                    metadata: { soundboard: sbMsg.soundboard },
                });
                if (saved.lastInsertRowid) sbMsg.id = Number(saved.lastInsertRowid);
            } catch { /* non-critical */ }
            this.broadcastToStream(streamId, sbMsg);

            audioQueue.enqueue({
                kind: 'soundboard',
                streamId,
                requestedBy: username,
                identityKey: client.user ? `user:${client.user.username}` : `anon:${client.anonId}`,
                label: result.title,
                payload: { username, soundId: result.soundId, pitch: parsed.pitch, speed: parsed.speed, pitchShift: parsed.pitchShift },
                dedupeKey: sbMsg.id ? `m${sbMsg.id}` : null,
            });
        } catch (err) {
            if (String(text || '').trim().startsWith('!sb')) {
                this.sendTo(ws, { type: 'system', message: err.message || 'Could not load that 101soundboards clip.' });
            }
            console.error('[Soundboard] Process error:', err.message);
        }
    }

    /**
     * Can this client moderate their current stream's chat?
     * Uses the permission layer: admin, global_mod, stream owner, or channel mod.
     * Streamers do NOT get mod powers in other people's chats.
     */
    canModerate(client) {
        if (!client.user) return false;
        // Offline channel chat: the channel's latest stream stands in (see _moderationStreamFor).
        const sid = client.streamId || this._moderationStreamFor(client);
        return !!sid && permissions.canModerateStream(client.user, sid) || permissions.isGlobalModOrAbove(client.user);
    }

    /** @deprecated Use canModerate(client) — kept temporarily for any external callers */
    isMod(client) {
        return this.canModerate(client);
    }

    findClientByAnonId(anonId, streamId) {
        for (const [, info] of this.clients) {
            if (info.anonId === anonId && info.streamId === streamId) {
                return info;
            }
        }
        return null;
    }

    /**
     * Find the IP address of a connected user by user ID.
     * Returns the IP from their most recent connection, or null if not connected.
     */
    getConnectedUserIp(userId) {
        for (const [, info] of this.clients) {
            if (info.user?.id === userId) return info.ip;
        }
        return null;
    }

    /**
     * Disconnect all WebSocket clients for a given user ID or IP.
     * Used after banning to immediately kick them.
     */
    disconnectUser({ userId, ip, streamId } = {}) {
        for (const [ws, info] of this.clients) {
            const matchUser = userId && info.user?.id === userId;
            const matchIp = ip && info.ip === ip;
            const matchStream = streamId ? info.streamId === streamId : true;
            if ((matchUser || matchIp) && matchStream) {
                this.sendTo(ws, { type: 'system', message: 'You have been banned.' });
                try { ws.close(1000, 'banned'); } catch {}
            }
        }
    }

    findWsByUsername(name, streamId) {
        const nameLower = name.toLowerCase();
        for (const [ws, info] of this.clients) {
            if (info.streamId !== streamId) continue;
            const uname = info.user?.display_name || info.user?.username || info.anonId;
            if (uname && uname.toLowerCase() === nameLower) return ws;
        }
        return null;
    }

    sendTo(ws, data) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
            ws.send(JSON.stringify(data));
        }
    }

    /** sendTo() for a socket Live knows only by its handle (connId) — replies to Live-run commands. */
    sendToConn(connId, data) {
        if (!connId) return false;
        for (const [ws, client] of this.clients) {
            if (client.connId === connId) { this.sendTo(ws, data); return true; }
        }
        return false;
    }

    /** Language a channel lives in ('en' when unknown). Live's i18n decides; cached in live-context. */
    _channelLanguage(channelUserId) {
        if (!channelUserId) return 'en';
        try { return ctx.channelLanguage(channelUserId); } catch { return 'en'; }
    }

    /** A signed-in user's Network subject (the projection's subject_id, else the ctx_users row). */
    _subjectOfUser(user) {
        if (!user) return null;
        return user.subject_id || db.subjectFor(user.id) || null;
    }

    /**
     * A VIP badge that was not cached when its message went out: when the lookup finds one, push
     * it to the same rooms as a 'chat_vip_badge' event (clients attach it to the message by id) and
     * keep it in the row's metadata so history shows it. Fire-and-forget; never throws.
     */
    _followVipBadge(pending, chatMsg, channelUserId, streamId) {
        Promise.resolve(pending).then((badge) => {
            if (!badge || !chatMsg || !chatMsg.id) return;
            const evt = { type: 'chat_vip_badge', id: chatMsg.id, vip_badge: badge, stream_id: streamId || null, channel_user_id: channelUserId || null, timestamp: new Date().toISOString() };
            this.broadcastToChannelRoom(channelUserId, streamId, evt);
            if (streamId) this.forwardToGlobal(streamId, evt);
            else this.forwardToGlobalByChannel(channelUserId, evt);
            try { db.mergeChatMessageMetadata(chatMsg.id, { vip_badge: badge }); } catch { /* */ }
        }).catch(() => { /* no badge */ });
    }

    /**
     * Translate a just-broadcast chat line and push the translation to the same rooms as a
     * 'chat_translation' event (clients attach it under the message by id). Persisted into
     * chat_messages.metadata so history shows it too. Fire-and-forget; never throws.
     */
    _maybeTranslate(chatMsg, channelUserId, streamId) {
        if (!chatMsg || !chatMsg.message || chatMsg.message_type && chatMsg.message_type !== 'chat') return;
        // Live's i18n translates (and answers null when translation is unavailable).
        let chanUid = channelUserId || null;
        if (!chanUid && streamId) { try { chanUid = ctx.getStreamById(streamId)?.user_id || null; } catch { /* */ } }
        const text = String(chatMsg.message).replace(/^\s*\.\s?/, '');   // ".msg" = tts-off marker
        ctx.effects.translate(text, chanUid).then((tr) => {
            if (!tr || !tr.text) return;
            const evt = {
                type: 'chat_translation', id: chatMsg.id || null, from: tr.from, to: tr.to, text: tr.text,
                stream_id: streamId || null, channel_user_id: chanUid, timestamp: new Date().toISOString(),
            };
            this.broadcastToChannelRoom(chanUid, streamId, evt);
            if (streamId) this.forwardToGlobal(streamId, evt);
            else this.forwardToGlobalByChannel(chanUid, evt);
            if (chatMsg.id) { try { db.mergeChatMessageMetadata(chatMsg.id, { translation: tr }); } catch { /* */ } }
        }).catch(() => { /* best-effort */ });
    }

    /**
     * Public chat and blocks (network-blocks.js, one-way): the subjects who blocked the author of a
     * line frame (chat, /me, /tts and its audio), or null — the usual case, everyone gets it.
     * Computed once per frame object, however many rooms it goes to.
     */
    _blockersOf(data) {
        if (!data || typeof data !== 'object' || !LINE_FRAMES.has(data.type)) return null;
        if (this._blockMemo.has(data)) return this._blockMemo.get(data);
        let out = null;
        try {
            let authorId = data.user_id || null;
            if (!authorId && data.type === 'tts-audio' && /^user:/.test(String(data.sender_key || ''))) {
                authorId = ctx.getUserByUsername(String(data.sender_key).slice(5))?.id || null;
            }
            const subject = authorId ? db.subjectFor(authorId) : null;
            const list = subject ? networkBlocks.blockersOf(subject) : [];
            if (list.length) out = new Set(list);
        } catch { out = null; }
        this._blockMemo.set(data, out);
        return out;
    }

    /** Does this socket's person not get the frame (they blocked its author)? */
    _blockedFor(client, blockers) {
        return !!(blockers && client.user && blockers.has(this._subjectOfUser(client.user)));
    }

    /**
     * Deliver to the room a client is in: its stream room when in a stream, its channel room when
     * in an offline channel chat, else pure global chat. broadcastToStream(null) would reach every
     * client without a stream — global chat AND every other channel's offline room.
     */
    _broadcastToRoom(client, data) {
        if (client.streamId) this.broadcastToStream(client.streamId, data);
        else if (client.channelUserId) this.broadcastToChannelRoom(client.channelUserId, null, data);
        else this.broadcastGlobal(data);
    }

    broadcastToStream(streamId, data) {
        const msg = JSON.stringify(data);
        const blockers = this._blockersOf(data);
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE && !this._blockedFor(client, blockers)) {
                ws.send(msg);
            }
        }
    }

    /**
     * Deliver to a streamer's whole channel room: any client in that streamer's
     * channel (`channelUserId`, stable across slots + offline) OR in the specific
     * live-session stream room (`streamId`, for backward-compat with clients that
     * joined before channel rooms existed). Deduped per connection.
     */
    broadcastToChannelRoom(channelUserId, streamId, data) {
        const msg = JSON.stringify(data);
        const blockers = this._blockersOf(data);
        for (const [ws, client] of this.clients) {
            if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_SEND_BACKPRESSURE) continue;
            if (this._blockedFor(client, blockers)) continue;
            const inChannel = channelUserId && client.channelUserId === channelUserId;
            const inStream = streamId && client.streamId === streamId;
            if (inChannel || inStream) ws.send(msg);
        }
    }

    /**
     * Forward an OFFLINE channel message to the homepage global feed, tagged with
     * the channel username (parallels forwardToGlobal but keyed by user id since
     * there's no live session id to resolve).
     */
    forwardToGlobalByChannel(channelUserId, data) {
        if (!channelUserId) return;
        let username = null;
        try { username = ctx.getUserById(channelUserId)?.username; } catch { /* ignore */ }
        if (!username) return;
        const globalMsg = JSON.stringify({ ...data, stream_channel: username, source_channel: username });
        const blockers = this._blockersOf(data);
        for (const [ws, client] of this.clients) {
            if (!client.streamId && !client.channelUserId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE && !this._blockedFor(client, blockers)) {
                ws.send(globalMsg);
            }
        }
    }

    broadcastGlobal(data) {
        const msg = JSON.stringify(data);
        const blockers = this._blockersOf(data);
        for (const [ws, client] of this.clients) {
            // Pure global clients only (see forwardToGlobal) — channel/stream viewers get
            // global activity via their dedicated cross-feed socket, not their main one.
            if (!client.streamId && !client.channelUserId && !client.roomId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE && !this._blockedFor(client, blockers)) {
                ws.send(msg);
            }
        }
    }

    /** Everyone following a chat room (server/rooms/) on this server. */
    broadcastToRoom(roomId, data) {
        const msg = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.roomId === roomId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) ws.send(msg);
        }
    }

    /** A person may no longer read a room (blocked, removed from a private room, left): stop their feed. */
    removeFromRoom(roomId, userId) {
        let n = 0;
        for (const [ws, client] of this.clients) {
            if (client.roomId === roomId && client.user && client.user.id === userId) {
                client.roomId = null; client.roomSlug = null; n++;
                this.sendTo(ws, { type: 'room_left', reason: 'removed' });
            }
        }
        return n;
    }

    /**
     * Notify everyone watching any of a channel owner's live streams that the
     * channel's emotes/sounds changed, so their chat pickers refresh live
     * (no page reload). No-op when the owner has no live streams / viewers.
     */
    broadcastToOwnerStreams(ownerUserId, data) {
        try {
            const streams = ctx.getLiveStreamsByUserId(ownerUserId) || [];
            if (!streams.length) return;
            const ids = new Set(streams.map(s => String(s.id)));
            const msg = JSON.stringify(data);
            for (const [ws, client] of this.clients) {
                if (ids.has(String(client.streamId)) && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                    ws.send(msg);
                }
            }
        } catch { /* ignore */ }
    }

    /**
     * Forward a stream message to all global-connected clients
     * so the global chat feed shows activity from every stream.
     */
    forwardToGlobal(streamId, data) {
        // Look up stream owner username + slot title/slug (cached per stream)
        if (!this._streamNameCache) this._streamNameCache = new Map();
        let info = this._streamNameCache.get(streamId);
        if (!info || typeof info !== 'object') {
            try {
                const stream = ctx.getStreamById(streamId);
                info = {
                    username: stream?.username || `stream-${streamId}`,
                    title: stream?.managed_stream_title || stream?.title || null,
                    slug: stream?.managed_stream_slug || null,
                    managedId: stream?.managed_stream_id || null,
                };
                this._streamNameCache.set(streamId, info);
                // Auto-expire cache after 5 min
                setTimeout(() => this._streamNameCache.delete(streamId), 300000);
            } catch {
                info = { username: `stream-${streamId}`, title: null, slug: null, managedId: null };
            }
        }
        const globalMsg = JSON.stringify({
            ...data,
            stream_channel: info.username,
            source_channel: info.username,
            source_stream_id: streamId,
            source_stream_title: info.title,
            source_slug: info.slug,
            source_managed_id: info.managedId,
            source_is_live: 1, // this path only fires for a live send
        });
        const blockers = this._blockersOf(data);
        for (const [ws, client] of this.clients) {
            if (this._blockedFor(client, blockers)) continue;
            // Only PURE global clients (no stream AND no channel) — otherwise an
            // offline-channel viewer's main socket (streamId null, channelUserId set)
            // would render this via addChatMessage AND get it again as a cross-feed on
            // its dedicated global socket → duplicate. Channel/stream viewers receive the
            // cross-feed exclusively through their separate global-feed connection.
            if (!client.streamId && !client.channelUserId && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE) {
                ws.send(globalMsg);
            }
        }
    }

    /**
     * Deliver a stream message to viewers of the SAME streamer's OTHER live slots
     * ("Show All Chats Under This Streamer"). Tagged with source-slot info so the
     * client can show a stream-title badge + let viewers hop between slots. Only
     * fires when the streamer has 2+ live slots.
     */
    forwardToStreamerRooms(streamId, data) {
        try {
            const stream = ctx.getStreamById(streamId);
            if (!stream || !stream.user_id) return;
            const siblings = ctx.getLiveStreamsByUserId(stream.user_id) || [];
            if (siblings.length < 2) return;
            const siblingIds = new Set(siblings.map(s => s.id));
            const payload = JSON.stringify({
                ...data,
                cross_stream: true,
                source_stream_id: streamId,
                source_stream_title: stream.managed_stream_title || stream.title || null,
                source_slug: stream.managed_stream_slug || null,
                source_managed_id: stream.managed_stream_id || null,
                source_channel: stream.username || null,
                source_is_live: 1,
            });
            const blockers = this._blockersOf(data);
            for (const [ws, client] of this.clients) {
                if (client.streamId && client.streamId !== streamId && siblingIds.has(client.streamId)
                    && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE && !this._blockedFor(client, blockers)) {
                    ws.send(payload);
                }
            }
        } catch { /* non-critical */ }
    }

    _broadcastDeletedMessages(streamId, ids) {
        if (!Array.isArray(ids) || ids.length === 0) return;
        const payload = { type: 'delete-messages', ids };
        if (streamId) {
            // The stream's room, the rest of its channel room (other slots, the offline room, a
            // channel popout) and the global feed: everywhere the lines were shown.
            let ownerId = null;
            try { ownerId = ctx.getStreamById(streamId)?.user_id || null; } catch { ownerId = null; }
            this.broadcastToChannelRoom(ownerId, streamId, payload);
            this.forwardToGlobal(streamId, payload);
            return;
        }
        this.broadcastAll(payload);
    }

    _sweepExpiredChatMessages() {
        try {
            const expired = db.deleteExpiredChatMessages(500);
            if (!expired.length) return;
            const byScope = new Map();
            for (const row of expired) {
                const key = row.stream_id ? `stream:${row.stream_id}` : 'global';
                if (!byScope.has(key)) byScope.set(key, []);
                byScope.get(key).push(row.id);
            }
            for (const [key, ids] of byScope.entries()) {
                const streamId = key === 'global' ? null : parseInt(key.split(':')[1], 10);
                this._broadcastDeletedMessages(streamId, ids);
            }
        } catch (err) {
            console.warn('[Chat] Failed to sweep expired auto-delete messages:', err.message);
        }
    }

    broadcastUserCount(streamId) {
        const count = this.getStreamViewerCount(streamId);
        const data = JSON.stringify({ type: 'user-count', count, stream_id: streamId });
        for (const [ws, client] of this.clients) {
            if (client.streamId === streamId && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        }
        // Live persists it (streams.viewer_count) so /api/streams returns real counts
        if (streamId) {
            try { ctx.effects.viewerCount(streamId, count); } catch {}
        }
    }

    /**
     * Record viewer snapshots for all active streams.
     * Called every 60 seconds by the snapshot interval timer.
     */
    _recordViewerSnapshots() {
        // Collect unique active stream IDs
        const streamIds = new Set();
        for (const [, client] of this.clients) {
            if (client.streamId) streamIds.add(client.streamId);
        }
        for (const streamId of streamIds) {
            try {
                const count = this.getStreamViewerCount(streamId);
                const chatActivity = db.getRecentChatActivity(streamId, 5);
                ctx.effects.viewerSnapshot(streamId, count, chatActivity);
            } catch (err) {
                // Non-critical — don't crash the chat server over analytics
            }
        }
    }

    /**
     * Push the current users list to all clients in a stream/global.
     * Throttled to avoid flooding on rapid join/leave bursts.
     */
    broadcastUsersList(streamId) {
        const key = `users-${streamId ?? 'global'}`;
        if (this._usersListTimers?.has(key)) return; // already scheduled
        if (!this._usersListTimers) this._usersListTimers = new Map();
        this._usersListTimers.set(key, setTimeout(() => {
            this._usersListTimers.delete(key);
            const users = this.getUserList(streamId);
            const data = JSON.stringify({ type: 'users-list', users });
            for (const [ws, client] of this.clients) {
                if (client.streamId === streamId && ws.readyState === WebSocket.OPEN) {
                    try { ws.send(data); } catch {}
                }
            }
        }, 500));
    }

    /**
     * Count unique IPs watching a stream (not raw connections).
     * Multiple tabs from the same IP count as one viewer.
     */
    getStreamViewerCount(streamId) {
        const ips = new Set();
        for (const [, client] of this.clients) {
            if (client.streamId === streamId && client.ip) {
                ips.add(client.ip);
            }
        }
        return ips.size;
    }

    getTotalConnections() {
        return this.clients.size;
    }

    /**
     * Send a DM payload to all WebSocket connections belonging to a given user ID.
     * Used by the DM REST API for real-time delivery.
     */
    sendDm(userId, data) {
        const convId = data?.conversation_id;
        if (convId && !dm.isParticipant(convId, userId)) {
            if (DEBUG_DM_DELIVERY) {
                console.warn(`[DM] blocked delivery to user ${userId} for conversation ${convId} (not a participant)`, data.type, data);
            }
            return;
        }
        const payload = JSON.stringify(data);
        for (const [ws, client] of this.clients) {
            if (client.user?.id === userId && ws.readyState === WebSocket.OPEN) {
                if (DEBUG_DM_DELIVERY) {
                    console.debug(`[DM] delivering ${data.type} conversation ${convId} to ws user ${client.user.id} (${client.user.username})`);
                }
                try {
                    if (ws.bufferedAmount < MAX_SEND_BACKPRESSURE) {
                        ws.send(payload);
                    }
                } catch { /* non-critical */ }
            }
        }
    }

    /**
     * Network moved this person's token cutoff (network.user.token_valid_after: signed out everywhere,
     * password changed, banned…). Close every socket they opened with an older Network token; the
     * browser reconnects and, holding no valid token, carries on as a guest. Bot sockets (hbt_ API
     * tokens) are not Network sessions and stay. Returns how many closed.
     */
    revokeSubject(subjectId, validAfterMs) {
        let closed = 0;
        for (const [ws, client] of this.clients) {
            const u = client.user;
            if (!u || !subjectId || u.subject_id !== subjectId || u.auth_source === 'api_token' || u._authSource === 'api_token') continue;
            if (client.tokenIat != null && client.tokenIat * 1000 >= validAfterMs) continue;
            try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'auth_revoked', reason: 'signed_out' })); } catch { /* closing anyway */ }
            try { ws.close(4001, 'Signed out'); } catch { /* already gone */ }
            closed++;
        }
        return closed;
    }

    /**
     * Push a profile/identity update to all chat connections belonging to a user.
     * Refreshes cached client.user so subsequent messages use the new info.
     */
    sendUserUpdate(userId, userData) {
        // Live changed the account (admin edit): refresh the projection first. A new name is
        // also rewritten into this user's stored chat lines, as Live did with its own rows.
        const before = ctx.getUserById(userId);
        if (userData && userData.id != null) {
            ctx.upsertUser({ ...(before || {}), ...userData });
            const newChatName = userData.display_name || userData.username;
            if (before && newChatName && newChatName !== (before.display_name || before.username)) {
                try { db.renameUserChatMessages(userId, newChatName); } catch { /* non-critical */ }
            }
        }
        ctx.invalidateUser(userId);
        const freshUser = ctx.getUserById(userId);
        const payload = JSON.stringify({
            type: 'user-updated',
            user: {
                id: userData.id,
                username: userData.username,
                display_name: userData.display_name,
                role: userData.role,
                avatar_url: userData.avatar_url,
                profile_color: userData.profile_color,
            },
        });
        for (const [ws, client] of this.clients) {
            if (client.user?.id === userId && ws.readyState === WebSocket.OPEN) {
                // Refresh cached user object so future messages use new name
                if (freshUser) client.user = freshUser;
                try {
                    if (ws.bufferedAmount < MAX_SEND_BACKPRESSURE) ws.send(payload);
                } catch { /* non-critical */ }
            }
        }
    }

    /**
     * Broadcast a message to ALL connected chat clients (every stream + global).
     * Used for server-wide announcements (restarts, updates).
     */
    broadcastAll(data) {
        const msg = JSON.stringify(data);
        const blockers = this._blockersOf(data);
        for (const [ws, client] of this.clients) {
            if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_SEND_BACKPRESSURE && !this._blockedFor(client, blockers)) {
                ws.send(msg);
            }
        }
    }

    close() {
        if (this.wss) {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            if (this._snapshotInterval) {
                clearInterval(this._snapshotInterval);
                this._snapshotInterval = null;
            }
            if (this._autoDeleteSweepInterval) {
                clearInterval(this._autoDeleteSweepInterval);
                this._autoDeleteSweepInterval = null;
            }
            audioQueue.stop();
            this.wss.clients.forEach(ws => ws.close());
            this.wss.close();
        }
    }

    /**
     * Notify the stream owner that a new IP needs approval.
     * Sends a system message only to the streamer's connection.
     */
    _notifyStreamerPendingIp(streamId, streamOwnerId, username, ip) {
        if (!streamOwnerId) return;
        try {
            for (const [ws, client] of this.clients) {
                if (client.user?.id === streamOwnerId && client.streamId === streamId) {
                    this.sendTo(ws, {
                        type: 'system',
                        message: `⏳ New IP needs approval: ${username} (${ip}). Open Dashboard → Moderation to review.`,
                        ip_approval_alert: true,
                    });
                    break;
                }
            }
        } catch { /* non-critical */ }
    }

    /**
     * A room's slow mode in ms: its channel's saved slow_mode_seconds (channel moderation settings,
     * the dashboard's value and /slow's). Read from the policy cache, so a restart keeps it.
     */
    slowModeMs(streamId) {
        if (!streamId) return 0;
        return Math.max(0, parseInt(this._getChannelChatSettings(streamId).slow_mode_seconds, 10) || 0) * 1000;
    }

    /** streamId → slow mode ms for the streams with sockets here (Live's presence read). */
    get slowModeByStream() {
        const out = new Map();
        for (const [, c] of this.clients) if (c.streamId && !out.has(c.streamId)) out.set(c.streamId, this.slowModeMs(c.streamId));
        return out;
    }

    /** The channel a client's room belongs to: { channel, ownerId } or null (global chat). */
    async _channelOfRoom(client) {
        const modStreamId = client.streamId || this._moderationStreamFor(client);
        const stream = modStreamId ? ctx.getStreamById(modStreamId) : null;
        const ownerId = (stream && stream.user_id) || client.channelUserId || null;
        let channel = stream && stream.channel_id ? ctx.getChannelById(stream.channel_id) : null;
        if (!channel && ownerId) channel = await ctx.ensureChannelForUser(ownerId);
        return channel ? { channel, ownerId: channel.user_id || ownerId } : null;
    }

    _modesOf(settings) {
        return { slow: Math.max(0, parseInt(settings && settings.slow_mode_seconds, 10) || 0), sub: settings && Number(settings.sub_only) ? 1 : 0 };
    }

    /**
     * /slow and /subonly. The channel's saved setting is the truth: it is written where the table's
     * authority says (Live's effect, or here once Chat writes channel_moderation_settings), then the
     * channel's whole room hears it (every live slot, the offline room, popouts). Nothing changes when
     * the write fails. → true when saved.
     */
    async _setChannelModes(ws, client, fields, label) {
        let room = null;
        try { room = await this._channelOfRoom(client); } catch { room = null; }
        if (!room) { this.sendTo(ws, { type: 'system', message: `The ${label} is set per channel: use it in a channel's chat.` }); return false; }
        const id = Number(room.channel.id);
        // While the write runs, policy reads of this channel are not announced (one in flight may
        // still carry the old value); the command announces the result itself.
        this._modeWrites.set(id, (this._modeWrites.get(id) || 0) + 1);
        try {
            await ctx.effects.updateChannelModerationSettings(id, fields, client.user ? client.user.id : null);
        } catch (err) {
            this.sendTo(ws, { type: 'system', message: err && err.status === 403 ? 'You do not have permission.' : `Could not change the ${label} right now. Try again.` });
            return false;
        } finally {
            const n = (this._modeWrites.get(id) || 1) - 1;
            if (n > 0) this._modeWrites.set(id, n); else this._modeWrites.delete(id);
        }
        const next = this._modesOf(ctx.getChannelModerationSettings(id));
        if (fields.slow_mode_seconds !== undefined) next.slow = Math.max(0, parseInt(fields.slow_mode_seconds, 10) || 0);
        if (fields.sub_only !== undefined) next.sub = fields.sub_only ? 1 : 0;
        this._announcedModes.set(id, next);
        // A command is always answered in the room, even when the value did not change.
        this._announceModes(room.ownerId, client.streamId, { slow: fields.slow_mode_seconds !== undefined ? -1 : next.slow, sub: fields.sub_only !== undefined ? -1 : next.sub }, next);
        return true;
    }

    /** Tell a channel's room what changed: the slowmode / subonly frame and a system line for each. */
    _announceModes(ownerUserId, streamId, prev, next) {
        if (!ownerUserId && !streamId) return;
        const say = (frame) => this.broadcastToChannelRoom(ownerUserId || null, streamId || null, frame);
        if (prev.slow !== next.slow) {
            say({ type: 'slowmode', seconds: next.slow });
            say({ type: 'system', message: next.slow > 0 ? `Slow mode enabled: ${next.slow}s between messages` : 'Slow mode disabled.' });
        }
        if (prev.sub !== next.sub) {
            say({ type: 'subonly', enabled: !!next.sub });
            say({ type: 'system', message: next.sub ? 'Sub-only mode enabled: only subscribers and moderators can chat.' : 'Sub-only mode disabled.' });
        }
    }

    /**
     * A channel's settings were read anew (live-context.onChannelSettings): when its slow mode or
     * sub-only mode differs from what its room was last told (the dashboard changed it), tell the
     * room. The first read after a start only records the values.
     */
    _channelSettingsSeen(channelId, settings) {
        const id = Number(channelId);
        if (!id || this._modeWrites.has(id)) return;
        const next = this._modesOf(settings);
        const prev = this._announcedModes.get(id);
        this._announcedModes.set(id, next);
        if (!prev || (prev.slow === next.slow && prev.sub === next.sub)) return;
        const channel = ctx.getChannelById(id);
        if (channel && channel.user_id) this._announceModes(channel.user_id, null, prev, next);
    }

    /**
     * Get channel moderation settings for a stream.
     * Caches the channel lookup to avoid repeated DB queries.
     */
    _getChannelChatSettings(streamId) {
        const defaults = {
            slow_mode_seconds: 0, followers_only: 0, emote_only: 0,
            allow_anonymous: 1, links_allowed: 1, account_age_gate_hours: 0,
            caps_percentage_limit: 0, aggressive_filter: 0, max_message_length: 500,
            slur_filter_enabled: 0, slur_filter_use_builtin: 1, slur_filter_terms: '', slur_filter_regexes: '', slur_filter_nudge_message: '', slur_filter_disabled_categories: '[]',
            ip_approval_mode: 0,
            gifs_enabled: 1,
            soundboard_enabled: 1,
            soundboard_allow_pitch: 1,
            soundboard_allow_speed: 1,
            soundboard_banned_ids: '',
            viewer_auto_delete_enabled: 1,
            viewer_delete_all_enabled: 1,
            custom_emotes_enabled: 1,
            custom_sounds_enabled: 1,
            max_sound_seconds: 10,
            uploads_mods_only: 0,
            emote_scale: 100,
            sound_min_speed: 0.5,
            sound_max_speed: 3.0,
            sound_min_pitch_cents: -1200,
            sound_max_pitch_cents: 1200,
        };
        // Derive pitch rate bounds from the configured cents (2^(cents/1200)).
        const finalize = (s) => ({
            ...s,
            sound_min_pitch_rate: Math.pow(2, (Number(s.sound_min_pitch_cents) ?? -1200) / 1200),
            sound_max_pitch_rate: Math.pow(2, (Number(s.sound_max_pitch_cents) ?? 1200) / 1200),
        });
        if (!streamId) return finalize(defaults);
        try {
            const stream = ctx.getStreamById(streamId);
            if (!stream) return finalize(defaults);
            const channel = stream.channel_id ? ctx.getChannelById(stream.channel_id) : ctx.getChannelByUserId(stream.user_id);
            if (!channel) return finalize(defaults);
            return finalize({ ...defaults, ...ctx.getChannelModerationSettings(channel.id) });
        } catch {
            return finalize(defaults);
        }
    }

    /**
     * Log a moderation action from a chat command (/ban, /timeout, /clear, /slowmode).
     * Non-critical — failures are silently ignored.
     */
    logChatModeration(client, actionType, details = {}, targetUserId = null) {
        try {
            const stream = client.streamId ? ctx.getStreamById(client.streamId) : null;
            const channel = stream?.channel_id
                ? ctx.getChannelById(stream.channel_id)
                : stream ? ctx.getChannelByUserId(stream.user_id) : null;
            db.logModerationAction({
                scope_type: channel ? 'channel' : 'site',
                scope_id: channel?.id || undefined,
                actor_user_id: client.user?.id || undefined,
                target_user_id: targetUserId || undefined,
                action_type: actionType,
                details: { stream_id: client.streamId || null, ...details },
            });
        } catch { /* non-critical */ }
    }
}

module.exports = new ChatServer();
