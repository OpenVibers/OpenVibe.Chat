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
 * Run a workflow and return its `output` object, or null: disabled, a refusal, a failed run, or a
 * transport error all answer null — exactly Live's ai-service.structured() contract. `force` runs it even with
 * the insight job switched off (CHAT_AI_ENABLED): a room's AI members have their own switch (CHAT_AI_MEMBERS).
 */
async function structured(workflow, input, opts = {}) {
    if (!(opts.force ? config.oauth.clientSecret : enabled())) return null;
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
        if (!res.ok) { console.warn(`[AI] ${workflow}: AI answered ${res.status}`); return null; }
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
        if (!run || run.status !== 'succeeded' || run.synthetic) return null;
        return run.output || null;
    } catch (err) {
        if (!(opts.signal && opts.signal.aborted)) console.warn(`[AI] ${workflow}: ${err && err.message}`);
        return null;
    }
}

module.exports = { structured, stream, enabled, http, _setClient(c) { _ai = c; }, _setHttp(h) { _http = h; }, _setTokens(t) { _tokens = t; }, _reset() { _ai = null; _http = null; _tokens = null; } };
