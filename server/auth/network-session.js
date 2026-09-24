/**
 * OpenVibe.Chat — Network session tokens verified here (WS-I task 3).
 *
 * A browser's Network JWT (RS256, issuer the Network) is verified with the Network's public key
 * (net/service-auth.js ensureKey: the PEM file, else the Network's JWKS) and resolved to the chat
 * user through the ctx_users projection by its subject (usr_…). Live is asked (live-context
 * authenticate, which also creates first-time accounts) only when that cannot answer:
 *   - hbt_ API tokens (Live owns them and their scopes);
 *   - no key loaded yet, anything that is not a JWT, or a signature that does not match the key we
 *     hold (a rotation);
 *   - a token without a subject, or a subject with no single projected user (first visit, merges).
 * So a signed-in person keeps chatting while Live restarts or is down.
 *
 * The user carries the token's staff_caps (permissions.can reads them first) and its role when
 * that is higher than the projection's; a lower one is ignored, as Live does (downgrades arrive
 * from the Network over Live, then the bridge).
 */
'use strict';

const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const config = require('../config');
const db = require('../db/database');
const serviceAuth = require('../net/service-auth');
const ctx = require('../live-context');
const revocations = require('./revocations');

const ROLE_RANK = { user: 0, streamer: 1, global_mod: 2, admin: 3 };
const stats = { local: 0, live: 0, rejected: 0 };
const _reasons = new Map(); // sha256(token) → 'invalid' for tokens refused here (bounded)
const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** { ok: true, claims } | { ok: false, reason }. Session tokens only (no typ / actor_type claims). */
function verify(token, publicKey, { issuer = config.networkUrl, now = Date.now() } = {}) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    let header; let claims;
    try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return { ok: false, reason: 'malformed' }; }
    if (!header || header.alg !== 'RS256' || !claims || typeof claims !== 'object') return { ok: false, reason: 'malformed' };
    let good = false;
    try { good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
    if (!good) return { ok: false, reason: 'signature' };
    const s = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || s >= claims.exp) return { ok: false, reason: 'expired' };
    if (typeof claims.nbf === 'number' && s + 30 < claims.nbf) return { ok: false, reason: 'not_yet_valid' };
    if (issuer && claims.iss !== issuer) return { ok: false, reason: 'issuer' };
    if (claims.typ !== undefined || claims.actor_type !== undefined) return { ok: false, reason: 'not_a_session_token' };
    return { ok: true, claims };
}

/** The projected user for a verified token, or null when the projection cannot say which one. */
function userFor(claims) {
    const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
    if (!subject) return null;
    const rows = db.all('SELECT * FROM ctx_users WHERE subject_id = ? LIMIT 2', [subject]);
    if (rows.length !== 1) return null;
    const row = rows[0];
    const user = {
        id: row.id, username: row.username, display_name: row.display_name, avatar_url: row.avatar_url || null,
        profile_color: row.profile_color || null, role: row.role || 'user', is_banned: row.is_banned ? 1 : 0, ban_reason: row.ban_reason || null,
        is_owner: row.is_owner ? 1 : 0, created_at: row.created_at, subject_id: subject, auth_source: 'network',
    };
    if (claims.role && ROLE_RANK[claims.role] !== undefined && ROLE_RANK[claims.role] > (ROLE_RANK[user.role] ?? 0)) user.role = claims.role;
    if (Array.isArray(claims.staff_caps)) user.staff_caps = claims.staff_caps.filter((c) => typeof c === 'string');
    return user;
}

function refuse(token) {
    stats.rejected++;
    _reasons.set(tokenKey(token), 'invalid');
    if (_reasons.size > 10000) _reasons.delete(_reasons.keys().next().value);
    return null;
}

/** Resolve a browser/bot token to a chat user (a fresh object) or null. */
async function authenticate(token) {
    if (!token) return null;
    const viaLive = async () => {
        stats.live++;
        const u = await ctx.authenticate(token);
        // Live resolved a Network token (first visit, another key): the same cutoff applies.
        const iat = u && u.auth_source !== 'api_token' ? tokenIat(token) : null;
        if (iat != null && iat * 1000 < revocations.cutoffFor(u.subject_id)) return refuse(token);
        return u;
    };
    if (String(token).startsWith('hbt_')) return viaLive();
    const key = await serviceAuth.ensureKey();
    if (!key) return viaLive();
    const r = verify(token, key);
    // Only a token signed by the key we hold is decided here; anything else is Live's to judge.
    if (!r.ok) return r.reason === 'signature' || r.reason === 'malformed' ? viaLive() : refuse(token);
    // Signed out everywhere, password changed, banned…: Network's cutoff for this person (WS-B task 4).
    if (revocations.isRevoked(r.claims)) return refuse(token);
    const user = userFor(r.claims);
    if (!user) return viaLive();
    stats.local++;
    return user;
}

/** A JWT's iat (seconds), read without verifying (the token was verified when it was accepted); null otherwise. */
function tokenIat(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { const c = b64json(parts[1]); return typeof c.iat === 'number' ? c.iat : null; } catch { return null; }
}

/** Why the last resolution of this token failed: 'invalid' (bad/expired) or 'unresolved' (no account). */
function failureReason(token) {
    return (token && _reasons.get(tokenKey(token))) || ctx.authFailureReason(token);
}

module.exports = { authenticate, failureReason, verify, userFor, tokenIat, stats: () => ({ ...stats }) };
