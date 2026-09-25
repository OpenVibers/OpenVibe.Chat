/**
 * OpenVibe.Events → Chat: POST /internal/events, the endpoint of Chat's Events subscriptions
 * (consumer `chat`, created at boot by ./subscriptions.js; scripts/subscribe-events.js lists,
 * disables and enables them).
 *
 *   live.release.deployed   Live shipped new commits (Live server/events/release-events.js). The deploy
 *                           card in global chat is stored or folded exactly as the bridge's deployNotice
 *                           does (../chat/deploy-notice.js), keyed by subject.id, the head commit: both
 *                           paths claim the head in deploy_releases, so while both run (compatibility
 *                           register C-84) a deploy makes one card whichever arrives first. Older than
 *                           6 hours = ignored:stale.
 *   network.module.updated  a user-module record changed at Network. Only the chat.* namespaces Chat owns
 *                           matter (../prefs/stores.js): a revision newer than the cached copy drops it
 *                           (handleEvent), so a change made elsewhere shows at once instead of within
 *                           CHAT_PREFS_TTL_MS; a chat.presence_prefs change also refreshes the user lists
 *                           the person is in. Other namespaces are acknowledged and not recorded.
 *   vip.membership.changed  a membership started, lapsed or was revoked (source vip): the member's cached
 *                           subscriber-badge answers for that creator are dropped at once
 *                           (../vip/badges.js handleEvent) instead of converging by the cache TTL.
 *
 * Exactly once: the openvibe-sdk inbox claims (consumer, event_id) in the same SQLite transaction as
 * the change, so a redelivery does nothing and a failure rolls both back (Events retries). Broadcasts
 * to browsers run only after that transaction has committed.
 *
 * Signature: v2 only (openvibe-sdk parseDelivery with requireV2): HMAC over "<t>.<raw body>" with t
 * within ±300 s, under CHAT_EVENTS_SECRET (comma-separated for rotation, each 32+ characters). A
 * v1-only, stale, forged or unsigned delivery is 401. Unset secret = 503: the route is inert until
 * the operator sets it. Loopback only, like Chat's other internal routes: a request that came through
 * nginx/Cloudflare (it carries a forwarding header) is refused whatever it presents.
 */
'use strict';

const express = require('express');
const { http } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');
const db = require('../db/database');
const { viaProxy } = require('../net/service-auth');
const deployNotice = require('../chat/deploy-notice');
const prefStores = require('../prefs/stores');
const vipBadges = require('../vip/badges');
const revocations = require('../auth/revocations');
const ctx = require('../live-context');

const CONSUMER = 'chat';
const INBOX_TABLE = 'chat_event_inbox';
const TOPICS = Object.freeze(['live.release.deployed', 'network.module.updated', 'network.user.token_valid_after', 'vip.membership.changed']);
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const INBOX_KEEP_MS = 35 * 24 * 3600 * 1000;       // Events keeps events 30 days: nothing older can be redelivered

/**
 * @param {object} o
 * @param {object} o.chatServer
 * @param {string[]} o.secrets  CHAT_EVENTS_SECRET values (32+ characters each)
 */
function createEventsConsumer({ chatServer, secrets = [], now = () => Date.now(), releaseMaxAgeMs = deployNotice.RELEASE_MAX_AGE_MS, log = console } = {}) {
    const keys = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 32);
    const inbox = createInbox(db.getDb(), { table: INBOX_TABLE, now });
    inbox.ensureSchema();
    const stats = { received: 0, applied: 0, duplicates: 0, ignored: 0, refused: 0, failed: 0, last_at: null, last_type: null, last_outcome: null, last_error: null };

    /**
     * What an envelope needs, decided before the inbox: an 'ignored:*' outcome (acknowledged, not
     * recorded), or the synchronous work to run inside the inbox transaction.
     */
    function plan(event) {
        if (event.event_type === 'live.release.deployed') {
            const rel = deployNotice.releaseFrom(event, { now: now(), maxAgeMs: releaseMaxAgeMs });
            if (typeof rel === 'string') return rel;
            return () => deployNotice.applyReleaseEvent({ db, chatServer, event, now: now(), maxAgeMs: releaseMaxAgeMs, log });
        }
        if (event.event_type === 'network.module.updated') {
            if (event.source !== 'network') return 'ignored:source';
            const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
            const store = prefStores.byNamespace.get(p.namespace);
            if (!store) return 'ignored:namespace';
            return () => {
                if (!store.handleEvent(event)) return 'unchanged';
                // Someone changed whether they are named in user lists: fetch it again and refresh the lists they are in.
                if (store === prefStores.presence && chatServer && typeof chatServer.presenceChanged === 'function') chatServer.presenceChanged(p.owner && p.owner.id);
                return 'invalidated';
            };
        }
        if (event.event_type === 'network.user.token_valid_after') {
            // Signed out everywhere, password changed, banned…: refuse this person's older tokens and
            // close the sockets they opened (WS-B task 4).
            if (event.source !== 'network') return 'ignored:source';
            const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
            const subject = p.subject && p.subject.id;
            const ms = Date.parse(p.valid_after);
            if (!SUBJECT_RE.test(String(subject || '')) || !Number.isFinite(ms)) return 'ignored:payload';
            return () => {
                const moved = revocations.record(subject, ms, typeof p.reason === 'string' ? p.reason.slice(0, 40) : null, now());
                if (!moved) return 'unchanged';
                return {
                    outcome: 'revoked',
                    after: () => {
                        for (const r of db.all('SELECT id FROM ctx_users WHERE subject_id = ?', [subject])) ctx.invalidateUser(r.id);
                        const closed = chatServer ? chatServer.revokeSubject(subject, ms) : 0;
                        if (closed) log.log && log.log(`[Events consumer] ${p.reason || 'revoked'}: closed ${closed} socket(s)`);
                    },
                };
            };
        }
        if (event.event_type === 'vip.membership.changed') {
            // A membership started, lapsed or was revoked: drop that member's cached badge answers for
            // that creator now instead of waiting out the cache TTL (VIP convergence).
            if (event.source !== 'vip') return 'ignored:source';
            return () => (vipBadges.handleEvent(event) ? 'invalidated' : 'unchanged');
        }
        return 'ignored:type';
    }

    /** Apply one envelope. Returns { duplicate, outcome, detail? }. Throws only on a storage failure. */
    function apply(event) {
        const work = plan(event);
        if (typeof work === 'string') return { duplicate: false, outcome: work };
        let after = null;
        const r = inbox.once(CONSUMER, event.event_id, () => {
            const out = work();
            if (typeof out === 'string') return { outcome: out };
            after = out.after || null;
            return { outcome: out.outcome, detail: out.detail };
        });
        if (r.duplicate) return { duplicate: true, outcome: null };
        // Side effects outside the database run only after the commit, once per event.
        if (after) { try { after(); } catch (err) { log.warn('[Events consumer] after-commit step failed:', err.message); } }
        return { duplicate: false, outcome: r.result.outcome, ...(r.result.detail ? { detail: r.result.detail } : {}) };
    }

    const router = express.Router();
    router.post('/', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        const ctx = http.requestContext(req.headers);
        const problem = (status, code, detail) => http.sendProblem(res, status, code, { detail, ctx });
        if (viaProxy(req)) return problem(403, 'chat.internal_only', 'internal route');
        if (!keys.length) return problem(503, 'chat.webhook_disabled', 'CHAT_EVENTS_SECRET is not set');
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        // Signature v2 only: a v1-only (v2 stripped), stale or forged delivery is refused.
        for (const s of keys) { delivery = parseDelivery(raw, req.headers, s, { requireV2: true, now: now() }); if (delivery) break; }
        if (!delivery) { stats.refused++; return problem(401, 'chat.bad_signature', 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window'); }
        const event = delivery.event;
        if (!event || typeof event !== 'object' || typeof event.event_id !== 'string' || !EVENT_ID_RE.test(event.event_id) || typeof event.event_type !== 'string') {
            stats.refused++;
            return problem(400, 'chat.bad_delivery', 'body must be { event: <envelope>, seq }');
        }
        stats.received++;
        stats.last_at = new Date(now()).toISOString();
        stats.last_type = event.event_type;
        let out;
        try {
            out = apply(event);
        } catch (err) {
            // Not acknowledged: the inbox claim rolled back with the change, and Events retries.
            stats.failed++;
            stats.last_error = String(err.message || err).slice(0, 200);
            log.error(`[Events consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
            return problem(500, 'chat.event_failed', 'processing failed; it will be retried');
        }
        if (out.duplicate) stats.duplicates++;
        else if (String(out.outcome).startsWith('ignored:')) stats.ignored++;
        else stats.applied++;
        stats.last_outcome = out.duplicate ? 'duplicate' : out.outcome;
        if (event.event_type === 'live.release.deployed' && !out.duplicate) {
            log.log(`[Events consumer] ${event.event_id} live.release.deployed ${String(event.subject && event.subject.id).slice(0, 7)}: ${out.outcome}`);
        }
        res.status(200).json({ event_id: event.event_id, duplicate: out.duplicate, outcome: out.outcome, ...(out.detail ? { detail: out.detail } : {}) });
    });

    /** Drop inbox receipts older than Events' retention (nothing older can be redelivered). */
    function prune() {
        return db.run(`DELETE FROM ${INBOX_TABLE} WHERE processed_at < ?`, [now() - INBOX_KEEP_MS]).changes;
    }
    let timer = null;
    function start() {
        if (timer) return;
        timer = setInterval(() => { try { prune(); } catch (err) { log.warn('[Events consumer] inbox prune:', err.message); } }, 6 * 3600 * 1000);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { router, apply, prune, start, stop, stats, enabled: keys.length > 0 };
}

module.exports = { createEventsConsumer, CONSUMER, TOPICS, INBOX_TABLE };
