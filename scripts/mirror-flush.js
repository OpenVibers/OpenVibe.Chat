#!/usr/bin/env node
/**
 * Send whatever is still queued in live_mirror_outbox to Live, once, without starting the service.
 * For a rollback when the service cannot run: every change Chat made reaches Live's tables before
 * Live becomes the chat authority again (docs/cutover.md). Uses the same env as the service
 * (/etc/openvibe/chat.env); LIVE_MIRROR is forced on.
 *
 *   node scripts/mirror-flush.js            → { sent, pending, error }
 */
'use strict';

process.env.LIVE_MIRROR = '1';
const config = require('../server/config');
const db = require('../server/db/database');
const { createMirror } = require('../server/bridge/live-mirror');

(async () => {
    db.initDb({ captureMirror: false });
    const mirror = createMirror({ config });
    const before = mirror.pending();
    const r = await mirror.flush();
    console.log(JSON.stringify({ pending_before: before, ...r }, null, 2));
    db.close();
    process.exit(r.pending ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(3); });
