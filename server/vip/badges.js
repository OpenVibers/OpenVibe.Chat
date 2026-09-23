/**
 * The VIP member badge on chat messages.
 *
 * A member's messages in a creator's room carry that creator's VIP badge: a perk of the member's plan
 * version with a `chat badge` product binding (the network perk `subscriber-badge` has one), unless
 * the member turned the badge off in VIP (show_badge). Resolved through VIP's entitlement check
 * (vip.entitlement.check, product 'chat') behind the shared product cache (openvibe-vip/client
 * createVipCache):
 *
 *   - sending NEVER waits on VIP: forMessage() reads the cache synchronously. A miss sends the
 *     message without a badge and starts the lookup; when it finds a badge, chat-server pushes a
 *     `chat_vip_badge` frame for that message id (and stores it in the row's metadata);
 *   - it fails closed: VIP down, no token, a refused grant, a malformed answer → no badge;
 *   - convergence: Chat has no Events inbox, so a badge outlives the membership by at most
 *     config.vip.ttlMs (60 s) after VIP stopped granting (VIP README: "The product cache and the
 *     convergence bound"). handleEvent() drops a pair at once if events are ever routed here.
 *
 * The badge is plain data for Live's chat UI to render as text: { creator, perk, name, badge, label }.
 * Binding config comes from creators, so only a short id (`badge`) and a short text label pass.
 */
'use strict';

const config = require('../config');
const serviceAuth = require('../net/service-auth');
const { createVipClient, createVipCache } = require('./vip-client');

const AUDIENCE = 'openvibe.vip';
const SCOPE = 'vip.entitlement.check';
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

let cache = null;
let clock = () => Date.now();
let fetchImpl = null;

function enabled() {
    return !!(config.vip.enabled && config.vip.internalUrl && config.oauth.clientSecret);
}

function build() {
    const tokenClient = {
        authHeaders: () => serviceAuth.headers(AUDIENCE, SCOPE),
        invalidate: () => serviceAuth.invalidate(AUDIENCE, SCOPE),
    };
    const vip = createVipClient({
        baseUrl: config.vip.internalUrl, tokenClient, timeoutMs: config.vip.timeoutMs,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    return createVipCache({
        vip, ttlMs: config.vip.ttlMs, denyTtlMs: config.vip.denyTtlMs, unavailableTtlMs: config.vip.unavailableTtlMs, now: () => clock(),
    });
}
function theCache() { if (!cache) cache = build(); return cache; }

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '');

/** An entitlement answer (product 'chat') → the badge to show, or null. */
function badgeOf(answer, creator) {
    if (!answer || answer.active !== true || answer.status !== 'active') return null;
    if (answer.preferences && answer.preferences.show_badge === false) return null;
    for (const perk of Array.isArray(answer.product_perks) ? answer.product_perks : []) {
        const b = (perk.bindings || []).find((x) => x && x.binding === 'badge');
        if (!b) continue;
        const cfg = b.config && typeof b.config === 'object' ? b.config : {};
        const id = typeof cfg.badge === 'string' && /^[a-z0-9_-]{1,32}$/.test(cfg.badge) ? cfg.badge : 'member';
        const out = { creator, perk: text(perk.key, 48), name: text(perk.name, 80), badge: id };
        const label = text(cfg.label, 32);
        if (label) out.label = label;
        return out;
    }
    return null;
}

const pairOf = (memberSubject, creatorSubject) => (
    USER_SUBJECT.test(String(memberSubject || '')) && USER_SUBJECT.test(String(creatorSubject || '')) && memberSubject !== creatorSubject
        ? { subject: memberSubject, creator: creatorSubject, product: 'chat' } : null);

/**
 * For a message being sent: { badge } from the cache, or { badge: null, pending } — a promise of
 * the badge (or null) that never rejects — when the cache has no answer yet. Never waits.
 */
function forMessage(memberSubject, creatorSubject) {
    const args = enabled() ? pairOf(memberSubject, creatorSubject) : null;
    if (!args) return { badge: null, pending: null };
    const c = theCache();
    const hit = c.peekEntitlement(args);
    if (hit !== undefined) return { badge: badgeOf(hit, creatorSubject), pending: null };
    return { badge: null, pending: c.entitlement(args).then((a) => badgeOf(a, creatorSubject), () => null) };
}

/** Look the pair up ahead of the first message (a join). Fire-and-forget. */
function warm(memberSubject, creatorSubject) {
    const args = enabled() ? pairOf(memberSubject, creatorSubject) : null;
    if (args) theCache().entitlement(args).catch(() => {});
}

/** vip.membership.changed / billing.entitlement.changed / … → drop that pair now. */
function handleEvent(envelope) { return enabled() ? theCache().handleEvent(envelope) : false; }

/** Tests: an injected clock and fetch; rebuilds the cache. */
function _configure({ now, fetch } = {}) {
    if (now) clock = now;
    if (fetch !== undefined) fetchImpl = fetch;
    cache = null;
}

module.exports = { forMessage, warm, handleEvent, badgeOf, enabled, _configure, get bounds() { return theCache().bounds; } };
