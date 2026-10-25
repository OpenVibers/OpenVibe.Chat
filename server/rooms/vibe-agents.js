'use strict';
/**
 * Recurring work from a Vibe chat (consumer plan §4: "Tasks: recurring work in plain words"). Vibe sets up one of the
 * person's OpenVibe Agents (OpenVibe.Actor, /api/v1/me/agents) once they agreed to it, and lists the ones they have
 * (its set_up_agent and my_agents tools, server/rooms/ai-tools.js). Chat's own service token (audience openvibe.actor,
 * scope actor.agent.manage, granted by Network) names the person in X-OV-Subject, so the agent is theirs: it runs on
 * their allowance, and they pause, change or delete it on openvibe.actor/me/agents like one they made there.
 *
 *   create(subject, { name, instructions, schedule, time_utc, weekday }) → { agent } | { error }
 *   list(subject)                                                        → { agents } | { error }
 *
 * Vibe offers daily and weekly runs only (an hourly agent would use up a free day's tasks); the agent's page offers more.
 */
const config = require('../config');

const ACTOR_SITE = 'https://openvibe.actor';
const SCHEDULES = ['daily', 'weekly'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

let tokens = null;
function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    // Its own token, apart from the task scopes (workspace.js, web-search.js): asking for a scope Network has not granted
    // would refuse the whole token.
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.actor', scope: 'actor.agent.manage',
    });
    return tokens;
}

/** What Vibe is told about an agent: no instructions back (it wrote them), and the page where the person manages it. */
const wire = (a) => ({
    id: a.id, name: a.name, status: a.status,
    when: a.schedule === 'daily' ? `every day at ${a.schedule_at} UTC` : a.schedule === 'weekly' ? `every ${DAYS[a.schedule_dow]} at ${a.schedule_at} UTC`
        : a.schedule === 'hourly' ? 'every hour' : 'only when they press Run now',
    next_run_at: a.next_run_at || null,
    page: `${ACTOR_SITE}/me/agents/${encodeURIComponent(a.id)}`,
});

async function call(method, path, subject, body, { fetchImpl = globalThis.fetch } = {}) {
    if (!config.oauth.clientSecret) return { error: 'OpenVibe Agents are not available on this server' };
    if (!SUBJECT.test(String(subject || ''))) return { error: 'they need to be signed in with an OpenVibe account' };
    let token;
    try { token = await tokenClient().getToken(); } catch { return { error: 'OpenVibe Agents are not available right now' }; }
    try {
        const res = await fetchImpl(`${config.actor.internalUrl}${path}`, {
            method, headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) return { error: (json && (json.detail || json.title)) ? String(json.detail || json.title).slice(0, 200) : `OpenVibe Agents answered ${res.status}` };
        return { json };
    } catch { return { error: 'OpenVibe Agents are unreachable' }; }
}

async function create(subject, args = {}, deps = {}) {
    const name = String(args.name || '').replace(/\s+/g, ' ').trim();
    const instructions = String(args.instructions || '').replace(/\r\n?/g, '\n').trim();
    const schedule = String(args.schedule || '');
    const at = String(args.time_utc || '').trim();
    if (!name || name.length > 60) return { error: 'name must be 1 to 60 characters' };
    if (!instructions || instructions.length > 4000) return { error: 'instructions must be 1 to 4000 characters' };
    if (!SCHEDULES.includes(schedule)) return { error: 'schedule must be daily or weekly' };
    if (!HHMM.test(at)) return { error: 'time_utc must be HH:MM, in UTC' };
    const body = { name, instructions, schedule, schedule_at: at };
    if (schedule === 'weekly') {
        if (!Number.isInteger(args.weekday) || args.weekday < 0 || args.weekday > 6) return { error: 'weekday must be 0 (Sunday) to 6 (Saturday) for a weekly agent' };
        body.schedule_dow = args.weekday;
    }
    const out = await call('POST', '/api/v1/me/agents', subject, body, deps);
    return out.error ? out : { agent: wire(out.json) };
}

async function list(subject, deps = {}) {
    const out = await call('GET', '/api/v1/me/agents', subject, null, deps);
    if (out.error) return out;
    const agents = Array.isArray(out.json && out.json.agents) ? out.json.agents : [];
    return { agents: agents.slice(0, 30).map(wire), manage: `${ACTOR_SITE}/me/agents` };
}

function _setTokens(t) { tokens = t; }

module.exports = { create, list, SCHEDULES, _setTokens };
