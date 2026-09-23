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
    extraOrigins: String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => strip(s.trim())).filter(Boolean),

    // Chat's own SQLite database (systemd StateDirectory openvibe-chat).
    dbPath: process.env.CHAT_DB_PATH || './data/chat.db',

    // OpenVibe.Network — issuer of user JWTs and service tokens.
    networkUrl: strip(process.env.OV_NETWORK_URL || 'https://openvibe.network'),
    networkInternalUrl: strip(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
    // PEM with the Network's RS256 public key. When unset or unreadable the key is fetched from
    // ${networkInternalUrl}/api/.well-known/jwks.
    networkPublicKeyPath: process.env.OV_NETWORK_PUBLIC_KEY || '',
    // Chat's service principal (client `chat` in the Network's oauth_clients).
    oauth: {
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'chat',
        clientSecret: process.env.OV_OAUTH_CLIENT_SECRET || '',
    },

    // OpenVibe.Live — users, streams, channels, bans and every side effect chat triggers.
    live: {
        internalUrl: strip(process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000'),
        audience: 'openvibe.live',
        // Chat's read-mirror of its tables into Live (rollback path + Live's own readers). Only
        // switch on at cutover; Live refuses mirror writes unless it runs with CHAT_AUTHORITY=chat.
        mirror: bool(process.env.LIVE_MIRROR, false),
        mirrorIntervalMs: int(process.env.LIVE_MIRROR_INTERVAL_MS, 1000),
        requestTimeoutMs: int(process.env.LIVE_TIMEOUT_MS, 4000),
    },

    // OpenVibe.Events — the outbox relays only when EVENTS_URL is set.
    events: {
        url: strip(process.env.EVENTS_URL || ''),
        intervalMs: int(process.env.EVENTS_RELAY_INTERVAL_MS, 5000),
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
