'use strict';
/**
 * The open web for Vibe (server/rooms/vibe.js, and Vibe added to a room): a question goes to OpenVibe.Actor as a task
 * for the person who asked, and Actor's web agent answers it with its sources. Chat's own service token (audience
 * openvibe.actor; Network grants Chat actor.task.create and actor.task.read) names the person in X-OV-Subject, so the
 * task is theirs (their free allowance and task list) and Actor records Chat as `via`; Chat reads only that task back.
 *
 *   search({ subject, query, idempotencyKey }) → { answer, sources } | { error }
 *
 * Polls the task for at most WAIT_MS. Without Chat's OAuth secret or the asker's subject it answers an error the model
 * can say plainly.
 */
const config = require('../config');

const WAIT_MS = 50_000;
const POLL_MS = 1500;
const DONE = new Set(['succeeded', 'failed', 'cancelled']);
let tokens = null;

function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.actor',
        scope: 'actor.task.create actor.task.read',
    });
    return tokens;
}

async function search({ subject, query, idempotencyKey }, { fetchImpl = globalThis.fetch, waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!q) return { error: 'query is required' };
    if (!config.oauth.clientSecret) return { error: 'web search is not available on this server' };
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) return { error: 'web search needs the person to be signed in' };
    let token;
    try { token = await tokenClient().getToken(); } catch { return { error: 'web search is not available right now' }; }
    const headers = { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json' };
    const base = config.actor.internalUrl;
    let task;
    try {
        const res = await fetchImpl(`${base}/api/v1/tasks`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: `Search the web and answer briefly, with the links of your sources: ${q}`, ...(idempotencyKey ? { idempotency_key: String(idempotencyKey).slice(0, 120) } : {}) }),
            signal: AbortSignal.timeout(10_000),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) return { error: (body && (body.detail || body.title)) ? String(body.detail || body.title).slice(0, 200) : `OpenVibe.Actor answered ${res.status}` };
        task = body;
    } catch { return { error: 'OpenVibe.Actor is unreachable' }; }
    const started = Date.now();
    while (task && !DONE.has(task.state) && Date.now() - started < waitMs) {
        await new Promise((r) => setTimeout(r, pollMs));
        try {
            const res = await fetchImpl(`${base}/api/v1/tasks/${encodeURIComponent(task.id)}`, { headers, signal: AbortSignal.timeout(10_000) });
            if (res.ok) task = await res.json();
        } catch { /* try again until the wait is over */ }
    }
    if (!task || task.state !== 'succeeded') {
        const why = task && task.error ? (task.error.detail || task.error.code) : task && !DONE.has(task.state) ? 'it took too long' : 'no answer';
        return { error: `the web search did not finish: ${String(why).slice(0, 200)}` };
    }
    const r = task.result || {};
    return { answer: String(r.answer || '').slice(0, 3000), sources: (Array.isArray(r.sources) ? r.sources : []).slice(0, 8).map((s) => (typeof s === 'string' ? s : s && s.url)).filter(Boolean) };
}

function _setTokens(t) { tokens = t; }

module.exports = { search, WAIT_MS, _setTokens };
