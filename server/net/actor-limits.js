/**
 * OpenVibe.Chat — per-actor rate limits on the REST API (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address /api/ limit (app.js) and the chat flood controls (the socket's, the DM and room
 * message limits, the call ring limit) stay. These count requests by who makes them:
 *
 *   a person     user:usr_… (user:<id> before their Network subject is known), whether they call with
 *                their Network token or an hbt_ API token (a bot counts as the person who made it)
 *   anyone else  ip:<address>, the visitor's own address (Cloudflare → nginx → Chat, net/client-ip.js)
 *
 * Browsers call these routes themselves (nginx sends Live's chat prefixes here), so no service ever
 * speaks for many visitors on them. Live's service calls (the bridge at /internal/live, the stream
 * hooks at /internal/calls) carry every viewer's chat and are never limited here: a refusal there
 * would drop the whole site's chat, and the WebSocket keeps its own flood control.
 *
 * Reads: every signed-in GET/HEAD under /api/chat, /api/dm, /api/tts, /api/sounds (and /api/streams once
 * calls are Chat's) takes CHAT_LIMITS_MINUTE / CHAT_LIMITS_HOUR, 120 and 3000, one budget per API, counted
 * once the caller's token is resolved (identify below). Signed-out reads keep the per-address limit only. Writes and expensive reads set their own,
 * tighter numbers where they are mounted, after requireAuth. Past a limit the route answers 429
 * problem+json `rate_limited` with Retry-After before it does any work; the refusal is logged once
 * and counted in chat_rate_limited_total{limit,window}. Counters live in this process: a restart
 * forgets them.
 *
 * Never limited: /health, /ready, /release.json, /metrics, /internal/* (the bridge, the call hooks and
 * the signed Events deliveries, which carry account deletions and merges), the WebSocket, and the
 * pages of openvibe.chat.
 */
'use strict';

const { createActorLimiter, createValkeyLimitStore } = require('openvibe-sdk/limits');
const config = require('../config');
const { requestUser } = require('../auth/auth');

/** The limiter's clock (tests set it). */
const clock = { now: () => Date.now() };
let refused = null;
let attachedTo = null;

function personOf(u) {
    if (!u || (!u.subject_id && u.id == null)) return null;
    return u.subject_id ? `user:${u.subject_id}` : `user:${u.id}`;
}

/** Who a request counts against: the person its token resolved to, else its address. */
function actor(req) {
    return personOf(req.user) || personOf(req.ovActorUser) || `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

// The counters: in this process, or shared across processes on Valkey once server/index.js calls
// useValkey() at boot (ADR-035). A limiter built before that is replaced on the next request.
let store = null;
let valkeyHandle = null;
let limiter = null;
let generation = 0;

/** A refusal: logged once, counted in chat_rate_limited_total (the actor is never a token). */
function onLimited(e) {
    console.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
    if (refused) refused.inc({ limit: e.name, window: e.window });
}

function current() {
    if (!limiter) {
        limiter = createActorLimiter({
            limits: { minute: config.limits.minute, hour: config.limits.hour },
            actor,
            now: () => clock.now(),
            onLimited,
            ...(store ? { store } : {}),
        });
    }
    return limiter;
}

/** The middleware factory (each API calls limits(name), possibly with its own numbers). */
function limits(name, own) {
    let mw = null;
    let built = -1;
    return (req, res, next) => {
        if (built !== generation || !mw) { mw = current()(name, own); built = generation; }
        return mw(req, res, next);
    };
}
limits.stats = () => current().stats();
limits.reset = () => current().reset();
/** Count on Valkey (an openvibe-sdk/valkey handle), from now on; null keeps the in-process counters. */
limits.useValkey = function useValkey(valkey) {
    valkeyHandle = valkey || null;
    store = valkey ? createValkeyLimitStore(valkey) : null;
    limiter = null;
    generation++;
};
/** The Valkey handle, for /ready (null when VALKEY_URL is unset). */
limits.valkey = () => valkeyHandle;

/**
 * Resolve the caller's token once (the same resolution requireAuth and optionalAuth then reuse), so
 * a read counts against the person and not their address. A bad or missing token counts by address.
 */
limits.identify = async function identify(req, res, next) {
    try { req.ovActorUser = await requestUser(req); } catch { req.ovActorUser = null; }
    next();
};

/**
 * The defaults on every GET/HEAD of one API. `skip(req)`: reads left to the per-address limit (media
 * files every viewer's player fetches, cached by the browser).
 */
limits.reads = function reads(name, { skip = null } = {}) {
    const limit = limits(name);
    // Signed-out reads stay with the per-address limit (900 a minute, app.js): on Live's busiest streams many
    // viewers share one carrier or campus address, and 120 a minute for all of them would refuse real people.
    const signedOut = (req) => !personOf(req.user) && !personOf(req.ovActorUser);
    return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !signedOut(req) && !(skip && skip(req)) ? limit(req, res, next) : next());
};

/** Count refusals in this app's registry (chat_rate_limited_total{limit,window}). */
limits.attach = function attach(registry) {
    if (registry && registry !== attachedTo) {
        attachedTo = registry;
        refused = registry.counter({ name: 'chat_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] });
    }
    return limits;
};

module.exports = { limits, actor, clock };
