'use strict';
/**
 * The open web for Vibe (server/rooms/vibe.js, and Vibe added to a room), through the Search Fabric first:
 * the web scope asks Search's open index, then its paid/free providers (DeepSeek, Wikipedia) and returns every
 * result with its URL, provider and dates. Chat's own service token (audience openvibe.search) holds
 * `search.query.delegate` and names the person in X-OV-Subject, so the paid steps are theirs.
 *
 *   search({ subject, query, freshness, idempotencyKey }) → { answer, results, citations, sources, … } | { error }
 *
 * `freshness` (day|week|month|year) is the Search Fabric's window: news today, postings this week, prices this month.
 * It reaches the open index and the web providers, and is named in the Actor fallback's task.
 *
 * The old path — an OpenVibe.Actor task for the person who asked (Chat's token, audience openvibe.actor;
 * Network grants actor.task.create and actor.task.read) — answers only when the fabric is down (unreachable,
 * 404 on a Search without it, or a 5xx). Actor's web agent still gives a short answer with its sources.
 */
const config = require('../config');
const fabricSearch = require('./search-fabric');

const WAIT_MS = 50_000;
const POLL_MS = 1500;
const DONE = new Set(['succeeded', 'failed', 'cancelled']);
const WEB_LIMIT = 6;
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const FRESHNESS = ['day', 'week', 'month', 'year'];
const freshnessOf = (v) => { const f = String(v == null ? '' : v).trim().toLowerCase(); return FRESHNESS.includes(f) ? f : null; };
const EMPTY_HINT = 'Retry once with only the 2–3 key nouns and no filler words ("jobs", "deals", "best", "find me"); if that also finds nothing, say so plainly.';
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

/** A fabric web answer, cited: each result keeps its provider, publication date and retrieval time. */
function fromFabric(body, query, freshness = null) {
    const results = (Array.isArray(body && body.results) ? body.results : [])
        .filter((r) => r && /^https?:\/\//i.test(String(r.url || r.canonical_url || '')))
        .slice(0, WEB_LIMIT)
        .map((r) => fabricSearch.resultOf(r));
    const citations = fabricSearch.citationsOf(results);
    const answer = body && body.answer ? (typeof body.answer === 'string' ? body.answer : body.answer.text || null) : null;
    const foundBy = ((body && body.route && body.route.explain) || [])
        .filter((e) => e && e.scope === 'web' && e.ok && Number(e.count) > 0).map((e) => e.step);
    return {
        query,
        answer,
        citations,
        sources: results.map((r) => r.url),
        results,
        ...(freshness ? { freshness } : {}),
        ...(foundBy.length ? { found_by: foundBy.join(', ') } : {}),
        ...(body && body.route && Number.isFinite(Number(body.route.cost_usd)) ? { cost_usd: Number(body.route.cost_usd) } : {}),
        note: results.length ? 'Cite each result with its url, provider and date.' : `Nothing found on the web for "${query}". ${EMPTY_HINT}`,
    };
}

/** The actor fallback: one task for the person, polled until it answers or the wait is over. */
async function actorSearch({ subject, q, freshness = null, idempotencyKey }, { fetchImpl = globalThis.fetch, waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
    let token;
    try { token = await tokenClient().getToken(); } catch { return { error: 'web search is not available right now' }; }
    const headers = { Authorization: `Bearer ${token}`, 'X-OV-Subject': subject, Accept: 'application/json' };
    const base = config.actor.internalUrl;
    const window = freshness ? ` Prefer results published in the last ${freshness}.` : '';
    let task;
    try {
        const res = await fetchImpl(`${base}/api/v1/tasks`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: `Search the web and answer briefly, with the links of your sources: ${q}.${window}`, ...(idempotencyKey ? { idempotency_key: String(idempotencyKey).slice(0, 120) } : {}) }),
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

async function search({ subject, query, freshness, idempotencyKey }, opts = {}) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!q) return { error: 'query is required' };
    const fresh = freshnessOf(freshness);
    if (!config.oauth.clientSecret) return { error: 'web search is not available on this server' };
    if (!SUBJECT.test(String(subject || ''))) return { error: 'web search needs the person to be signed in' };
    const { fetchImpl = null, waitMs = WAIT_MS, pollMs = POLL_MS, fabricClient = null, searchClient = null, fabricFetch = null } = opts;
    const actorFetch = fetchImpl || globalThis.fetch;
    // A test (or a caller with its own transport) may pass fetchImpl alone: use it for the fabric too, anonymously.
    const injectedFetch = fabricClient || searchClient ? null : (fabricFetch || fetchImpl);
    try {
        const body = await fabricSearch.query({ q, scopes: ['web'], subject, limit: WEB_LIMIT, ...(fresh ? { freshness: fresh } : {}) }, { client: fabricClient || searchClient, fetchImpl: injectedFetch });
        return fromFabric(body, q, fresh);
    } catch (err) {
        if (!fabricSearch.isDown(err)) {
            const status = err && err.status;
            return { error: status ? `OpenVibe.Search answered ${status}` : 'OpenVibe.Search did not answer' };
        }
        // The fabric is down: the old Actor task still answers, as it did before the fabric.
        return await actorSearch({ subject, q, freshness: fresh, idempotencyKey }, { fetchImpl: actorFetch, waitMs, pollMs });
    }
}

function _setTokens(t) { tokens = t; }

module.exports = { search, actorSearch, fromFabric, WAIT_MS, WEB_LIMIT, _setTokens };
