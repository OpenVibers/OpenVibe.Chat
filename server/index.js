/**
 * OpenVibe.Chat — entry point.
 *
 *   node server/index.js      (PORT 4400; systemd unit deploy/systemd/openvibe-chat.service)
 *
 * Boot: database → Live projections (first full sync; Chat serves with whatever it has if Live is
 * slow) → chat WebSocket server → HTTP app (with the Events consumer, POST /internal/events) →
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
const { createBridge } = require('./bridge/live-bridge');
const { createMirror } = require('./bridge/live-mirror');
const { createRelay } = require('./events/outbox');
const { createEventsConsumer } = require('./events/consumer');
const subscriptions = require('./events/subscriptions');
const { createApp } = require('./app');

async function start() {
    console.log(`[Chat] OpenVibe.Chat starting (db ${config.dbPath}, Live ${config.live.internalUrl}, mirror ${config.live.mirror ? 'on' : 'off'}, events ${config.events.url || 'off'}, consumer ${config.events.secrets.length ? 'on' : 'off'})`);
    // Mirror capture only when the mirror is on: before the cutover (rehearsals) nothing queues.
    db.initDb({ captureMirror: config.live.mirror });

    const firstSync = ctx.sync().catch((err) => console.warn('[Chat] first Live sync:', err.message));
    await Promise.race([firstSync, new Promise((r) => setTimeout(r, 15000))]);
    ctx.start();

    const server = http.createServer();
    chatServer.init(server);
    const bridge = createBridge({ chatServer });
    const mirror = createMirror({ config });
    const relay = createRelay({ config });
    const events = createEventsConsumer({ chatServer, secrets: config.events.secrets });
    const { app, handleUpgrade } = createApp({ chatServer, bridge, mirror, relay, events });
    server.on('request', app);
    server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch { /* */ } }); });
    mirror.start();
    relay.start();
    events.start();

    await new Promise((resolve) => server.listen(config.port, config.host, resolve));
    console.log(`[Chat] listening on http://${config.host}:${server.address().port} (ws /ws/chat)`);
    const subs = subscriptions.startAtBoot({ config, port: server.address().port });

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('[Chat] shutting down');
        try {
            chatServer.broadcastAll({
                type: 'server_restart',
                message: '⚙️ Chat server restarting — you will be reconnected automatically.',
                timestamp: new Date().toISOString(),
            });
        } catch { /* non-critical */ }
        ctx.stop();
        relay.stop();
        mirror.stop();
        events.stop();
        subs.stop();
        try { await Promise.race([mirror.flush(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* */ }
        try { chatServer.close(); } catch { /* */ }
        server.close(() => { db.close(); process.exit(0); });
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return { server, mirror, relay, bridge, events, subscriptions: subs, shutdown };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[Chat] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start };
