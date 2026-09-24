'use strict';
/**
 * openvibe.chat as an OAuth2 client of OpenVibe.Network (client `chat`, redirect
 * <CHAT_WEB_URL>/auth/callback): the session layer OpenVibe.Wiki and OpenVibe.Community use.
 *
 *   GET  /auth/login     → Network /oauth/authorize (?silent=1 adds prompt=none; ?next= same-site path)
 *   GET  /auth/callback  → server-side code exchange, sets the cookies
 *   POST /auth/fedcm     → the shared navbar's FedCM assertion (nonce checked here, signature by the Network)
 *   GET  /auth/logout    → clears the cookies (best-effort refresh revoke)
 *   GET  /auth/me        → the signed-in profile (offline JWT verification)
 *   POST /auth/refresh   → rotates tokens with the refresh token
 *
 * Cookies (host-only): ov_token (access JWT, JS-readable for the navbar), ov_refresh (httpOnly,
 * Path=/auth), ov_sso_hint ('account' | 'guest', tells the navbar whether a silent login is worth it).
 */
const crypto = require('crypto');
const express = require('express');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const HINT_COOKIE = 'ov_sso_hint';
const STATE_COOKIE = 'ov_oauth_state';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';

function sanitizeNext(next, config) {
    if (!next || typeof next !== 'string') return '/';
    if (/^\/(?!\/|\\)/.test(next)) return next;
    try {
        const u = new URL(next);
        if (u.protocol !== 'https:') return '/';
        const allowed = [config.baseUrl, config.networkUrl].map((b) => { try { return new URL(b).hostname; } catch { return null; } }).filter(Boolean);
        if (allowed.includes(u.hostname)) return u.toString();
    } catch { /* fall through */ }
    return '/';
}

function withParam(target, key, value) {
    const at = target.indexOf('#');
    const hash = at >= 0 ? target.slice(at) : '';
    const base = at >= 0 ? target.slice(0, at) : target;
    return `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

function authorizeUrl(config, { silent = false } = {}) {
    const state = crypto.randomBytes(16).toString('hex');
    const u = new URL(`${config.networkUrl}/oauth/authorize`);
    u.searchParams.set('client_id', config.oauth.clientId);
    u.searchParams.set('redirect_uri', config.oauth.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', config.oauth.scope);
    u.searchParams.set('state', state);
    if (silent) u.searchParams.set('prompt', 'none');
    return { url: u.toString(), state };
}

function fedcmNonceMatches(token, nonce) {
    if (typeof nonce !== 'string' || !nonce || nonce.length > 256) return false;
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return false;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return false; }
    if (!claims || typeof claims.nonce !== 'string') return false;
    const a = Buffer.from(claims.nonce), b = Buffer.from(nonce);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSessionRoutes({ config, viewers, fetchImpl = globalThis.fetch, log = console }) {
    const router = express.Router();
    const secure = config.cookies.secure;
    const access = () => ({ sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 24 * 3600 * 1000 });
    const refresh = () => ({ sameSite: 'lax', secure, httpOnly: true, path: '/auth', maxAge: 30 * 24 * 3600 * 1000 });
    const flow = () => ({ sameSite: 'lax', secure, httpOnly: true, path: '/auth', maxAge: 10 * 60 * 1000 });
    const hint = () => ({ sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 3600 * 1000 });

    function setSession(res, accessToken, refreshToken) {
        res.cookie(ACCESS_COOKIE, accessToken, access());
        if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, refresh());
        res.cookie(HINT_COOKIE, 'account', hint());
    }
    function clearSession(res) {
        res.clearCookie(ACCESS_COOKIE, { ...access(), maxAge: undefined });
        res.clearCookie(REFRESH_COOKIE, { ...refresh(), maxAge: undefined });
    }
    function clearFlow(res) { for (const c of [STATE_COOKIE, NEXT_COOKIE, SILENT_COOKIE]) res.clearCookie(c, { path: '/auth' }); }

    async function tokenGrant(body) {
        let lastErr = null;
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetchImpl(`${base}/oauth/token`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, ...body }),
                    signal: AbortSignal.timeout(10000),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || `token grant failed (${res.status})`), { status: res.status, error: data.error || 'invalid_grant' });
                return data;
            } catch (err) {
                lastErr = err;
                if (err.status && err.status < 500) throw err;
            }
        }
        throw lastErr || new Error('Network unreachable');
    }

    router.get('/login', async (req, res) => {
        const silent = !!req.query.silent && req.query.silent !== '0';
        const next = sanitizeNext(req.query.next, config);
        if (silent) {
            const actor = await viewers.resolve(req, { services: false }).catch(() => null);
            if (actor && actor.kind === 'user') { clearFlow(res); return res.redirect(next); }
        }
        const { url, state } = authorizeUrl(config, { silent });
        res.cookie(STATE_COOKIE, state, flow());
        if (next !== '/') res.cookie(NEXT_COOKIE, next, flow()); else res.clearCookie(NEXT_COOKIE, { path: '/auth' });
        if (silent) res.cookie(SILENT_COOKIE, '1', flow()); else res.clearCookie(SILENT_COOKIE, { path: '/auth' });
        res.redirect(url);
    });

    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        const next = sanitizeNext(req.cookies && req.cookies[NEXT_COOKIE], config);
        const silent = req.cookies && req.cookies[SILENT_COOKIE] === '1';
        if (error) {
            clearFlow(res);
            if (silent || error === 'login_required') return res.redirect(withParam(next, 'sso', 'none'));
            return res.redirect(withParam('/', 'auth_error', String(error)));
        }
        if (!code) return res.status(400).type('text/plain').send('Missing authorization code');
        const expected = req.cookies && req.cookies[STATE_COOKIE];
        clearFlow(res);
        if (!expected || !state || !crypto.timingSafeEqual(Buffer.from(String(state).padEnd(64).slice(0, 64)), Buffer.from(String(expected).padEnd(64).slice(0, 64)))) {
            return res.status(400).type('text/plain').send('OAuth state mismatch — please try signing in again.');
        }
        try {
            const data = await tokenGrant({ grant_type: 'authorization_code', redirect_uri: config.oauth.redirectUri, code });
            setSession(res, data.access_token, data.refresh_token);
            return res.redirect(next);
        } catch (err) {
            log.error(`[Wiki] code exchange failed: ${err.message}`);
            return res.status(502).type('text/plain').send('Sign-in failed — could not reach OpenVibe.Network. Please try again.');
        }
    });

    router.post('/fedcm', express.json({ limit: '16kb' }), async (req, res) => {
        const { token, nonce } = req.body || {};
        if (typeof token !== 'string' || !token || !fedcmNonceMatches(token, nonce)) return res.status(400).json({ error: 'invalid_request', error_description: 'token and a matching nonce are required' });
        try {
            const data = await tokenGrant({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: token });
            if (!data.access_token) throw Object.assign(new Error('no token'), { status: 401 });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ ok: true, user: data.user || null });
        } catch (err) {
            if (err.status && err.status < 500) return res.status(401).json({ error: 'invalid_grant' });
            return res.status(502).json({ error: 'server_error', error_description: 'Could not reach OpenVibe.Network' });
        }
    });

    router.get('/logout', async (req, res) => {
        const token = req.cookies && req.cookies[REFRESH_COOKIE];
        if (token) {
            try {
                await fetchImpl(`${config.networkInternalUrl || config.networkUrl}/oauth/revoke`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token }),
                    signal: AbortSignal.timeout(3000),
                });
            } catch { /* optional */ }
        }
        clearSession(res);
        res.cookie(HINT_COOKIE, 'guest', hint());
        res.redirect(sanitizeNext(req.query.next, config));
    });

    router.get('/me', async (req, res) => {
        const actor = await viewers.resolve(req, { services: false }).catch(() => null);
        if (!actor || actor.kind !== 'user') return res.status(401).json({ error: 'Not authenticated' });
        res.set('Cache-Control', 'private, no-store').json({ user: actor.user });
    });

    router.post('/refresh', async (req, res) => {
        const token = req.cookies && req.cookies[REFRESH_COOKIE];
        if (!token) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: token });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ token: data.access_token });
        } catch (err) {
            if (err.status && err.status < 500) { clearSession(res); return res.status(401).json({ error: 'Refresh token rejected — please sign in again' }); }
            return res.status(502).json({ error: 'Could not reach OpenVibe.Network' });
        }
    });

    return router;
}

module.exports = { createSessionRoutes, sanitizeNext, authorizeUrl, fedcmNonceMatches };
