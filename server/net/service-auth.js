/**
 * Service principals, both directions (openvibe-contracts serviceAuth, ADR-003).
 *
 *   headers(audience, scope)  Chat → another service: cached client-credentials token from the
 *                             Network's /oauth/token for client `chat`.
 *   guard(capability)         another service → Chat: Express guard for /internal/live/* that
 *                             verifies an RS256 service token for audience openvibe.chat and
 *                             checks the capability in its `cap` claim.
 *
 * The capabilities Chat introduces (docs/capabilities-proposal/) are not in the contracts
 * registry yet, so requireCapability() — which refuses unknown ids — can't be used for them;
 * the guard checks grants with the same library functions and switches to requireCapability as
 * soon as the registry knows the id. Internal routes are loopback-only: a request that came
 * through nginx/Cloudflare (it carries a forwarding header) is refused whatever it presents.
 */
'use strict';

const fs = require('fs');
const { serviceAuth, capabilities, http } = require('openvibe-contracts');
const config = require('../config');

const AUDIENCE = 'openvibe.chat';

let _publicKey = null;
let _keyLoading = null;

function loadKeyFromFile() {
    const p = config.networkPublicKeyPath;
    if (!p) return null;
    try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}

/** The Network's RS256 public key: the PEM file when configured, else the Network's JWKS endpoint. */
async function ensureKey() {
    if (_publicKey) return _publicKey;
    const fromFile = loadKeyFromFile();
    if (fromFile) { _publicKey = fromFile; return _publicKey; }
    if (!_keyLoading) {
        _keyLoading = (async () => {
            try {
                const res = await fetch(`${config.networkInternalUrl}/api/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
                const jwks = await res.json().catch(() => null);
                if (jwks && jwks.public_key) { _publicKey = jwks.public_key; console.log('[Auth] Network public key loaded from JWKS'); }
            } catch (err) {
                console.warn('[Auth] Network public key unavailable:', err.message);
            } finally { _keyLoading = null; }
            return _publicKey;
        })();
    }
    return _keyLoading;
}
function setPublicKey(pem) { _publicKey = pem || null; }

const _clients = new Map();
function clientFor(audience, scope) {
    const key = `${audience}|${scope || ''}`;
    if (!config.oauth.clientSecret) return null;
    if (!_clients.has(key)) {
        _clients.set(key, serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience,
            scope,
        }));
    }
    return _clients.get(key);
}

/** Bearer headers for a call to another service. Throws when no token can be had. */
async function headers(audience, scope) {
    const c = clientFor(audience, scope);
    if (!c) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    return c.authHeaders();
}
function invalidate(audience, scope) { const c = _clients.get(`${audience}|${scope || ''}`); if (c) c.invalidate(); }

function viaProxy(req) {
    return !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']);
}

/** Express guard for one capability on an /internal route. */
function guard(capability) {
    const registered = !!capabilities.get(capability);
    return async function serviceGuard(req, res, next) {
        const ctx = http.requestContext(req.headers);
        if (viaProxy(req)) return http.sendProblem(res, 403, 'capability.denied', { detail: 'internal routes are loopback-only', ctx });
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'no service token', ctx });
        const publicKey = await ensureKey();
        if (!publicKey) return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded', ctx });
        const r = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey, issuer: config.networkUrl, audience: AUDIENCE });
        if (!r.ok) return http.sendProblem(res, 401, r.code, { detail: r.reason, ctx });
        const c = registered
            ? capabilities.check(r.claims, capability)
            : (capabilities.grants(r.claims.cap, capability) ? { allowed: true } : { allowed: false, code: 'capability.denied', reason: `${capability} not granted` });
        if (!c.allowed) return http.sendProblem(res, 403, c.code || 'capability.denied', { detail: c.reason, ctx });
        req.principal = { sub: r.claims.sub, cap: r.claims.cap, jti: r.claims.jti };
        next();
    };
}

module.exports = { AUDIENCE, ensureKey, setPublicKey, headers, invalidate, guard, viaProxy };
