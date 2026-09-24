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

let ready = false;
const cache = new Map(); // subject → valid_after ms (0 = none known)

function ensureSchema() {
    if (ready) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS token_revocations (
        subject_id     TEXT PRIMARY KEY,
        valid_after_ms INTEGER NOT NULL,
        reason         TEXT,
        updated_at     INTEGER NOT NULL
    )`);
    ready = true;
}

/** The cutoff for a subject in ms, 0 when none. */
function cutoffFor(subject) {
    if (!subject) return 0;
    if (cache.has(subject)) return cache.get(subject);
    ensureSchema();
    const row = db.get('SELECT valid_after_ms FROM token_revocations WHERE subject_id = ?', [subject]);
    const ms = row ? Number(row.valid_after_ms) || 0 : 0;
    if (cache.size > 50000) cache.clear();
    cache.set(subject, ms);
    return ms;
}

/** Keep the later cutoff (events can arrive out of order). Returns true when it moved forward. */
function record(subject, validAfterMs, reason = null, now = Date.now()) {
    ensureSchema();
    const current = cutoffFor(subject);
    if (!(validAfterMs > current)) return false;
    db.run(`INSERT INTO token_revocations (subject_id, valid_after_ms, reason, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(subject_id) DO UPDATE SET valid_after_ms = excluded.valid_after_ms, reason = excluded.reason, updated_at = excluded.updated_at
        WHERE excluded.valid_after_ms > token_revocations.valid_after_ms`, [subject, validAfterMs, reason, now]);
    cache.set(subject, validAfterMs);
    return true;
}

/** Was a token with these claims issued before its subject's cutoff? */
function isRevoked(claims) {
    if (!claims || typeof claims.iat !== 'number') return false;
    return claims.iat * 1000 < cutoffFor(claims.subject_id);
}

/** For tests: forget the in-memory cache (the table stays). */
function _reset() { cache.clear(); ready = false; }

module.exports = { ensureSchema, cutoffFor, record, isRevoked, _reset };
