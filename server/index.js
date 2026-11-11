/**
 * OpenVibe.Chat — entry point.
 *
 *   node server/index.js      (PORT 4400; systemd unit deploy/systemd/openvibe-chat.service)
 *
 * Boot: database → Live projections (first full sync; Chat serves with whatever it has if Live is
 * slow) → chat and call WebSocket servers → HTTP app (with the Events consumer, POST /internal/events) →
 * background loops (Live sync, events outbox relay) → once listening, Chat's
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
const serviceOutbox = require('./events/service-outbox');
const { createEventsConsumer } = require('./events/consumer');
const subscriptions = require('./events/subscriptions');
const chatAi = require('./ai/chat-ai');
const { limits } = require('./net/actor-limits');
const { createValkey } = require('openvibe-sdk/valkey');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { createApp } = require('./app');
const settingsLib = require('./settings');

let rejectionsLogged = false;

async function start() {
    // Background loops (timers, socket close handlers) await the database now; a transient failure there (a
    // PgBouncer restart, a statement timeout) is logged, and the loop's next tick tries again, instead of ending
    // the process as an unhandled rejection would.
    if (!rejectionsLogged) {
        rejectionsLogged = true;
        process.on('unhandledRejection', (err) => console.error('[Chat] unhandled rejection:', (err && err.stack) || err));
    }
    console.log(`[Chat] OpenVibe.Chat starting (db ${config.db.url ? 'postgresql' : 'pglite'}, Live ${config.live.internalUrl}, events ${config.events.url || 'off'}, consumer ${config.events.secrets.length ? 'on' : 'off'})`);
    // PostgreSQL (DATABASE_URL; migrations first, as the owner) or, outside production, an embedded PGlite.
    await db.initDb();

    // D11 owner settings (chat.voices): created before the app mounts /internal/config. A failure leaves Chat
    // serving (the voice keys fall back to the environment and Live's site setting) and says why in the log.
    let settings = null;
    try {
        const made = settingsLib.createSettings({ db: db.getDb(), log: console });
        await made.ready;
        settings = settingsLib.activate(made);
        console.log(`[Chat] owner settings ready (${settings.namespace})`);
    } catch (err) {
        console.warn('[Chat] owner settings unavailable, voice keys fall back to the environment:', err && err.message);
    }
    // The chat apps' bot accounts (chat.apps, the owner-setup design): config.chatApps reads the panel's values first
    // and the environment second, every time. A failure leaves the environment's values in place.
    let chatAppSettings = null;
    try {
        chatAppSettings = await require('./chat-apps/owner-settings').createChatAppSettings({ db: db.getDb(), log: console });
        chatAppSettings.install(config);
        console.log(`[Chat] owner settings ready (${chatAppSettings.namespace})`);
    } catch (err) {
        console.warn('[Chat] chat-app settings unavailable, the chat apps read the environment:', err && err.message);
    }

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
    const relay = serviceOutbox.configure({ config });
    const events = createEventsConsumer({ chatServer, secrets: config.events.secrets });
    const { app, handleUpgrade } = createApp({ chatServer, relay, events, callServer, settings, chatAppSettings });
    void app.locals.chatApps.start();
    server.on('request', app);
    server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head).catch(() => { try { socket.destroy(); } catch { /* */ } }); });
    relay.start();
    events.start();
    // The chat-AI job (Live's server/ai/chat-ai.js, now Chat's): off unless CHAT_AI_ENABLED=1; it
    // writes Chat's own chat_ai_summaries/chat_timeline_events rows directly (C-04 done).
    chatAi.start();
    // Workspace rooms' queues (server/rooms/workspace.js): the OpenVibe.Actor tasks they started, followed every 10 s.
    require('./rooms/workspace').start();
    require('./chat/room-slash').start();
    // OpenVibe's own computers for parties (server/rooms/party-pool.js): release holds that went idle and seat the
    // line once a minute. The owner switch is read at each placement, so this is safe while it is off.
    require('./rooms/party-pool').start({ intervalMs: 60_000 });

    // Zero-downtime restarts (as OpenVibe.Live): when systemd owns the listener (deploy/systemd/openvibe-chat.socket) it
    // hands it over as file descriptor 3, and connections that arrive during a restart wait in the kernel's accept queue
    // instead of being refused (chat history and the chat API of openvibe.live answered 502 through each boot). Without
    // the socket unit this is the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    if (socketActivated) console.log('[Server] socket-activated: listening on the socket systemd handed over (fd 3)');
    await new Promise((resolve) => server.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), resolve));
    console.log(`[Chat] listening on http://${config.host}:${server.address().port} (ws /ws/chat${config.calls.enabled ? ', /ws/call' : ''})`);
    const subs = subscriptions.startAtBoot({ config, port: server.address().port });
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each minute, stored in this service's telemetry_samples table; rows older than 14 days go daily.
    telemetry.init({ service: 'chat', sink: createPgTelemetrySink({ db: db.getDb(), log: console }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    const telemetryRetention = startTelemetryRetention({ db: db.getDb(), log: console, olderThanDays: 14 });

    // systemd sends SIGTERM (SIGINT by hand); openvibe-sdk/service's gracefulStop takes the signal, runs the stop
    // steps in order (nothing new starts), drains the HTTP server, runs the close steps, then exits 0. drainMs
    // bounds the drain; deadlineMs 8000 is the manifest's lifecycle.shutdown.deadlineSeconds (openvibe-contracts
    // manifests/services/chat.json) and deadlineExitCode 0 keeps the hand-written hard timer's exit 0. The stop
    // steps keep the old shutdown's exact order; a step that throws is logged and the stop goes on.
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
            async () => { await relay.stop(); serviceOutbox.reset(); },
            () => events.stop(),
            () => chatAi.stop(),
            () => require('./rooms/workspace').stop(),
            () => require('./rooms/party-pool').stop(),
            () => subs.stop(),
            () => { if (valkey) return valkey.close(); },
            () => app.locals.chatApps.stop(),
            () => chatServer.close(),
            () => callServer.close(),
        ],
        close: [async () => { if (telemetryRetention) await telemetryRetention.stop(); await telemetry.stop(); }, () => db.close()],
    });
    return { server, relay, events, callServer, subscriptions: subs, shutdown };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[Chat] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start };
