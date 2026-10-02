/**
 * OpenVibe.Chat — request authentication.
 *
 * The same tokens Live accepts (a Network RS256 JWT in Authorization / ov_token cookie,
 * or an hbt_ API token) with the same rules, resolved by Live through live-context.authenticate()
 * — Live owns the account links, auto-creates first-time accounts and knows API-token scopes.
 * Moved from OpenVibe.Live server/auth/auth.js; the middleware are async now because resolution
 * is a (cached) call to Live.
 */
'use strict';

const ctx = require('../live-context');
const session = require('./network-session');

/**
 * What an hbt_ API token may do over REST, by scope (Live's apiTokenAllows, verbatim).
 *   - money, staff and credential routes refuse API tokens outright;
 *   - reads (GET/HEAD) need any scope;
 *   - writes need the scope that covers the area, and areas with no scope refuse tokens.
 */
const TOKEN_DENIED_PREFIXES = ['/api/admin', '/api/mod', '/api/funds', '/api/payments', '/api/auth/stream-key', '/api/auth/tokens', '/api/cosmetics', '/api/analytics'];
const TOKEN_WRITE_SCOPES = [
    ['/api/chat', ['chat']], ['/api/dm', ['chat']], ['/api/emotes', ['chat']], ['/api/sounds', ['chat']], ['/api/tts', ['chat']],
    ['/api/streams', ['stream']],   // the call routes (server/calls/routes.js), as on Live
];
function apiTokenAllows(req, scopes) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const under = (prefix) => path === prefix || path.startsWith(prefix + '/');
    if (TOKEN_DENIED_PREFIXES.some(under)) return false;
    const list = Array.isArray(scopes) ? scopes : [];
    if (req.method === 'GET' || req.method === 'HEAD') return list.length > 0;
    const rule = TOKEN_WRITE_SCOPES.find(([prefix]) => under(prefix));
    return !!rule && rule[1].some((sc) => list.includes(sc));
}

/**
 * Extract the token from Authorization header or cookie
 */
function extractToken(req, { legacyCookie = true } = {}) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    // The Network session cookie is shared with the browser. REST still accepts Live's legacy
    // 'token' cookie (as Live does); WebSocket upgrades ignore it (legacyCookie: false).
    if (req.cookies) {
        if (req.cookies.ov_token) return req.cookies.ov_token;
        if (legacyCookie && req.cookies.token) return req.cookies.token;
    }

    // Raw Node/WebSocket upgrade requests do not go through cookie-parser,
    // so parse the Cookie header directly as a fallback.
    const cookieHeader = req.headers?.cookie;
    if (cookieHeader && typeof cookieHeader === 'string') {
        const parsed = {};
        for (const part of cookieHeader.split(';')) {
            const idx = part.indexOf('=');
            if (idx === -1) continue;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!key) continue;
            try { parsed[key] = decodeURIComponent(value); } catch { parsed[key] = value; }
        }
        if (parsed.ov_token) return parsed.ov_token;
        if (legacyCookie && parsed.token) return parsed.token;
    }

    return null;
}

/**
 * Extract the token for a WebSocket upgrade request
 */
function extractWsToken(req) {
    return extractToken(req, { legacyCookie: false });
}

/**
 * Authenticate a WebSocket connection (resolves to user or null).
 * Supports both openvibe.network JWT and API tokens (hbt_xxx).
 */
async function authenticateWs(token) {
    if (!token) return null;
    const user = await session.authenticate(token);
    if (user && user.auth_source === 'api_token') user._authSource = 'api_token';
    return user;
}

/**
 * The account behind this request's token (null without one, or when it does not resolve), resolved
 * once per request: requireAuth, optionalAuth, the ban exemption and the per-actor limits
 * (net/actor-limits.js) share the answer.
 */
function requestUser(req) {
    if (!req._ovAuthUser) {
        const token = extractToken(req);
        req._ovAuthUser = token ? session.authenticate(token).catch(() => null) : Promise.resolve(null);
    }
    return req._ovAuthUser;
}

/**
 * Express middleware — requires a valid openvibe.network JWT or API token.
 */
async function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    let user = null;
    try { user = await requestUser(req); } catch { user = null; }
    if (!user) {
        return session.failureReason(token) === 'unresolved'
            ? res.status(401).json({ error: 'Unable to resolve account' })
            : res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (user.auth_source === 'api_token') {
        if (user.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        if (!apiTokenAllows(req, user.scopes)) {
            return res.status(403).json({ error: 'This API token\'s scopes do not allow this request' });
        }
        req.user = user;
        req.authSource = 'api_token';
        req.tokenScopes = user.scopes || [];
        return next();
    }
    if (user.is_banned) {
        return res.status(403).json({ error: 'Account is banned', reason: user.ban_reason });
    }
    req.user = user;
    req.authSource = 'network';
    next();
}

/**
 * Express middleware — optional auth (attaches user if token present)
 */
async function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (token) {
        let user = null;
        try { user = await requestUser(req); } catch { user = null; }
        if (user && !user.is_banned) {
            if (user.auth_source === 'api_token') {
                if (apiTokenAllows(req, user.scopes)) {
                    req.user = user;
                    req.authSource = 'api_token';
                    req.tokenScopes = user.scopes || [];
                }
            } else {
                req.user = user;
                req.authSource = 'network';
            }
        }
    }
    next();
}

/**
 * Express middleware — requires admin role
 */
async function requireAdmin(req, res, next) {
    await requireAuth(req, res, () => {
        if (!require('./permissions').isAdmin(req.user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

module.exports = {
    apiTokenAllows,
    extractToken,
    requestUser,
    extractWsToken,
    authenticateWs,
    requireAuth,
    optionalAuth,
    requireAdmin,
};
