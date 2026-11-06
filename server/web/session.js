'use strict';
/**
 * openvibe.chat as an OAuth2 client of OpenVibe.Network (client `chat`, redirect
 * <CHAT_WEB_URL>/auth/callback): the session layer OpenVibe.Wiki and OpenVibe.Community use. The OAuth half is
 * openvibe-sdk/sso's (createSsoClient): the authorize URL, the PKCE S256 pair, the code, refresh and FedCM grants
 * and GET /auth/health. The state is compared with the flow cookie in constant time.
 *
 *   GET  /auth/login     → Network /oauth/authorize (?silent=1 adds prompt=none; ?next= same-site path)
 *   GET  /auth/callback  → server-side code exchange with the PKCE verifier, sets the cookies
 *   POST /auth/fedcm     → the shared navbar's FedCM assertion (nonce checked here, signature by the Network)
 *   GET  /auth/health    → does the Network accept this OAuth client? 503 only when it refuses it
 *   GET  /auth/logout    → clears the cookies (best-effort refresh revoke)
 *   GET  /auth/me        → the signed-in profile (offline JWT verification); a guest gets 200 { user: null }
 *   POST /auth/refresh   → rotates tokens with the refresh token
 *
 * Cookies (host-only, the names this site has always used): ov_token (access JWT, JS-readable for the navbar),
 * ov_refresh (httpOnly, Path=/auth), ov_sso_hint ('account' | 'guest', tells the navbar whether a silent login is
 * worth it). The redirect URI is unchanged.
 */
const crypto = require('crypto');
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { createSsoClient, failurePage } = require('openvibe-sdk/sso');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const HINT_COOKIE = 'ov_sso_hint';
const STATE_COOKIE = 'ov_oauth_state';
const VERIFIER_COOKIE = 'ov_oauth_verifier';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';
const SITE_NAME = 'OpenVibe.Chat';

function sanitizeNext(next, config) {
    // Browsers drop tab and newline characters from a URL and read a backslash as "/": "/<TAB>/evil.com" would
    // leave the site. A next with any control character or backslash goes home.
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
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

/** Compare two strings in constant time (the state must match the browser that started the flow). */
function sameString(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
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
    const sdkSso = createSsoClient({
        site: 'chat',
        siteName: SITE_NAME,
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        secureCookies: secure,
        fetch: fetchImpl,
        log,
    });
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
    function clearFlow(res) { for (const c of [STATE_COOKIE, VERIFIER_COOKIE, NEXT_COOKIE, SILENT_COOKIE]) res.clearCookie(c, { path: '/auth' }); }

    router.get('/login', async (req, res) => {
        const silent = !!req.query.silent && req.query.silent !== '0';
        const next = sanitizeNext(req.query.next, config);
        if (silent) {
            const actor = await viewers.resolve(req, { services: false }).catch(() => null);
            if (actor && actor.kind === 'user') { clearFlow(res); return res.redirect(next); }
        }
        const started = sdkSso.authorizeUrl({ silent });
        res.cookie(STATE_COOKIE, started.state, flow());
        res.cookie(VERIFIER_COOKIE, started.verifier, flow());
        if (next !== '/') res.cookie(NEXT_COOKIE, next, flow()); else res.clearCookie(NEXT_COOKIE, { path: '/auth' });
        if (silent) res.cookie(SILENT_COOKIE, '1', flow()); else res.clearCookie(SILENT_COOKIE, { path: '/auth' });
        res.redirect(started.url);
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
        const verifier = req.cookies && req.cookies[VERIFIER_COOKIE];
        clearFlow(res);
        if (!verifier || !sameString(state, expected)) {
            return res.status(400).type('text/plain').send('OAuth state mismatch — please try signing in again.');
        }
        try {
            const data = await sdkSso.tokenGrant({ grant_type: 'authorization_code', redirect_uri: config.oauth.redirectUri, code: String(code), code_verifier: verifier });
            setSession(res, data.access_token, data.refresh_token);
            return res.redirect(next);
        } catch (err) {
            if (err.status === 401 || err.error === 'invalid_client' || err.error === 'unauthorized_client') {
                log.error(`[Chat] the Network refuses this site's OAuth client (${err.error || err.status}): check OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET`);
                return res.status(500).type('html').send(failurePage({
                    siteName: SITE_NAME,
                    title: 'Sign-in isn\'t working on OpenVibe.Chat right now',
                    text: 'This is a problem on our side, not with your account, and it has been logged. Please try again a little later.',
                    retryHref: `/auth/login?next=${encodeURIComponent(next)}`,
                    backHref: next || '/',
                }));
            }
            log.error(`[Chat] code exchange failed: ${err.message}`);
            return res.status(502).type('text/plain').send('Sign-in failed — could not reach OpenVibe.Network. Please try again.');
        }
    });

    // GET /auth/health: does the Network accept this site's OAuth client? 503 only when it refuses it.
    router.get('/health', async (_req, res) => {
        const client = await sdkSso.checkClient();
        res.set('Cache-Control', 'no-store');
        return res.status(client === 'invalid' ? 503 : 200).json({ ok: client !== 'invalid', client });
    });

    router.post('/fedcm', express.json({ limit: '16kb' }), async (req, res) => {
        const { token, nonce } = req.body || {};
        if (typeof token !== 'string' || !token || !fedcmNonceMatches(token, nonce)) return res.status(400).json({ error: 'invalid_request', error_description: 'token and a matching nonce are required' });
        try {
            const data = await sdkSso.tokenGrant({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: token });
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
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        // No credential at all (a guest) is signed out, not an error: the shared navbar asks this on every
        // page view, and a 401 logged a console error on each (browser check, OpenVibe.Host). A credential
        // that is present but invalid or expired still answers 401.
        if (!(req.cookies && req.cookies[ACCESS_COOKIE]) && !req.get('authorization')) return res.json({ user: null });
        const actor = await viewers.resolve(req, { services: false }).catch(() => null);
        if (!actor || actor.kind !== 'user') return res.status(401).json({ error: 'Not authenticated' });
        res.json({ user: actor.user });
    });

    router.post('/refresh', async (req, res) => {
        const token = req.cookies && req.cookies[REFRESH_COOKIE];
        if (!token) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await sdkSso.tokenGrant({ grant_type: 'refresh_token', refresh_token: token });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ token: data.access_token });
        } catch (err) {
            if (err.status && err.status < 500) { clearSession(res); return res.status(401).json({ error: 'Refresh token rejected — please sign in again' }); }
            return res.status(502).json({ error: 'Could not reach OpenVibe.Network' });
        }
    });

    return router;
}

module.exports = { createSessionRoutes, sanitizeNext, fedcmNonceMatches };
