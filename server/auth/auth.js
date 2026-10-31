/**
 * OpenVibe.Chat — request authentication.
 *
 * The same tokens Live accepts (a Network RS256 JWT in Authorization / ov_token cookie / Live's legacy token cookie;
 * a WebSocket takes only the Authorization bearer or the token its first message presents),
 * or an hbt_ API token) with the same rules, resolved by Live through live-context.authenticate()
 * — Live owns the account links, auto-creates first-time accounts and knows API-token scopes.
 * Moved from OpenVibe.Live server/auth/auth.js; the middleware are async now because resolution
 * is a (cached) call to Live.
 */
'use strict';

const ctx = require('../live-context');
const session = require('./network-session');
const { isExtensionOrigin } = require('./extension-origin');

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
 * Extract the token and where it came from: the Bearer header or the Network `ov_token` cookie. Live's legacy
 * `token` cookie is not read (Live no longer sets it; compatibility register C-05). Internal: extractToken returns
 * the token alone.
 */
function extractTokenFrom(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return { token: authHeader.slice(7), from: 'header' };
    }

    // An extension page never authenticates with a cookie: only its Bearer counts. The page has host
    // permissions, so the request works without CORS; a stray ov_token must not act for it.
    if (isExtensionOrigin(req.headers.origin)) return { token: null, from: null };

    // The Network session cookie is shared with the browser.
    if (req.cookies) {
        if (req.cookies.ov_token) return { token: req.cookies.ov_token, from: 'ov_token_cookie' };
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
        if (parsed.ov_token) return { token: parsed.ov_token, from: 'ov_token_cookie' };
    }

    return { token: null, from: null };
}

/**
 * Extract the token from Authorization header or cookie
 */
function extractToken(req, opts) {
    return extractTokenFrom(req, opts).token;
}

/**
 * The token a WebSocket upgrade authenticates with: the Authorization bearer only (bots). A browser
 * cannot set headers on an upgrade, so its socket starts anonymous and presents the token in its first
 * message (chat `join`/`join_room`, the call's `auth-update`). Neither the URL (`?token=`, C-05: URLs
 * end up in proxy logs) nor a cookie (C-06: the socket would ride whatever session the browser holds)
 * authenticates a socket.
 */
function extractWsToken(req) {
    const authHeader = req.headers.authorization;
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

/**
 * The token that may exempt an upgrade from a network (IP) ban: the bearer or the Network `ov_token`
 * cookie. Staff share home networks with banned people, and a browser cannot present its token before
 * the ban check runs. It only lets the upgrade through; the socket's identity still comes from
 * extractWsToken or its first message.
 */
function banExemptionToken(req) {
    return extractTokenFrom(req).token;
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
        req._ovAuthUser = token ? session.authenticate(token, { allowDock: isDmPath(req) }).catch(() => null) : Promise.resolve(null);
    }
    return req._ovAuthUser;
}

/** The DM API path (the only place a Dock token is allowed to go in Chat). */
function isDmPath(req) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    return path === '/api/dm' || path.startsWith('/api/dm/');
}

/** Reads only: DM GET/HEAD, plus marking a conversation read. Sending/creating/renaming are not allowed. */
function isDmRead(req) {
    if (!isDmPath(req)) return false;
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    return req.method === 'POST' && /^\/api\/dm\/conversations\/[^/]+\/read$/.test(path);
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
    if (user.auth_source === 'dock' && !isDmRead(req)) {
        return res.status(403).json({ error: 'This extension can only read messages.' });
    }
    req.user = user;
    req.authSource = user.auth_source === 'dock' ? 'dock' : 'network';
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
            } else if (user.auth_source !== 'dock' || isDmRead(req)) {
                req.user = user;
                req.authSource = user.auth_source === 'dock' ? 'dock' : 'network';
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
    isDmPath, isDmRead,
    apiTokenAllows,
    extractToken,
    requestUser,
    extractWsToken,
    banExemptionToken,
    authenticateWs,
    requireAuth,
    optionalAuth,
    requireAdmin,
};
