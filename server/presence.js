'use strict';
/**
 * OpenVibe.Network presence for Chat (plan 2026-10-22 track X item 9; Contracts 0.318.0
 * network.presence@1).
 *
 * Network owns the person's chosen online status. Chat reads it through Network's internal API as a
 * first-party service (GET /internal/presence?for=usr_…&subjects=…, network.presence.read) and caches
 * the answer for 30 seconds. The answer already applies the privacy rule for `for`: themselves, people
 * they follow and people they share a direct conversation with, never a stranger, and never an
 * invisible person. Chat never widens it; an absent subject is simply drawn as offline.
 *
 * DND is read the same way for the person it belongs to (for = themselves): a DM message to a person
 * in DND arrives with `silent: true` and is left out of the Network push, so Chat does not ping them.
 *
 * When Network does not answer, nobody is shown a state (the UI draws offline) and no ping is muted:
 * failing closed on privacy, and never blocking a message on presence.
 */
const config = require('./config');
const auth = require('./net/service-auth');

const TTL_MS = 30_000;
const FAIL_TTL_MS = 5_000;
const MAX_SUBJECTS = 100;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const cache = new Map();

/** Network presence for `subjects` as `viewer` may see it → Map(subject → presence view). */
async function forViewer(viewer, subjects) {
    const list = [...new Set((subjects || []).filter((s) => SUBJECT_RE.test(String(s))))].slice(0, MAX_SUBJECTS);
    if (!viewer || !SUBJECT_RE.test(String(viewer)) || !list.length) return new Map();
    const key = `${viewer}|${list.sort().join(',')}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    let value = new Map();
    let ttl = FAIL_TTL_MS;
    try {
        const headers = await auth.headers('openvibe.network', ['network.presence.read']);
        const url = `${config.networkInternalUrl}/internal/presence?for=${encodeURIComponent(viewer)}&subjects=${list.map(encodeURIComponent).join(',')}`;
        const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(1500) });
        if (res.ok) {
            const body = await res.json().catch(() => ({}));
            for (const p of Array.isArray(body.presence) ? body.presence : []) if (SUBJECT_RE.test(String(p.subject))) value.set(p.subject, p);
            ttl = TTL_MS;
        }
    } catch { /* Network down: no state, no muted pings */ }
    if (cache.size > 1000) cache.clear();
    cache.set(key, { at: Date.now(), value, ttl });
    return value;
}

/** Attach `presence` (the Network view or null) to each person in `people`, keyed by subject_id. */
async function attachTo(viewer, people) {
    const list = Array.isArray(people) ? people : [];
    const subjects = list.map((p) => p && p.subject_id).filter(Boolean);
    const seen = await forViewer(viewer, subjects);
    for (const p of list) if (p) p.presence = (p.subject_id && seen.get(p.subject_id)) || null;
    return list;
}

/** The person's own presence (for DND). Null when Network cannot answer. */
async function self(subject) {
    return (await forViewer(subject, [subject])).get(subject) || null;
}

function clearCache() { cache.clear(); }

module.exports = { forViewer, attachTo, self, clearCache, TTL_MS, SUBJECT_RE, MAX_SUBJECTS };
