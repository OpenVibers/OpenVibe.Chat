/**
 * OpenVibe.Chat — HTTP app and WebSocket upgrade handling.
 *
 * Browsers reach Chat on Live's origin: nginx sends /ws/chat and the chat REST prefixes
 * (/api/chat/, /api/dm/, /api/tts/, /api/sounds) here (docs/cutover.md), so the guards Live ran
 * in front of those routes run here too, with Live's values: credentialed CORS for an explicit
 * list of origins (never a wildcard), the /api rate limit, IP/network bans (admins exempt) and the ov_banned cookie, the
 * WebSocket origin allow-list and IP-ban check at upgrade.
 */
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const ctx = require('./live-context');
const db = require('./db/database');
const { extractToken, extractWsToken, authenticateWs } = require('./auth/auth');
const { trustProxy } = require('./net/client-ip');

function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return null;
    try {
        return new URL(origin).origin;
    } catch {
        return null;
    }
}

/**
 * The browser origins allowed credentialed CORS and WebSocket upgrades: Live's exact list (BASE_URL
 * and its www variant, the Network, openvibe.games, openvibe.tools) plus ALLOWED_ORIGINS. Exact
 * origins only: Live's *.openvibe.tools suffix rule is not carried over, because a credentialed
 * CORS grant lets that origin read a signed-in person's DMs and chat, and no tools satellite embeds
 * chat. A host that starts to must be listed in ALLOWED_ORIGINS.
 */
function getAllowedOrigins() {
    const allowed = new Set();
    const baseOrigin = normalizeOrigin(config.baseUrl);
    if (baseOrigin) {
        allowed.add(baseOrigin);
        // www variant (and vice versa), as Live does, so www.openvibe.live works too
        try {
            const url = new URL(baseOrigin);
            if (url.hostname.startsWith('www.')) allowed.add(`${url.protocol}//${url.hostname.slice(4)}${url.port ? ':' + url.port : ''}`);
            else allowed.add(`${url.protocol}//www.${url.hostname}${url.port ? ':' + url.port : ''}`);
        } catch { /* */ }
    }
    allowed.add(normalizeOrigin(config.networkUrl) || 'https://openvibe.network');
    allowed.add('https://openvibe.games');
    allowed.add('https://openvibe.tools');
    if (!config.isProduction) {
        ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3200']
            .forEach((o) => allowed.add(o));
    }
    for (const o of config.extraOrigins) { const n = normalizeOrigin(o); if (n) allowed.add(n); }
    return allowed;
}

function createApp({ chatServer, bridge, mirror, relay, events = null }) {
    const allowedOrigins = getAllowedOrigins();
    const app = express();
    app.disable('x-powered-by');
    // Cloudflare → nginx → Node: TRUST_PROXY hops, but a hop past nginx only when it is a
    // Cloudflare address (DNS-only hosts reach nginx directly with a client-written X-Forwarded-For).
    app.set('trust proxy', trustProxy(config.trustProxy));
    // The request's W3C trace and request id (openvibe-contracts), carried onto the calls Chat makes.
    app.use(require('openvibe-contracts').http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);

    // GET /release.json (ADR-016, D43) and loopback GET /metrics (Track O): what this deployment is,
    // request rates/latencies and process metrics, from openvibe-shared (before any route).
    const release = require('openvibe-shared/release').createRelease({ service: 'chat', root: require('path').join(__dirname, '..'), packages: ['openvibe-shared', 'openvibe-sdk', 'openvibe-contracts'] });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'chat', release: release.release });
    release.mount(app, { registry: metrics.registry });
    app.locals.metrics = metrics.registry;

    /** Exact allow-list only (no subdomain wildcard). */
    function isAllowedOrigin(origin) {
        return allowedOrigins.has(origin);
    }

    // ── Internal (loopback; never routed by nginx) ─────────────
    // Alert sounds travel as base64 in broadcasts (uploads up to MAX_SOUND_SIZE_KB): room for them.
    app.use('/internal/live', express.json({ limit: '16mb' }), bridge);
    // OpenVibe.Events deliveries (live.release.deployed, network.module.updated): signature v2 over
    // the raw body, so this router reads the body itself (server/events/consumer.js).
    if (events) app.use('/internal/events', events.router);
    app.get('/health', (req, res) => res.json({ ok: true, service: 'chat' }));
    // Readiness in the openvibe-shared/ready shape (status ready/degraded/not_ready, named checks):
    // 503 only when the required check fails. `db` is Chat's own database, which it cannot serve
    // without; `live_sync` is optional, because chat keeps flowing from warm caches while Live is
    // down (live-context.js), so a stale sync degrades the service instead of taking it out.
    function timed(fn) {
        const t0 = process.hrtime.bigint();
        let out;
        try { out = fn(); } catch (err) { out = { ok: false, error: String((err && err.message) || err).split('\n')[0].slice(0, 200) }; }
        const { ok, error, detail } = out;
        return {
            status: ok ? 'ok' : 'fail', required: false,
            ...(error ? { error } : {}), ...(detail !== undefined ? { detail } : {}),
            latency_ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
            checked_at: new Date().toISOString(),
        };
    }
    app.get('/ready', (req, res) => {
        const checks = {
            // A real read of a chat table (MAX of the rowid is an index seek, not a scan).
            db: { ...timed(() => ({ ok: true, detail: { max_message_id: db.get('SELECT MAX(id) AS id FROM chat_messages').id } })), required: true },
            live_sync: timed(() => {
                const s = ctx.syncStatus(config.live.syncStaleMs);
                const detail = { ...s, threshold_ms: config.live.syncStaleMs };
                if (s.last_success_at === null) return { ok: false, error: 'no successful Live sync since start', detail };
                if (s.age_ms > config.live.syncStaleMs) return { ok: false, error: `last successful Live sync ${Math.round(s.age_ms / 1000)}s ago`, detail };
                if (s.late_steps.length) return { ok: false, error: `Live sync late: ${s.late_steps.join(', ')}`, detail };
                return { ok: true, detail };
            }),
        };
        const failed = Object.keys(checks).filter((k) => checks[k].required && checks[k].status !== 'ok');
        const degraded = Object.keys(checks).filter((k) => !checks[k].required && checks[k].status !== 'ok');
        const ready = failed.length === 0;
        let pending = null;
        if (mirror && checks.db.status === 'ok') { try { pending = mirror.pending(); } catch { /* reported by db */ } }
        res.set('Cache-Control', 'no-store');
        res.status(ready ? 200 : 503).json({
            ready,
            status: !ready ? 'not_ready' : degraded.length ? 'degraded' : 'ready',
            service: 'chat',
            checked_at: new Date().toISOString(),
            failed,
            degraded,
            checks,
            connections: chatServer.getTotalConnections(),
            live: { last_sync_at: ctx.stats.lastSyncAt, last_success_at: ctx.stats.lastSuccessAt, failures: ctx.stats.failures, last_error: ctx.stats.lastError },
            mirror: mirror ? { enabled: config.live.mirror, pending, last_error: mirror.lastError() } : null,
            events: {
                enabled: !!config.events.url,
                consumer: events ? { enabled: events.enabled, ...events.stats } : null,
            },
        });
    });

    // ── Public: the same middleware Live runs in front of these routes ─
    const allowlistedCors = cors({
        origin(origin, callback) {
            if (!origin) return callback(null, true);
            if (isAllowedOrigin(origin)) return callback(null, true);
            console.warn(`[CORS] Rejected origin: "${origin}"`);
            return callback(new Error('Origin not allowed by CORS'));
        },
        credentials: true,
    });
    app.use(allowlistedCors);
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '256kb' }));
    app.use(cookieParser());
    app.use((err, req, res, next) => {
        if (err && err.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed' });
        next(err);
    });

    // Live's /api limiter (per process, so chat routes now have their own budget).
    app.use('/api/', rateLimit({
        windowMs: 60 * 1000,
        max: (req) => ((req.method === 'GET' || req.method === 'HEAD') ? 900 : 180),
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down partner' },
    }));

    // Banned networks and the ban cookie (Live's middleware, API branch). Admins pass: they may
    // share an address with a banned person.
    async function isBanExemptAdmin(req) {
        if (req._ovBanUser === undefined) {
            let user = null;
            try { const t = extractToken(req); user = t ? await require('./auth/network-session').authenticate(t) : null; } catch { user = null; }
            req._ovBanUser = user;
        }
        const u = req._ovBanUser;
        return !!(u && !u.is_banned && require('./auth/permissions').can(u, 'staff.limits.exempt'));
    }
    app.use(async (req, res, next) => {
        try {
            const ipBan = ctx.getIpBan(req.ip, null);
            if (ipBan && !(await isBanExemptAdmin(req))) return res.status(403).json({ error: 'Access denied' });
        } catch { /* policy unavailable — let the request through, as Live does on a DB error */ }
        if (req.cookies && req.cookies.ov_banned === '1') {
            if (await isBanExemptAdmin(req)) { res.clearCookie('ov_banned'); res.clearCookie('ov_banned_name'); return next(); }
            return res.status(403).json({ error: 'Account is banned' });
        }
        next();
    });

    // The person's chat preferences: Network user module chat.preferences (server/prefs/).
    app.use('/api/chat/preferences', require('./prefs/routes'));
    app.use('/api/chat', require('./chat/routes'));
    app.use('/api/dm', require('./chat/dm-routes'));
    app.use('/api/tts', require('./chat/tts-routes'));
    app.use('/api/sounds', require('./chat/sounds-routes'));

    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use((err, req, res, _next) => {
        if (err.name === 'MulterError' || (err.message && err.message.includes('file'))) {
            return res.status(400).json({ error: err.message || 'File upload error' });
        }
        console.error('[Server] Unhandled route error:', err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    });

    /** Live's upgrade guard for /ws/chat: exact origin allow-list, then IP / network bans. */
    async function handleUpgrade(req, socket, head) {
        const url = req.url || '';
        const origin = normalizeOrigin(req.headers.origin);
        if (origin && !allowedOrigins.has(origin)) {
            console.warn(`[Server] WebSocket upgrade rejected — origin "${origin}" not in allowed origins`);
            socket.destroy();
            return;
        }
        if (!url.startsWith('/ws/chat')) { socket.destroy(); return; }
        try {
            const wsIp = chatServer.getClientIp(req);
            if (ctx.isIpBanned(wsIp, null)) {
                // Admins pass network bans (shared home network).
                let exempt = false;
                try { const u = await authenticateWs(extractWsToken(req)); exempt = !!(u && !u.is_banned && require('./auth/permissions').can(u, 'staff.limits.exempt')); } catch { exempt = false; }
                if (!exempt) { socket.destroy(); return; }
            }
        } catch { /* non-critical — allow through on a policy error */ }
        chatServer.handleUpgrade(req, socket, head);
    }

    return { app, handleUpgrade, allowedOrigins, isAllowedOrigin };
}

module.exports = { createApp, getAllowedOrigins, normalizeOrigin };
