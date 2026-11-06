'use strict';
const config = require('../config');
const db = require('../db/database');
const { createProviders } = require('./providers');
const { createStore } = require('./store');
const { createNetworkClient } = require('./network');
const { createActorClient } = require('./actor');
const { createHandler } = require('./handler');
function createChatApps({ log = console } = {}) {
    const { providers, whoami } = createProviders({ config });
    const store = createStore({ db });
    const handler = createHandler({ config, store, providers, network: createNetworkClient(), actor: createActorClient() });
    const abort = new AbortController();
    let timer, gateway, starting = false, stopped = false;
    const running = [0, 0];
    async function worker(button) {
        const lane = button ? 1 : 0;
        if (stopped || running[lane] >= (button ? 2 : 4)) return;
        running[lane]++;
        try {
            for (;;) {
                if (stopped) return;
                const row = await store.next(button);
                if (!row) return;
                const m = typeof row.message === 'string' ? JSON.parse(row.message) : row.message;
                let ok = true;
                try { await handler.handle(m, row.id, abort.signal); }
                catch {
                    ok = false;
                    if (!stopped) await handler.send(m, 'I could not complete that request. Please try again.').catch(() => {});
                    log.warn('[chat-apps] delivery failed');
                }
                await store.finish(row.app, row.id, ok);
            }
        } catch { log.warn('[chat-apps] queue unavailable'); }
        finally { running[lane]--; }
    }
    const wake = () => { if (!starting && !stopped) { void worker(false); void worker(true); } };
    const router = require('./ingress').router({ config, providers, store, wake, onError: () => log.warn('[chat-apps] ingress unavailable') });
    async function start() {
        if (!Object.values(providers).some(p => p.on)) return;
        starting = true;
        try {
            await whoami();
            // A delivery interrupted after an external effect is not blindly repeated on restart.
            await db.run("UPDATE chat_app_deliveries SET state = 'failed', message = '{}'::jsonb WHERE state = 'running'");
            await store.prune();
            if (providers.discord.on) gateway = await require('./discord-gateway').start({ config, provider: providers.discord, store, wake, log });
            timer = setInterval(wake, 1000); timer.unref();
        } catch { log.warn('[chat-apps] startup unavailable'); }
        finally { starting = false; wake(); }
    }
    return { router, start, stop() { stopped = true; abort.abort(); clearInterval(timer); gateway?.destroy(); } };
}
module.exports = { createChatApps };
