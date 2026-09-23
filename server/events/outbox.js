/**
 * Transactional outbox (events.event-envelope@1).
 *
 * enqueue() runs inside the same SQLite transaction as the change it announces (a chat message,
 * a DM, a moderation action), so an event exists exactly when its effect does:
 *   chat.message.created   visibility public   — a message in a public room (global/channel/stream)
 *   chat.message.deleted   visibility public   — ids of deleted messages (moderation, the author,
 *                                                a purge, auto-delete); payload.redacts makes
 *                                                OpenVibe.Events tombstone their chat.message.created
 *   chat.dm.created        visibility subject  — a DM; the payload names participants, never the text
 *   chat.moderation.action visibility internal — ban/timeout/clear/slow/deletes, from chat or Live
 *
 * The relay publishes unsent rows to OpenVibe.Events (POST /api/v1/events, service token for
 * audience openvibe.events with events.event.publish) and runs only when EVENTS_URL is set;
 * without it rows accumulate and are relayed later. Events deduplicates on event_id, so a retry
 * after a lost response never publishes twice.
 */
'use strict';

const { ids, validate, serviceAuth } = require('openvibe-contracts');

const SOURCE = 'chat';
const SERVICE_ACTOR = { type: 'service', id: SOURCE };
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function actorFor(subjectId) {
    return subjectId && USER_SUBJECT.test(subjectId) ? { type: 'user', id: subjectId } : SERVICE_ACTOR;
}

/** Add one envelope to the outbox. Call inside the transaction that makes the change. */
function enqueue({ event_type, subject, payload, visibility = 'internal', priority = 'important', actorSubject = null }) {
    const db = require('../db/database');
    const ms = Date.now();
    const env = {
        event_id: ids.newId('event', ms),
        event_type,
        version: 1,
        source: SOURCE,
        actor: actorFor(actorSubject),
        timestamp: new Date(ms).toISOString(),
        priority,
        visibility,
        subject,
        payload: payload || {},
    };
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`outbox: invalid envelope for ${event_type}: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    db.run('INSERT INTO events_outbox (event_id, event_type, event, created_at) VALUES (?, ?, ?, ?)', [env.event_id, event_type, JSON.stringify(env), env.timestamp]);
    return env;
}

/** Relay loop. Returns { start, stop, flush }. */
function createRelay({ config, fetchImpl = globalThis.fetch, tokenClient, log = console } = {}) {
    const db = require('../db/database');
    const tokens = tokenClient || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope: 'events.event.publish',
        fetchImpl,
    });
    let timer = null;
    let busy = false;

    function markFailed(rows, message) {
        const mark = db.getDb().prepare('UPDATE events_outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?');
        db.transaction(() => { for (const r of rows) mark.run(String(message).slice(0, 500), r.seq); });
        log.warn(`[Chat] outbox relay: ${rows.length} event(s) not published: ${message}`);
    }

    async function flush() {
        if (!config.events.url) return { sent: 0, disabled: true };
        if (busy) return { sent: 0, busy: true };
        busy = true;
        let sent = 0;
        try {
            for (;;) {
                const rows = db.all('SELECT seq, event_id, event FROM events_outbox WHERE sent_at IS NULL ORDER BY seq LIMIT 100');
                if (!rows.length) break;
                let res;
                try {
                    res = await fetchImpl(`${config.events.url}/api/v1/events`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
                        body: JSON.stringify({ events: rows.map((r) => JSON.parse(r.event)) }),
                        signal: AbortSignal.timeout(10000),
                    });
                } catch (e) {
                    markFailed(rows, e.message);
                    break;
                }
                if (res.status === 401) tokens.invalidate();
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    markFailed(rows, `${res.status} ${text.slice(0, 300)}`);
                    break;
                }
                const at = new Date().toISOString();
                const mark = db.getDb().prepare('UPDATE events_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ?');
                db.transaction(() => { for (const r of rows) mark.run(at, r.seq); });
                sent += rows.length;
            }
        } finally {
            busy = false;
        }
        return { sent };
    }

    function start() {
        if (timer || !config.events.url) return;
        timer = setInterval(() => { flush().catch((e) => log.warn('[Chat] outbox relay:', e.message)); }, config.events.intervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { start, stop, flush };
}

module.exports = { enqueue, createRelay, actorFor };
