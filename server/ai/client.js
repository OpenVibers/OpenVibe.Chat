/**
 * OpenVibe.Chat → OpenVibe.AI (run API v1, namespace `chat`).
 *
 * Chat's OWN service token (client `chat`; Network grants ai.run.create / ai.run.read on audience
 * openvibe.ai, namespace chat.*) through openvibe-sdk/ai's createAiClient. The chat-AI job calls
 * `structured(workflow, input)` and gets the run's `output`, or null when AI is off, refuses the
 * namespace, or the run did not succeed — the job then falls back to its extractive summary.
 */
'use strict';

const config = require('../config');

let _ai = null;
let _http = null;
let _tokens = null;
let _complete = null;
// Why the last run answered nothing, when the caller can show it: `ai.resting` today. Cleared by a run that
// succeeds. A product asks lastProblem() instead of turning "no answer" into an error.
let _lastProblem = null;
const problemOf = (run) => (run && run.error && run.error.code === 'ai.resting' ? 'ai.resting' : null);
function lastProblem() { return _lastProblem; }

/** The HTTP client behind ai() (Chat's token for openvibe.ai), for calls the SDK's AI client has no method for. */
function http() { ai(); return _http; }

function ai() {
    if (_ai) return _ai;
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const { createClient } = require('openvibe-sdk');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const { createAiClient } = require('openvibe-sdk/ai');
    const tokenClient = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai',
        scope: config.ai.scope,
    });
    _tokens = tokenClient;
    _http = createClient({ tokenProvider: tokenClient, timeoutMs: config.ai.waitMs + 10000 });
    _ai = createAiClient(_http, { baseUrl: config.ai.internalUrl });
    return _ai;
}

/** Is the job allowed to call AI at all (config gate; no key → no calls). */
function enabled() {
    return !!(config.ai.enabled && config.oauth.clientSecret);
}

/**
 * Chat's bearer token for AI (its own service token; no CHAT_AI_ENABLED gate — TTS has its own
 * setting). For calls the SDK's AI client has no method for (the Exchange speech route).
 */
async function bearer() {
    if (!_tokens) ai();
    return _tokens.getToken();
}

/**
 * Run a workflow and return its `output` object, or null: disabled, a refusal, a failed run, or a
 * transport error all answer null — exactly Live's ai-service.structured() contract. `force` runs it even with
 * the insight job switched off (CHAT_AI_ENABLED): a room's AI members have their own switch (CHAT_AI_MEMBERS).
 */
async function structured(workflow, input, opts = {}) {
    if (!(opts.force ? config.oauth.clientSecret : enabled())) return null;
    _lastProblem = null;
    try {
        const { runs } = ai();
        // A person's own provider key (ai.run-request `credential`): the SDK's runs.create does not carry it, so such a
        // run is posted through the same client (and token).
        const body = opts.credential
            ? await http().json({
                service: 'ai', baseUrl: config.ai.internalUrl, audience: 'openvibe.ai', method: 'POST', path: '/api/v1/runs',
                query: { wait: Math.max(0, Math.floor(config.ai.waitMs)) },
                json: { workflow, input, credential: opts.credential, ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}) },
                ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : { idempotencyKey: false }),
            })
            : await runs.create(workflow, input, {
                wait: config.ai.waitMs,
                ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
                ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}),
            });
        const run = body && (body.run || body);
        _lastProblem = problemOf(run);
        if (!run || run.status !== 'succeeded' || run.synthetic) return null;
        return run.output || null;
    } catch (err) {
        console.warn(`[AI] ${workflow}: ${err && err.message}`);
        return null;
    }
}

/**
 * structured(), with the answer's text as it is written: AI's POST /api/v1/runs?stream=1 sends `delta` events, and
 * onText(textSoFar) hears each one; the run's output comes back the same way (null on any failure). An AI without the
 * stream answers JSON, which is read as structured() reads it. A test's fake client (_setClient) has no stream: it goes
 * through structured().
 */
async function stream(workflow, input, opts = {}, onText = () => {}) {
    if (!(opts.force ? config.oauth.clientSecret : enabled())) return null;
    if (_ai && !_tokens) return structured(workflow, input, opts);
    _lastProblem = null;
    try {
        if (!_tokens) ai();
        const token = await _tokens.getToken();
        const timeout = AbortSignal.timeout(config.ai.waitMs + 10000);
        const res = await (opts.fetchImpl || globalThis.fetch)(`${config.ai.internalUrl}/api/v1/runs?stream=1&wait=${Math.max(0, Math.floor(config.ai.waitMs))}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) },
            body: JSON.stringify({ workflow, input, ...(opts.credential ? { credential: opts.credential } : {}), ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}) }),
            signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
        if (!res.ok) {
            if (res.status === 503) {
                const problem = await res.json().catch(() => null);
                _lastProblem = problem && problem.code === 'ai.resting' ? 'ai.resting' : null;
            }
            console.warn(`[AI] ${workflow}: AI answered ${res.status}`);
            return null;
        }
        // Stopped by the person (opts.signal): the run is cancelled at AI, so it spends nothing more.
        const runId = res.headers.get('x-openvibe-run-id');
        if (opts.signal && runId) opts.signal.addEventListener('abort', () => { try { const { runs } = ai(); if (runs && runs.cancel) runs.cancel(runId).catch(() => {}); } catch { /* AI away */ } }, { once: true });
        let run = null;
        if (!/event-stream/.test(String(res.headers.get('content-type') || ''))) {
            const body = await res.json();
            run = body && (body.run || body);
        } else {
            const decoder = new TextDecoder();
            let buffer = '';
            let text = '';
            for await (const chunk of res.body) {
                buffer += decoder.decode(chunk, { stream: true });
                let cut;
                while ((cut = buffer.indexOf('\n\n')) >= 0) {
                    const block = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 2);
                    const event = (/^event: (\w+)$/m.exec(block) || [])[1];
                    const line = (/^data: (.*)$/m.exec(block) || [])[1];
                    let data = null;
                    try { data = line ? JSON.parse(line) : null; } catch { data = null; }
                    if (event === 'delta' && data && typeof data.text === 'string') { text += data.text; try { onText(text); } catch { /* a listener never breaks the answer */ } }
                    else if (event === 'run' && data) run = data.run || null;
                    else if (event === 'error') console.warn(`[AI] ${workflow}: ${(data && data.message) || 'the stream broke'}`);
                }
            }
        }
        _lastProblem = problemOf(run);
        if (!run || run.status !== 'succeeded' || run.synthetic) return null;
        return run.output || null;
    } catch (err) {
        if (!(opts.signal && opts.signal.aborted)) console.warn(`[AI] ${workflow}: ${err && err.message}`);
        return null;
    }
}

/** An explicit catalogue model, billed by AI to the person named in on_behalf_of. */
async function complete({ model, messages, subject, temperature = null }) {
    if (_complete) return _complete({ model, messages, subject, temperature });
    if (!subject || !model) throw new Error('A person and model are required');
    if (!_tokens) ai();
    const token = await _tokens.getToken();
    const res = await fetch(`${config.ai.internalUrl}/api/v1/runs?wait=${Math.max(0, Math.floor(config.ai.waitMs))}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ workflow: 'ai.complete', input: { model, messages, max_tokens: 2048,
            ...(temperature == null ? {} : { temperature }) }, on_behalf_of: { type: 'user', id: subject }, options: { cache: 'none' } }),
        signal: AbortSignal.timeout(config.ai.waitMs + 10000),
    });
    const body = await res.json();
    const run = body && (body.run || body);
    if (!res.ok || !run || !['succeeded', 'cached'].includes(run.status)) throw new Error((run && run.error && run.error.code) || `AI answered ${res.status}`);
    const choice = run.output && run.output.choices && run.output.choices[0];
    return { text: String((choice && choice.message && choice.message.content) || ''),
        model: (run.output && run.output.model) || (run.provenance && run.provenance.model) || model,
        provider: run.provenance && run.provenance.provider || null,
        cost_usd: run.usage && run.usage.cost_usd != null ? Number(run.usage.cost_usd) : null,
        ms: run.started_at && run.finished_at ? Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at)) : null,
        run_id: run.id || null };
}

async function catalog() {
    const res = await fetch(`${config.ai.internalUrl}/api/v1/exchange/catalog`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`AI catalogue answered ${res.status}`);
    return res.json();
}

module.exports = { structured, stream, complete, catalog, enabled, bearer, http, lastProblem, _setClient(c) { _ai = c; }, _setComplete(c) { _complete = c; }, _setHttp(h) { _http = h; }, _setTokens(t) { _tokens = t; },
    _setProblem(p) { _lastProblem = p; }, _reset() { _ai = null; _http = null; _tokens = null; _complete = null; _lastProblem = null; } };
