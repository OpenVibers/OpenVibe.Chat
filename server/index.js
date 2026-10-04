/**
 * OpenVibe.Chat — entry point.
 *
 *   node server/index.js      (PORT 4400; systemd unit deploy/systemd/openvibe-chat.service)
 *
 * Boot: database → Live projections (first full sync; Chat serves with whatever it has if Live is
 * slow) → chat and call WebSocket servers → HTTP app (with the Events consumer, POST /internal/events) →
 * background loops (Live sync, events outbox relay, Live mirror relay) → once listening, Chat's
 * Events subscriptions are checked and created if missing (in the background, retried). SIGTERM
 * tells clients the chat is restarting, closes sockets and exits.
 */
'use strict';

const http = require('http');
const config = require('./config');
const db = require('./db/database');
const ctx = require('./live-context');
const chatServer = require('./chat/chat-server');
const callServer = require('./calls/call-server');
const { createMirror } = require('./bridge/live-mirror');
const { createRelay } = require('./events/outbox');
const { createEventsConsumer } = require('./events/consumer');
const subscriptions = require('./events/subscriptions');
const chatAi = require('./ai/chat-ai');
const { limits } = require('./net/actor-limits');
const { createValkey } = require('openvibe-sdk/valkey');
const { gracefulStop, within } = require('openvibe-sdk/service');
const { createApp } = require('./app');

let rejectionsLogged = false;

async function start() {
    // Background loops (timers, socket close handlers) await the database now; a transient failure there (a
    // PgBouncer restart, a statement timeout) is logged, and the loop's next tick tries again, instead of ending
    // the process as an unhandled rejection would.
    if (!rejectionsLogged) {
        rejectionsLogged = true;
        process.on('unhandledRejection', (err) => console.error('[Chat] unhandled rejection:', (err && err.stack) || err));
    }
    console.log(`[Chat] OpenVibe.Chat starting (db ${config.db.url ? 'postgresql' : 'pglite'}, Live ${config.live.internalUrl}, mirror ${config.live.mirror ? 'on' : 'off'}, events ${config.events.url || 'off'}, consumer ${config.events.secrets.length ? 'on' : 'off'})`);
    // PostgreSQL (DATABASE_URL; migrations first, as the owner) or, outside production, an embedded PGlite.
    // The Live mirror's capture is the migration's triggers; with the mirror off its queue is emptied.
    await db.initDb();

    // Shared per-actor rate-limit counters on Valkey (ADR-035); without VALKEY_URL they count in this
    // process, as before. openvibe-sdk/valkey's createValkey returns null when the URL is unset.
    const valkey = createValkey({ url: config.valkey.url, prefix: config.valkey.prefix });
    limits.useValkey(valkey);
    if (valkey) console.log(`[Chat] per-actor limits on Valkey (${config.valkey.prefix})`);

    const firstSync = ctx.sync().catch((err) => console.warn('[Chat] first Live sync:', err.message));
    await Promise.race([firstSync, new Promise((r) => setTimeout(r, 15000))]);
    ctx.start();

    const server = http.createServer();
    chatServer.init(server);
    callServer.init(server);
    const mirror = createMirror({ config });
    const relay = createRelay({ config });
    const events = createEventsConsumer({ chatServer, secrets: config.events.secrets });
    const { app, handleUpgrade } = createApp({ chatServer, mirror, relay, events, callServer });
    server.on('request', app);
    server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch { /* */ } }); });
    mirror.start();
    relay.start();
    events.start();
    // The chat-AI job (Live's server/ai/chat-ai.js, now Chat's): off unless CHAT_AI_ENABLED=1; it
    // writes Chat's own chat_ai_summaries/chat_timeline_events rows directly (C-04 done).
    chatAi.start();

    await new Promise((resolve) => server.listen(config.port, config.host, resolve));
    console.log(`[Chat] listening on http://${config.host}:${server.address().port} (ws /ws/chat${config.calls.enabled ? ', /ws/call' : ''})`);
    const subs = subscriptions.startAtBoot({ config, port: server.address().port });

    // systemd sends SIGTERM (SIGINT by hand); openvibe-sdk/service's gracefulStop takes the signal, runs the stop
    // steps in order (nothing new starts), drains the HTTP server, runs the close steps, then exits 0. drainMs
    // bounds the drain; deadlineMs 8000 is the manifest's lifecycle.shutdown.deadlineSeconds (openvibe-contracts
    // manifests/services/chat.json) and deadlineExitCode 0 keeps the hand-written hard timer's exit 0. The mirror
    // flush stays bounded at 3 s (within). The stop steps keep the old shutdown's exact order; a step that throws
    // is logged and the stop goes on.
    const { stop: shutdown } = gracefulStop({
        name: 'Chat',
        server,
        drainMs: 4000,
        deadlineMs: 8000,
        deadlineExitCode: 0,
        stop: [
            () => chatServer.broadcastAll({
                type: 'server_restart',
                message: '⚙️ Chat server restarting — you will be reconnected automatically.',
                timestamp: new Date().toISOString(),
            }),
            () => ctx.stop(),
            () => relay.stop(),
            () => mirror.stop(),
            () => events.stop(),
            () => chatAi.stop(),
            () => subs.stop(),
            () => { if (valkey) return valkey.close(); },
            () => within(3000, mirror.flush()),
            () => chatServer.close(),
            () => callServer.close(),
        ],
        close: [() => db.close()],
    });
    return { server, mirror, relay, events, callServer, subscriptions: subs, shutdown };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[Chat] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start };
