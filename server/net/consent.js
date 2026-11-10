'use strict';
/**
 * OpenVibe.Network's consent check, as Chat sees it for the room insight (plan L24: data and AI use by
 * consent, openvibe-contracts network.consent@1).
 *
 *   allowedSubjects(subjects)  POST /internal/consent/check { purpose: 'ai.train', kind: 'chat' }
 *                              with Chat's own service token (client `chat`, capability
 *                              network.consent.read). A person who has not allowed AI use of their
 *                              chat messages is left out of what the summariser reads.
 *
 * Fail-closed, exactly as the consent contract says: no token, an answer that is not ok, a timeout or a
 * Network that is down all mean "nobody allowed". An answer is cached 60 s per person; a failed call is
 * not retried for 30 s, so an outage costs one call, not one per tick. Nothing here logs a subject.
 */
const config = require('../config');
const auth = require('./service-auth');

const CACHE_TTL_MS = 60_000;
const FAIL_TTL_MS = 30_000;
const MAX_BATCH = 500;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const cache = new Map();          // subject → { at, allowed }
let blockedUntil = 0;             // a failed call: nobody is allowed until this passes
let lastLog = '';

function _log(message) {
    if (message === lastLog) return;
    lastLog = message;
    console.warn(`[Consent] ${message}`);
}

async function _ask(batch) {
    const headers = await auth.headers('openvibe.network', 'network.consent.read');
    const res = await fetch(`${config.networkInternalUrl}/internal/consent/check`, {
        method: 'POST',
        headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'ai.train', kind: 'chat', subjects: batch }),
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const data = await res.json().catch(() => null);
    return (data && data.allowed) || {};
}

/**
 * Which of these subjects allowed AI use of their chat messages. Always a Set of subject ids; a subject
 * that was not asked (no Network account, a relay or anon author) is simply not in it.
 */
async function allowedSubjects(subjects) {
    const wanted = [...new Set((subjects || []).map(String).filter((s) => SUBJECT_RE.test(s)))];
    const now = Date.now();
    const allowed = new Set();
    const missing = [];
    for (const s of wanted) {
        const hit = cache.get(s);
        if (hit && now - hit.at < CACHE_TTL_MS) { if (hit.allowed) allowed.add(s); } else missing.push(s);
    }
    if (!missing.length || blockedUntil > now) return allowed;
    for (let i = 0; i < missing.length; i += MAX_BATCH) {
        const batch = missing.slice(i, i + MAX_BATCH);
        try {
            const answers = await _ask(batch);
            const at = Date.now();
            for (const s of batch) {
                const ok = answers[s] === true;
                cache.set(s, { at, allowed: ok });
                if (ok) allowed.add(s);
                else allowed.delete(s);
            }
            lastLog = '';
        } catch (err) {
            blockedUntil = Date.now() + FAIL_TTL_MS;
            _log(`check failed, leaving everyone out: ${(err && err.message) || err}`);
            return allowed;   // fail closed; the people already cached as allowed stay
        }
    }
    return allowed;
}

/** The rows whose author allowed AI use. Rows without a Network subject (anon, relay, deleted) are left out. */
async function filterRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const allowed = await allowedSubjects(list.map((r) => r && r.subject_id).filter(Boolean));
    return list.filter((r) => r && r.subject_id && allowed.has(String(r.subject_id)));
}

module.exports = { allowedSubjects, filterRows, _reset() { cache.clear(); blockedUntil = 0; lastLog = ''; } };
