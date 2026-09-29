/**
 * OpenVibe.Chat — per-person token cutoffs (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after).
 *
 * When a person signs out everywhere, changes or resets their password, is banned or has their
 * sessions ended by staff, Network moves their cutoff and says so. Chat keeps the latest cutoff per
 * subject here, refuses a Network token issued before it (auth/network-session.js, Network's rule:
 * iat * 1000 < valid_after) and closes the sockets such tokens opened (chat-server revokeSubject).
 */
'use strict';

const db = require('../db/database');

const cache = new Map(); // subject → valid_after ms (0 = none known)

// The table is in migrations/0001_initial.sql (PostgreSQL); nothing is created at runtime. Kept for callers.
function ensureSchema() {}

/** The cutoff for a subject in ms, 0 when none. */
async function cutoffFor(subject) {
    if (!subject) return 0;
    if (cache.has(subject)) return cache.get(subject);
    ensureSchema();
    const row = await db.get('SELECT valid_after_ms FROM token_revocations WHERE subject_id = ?', [subject]);
    const ms = row ? Number(row.valid_after_ms) || 0 : 0;
    if (cache.size > 50000) cache.clear();
    cache.set(subject, ms);
    return ms;
}

/** Keep the later cutoff (events can arrive out of order). Returns true when it moved forward. */
async function record(subject, validAfterMs, reason = null, now = Date.now()) {
    ensureSchema();
    const current = await cutoffFor(subject);
    if (!(validAfterMs > current)) return false;
    await db.run(`INSERT INTO token_revocations (subject_id, valid_after_ms, reason, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(subject_id) DO UPDATE SET valid_after_ms = excluded.valid_after_ms, reason = excluded.reason, updated_at = excluded.updated_at
        WHERE excluded.valid_after_ms > token_revocations.valid_after_ms`, [subject, validAfterMs, reason, now]);
    cache.set(subject, validAfterMs);
    return true;
}

/** Was a token with these claims issued before its subject's cutoff? */
async function isRevoked(claims) {
    if (!claims || typeof claims.iat !== 'number') return false;
    return claims.iat * 1000 < await cutoffFor(claims.subject_id);
}

/** For tests: forget the in-memory cache (the table stays). */
function _reset() { cache.clear(); }

module.exports = { ensureSchema, cutoffFor, record, isRevoked, _reset };
