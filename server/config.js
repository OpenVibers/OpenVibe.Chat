/**
 * OpenVibe.Chat — configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/chat.env in production); see .env.example for the documented list.
 */
'use strict';

require('dotenv').config();

const path = require('path');

const isProduction = (process.env.NODE_ENV || 'development') === 'production';
const port = process.env.PORT != null && process.env.PORT !== '' && Number.isFinite(parseInt(process.env.PORT, 10)) ? parseInt(process.env.PORT, 10) : 4400;
const strip = (u) => String(u || '').replace(/\/+$/, '');
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

module.exports = {
    port,
    host: process.env.HOST || '127.0.0.1',
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction,

    // Public URL the browser uses. Chat is served on Live's origin (nginx routes /ws/chat and the
    // chat REST prefixes here), so this is https://openvibe.live in production.
    baseUrl: strip(process.env.BASE_URL || (isProduction ? 'https://openvibe.live' : 'http://localhost:3000')),
    // Proxy hops that set X-Forwarded-For (Cloudflare → nginx → Node = 2), same as Live.
    trustProxy: process.env.TRUST_PROXY != null ? Number(process.env.TRUST_PROXY) : 2,
    // Extra browser origins allowed for WebSocket upgrades and credentialed CORS, on top of the
    // ones Live allows (BASE_URL + www variant, the Network, openvibe.games, openvibe.tools).
    // Exact origins only: a *.openvibe.tools satellite that embeds chat must be listed here.
    extraOrigins: String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => strip(s.trim())).filter(Boolean),

    // Chat's own SQLite database (systemd StateDirectory openvibe-chat).
    dbPath: process.env.CHAT_DB_PATH || './data/chat.db',

    // OpenVibe.Network — issuer of user JWTs and service tokens.
    networkUrl: strip(process.env.OV_NETWORK_URL || 'https://openvibe.network'),
    networkInternalUrl: strip(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
    // PEM with the Network's RS256 public key. When unset or unreadable the key is fetched from
    // ${networkInternalUrl}/api/.well-known/jwks.
    networkPublicKeyPath: process.env.OV_NETWORK_PUBLIC_KEY || '',
    // Chat's service principal (client `chat` in the Network's oauth_clients). The same client signs
    // people in to openvibe.chat (redirect <web.baseUrl>/auth/callback), as Wiki and Blog do.
    oauth: {
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'chat',
        clientSecret: process.env.OV_OAUTH_CLIENT_SECRET || '',
        redirectUri: process.env.CHAT_OAUTH_REDIRECT_URI || `${strip(process.env.CHAT_WEB_URL || (isProduction ? 'https://openvibe.chat' : 'http://localhost:4400'))}/auth/callback`,
        scope: 'profile theme',
    },

    // openvibe.chat, the site (server/web/): global chat, messages and settings, served by Chat itself.
    web: {
        baseUrl: strip(process.env.CHAT_WEB_URL || (isProduction ? 'https://openvibe.chat' : 'http://localhost:4400')),
        // Where a room's Community attachments link (a space is <communityUrl>/s/<slug>).
        communityUrl: strip(process.env.OV_COMMUNITY_URL || 'https://openvibe.community'),
    },
    cookies: { secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction },

    // OpenVibe.Live — users, streams, channels, bans and every side effect chat triggers.
    live: {
        internalUrl: strip(process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000'),
        audience: 'openvibe.live',
        // Chat's read-mirror of its tables into Live (rollback path + Live's own readers). Only
        // switch on at cutover; Live refuses mirror writes unless it runs with CHAT_AUTHORITY=chat.
        mirror: bool(process.env.LIVE_MIRROR, false),
        mirrorIntervalMs: int(process.env.LIVE_MIRROR_INTERVAL_MS, 1000),
        requestTimeoutMs: int(process.env.LIVE_TIMEOUT_MS, 4000),
        // /ready reports the Live sync degraded once its last clean pass is older than this.
        // The loop ticks every 2 s and the bans and stream projections are due every 10 s, so a
        // healthy Chat finishes a clean pass at least every ~10 s; 60 s is six missed ban/stream
        // refreshes: long enough to ride out a Live restart (about 6 s) or a slow pass of 4 s
        // timeouts, short enough that bans and live state served from stale caches show within
        // a minute. The same margin applies to each step on top of its own interval
        // (live-context.js SCHEDULE), so the 5- and 15-minute full syncs are judged fairly too.
        syncStaleMs: int(process.env.LIVE_SYNC_STALE_MS, 60_000),
    },

    // OpenVibe.VIP — the member badge on chat messages (a creator's perk bound to `chat badge`).
    // Asked through a cache only (server/vip/badges.js): sending never waits on VIP, and any doubt
    // (VIP down, no token, no answer yet) is "no badge". Needs Chat's client secret and the Network
    // grant vip.entitlement.check on openvibe.vip.
    vip: {
        enabled: bool(process.env.CHAT_VIP_BADGES, true),
        internalUrl: strip(process.env.OV_VIP_INTERNAL_URL || 'http://127.0.0.1:4620'),
        timeoutMs: int(process.env.VIP_TIMEOUT_MS, 1500),
        // How long a badge outlives the membership at most (VIP applied the change; Chat has no
        // Events inbox): the convergence bound. A "no" is re-asked after denyTtlMs, a failure after
        // unavailableTtlMs.
        ttlMs: int(process.env.CHAT_VIP_BADGE_TTL_MS, 60_000),
        denyTtlMs: int(process.env.CHAT_VIP_BADGE_DENY_TTL_MS, 30_000),
        unavailableTtlMs: int(process.env.CHAT_VIP_BADGE_UNAVAILABLE_TTL_MS, 5_000),
    },

    // A person's chat preferences: the OpenVibe.Network user module chat.preferences, which Chat owns
    // (server/prefs/). Read and written with Chat's service token (grants network.modules.read and
    // network.modules.write on chat.preferences, audience openvibe.network). Cached per person for
    // ttlMs: Chat's own writes update the cache at once, a change made through Network directly shows
    // at once when its network.module.updated reaches the Events consumer (prefs.handleEvent()), and
    // within ttlMs without it.
    prefs: {
        enabled: bool(process.env.CHAT_PREFS_ENABLED, true),
        ttlMs: int(process.env.CHAT_PREFS_TTL_MS, 60_000),
        timeoutMs: int(process.env.CHAT_PREFS_TIMEOUT_MS, 3000),
        maxEntries: int(process.env.CHAT_PREFS_CACHE_MAX, 5000),
    },

    // OpenVibe.Events — the outbox relays only when EVENTS_URL is set.
    events: {
        url: strip(process.env.EVENTS_URL || ''),
        intervalMs: int(process.env.EVENTS_RELAY_INTERVAL_MS, 5000),
        // The consumer (server/events/consumer.js): POST /internal/events, deliveries of Chat's
        // subscriptions (live.release.deployed, network.module.updated), signature v2 under
        // CHAT_EVENTS_SECRET (comma-separated for rotation; each 32+ characters, the first is the one
        // handed to Events). Unset = the route answers 503 and no subscription is made.
        secrets: String(process.env.CHAT_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 32),
        // Create the subscriptions at boot when missing (idempotent; an existing one, even disabled,
        // is left as it is). Needs EVENTS_URL, the secret, OV_OAUTH_CLIENT_SECRET and the Network
        // grant chat events.subscription.manage on openvibe.events.
        subscribe: bool(process.env.CHAT_EVENTS_SUBSCRIBE, true),
        // Where Events delivers. Default http://127.0.0.1:<PORT>/internal/events.
        endpoint: strip(process.env.CHAT_EVENTS_ENDPOINT || ''),
    },

    // Voice/video calls (server/calls/): Live's call server, moved. Off until the calls cutover
    // (docs/calls-cutover.md): Chat's chat sockets and openvibe.chat's /api/ are already public,
    // so while calls are Live's this keeps /api/streams/voice-channels…, /api/streams/:id/call and
    // /ws/call unanswered here (404 / refused) and /internal/calls/* answering 409, and Chat never
    // pushes a voice-channel list or a call invite of its own. A direct call nobody answers is
    // missed after ringTimeoutMs (the callee's browser gives up after 30 s by itself).
    calls: {
        enabled: bool(process.env.CHAT_CALLS, false),
        ringTimeoutMs: int(process.env.CALL_RING_TIMEOUT_MS, 45_000),
    },

    // Channel sound clips live on disk. At cutover this is Live's sounds directory: stored rows
    // hold absolute paths into it, and Live's donation alerts read the alert sounds from there.
    sounds: {
        path: process.env.SOUNDS_PATH || './data/sounds',
        maxSizeKb: int(process.env.MAX_SOUND_SIZE_KB, 2048),
        defaultMaxSeconds: int(process.env.SOUND_DEFAULT_MAX_SECONDS, 10),
        maxPerChannel: int(process.env.MAX_SOUNDS_PER_CHANNEL, 150),
        maxPerUploaderPerChannel: int(process.env.MAX_SOUNDS_PER_UPLOADER_PER_CHANNEL, 10),
    },
    // Where Chat keeps its own caches (101soundboards clips, TTS preview clips).
    cacheDir: process.env.CHAT_CACHE_DIR || path.join(path.dirname(process.env.CHAT_DB_PATH || './data/chat.db'), 'cache'),
    // (SITE_URL — the public origin in /paste links — is read where Live read it, as in Live.)
};
