'use strict';
/**
 * The Live read mirror is retired (plan T3, 2026-10-05): Live #31 reads Chat's internal read API
 * (server/chat/internal-reads.js) instead of its mirror-filled copies of Chat's tables, so no Chat
 * code path enqueues into live_mirror_outbox or drains it. The table itself stays until a later
 * contract migration drops it, and migrations/0001_initial.sql still has the per-table triggers
 * that fill it (schema SQL, not an application code path); this guard is about the sender, its
 * config and its enqueue/relay call sites never coming back.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('no-live-mirror');
const ROOT = path.join(__dirname, '..');
const RETIRED = /live_mirror_outbox|live-mirror|LIVE_MIRROR|createMirror|mirror-flush|mirrorIntervalMs|chat_mirror\.write/;

function files(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...files(p));
        else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

t('no server/ or scripts/ code path writes, reads or drains live_mirror_outbox', () => {
    const offenders = [...files(path.join(ROOT, 'server')), ...files(path.join(ROOT, 'scripts'))]
        .filter((f) => RETIRED.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(offenders, []);
});

t('the mirror sender module and the flush script are gone', () => {
    for (const p of ['server/bridge/live-mirror.js', 'scripts/mirror-flush.js']) {
        assert.ok(!fs.existsSync(path.join(ROOT, p)), `${p} is gone`);
    }
});

t('.env.example no longer offers the retired mirror switches', () => {
    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert.ok(!/LIVE_MIRROR/.test(env), '.env.example still configures LIVE_MIRROR');
});

t.run();
