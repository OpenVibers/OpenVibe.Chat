'use strict';
/**
 * "Plan my day" (plan L48 V3; the owner, 2026-11-01: "Vibe reads your day and suggests blocks and reminders. You
 * confirm; it never fills your calendar alone"). Vibe's my_day tool reads the person's day from OpenVibe.Today:
 *
 *   - the agenda (GET /api/v1/me/agenda?days=1): their own events, the events they set a reminder on, and the streams
 *     of people they follow, read with Chat's own service token (audience openvibe.today, scope today.agenda.read,
 *     contracts 0.280.0) naming the person with X-OV-Subject;
 *   - their reminders that fire in the next 24 hours (the reminders module, today.reminder.write).
 *
 * Read-only. A turn that read the day may not set a reminder or start a timer (ai-tools.js refuses it): Vibe suggests,
 * and sets what the person agrees to in their next message.
 *
 *   day(subject, { timezone }) → { now, timezone, events, reminders, follows_unavailable, plan_rule } | { error }
 */
const config = require('../config');
const reminders = require('./vibe-reminders');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_MS = 24 * 60 * 60_000;

let tokens = null;
function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    // Its own token: asking for a scope Network has not granted would refuse a combined one whole.
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.today', scope: 'today.agenda.read',
    });
    return tokens;
}

/** A time in the person's zone, the way Vibe should say it ("Mon 14:30"). */
function local(iso, timezone) {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    } catch { return String(iso || '').slice(0, 16).replace('T', ' '); }
}

async function agenda(subject, { fetchImpl = globalThis.fetch } = {}) {
    if (!config.oauth.clientSecret) return { error: 'your day is not available on this server' };
    let token;
    try { token = await tokenClient().getToken(); } catch { return { error: 'your day is not available right now' }; }
    try {
        const res = await fetchImpl(`${config.today.internalUrl}/api/v1/me/agenda?days=1`, {
            headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json) return { error: `OpenVibe.Today answered ${res.status}` };
        return { json };
    } catch { return { error: 'OpenVibe.Today is unreachable' }; }
}

async function day(subject, { timezone = 'UTC', now = Date.now(), fetchImpl } = {}) {
    if (!SUBJECT.test(String(subject || ''))) return { error: 'they need to be signed in with an OpenVibe account' };
    const tz = String(timezone || 'UTC').slice(0, 64);
    const [a, r] = await Promise.all([agenda(subject, { fetchImpl }), reminders.list(subject, { fetchImpl })]);
    if (a.error && r.error) return { error: a.error };
    const until = now + DAY_MS;
    const events = a.error ? [] : (a.json.events || [])
        .filter((e) => { const t = Date.parse(e.starts_at); return t >= now - 2 * 60 * 60_000 && t <= until; })
        .slice(0, 25)
        .map((e) => ({
            title: String(e.title || '').slice(0, 120), at: local(e.starts_at, tz), starts_at: e.starts_at,
            ends_at: e.ends_at || null, kind: e.kind || null, channel: e.channel || null, url: e.url || null,
            yours: !!e.own, reminded: !!e.reminded,
        }));
    const due = r.error ? [] : (r.reminders || [])
        .filter((x) => x.next_at && Date.parse(x.next_at) <= until)
        .map((x) => ({ id: x.id, title: x.title, when: x.when, next: local(x.next_at, tz), repeats: x.repeats }));
    return {
        now: local(new Date(now).toISOString(), tz),
        timezone: tz,
        events,
        reminders: due,
        follows_unavailable: a.error ? true : !!a.json.follows_unavailable,
        ...(a.error ? { agenda_error: a.error } : {}),
        ...(r.error ? { reminders_error: r.error } : {}),
        plan_rule: 'Suggest a plan in their time zone around what is already there: what to do when, and which reminders or a focus timer would help. Set nothing in this answer; ask whether to add them, and set what they agree to when they say yes.',
        manage: 'https://openvibe.today/me/week',
    };
}

function _setTokens(t) { tokens = t; }

module.exports = { day, local, _setTokens };
