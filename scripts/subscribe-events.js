#!/usr/bin/env node
/**
 * Chat's OpenVibe.Events subscriptions (server/events/subscriptions.js): live.release.deployed and
 * network.module.updated → POST /internal/events. Boot already creates missing ones; this lists
 * them and is the rollback switch. Uses the service's env file (0600, so run it as root):
 *
 *   sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js --dry-run   # list, change nothing
 *   sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js             # create what is missing
 *   sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js --disable   # rollback: stop deliveries
 *   sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js --enable    # undo a --disable
 *
 *   [--endpoint http://127.0.0.1:4400/internal/events] [--topic live.release.deployed]  (repeatable)
 *
 * A disabled subscription stays disabled across Chat restarts (boot never re-enables one). Nothing
 * secret is printed.
 */
'use strict';

const config = require('../server/config');
const subscriptions = require('../server/events/subscriptions');

function parseArgs(argv) {
    const o = { action: 'create', endpoint: subscriptions.endpointFor(config), topics: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') o.action = 'list';
        else if (a === '--disable') o.action = 'disable';
        else if (a === '--enable') o.action = 'enable';
        else if (a === '--endpoint') o.endpoint = argv[++i];
        else if (a === '--topic') o.topics.push(argv[++i]);
        else throw new Error(`unknown argument ${a}`);
    }
    for (const t of o.topics) if (!subscriptions.TOPICS.includes(t)) throw new Error(`--topic ${t} is not one of ${subscriptions.TOPICS.join(', ')}`);
    if (!o.endpoint) throw new Error('--endpoint needs a value');
    return o;
}

(async () => {
    const o = parseArgs(process.argv.slice(2));
    const results = await subscriptions.ensure({ config, endpoint: o.endpoint, action: o.action, topics: o.topics.length ? o.topics : subscriptions.TOPICS });
    for (const r of results) {
        const state = r.enabled === false ? 'disabled' : r.enabled === true ? 'enabled' : 'state unknown';
        console.log(`${r.result.padEnd(8)} ${r.id || '-'} (${r.topic} → ${o.endpoint}${r.id ? `, ${state}` : ''})`);
    }
    if (o.action === 'list' && results.some((r) => r.result === 'missing')) console.log('missing ones are created at Chat\'s next boot, or by running this without --dry-run');
})().catch((err) => { console.error(`subscribe-events failed: ${err.message}`); process.exit(1); });
