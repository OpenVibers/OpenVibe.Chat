/**
 * Chat's OpenVibe.Events subscriptions: one per topic of ./consumer.js TOPICS (live.release.deployed,
 * network.module.updated), all delivering to POST /internal/events, signed with the first
 * CHAT_EVENTS_SECRET. Events names the consumer after the calling service (`chat`) and refuses a
 * second subscription with the same topic and endpoint (409 with its id), so creating is idempotent.
 *
 *   ensure({ action: 'create' })   what boot runs (startAtBoot): lists Chat's subscriptions and creates
 *                                  the missing ones. An existing one is left as it is, even disabled,
 *                                  so an operator's --disable (the rollback) survives restarts.
 *   ensure({ action: 'list' })     report only (scripts/subscribe-events.js --dry-run)
 *   ensure({ action: 'disable' | 'enable' })   the rollback switch and its undo
 *
 * Needs EVENTS_URL, OV_OAUTH_CLIENT_SECRET and the Network grant chat events.subscription.manage on
 * openvibe.events. Nothing secret is logged. A new subscription gets no history (Events replays with
 * POST /api/v1/deliveries/replay, events.delivery.admin; the inbox makes a replayed event a no-op).
 */
'use strict';

const { serviceAuth } = require('openvibe-contracts');
const { TOPICS } = require('./consumer');

const AUDIENCE = 'openvibe.events';
const SCOPE = 'events.subscription.manage';
const BOOT_RETRY_MS = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];

const normalize = (u) => { try { return new URL(String(u)).toString(); } catch { return String(u || ''); } };

/** The endpoint Events delivers to: CHAT_EVENTS_ENDPOINT, else loopback on the port Chat listens on. */
function endpointFor(config, port = config.port) {
    return config.events.endpoint || `http://127.0.0.1:${port}/internal/events`;
}

async function readJson(res) {
    const text = await res.text().catch(() => '');
    try { return text ? JSON.parse(text) : {}; } catch { return { detail: text.slice(0, 200) }; }
}

/**
 * @returns {Promise<Array<{ topic, id, result: 'exists'|'created'|'missing'|'disabled'|'enabled', enabled }>>}
 */
async function ensure({ config, endpoint, action = 'create', topics = TOPICS, fetchImpl = globalThis.fetch, tokenClient = null }) {
    const base = config.events.url;
    const secret = config.events.secrets[0];
    if (!base) throw new Error('EVENTS_URL is not set');
    if (action === 'create' && !secret) throw new Error('CHAT_EVENTS_SECRET must be set (32+ characters) before subscribing');
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const tokens = tokenClient || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: AUDIENCE,
        scope: SCOPE,
        fetchImpl,
    });
    const target = normalize(endpoint);
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401) tokens.invalidate();
        return { status: res.status, ok: res.ok, body: await readJson(res) };
    };

    const listed = await call('GET', '/api/v1/subscriptions');
    if (!listed.ok) throw new Error(`Events answered ${listed.status} listing subscriptions: ${listed.body.code || ''} ${listed.body.detail || ''}`.trim());
    const mine = (listed.body.subscriptions || []).filter((s) => normalize(s.endpoint) === target);

    const out = [];
    for (const topic of topics) {
        const existing = mine.find((s) => s.topic_pattern === topic) || null;
        if (action === 'list') {
            out.push({ topic, id: existing ? existing.id : null, result: existing ? 'exists' : 'missing', enabled: existing ? existing.enabled !== false : null });
            continue;
        }
        if (action === 'disable' || action === 'enable') {
            if (!existing) { out.push({ topic, id: null, result: 'missing', enabled: null }); continue; }
            const r = await call('POST', `/api/v1/subscriptions/${encodeURIComponent(existing.id)}/${action}`);
            if (!r.ok) throw new Error(`Events answered ${r.status} to ${action} ${existing.id}: ${r.body.code || ''} ${r.body.detail || ''}`.trim());
            out.push({ topic, id: existing.id, result: `${action}d`, enabled: action === 'enable' });
            continue;
        }
        if (existing) { out.push({ topic, id: existing.id, result: 'exists', enabled: existing.enabled !== false }); continue; }
        const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint: target, secret });
        if (r.status === 409 && r.body.subscription_id) { out.push({ topic, id: r.body.subscription_id, result: 'exists', enabled: null }); continue; }
        if (!r.ok) throw new Error(`Events answered ${r.status} for ${topic}: ${r.body.code || ''} ${r.body.detail || ''}`.trim());
        out.push({ topic, id: r.body.id, result: 'created', enabled: r.body.enabled !== false });
    }
    return out;
}

/**
 * At boot, in the background: make sure the subscriptions exist, retrying while Network or Events
 * cannot answer (a restart of either, the grant not seeded yet). Returns { done: Promise, stop() }.
 * Does nothing (done resolves null) unless EVENTS_URL, CHAT_EVENTS_SECRET and the client secret are
 * set and CHAT_EVENTS_SUBSCRIBE is on.
 */
function startAtBoot({ config, port, fetchImpl, log = console, retryMs = BOOT_RETRY_MS }) {
    let stopped = false;
    let timer = null;
    const why = !config.events.url ? 'EVENTS_URL unset' : !config.events.secrets.length ? 'CHAT_EVENTS_SECRET unset'
        : !config.oauth.clientSecret ? 'OV_OAUTH_CLIENT_SECRET unset' : !config.events.subscribe ? 'CHAT_EVENTS_SUBSCRIBE=0' : null;
    if (why) {
        log.log(`[Events] subscriptions not checked (${why})`);
        return { done: Promise.resolve(null), stop() {} };
    }
    const endpoint = endpointFor(config, port);
    let finish = () => {};
    const done = new Promise((resolve) => {
        finish = resolve;
        const attempt = async (i) => {
            if (stopped) return resolve(null);
            try {
                const results = await ensure({ config, endpoint, action: 'create', fetchImpl });
                for (const r of results) log.log(`[Events] subscription ${r.result}: ${r.id} (${r.topic} → ${endpoint}${r.enabled === false ? ', DISABLED' : ''})`);
                return resolve(results);
            } catch (err) {
                const next = retryMs[i + 1];
                log.warn(`[Events] subscriptions not ensured: ${err.message}${next != null ? `; retrying in ${Math.round(next / 1000)} s` : '; giving up until the next restart (or run scripts/subscribe-events.js)'}`);
                if (next == null || stopped) return resolve(null);
                timer = setTimeout(() => attempt(i + 1), next);
                if (timer.unref) timer.unref();
            }
        };
        timer = setTimeout(() => attempt(0), retryMs[0] || 0);
        if (timer.unref) timer.unref();
    });
    return { done, stop() { stopped = true; if (timer) clearTimeout(timer); finish(null); } };
}

module.exports = { ensure, startAtBoot, endpointFor, TOPICS, AUDIENCE, SCOPE };
