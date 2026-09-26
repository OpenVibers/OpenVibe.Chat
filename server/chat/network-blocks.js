/**
 * OpenVibe.Chat — platform blocks (roadmap WS-E task 5; Contracts 0.49.0 network.block.changed).
 *
 * People block each other once, on OpenVibe.Network, and Chat honours it. Network announces every change
 * as network.block.changed (blocker, blocked, active, a per-pair revision); ../events/consumer.js applies
 * each one here, keeping only the newest revision per (blocker, blocked), so a late or replayed event
 * never undoes a newer one.
 *
 * DMs (./dm.js isBlockedEither) refuse a conversation, a group invite or a direct message between two
 * people when either blocked the other, here or in Chat's own dm_blocks. Blocks are between Network
 * subjects; Chat's people are Live ids, mapped through ctx_users.subject_id (db.subjectFor).
 *
 * Public chat (WS-I task 6) is one-way: the person who blocked someone no longer gets that person's
 * lines, live (chat-server.js skips their sockets: blockersOf) or in history reads (routes.js drops
 * them from pages and cursor reads for that reader: blockedUserIds). Everyone else, the blocked
 * person included, sees the room as before; moderation tools and logs show everything.
 */
'use strict';

const { validate } = require('openvibe-contracts');
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
let ready = false;

function ensureSchema() {
    if (ready) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS network_blocks (
        blocker_subject TEXT NOT NULL,
        blocked_subject TEXT NOT NULL,
        active          INTEGER NOT NULL,
        revision        INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (blocker_subject, blocked_subject)
    );
    CREATE INDEX IF NOT EXISTS idx_network_blocks_blocked ON network_blocks(blocked_subject, active);`);
    ready = true;
}

/** The payload of a network.block.changed envelope from Network, or null when it is not one. */
function payloadOf(event) {
    if (!event || event.source !== 'network' || event.event_type !== 'network.block.changed') return null;
    const p = event.payload;
    if (!p || typeof p !== 'object' || !validate('network.block.changed@1', p).valid) return null;
    return p;
}

/** Apply one change when it is newer than what is kept for its pair. → true when the projection moved. */
function apply(p, now = Date.now()) {
    ensureSchema();
    const r = db.run(`INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(blocker_subject, blocked_subject) DO UPDATE SET active = excluded.active, revision = excluded.revision, updated_at = excluded.updated_at
        WHERE excluded.revision > network_blocks.revision`, [p.blocker, p.blocked, p.active ? 1 : 0, p.revision, now]);
    return r.changes > 0;
}

/** Did `blocker` block `blocked` (subjects)? */
function hasBlocked(blocker, blocked) {
    if (!SUBJECT_RE.test(String(blocker || '')) || !SUBJECT_RE.test(String(blocked || ''))) return false;
    ensureSchema();
    return !!db.get('SELECT 1 FROM network_blocks WHERE blocker_subject = ? AND blocked_subject = ? AND active = 1', [blocker, blocked]);
}

/** Did either of two subjects block the other? */
function eitherBlocked(a, b) {
    return hasBlocked(a, b) || hasBlocked(b, a);
}

/** The same, for two Live user ids (through their Network subjects). */
function eitherBlockedUsers(userIdA, userIdB) {
    return eitherBlocked(db.subjectFor(userIdA), db.subjectFor(userIdB));
}

/** The subjects who blocked `blocked` (a subject), active blocks only. One indexed read. */
function blockersOf(blocked) {
    if (!SUBJECT_RE.test(String(blocked || ''))) return [];
    ensureSchema();
    return db.all('SELECT blocker_subject FROM network_blocks WHERE blocked_subject = ? AND active = 1', [blocked]).map((r) => r.blocker_subject);
}

/** The Live user ids a signed-in reader blocked (through their subjects, the ctx_users projection). */
function blockedUserIds(user) {
    const subject = user && (user.subject_id || db.subjectFor(user.id));
    if (!SUBJECT_RE.test(String(subject || ''))) return new Set();
    ensureSchema();
    return new Set(db.all(`SELECT u.id FROM network_blocks b JOIN ctx_users u ON u.subject_id = b.blocked_subject
        WHERE b.blocker_subject = ? AND b.active = 1`, [subject]).map((r) => Number(r.id)));
}

/** For tests: forget that the table was created (the table stays). */
function _reset() { ready = false; }

module.exports = { ensureSchema, payloadOf, apply, hasBlocked, eitherBlocked, eitherBlockedUsers, blockersOf, blockedUserIds, _reset };
