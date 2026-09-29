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
const { createBridge } = require('./bridge/live-bridge');
const { createMirror } = require('./bridge/live-mirror');
const { createRelay } = require('./events/outbox');
const { createEventsConsumer } = require('./events/consumer');
const subscriptions = require('./events/subscriptions');
const chatAi = require('./ai/chat-ai');
const { limits } = require('./net/actor-limits');
const { createValkey } = require('openvibe-sdk/valkey');
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
    const bridge = createBridge({ chatServer, mirror, config });
    const relay = createRelay({ config });
    const events = createEventsConsumer({ chatServer, secrets: config.events.secrets });
    const { app, handleUpgrade } = createApp({ chatServer, bridge, mirror, relay, events, callServer });
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

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('[Chat] shutting down');
        try {
            await chatServer.broadcastAll({
                type: 'server_restart',
                message: '⚙️ Chat server restarting — you will be reconnected automatically.',
                timestamp: new Date().toISOString(),
            });
        } catch { /* non-critical */ }
        ctx.stop();
        relay.stop();
        mirror.stop();
        events.stop();
        chatAi.stop();
        subs.stop();
        try { if (valkey) await valkey.close(); } catch { /* */ }
        try { await Promise.race([mirror.flush(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* */ }
        try { chatServer.close(); } catch { /* */ }
        try { await callServer.close(); } catch { /* */ }
        server.close(async () => { await db.close(); process.exit(0); });
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return { server, mirror, relay, bridge, events, callServer, subscriptions: subs, shutdown };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[Chat] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start };
