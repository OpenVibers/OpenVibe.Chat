'use strict';
/**
 * A person's own AI provider key, for the AI members they set up in rooms (server/rooms/ai-members.js). The key lives in
 * OpenVibe.AI (PUT/GET/DELETE /api/v1/credentials/:subject, ai.credential-put@1 / ai.credential@1), encrypted there with
 * Chat as its owner; Chat never stores or shows it again (only AI's four-character hint). A run that names the
 * credential calls that provider with that key only, never a shared one, inside the person's own daily budget.
 *
 *   get(subject)                     → { provider, base_url, key_hint, model, budget_usd_per_day, spent_usd_today } | null
 *   put(subject, { provider, base_url?, api_key?, model, budget_usd_per_day? })
 *   remove(subject)
 *   label(cred)                      → "openai · gpt-4o-mini" (what a room shows next to the member)
 *
 * Needs Network's grant [chat, ai.credential.manage, openvibe.ai]. Refusals come back as CredentialError (status, code).
 *
 * Provider node (contracts 0.220.0) is a model on the person's own computer instead: `machine` names it (a dev_ id on
 * openvibe.bot/machines), there is no key and nothing is spent; OpenVibe.AI reaches it through OpenVibe.Bot, and only
 * while the person lets their AI use that computer's models there.
 */
const config = require('../config');
const aiClient = require('./client');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROVIDERS = { openai: 'OpenAI (or any OpenAI-compatible endpoint)', anthropic: 'Anthropic', node: 'A model on your own computer' };
const MACHINE_RE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;

class CredentialError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new CredentialError(status, code, message); };

function call(method, subject, json) {
    if (!config.oauth.clientSecret) fail(503, 'credentials.off', 'Your own AI key cannot be stored here right now.');
    if (!SUBJECT_RE.test(String(subject || ''))) fail(400, 'credentials.subject', 'An OpenVibe account is needed for your own AI key.');
    return aiClient.http().json({
        service: 'ai', baseUrl: config.ai.internalUrl, audience: 'openvibe.ai', method, path: `/api/v1/credentials/${encodeURIComponent(subject)}`,
        ...(json ? { json } : {}), idempotencyKey: false,
    });
}

const view = (c) => (c ? {
    provider: c.provider, base_url: c.base_url || null, machine: c.machine || null, key_hint: c.key_hint || null, model: (c.models && c.models.chat) || null,
    budget_usd_per_day: c.budget_usd_per_day == null ? null : Number(c.budget_usd_per_day),
    spent_usd_today: Number(c.spent_usd_today) || 0, last_used_at: c.last_used_at || null,
} : null);

async function get(subject) {
    try { return view(await call('GET', subject)); } catch (err) {
        if (err instanceof CredentialError) throw err;
        if (err && err.status === 404) return null;
        throw new CredentialError(502, 'credentials.unreachable', 'OpenVibe.AI did not answer. Try again in a minute.');
    }
}

async function put(subject, { provider, base_url, api_key, model, budget_usd_per_day, machine } = {}) {
    if (!PROVIDERS[provider]) fail(422, 'credentials.provider', 'Choose OpenAI (or an OpenAI-compatible endpoint), Anthropic, or a model on your own computer.');
    const m = String(model || '').trim();
    if (!m || m.length > 120 || /\s/.test(m)) fail(422, 'credentials.model', 'Name the model, for example gpt-4o-mini or claude-haiku-4-5.');
    if (provider === 'node') {
        // A model on the person's own computer: the machine, no key, no budget (nothing is spent).
        const id = String(machine || '').trim();
        if (!MACHINE_RE.test(id)) fail(422, 'credentials.machine', 'Name your computer: its id (dev_…) from openvibe.bot/machines.');
        try {
            return view(await call('PUT', subject, { provider: 'node', machine: id, models: { chat: m } }));
        } catch (err) {
            if (err instanceof CredentialError) throw err;
            if (err && err.status >= 400 && err.status < 500) throw new CredentialError(err.status, 'credentials.refused', (err.detail || err.message || 'OpenVibe.AI refused it.').slice(0, 200));
            throw new CredentialError(502, 'credentials.unreachable', 'OpenVibe.AI did not answer. Try again in a minute.');
        }
    }
    const url = base_url ? String(base_url).trim().replace(/\/+$/, '') : '';
    if (url && (provider !== 'openai' || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(url) || url.length > 300)) fail(422, 'credentials.base_url', 'An endpoint is an https:// address, for an OpenAI-compatible provider.');
    const key = api_key == null ? '' : String(api_key).trim();
    if (key && (key.length < 8 || key.length > 400)) fail(422, 'credentials.key', 'That does not look like an API key.');
    // Left out, the budget stays what it is ($1 a day the first time).
    const budget = budget_usd_per_day == null || budget_usd_per_day === ''
        ? (await get(subject).then((c) => (c && c.budget_usd_per_day != null ? c.budget_usd_per_day : 1), () => 1))
        : Number(budget_usd_per_day);
    if (!Number.isFinite(budget) || budget < 0 || budget > 1000) fail(422, 'credentials.budget', 'A daily budget is 0 to 1000 US dollars (0 means no cap).');
    try {
        return view(await call('PUT', subject, { provider, ...(url ? { base_url: url } : {}), ...(key ? { api_key: key } : {}), models: { chat: m }, budget_usd_per_day: budget }));
    } catch (err) {
        if (err instanceof CredentialError) throw err;
        if (err && err.code === 'credential.key_required') throw new CredentialError(400, 'credentials.key', 'Enter the key: it is needed the first time, and again for a new provider or endpoint.');
        if (err && err.status >= 400 && err.status < 500) throw new CredentialError(err.status, 'credentials.refused', (err.detail || err.message || 'OpenVibe.AI refused the key.').slice(0, 200));
        throw new CredentialError(502, 'credentials.unreachable', 'OpenVibe.AI did not answer. Try again in a minute.');
    }
}

async function remove(subject) {
    try { await call('DELETE', subject); } catch (err) {
        if (err instanceof CredentialError) throw err;
        if (err && err.status === 404) return;
        throw new CredentialError(502, 'credentials.unreachable', 'OpenVibe.AI did not answer. Try again in a minute.');
    }
}

const label = (c) => (c && c.provider === 'node' ? `your own computer · ${c.model || 'its model'}` : c ? `${c.provider}${c.base_url ? ` (${(() => { try { return new URL(c.base_url).hostname; } catch { return 'custom'; } })()})` : ''} · ${c.model || 'default model'}` : null);

module.exports = { get, put, remove, label, CredentialError, PROVIDERS };
