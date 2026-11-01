'use strict';
/**
 * The Dock's timer, set from a Vibe chat (plan L48 R2; the owner, 2026-11-01: "Vibe, start a 25-minute focus timer").
 * Vibe starts and stops the timer in the person's Dock (its start_timer and stop_timer tools,
 * server/rooms/ai-tools.js) with Chat's own service token (audience openvibe.network, scope
 * network.dock.timer.write, granted by Network), so the timer counts down in the Dock's pill on every OpenVibe site
 * and rings at its end. The person is named with X-OV-Subject, so the timer is theirs.
 *
 *   start(subject, { minutes, label?, kind?, rounds? }) → { timer, said } | { error }
 *   stop(subject)                                    → { stopped, said } | { error }
 *   fromRequest(message)                             → what they plainly asked for, or null
 */
const config = require('../config');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_MINUTES = 180;

let tokens = null;
function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    // Its own token, apart from Chat's other scopes: asking for a scope Network has not granted would refuse it whole.
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.dock.timer.write',
    });
    return tokens;
}

/** What Vibe is told about the timer: the object the Dock reads, and the words to say about it. */
const wire = (t) => ({
    kind: t.kind, started_at: t.started_at, ends_at: t.ends_at,
    ...(t.label ? { label: t.label } : {}), ...(t.round ? { round: t.round } : {}), ...(t.rounds ? { rounds: t.rounds } : {}),
    ...(t.focus_min ? { focus_min: t.focus_min } : {}), ...(t.break_min ? { break_min: t.break_min } : {}),
});

/** What Vibe says when the timer is set: how long it runs, and where it counts down. */
function sayOf(timer) {
    const minutes = Math.max(1, Math.round((Date.parse(timer.ends_at) - Date.parse(timer.started_at)) / 60000));
    const kind = timer.kind === 'focus' ? ', focus' : '';
    return `Timer set: ${minutes} min${kind}. It's in the Dock on every site.`;
}

async function call(subject, body, { fetchImpl = globalThis.fetch } = {}) {
    if (!config.oauth.clientSecret) return { error: 'the timer is not available on this server' };
    if (!SUBJECT.test(String(subject || ''))) return { error: 'they need to be signed in with an OpenVibe account' };
    let token;
    try { token = await tokenClient().getToken(); } catch { return { error: 'the timer is not available right now' }; }
    try {
        const res = await fetchImpl(`${config.networkInternalUrl}/api/v1/people/${encodeURIComponent(subject)}/dock/timer`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const detail = json && (json.detail || json.error || json.message);
            return { error: detail ? String(detail).slice(0, 200) : `OpenVibe.Network answered ${res.status}` };
        }
        return { json };
    } catch { return { error: 'OpenVibe.Network is unreachable' }; }
}

/**
 * Start the person's timer.
 *   minutes  how long it runs, 1 to 180
 *   kind     'timer' (a plain one) or 'focus' (a block that alternates a round and a break by itself)
 *   label    what it is for, in their words
 *   rounds   how many focus rounds in all (a focus timer only; the Dock's own default is 4)
 */
async function start(subject, { minutes, label = null, kind = null, rounds = null } = {}, deps = {}) {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) return { error: 'the timer runs from 1 to 180 minutes' };
    const body = { minutes: m };
    if (kind === 'focus') body.kind = 'focus';
    if (label) body.label = String(label).slice(0, 60);
    if (kind === 'focus') body.rounds = Math.min(12, Math.max(1, Math.round(Number(rounds) || 4)));
    const out = await call(subject, body, deps);
    if (out.error) return out;
    const timer = out.json && out.json.state && out.json.state.timer;
    if (!timer) return { error: 'the timer was not set' };
    return { timer: wire(timer), said: sayOf(timer) };
}

/** Stop the person's timer. */
async function stop(subject, deps = {}) {
    const out = await call(subject, { clear: true }, deps);
    if (out.error) return out;
    return { stopped: true, said: 'Timer stopped.' };
}

// "a 25 minute timer", "set a timer for 10 minutes", "focus timer", "pomodoro", "stop the timer".
const STOP = /\b(?:stop|cancel|end|clear|remove|delete)\b[^.?!]{0,24}\btimers?\b/i;
const ACTION = /\b(?:start|set|begin|put|give|launch|run)\b/i;
const MINUTES = /\b(\d{1,3})\s*(?:minutes?|mins?|m)\b/i;
const FOCUS = /\b(?:pomodoro|focus|deep\s+work)\b/i;

/**
 * The person's words when they plainly ask for a timer (Vibe then sets it even when the model only promised to).
 * → { minutes, kind } to start one, { stop: true } to stop it, or null when they did not ask.
 */
function fromRequest(message) {
    const flat = String(message || '').replace(/\s+/g, ' ').trim();
    if (!flat || flat.length > 400) return null;
    if (STOP.test(flat)) return { stop: true };
    const focus = FOCUS.test(flat);
    if (!/\btimers?\b/.test(flat) && !focus) return null;
    const action = ACTION.test(flat);
    const said = MINUTES.exec(flat);
    if (!action && !focus && !said) return null;   // a question about timers ("how does the timer work?") is not a request
    if (said) {
        const m = Number(said[1]);
        if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) return null;   // out of range: let Vibe ask
        // "how long is a 25 minute timer?" is a question, not a request for one.
        if (!action && /\?\s*$/.test(flat)) return null;
        return { minutes: m, kind: focus ? 'focus' : 'timer' };
    }
    // "a pomodoro" or "a focus timer" is 25 minutes of focus, the way the Dock's own focus block is.
    if (focus) return { minutes: 25, kind: 'focus' };
    // "start a timer" with no length: 25 minutes, the Dock's own focus length.
    return { minutes: 25, kind: 'timer' };
}

function _setTokens(t) { tokens = t; }

module.exports = { start, stop, fromRequest, sayOf, wire, _setTokens };
