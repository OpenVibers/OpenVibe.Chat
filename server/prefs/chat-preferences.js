/**
 * A person's chat preferences: the OpenVibe.Network user module `chat.preferences`
 * (openvibe-contracts manifests/namespaces/chat.preferences.json, schema v1: timestamps, compact,
 * font_scale, show_badges, hide_emotes). Chat owns the namespace since the Wave 6 cutover; Network
 * stores it, validates it, versions it (revision) and announces every change (network.module.updated).
 *
 *   get(subject)            the record ({ preferences, revision, version }); {} and revision 0 when the
 *                           person has none. Cached per person for config.prefs.ttlMs; when Network
 *                           cannot answer, a cached copy is served (stale: true), else 503.
 *   update(subject, patch)  { field: value | null } (null removes the field). Read-modify-write against
 *                           Network naming the revision read (If-Match); a revision that moved is read
 *                           again, up to 3 times. With expectedRevision (the browser's If-Match) it is
 *                           strict instead: 412 when the record moved. A patch that changes nothing
 *                           writes nothing.
 *   handleEvent(envelope)   network.module.updated for chat.preferences newer than the cached copy
 *                           drops it at once. Called by the Events consumer (server/events/consumer.js,
 *                           Chat's subscription to network.module.updated); without that subscription
 *                           the TTL bounds how long a change made outside Chat takes to show.
 *
 * Only usr_ subjects: Network keeps modules for accounts, and Chat learns a person's subject from Live.
 */
'use strict';

const { modules } = require('openvibe-contracts');
const config = require('../config');
const client = require('./network-modules');

const NAMESPACE = 'chat.preferences';
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const FIELDS = Object.freeze(Object.keys(modules.get(NAMESPACE).schema.properties));
const MAX_TRIES = 3;

class PrefsError extends Error {
    constructor(status, code, message, errors) { super(message); this.status = status; this.code = code; if (errors) this.errors = errors; }
}

const cache = new Map();            // subject → { data, revision, version, at } (insertion order = age)
let clock = () => Date.now();

function enabled() { return !!(config.prefs.enabled && config.oauth.clientSecret); }

function remember(subject, rec) {
    cache.delete(subject);
    cache.set(subject, { data: rec.data, revision: rec.revision, version: rec.version, at: clock() });
    while (cache.size > Math.max(1, config.prefs.maxEntries)) cache.delete(cache.keys().next().value);
}

const view = (rec, extra = {}) => ({ namespace: NAMESPACE, version: rec.version, revision: rec.revision, preferences: { ...rec.data }, ...extra });

function unavailable(r) {
    return new PrefsError(503, 'prefs.unavailable', r.error ? `OpenVibe.Network is unavailable (${r.error})` : `OpenVibe.Network answered ${r.status}`);
}

function checkSubject(subject) {
    if (!enabled()) throw new PrefsError(503, 'prefs.disabled', 'chat preferences are not configured on this server');
    if (!USER_SUBJECT.test(String(subject || ''))) throw new PrefsError(409, 'prefs.subject_unknown', 'this account is not linked to OpenVibe.Network yet');
}

/** The current record from Network ({ data, revision, version }; none yet = {} at revision 0). */
async function fetchRecord(subject) {
    const r = await client.request('GET', NAMESPACE, subject);
    if (r.status === 200 && r.body && r.body.data && typeof r.body.data === 'object') {
        return { data: r.body.data, revision: Number(r.body.revision) || 0, version: Number(r.body.version) || 1 };
    }
    if (r.status === 404 && r.body && r.body.code === 'modules.not_found') return { data: {}, revision: 0, version: modules.get(NAMESPACE).version };
    if (r.status === 403) throw new PrefsError(503, 'prefs.not_granted', 'Chat may not read chat.preferences (Network grant missing)');
    throw unavailable(r);
}

async function get(subject, { fresh = false } = {}) {
    checkSubject(subject);
    const hit = cache.get(subject);
    if (!fresh && hit && clock() - hit.at < config.prefs.ttlMs) return view(hit);
    try {
        const rec = await fetchRecord(subject);
        remember(subject, rec);
        return view(rec);
    } catch (err) {
        if (hit && err.status === 503) return view(hit, { stale: true });
        throw err;
    }
}

/** A patch's problems: unknown fields, or a value the schema refuses once applied. */
function checkPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PrefsError(400, 'prefs.bad_request', 'send { preferences: { field: value } }');
    const unknown = Object.keys(patch).filter((k) => !FIELDS.includes(k));
    if (unknown.length) throw new PrefsError(422, 'prefs.invalid', `unknown preference${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, unknown.map((k) => ({ path: `/${k}`, message: 'not a chat preference' })));
}

const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

async function update(subject, patch, { expectedRevision } = {}) {
    checkSubject(subject);
    checkPatch(patch);
    for (let i = 0; i < MAX_TRIES; i++) {
        const cur = await fetchRecord(subject);
        if (expectedRevision !== undefined && cur.revision !== expectedRevision) {
            remember(subject, cur);
            throw new PrefsError(412, 'prefs.revision_conflict', `the preferences changed (revision ${cur.revision}, not ${expectedRevision}); read them again`);
        }
        const next = { ...cur.data };
        for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
        const v = modules.validateData(NAMESPACE, next);
        if (!v.valid) throw new PrefsError(422, 'prefs.invalid', 'these values are not allowed', v.errors);
        if (same(next, cur.data)) { remember(subject, cur); return view(cur); }
        const r = await client.request('PUT', NAMESPACE, subject, { data: next, revision: cur.revision });
        if ((r.status === 200 || r.status === 201) && r.body && r.body.data) {
            const rec = { data: r.body.data, revision: Number(r.body.revision) || 0, version: Number(r.body.version) || 1 };
            remember(subject, rec);
            return view(rec);
        }
        if (r.status === 412) {
            if (expectedRevision !== undefined) throw new PrefsError(412, 'prefs.revision_conflict', 'the preferences changed; read them again');
            continue;                                      // someone else wrote first: read again
        }
        if (r.status === 422) throw new PrefsError(422, 'prefs.invalid', 'these values are not allowed', r.body && r.body.errors);
        if (r.status === 404) throw new PrefsError(409, 'prefs.subject_unknown', 'this account is not known to OpenVibe.Network');
        if (r.status === 403 || r.status === 409) throw new PrefsError(503, 'prefs.not_granted', `Network refused the write (${(r.body && r.body.code) || r.status})`);
        throw unavailable(r);
    }
    throw new PrefsError(409, 'prefs.busy', 'the preferences kept changing; try again');
}

function handleEvent(envelope) {
    if (!envelope || envelope.event_type !== 'network.module.updated' || envelope.source !== 'network') return false;
    const p = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const subject = p.owner && p.owner.id;
    if (p.namespace !== NAMESPACE || !cache.has(subject)) return false;
    if (!(Number(p.revision) > cache.get(subject).revision)) return false;   // ours, or older than what we hold
    cache.delete(subject);
    return true;
}

function invalidate(subject) { return cache.delete(subject); }

/** Tests: an injected clock; clears the cache. */
function _configure({ now } = {}) { if (now) clock = now; cache.clear(); }
function _cached(subject) { return cache.get(subject) || null; }

module.exports = { NAMESPACE, FIELDS, PrefsError, enabled, get, update, handleEvent, invalidate, _configure, _cached };
