#!/usr/bin/env node
/**
 * Send whatever is still queued in live_mirror_outbox to Live, once, without starting the service.
 * A recovery helper when the service cannot run: Live's readers see every change Chat made
 * (docs/cutover.md). There is no rollback to Live to drain for. Uses the same env as the service
 * (/etc/openvibe/chat.env: DATABASE_URL, DATABASE_DIRECT_URL); LIVE_MIRROR is forced on.
 *
 *   node scripts/mirror-flush.js            → { sent, pending, error }
 */
'use strict';

process.env.LIVE_MIRROR = '1';
const config = require('../server/config');
const db = require('../server/db/database');
const { createMirror } = require('../server/bridge/live-mirror');

(async () => {
    await db.initDb();
    const mirror = createMirror({ config });
    const before = await mirror.pending();
    const r = await mirror.flush();
    console.log(JSON.stringify({ pending_before: before, ...r }, null, 2));
    await db.close();
    process.exit(r.pending ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(3); });
