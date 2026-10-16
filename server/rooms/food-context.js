'use strict';
/**
 * Shared context for an AI member linked to an OpenVibe.Food household (room_ai_members.link_service = 'food',
 * link_resource = the household's plan id): what the household has in its cupboards and what it planned, as text for
 * the prompt. Read from Food's internal API with Chat's own service token (audience openvibe.food, capability
 * food.household.read, which Network grants Chat), at most once a minute per household.
 *
 *   GET {CHAT_FOOD_INTERNAL_URL}/internal/households/:plan/chat-context → { text, source }
 *
 * Nothing is cached past a minute: a pantry changes as people cook. Without the client secret it answers null.
 */
const config = require('../config');

const TTL_MS = 60_000;
const cache = new Map();   // plan id → { at, value }
let tokens = null;

function tokenClient() {
    if (tokens) return tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.food',
        scope: 'food.household.read',
    });
    return tokens;
}

async function contextOf(planId, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    if (!config.oauth.clientSecret || !/^pln_[0-9A-Z]{26}$/.test(String(planId))) return null;
    const hit = cache.get(planId);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    const token = await tokenClient().getToken();
    const res = await fetchImpl(`${config.food.internalUrl}/internal/households/${encodeURIComponent(planId)}/chat-context`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    const value = body && typeof body.text === 'string' && body.text.trim() ? { text: body.text.slice(0, 4000), source: String(body.source || 'OpenVibe.Food household').slice(0, 80) } : null;
    cache.set(planId, { at: now, value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
}

function _reset() { cache.clear(); tokens = null; }

module.exports = { contextOf, _reset, _setTokens(t) { tokens = t; } };
