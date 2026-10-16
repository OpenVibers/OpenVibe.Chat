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

module.exports = { structured, enabled, http, _setClient(c) { _ai = c; }, _setHttp(h) { _http = h; }, _reset() { _ai = null; _http = null; } };
