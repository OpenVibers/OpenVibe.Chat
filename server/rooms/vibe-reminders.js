'use strict';
/**
 * Reminders from a Vibe chat (plan L48, V1; the owner, 2026-11-01: "use a voice feature to tell it to set a reminder").
 * Vibe sets, lists and stops a person's own reminders on OpenVibe.Today (its set_reminder, my_reminders and
 * stop_reminder tools, server/rooms/ai-tools.js). Chat's own service token (audience openvibe.today, scope
 * today.reminder.write, granted by Network) names the person in X-OV-Subject, so the reminder is theirs: it arrives in
 * their bell and as a push on every OpenVibe site, and they snooze, stop or remove it on openvibe.today/me, where it
 * shows as "Set by Vibe".
 *
 *   create(subject, { text, timezone }) → { reminder } | { error }    text: what and when, in the person's own words
 *   list(subject)                       → { reminders, manage } | { error }
 *   stop(subject, id)                   → { stopped } | { error }
 *   fromRequest(message)                → the person's own words when the message plainly asks for a reminder, or null
 */
const config = require('../config');

const TODAY_SITE = 'https://openvibe.today';
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ID = /^rem_[0-9A-HJKMNP-TV-Z]{26}$/;

let tokens = null;
function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    // Its own token, apart from Chat's other scopes: asking for a scope Network has not granted would refuse it whole.
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.today', scope: 'today.reminder.write',
    });
    return tokens;
}

/** What Vibe is told about a reminder: its words, its rule in words, when next, and where the person manages it. */
const wire = (r) => ({ id: r.id, title: r.title, when: r.summary, next_at: r.next_at || null, repeats: !!r.repeats, status: r.status });

async function call(method, path, subject, body, { fetchImpl = globalThis.fetch } = {}) {
    if (!config.oauth.clientSecret) return { error: 'reminders are not available on this server' };
    if (!SUBJECT.test(String(subject || ''))) return { error: 'they need to be signed in with an OpenVibe account' };
    let token;
    try { token = await tokenClient().getToken(); } catch { return { error: 'reminders are not available right now' }; }
    try {
        const res = await fetchImpl(`${config.today.internalUrl}${path}`, {
            method, headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
        });
        const json = res.status === 204 ? {} : await res.json().catch(() => null);
        // Today's own words for a vague time ("Say when: …") go back to Vibe, so it can ask the person.
        if (!res.ok) return { error: (json && (json.error || json.message || json.detail)) ? String(json.error || json.message || json.detail).slice(0, 200) : `OpenVibe.Today answered ${res.status}` };
        return { json };
    } catch { return { error: 'OpenVibe.Today is unreachable' }; }
}

async function create(subject, { text, timezone } = {}, deps = {}) {
    const words = String(text || '').replace(/\s+/g, ' ').trim();
    if (!words || words.length > 500) return { error: 'say what to remind them of and when, in up to 500 characters' };
    const out = await call('POST', '/api/v1/reminders', subject, { text: words, tz: String(timezone || 'UTC').slice(0, 64), source: 'vibe', url: 'https://openvibe.chat/vibe' }, deps);
    return out.error ? out : { reminder: wire(out.json), manage: `${TODAY_SITE}/me#reminders` };
}

async function list(subject, deps = {}) {
    const out = await call('GET', '/api/v1/reminders', subject, null, deps);
    if (out.error) return out;
    const all = Array.isArray(out.json && out.json.reminders) ? out.json.reminders : [];
    return { reminders: all.filter((r) => r.status === 'active').slice(0, 30).map(wire), manage: `${TODAY_SITE}/me#reminders` };
}

async function stop(subject, id, deps = {}) {
    if (!ID.test(String(id || ''))) return { error: 'that is not a reminder id (rem_…); list them with my_reminders' };
    const out = await call('POST', `/api/v1/reminders/${encodeURIComponent(id)}/done`, subject, {}, deps);
    return out.error ? out : { stopped: wire(out.json) };
}

// "remind me to stretch every 2 hours", "set a reminder for 3pm to call the bank", "can you remind me tomorrow…"
const REQUEST = /^(?:hey\s+vibe[,!]?\s*)?(?:(?:can|could|would|will)\s+you\s+|please\s+)?(?:remind\s+me\b|set\s+(?:me\s+)?(?:a\s+|an?\s+)?reminder\b)/i;
/** The person's words when they plainly ask for a reminder (Vibe then sets it even when the model only promised to). */
function fromRequest(message) {
    const flat = String(message || '').replace(/\s+/g, ' ').trim();
    if (!flat || flat.length > 400 || !REQUEST.test(flat)) return null;
    return flat.replace(/\?+$/, '').trim();
}

function _setTokens(t) { tokens = t; }

module.exports = { create, list, stop, fromRequest, _setTokens };
