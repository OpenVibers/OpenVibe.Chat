'use strict';
/**
 * The person's Network friends (plan §AB.51; Contracts 0.431.0 network.friend-subjects@1).
 *
 * The friend system is one across every site: a friend made on OpenVibe.Network is a friend
 * everywhere. Chat reads the person's mutual friends from Network (GET /internal/friends?subject=…)
 * with its own service token (the capability network.friends.read) and keeps the answer for a
 * minute, so the contacts list and a DM start do not ask again and again.
 *
 * The read gives subjects only — never names. The names come from Chat's own projection
 * (ctx_users, matched by subject) for the people Chat knows, and from Network's identity resolve
 * for the rest, so a friend Chat has never talked to is still listed with a name and is reachable.
 *
 * A Network that cannot be reached, or one that does not know the capability yet, is not an error
 * here: the person's own contacts stand alone.
 */
const config = require('../config');
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
// The answer is kept for a minute per person.
const TTL_MS = 60_000;
// A Network that cannot be reached is asked again sooner than a minute.
const FAIL_TTL_MS = 15_000;
// The names are asked for in one batch (Network takes 500 subjects a call).
const BATCH = 500;

const _cache = new Map();   // subject -> { at, people }
let _client = null;

/** Chat's client for the Network (one service token, the two capabilities this needs). */
function client() {
    if (_client) return _client;
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const { createClient } = require('openvibe-sdk');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'network.friends.read identity.subject.resolve',
    });
    _client = createClient({ tokenProvider: tokens, timeoutMs: 5000 });
    return _client;
}

/** The subjects of a person's mutual friends, read from Network. */
async function readSubjects(subject) {
    const out = await client().json({
        service: 'network', baseUrl: config.networkInternalUrl, audience: 'openvibe.network', retries: 1,
        path: '/internal/friends', query: { subject },
    });
    return (out && Array.isArray(out.friends) ? out.friends : []).map(String).filter((s) => SUBJECT_RE.test(s));
}

/** The names of people Network knows (identity.subject.resolve, one batch). */
async function readNames(subjects) {
    if (!subjects.length) return {};
    try {
        const out = await client().json({
            service: 'network', baseUrl: config.networkInternalUrl, audience: 'openvibe.network', retries: 1,
            method: 'POST', path: '/internal/identity/resolve-batch', json: { subject_ids: subjects.slice(0, BATCH) }, idempotent: true,
        });
        return (out && out.results) || {};
    } catch (err) {
        console.warn('[NetworkFriends] names:', err.message);
        return {};
    }
}

/**
 * The person's mutual friends as people: { id, username, display_name, avatar_url, subject_id, status }.
 * The id is Chat's own (null for a person Chat has never seen); the rest is the person's name.
 */
async function read(subject) {
    const subjects = await readSubjects(subject);
    if (!subjects.length) return [];
    const rows = await db.all('SELECT id, username, display_name, avatar_url, subject_id FROM ctx_users WHERE subject_id = ANY(?)', [subjects]);
    const known = new Map(rows.map((r) => [r.subject_id, r]));
    // The Network owns the names: a friend who renamed their account is still the right person here.
    const named = await readNames(subjects);
    return subjects.map((s) => {
        const row = known.get(s);
        const n = named[s] || {};
        return {
            id: row ? Number(row.id) : null,
            username: n.username || (row && row.username) || null,
            display_name: n.display_name || (row && row.display_name) || n.username || (row && row.username) || null,
            avatar_url: n.avatar_url || (row && row.avatar_url) || null,
            subject_id: s,
            status: 'friend',
        };
    });
}

/**
 * The person's Network friends, kept for a minute. Never throws: an answer Chat cannot get is no
 * friends, and the person's own contacts stand alone.
 */
async function peopleOf(subject) {
    const s = String(subject || '');
    if (!SUBJECT_RE.test(s)) return [];
    const hit = _cache.get(s);
    if (hit && Date.now() - hit.at < (hit.ttl || TTL_MS)) return hit.people;
    let people = [];
    let failed = false;
    try {
        people = await read(s);
    } catch (err) {
        console.warn('[NetworkFriends]', err.message);
        people = [];
        failed = true;
    }
    _cache.set(s, { at: Date.now(), people, ttl: failed ? FAIL_TTL_MS : TTL_MS });
    return people;
}

/** The person's Network friend with that name (any case), or null. */
async function friendByName(subject, username) {
    const want = String(username || '').trim().toLowerCase();
    if (!want) return null;
    const people = await peopleOf(subject);
    return people.find((p) => String(p.username || '').toLowerCase() === want) || null;
}

/** Forget the cached answer (a test, and the moment a friendship changes). */
function reset() { _cache.clear(); }

module.exports = { peopleOf, friendByName, reset, TTL_MS, FAIL_TTL_MS };
