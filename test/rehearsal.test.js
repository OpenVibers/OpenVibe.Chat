'use strict';
/**
 * The cutover rehearsal's seed (docs/cutover.md's ```rehearse block → test/rehearsal/seed.sql).
 * `ov rehearse` loads the declared seed on a fresh database after main's migrations and before the
 * branch's, so the seed must be PostgreSQL and must only name columns of migrations/0001 and 0002 —
 * not chat_ingress_applied, which 0003 creates. Without the declaration the harness would load every
 * test/fixtures/*.sql instead, and test/fixtures/live-chat-schema.sql is Live's SQLite schema.
 * This reproduces that exact order on an in-process PostgreSQL (PGlite).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { suite } = require('./helpers');

const t = suite('rehearsal');
const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const RUNBOOK = path.join(ROOT, 'docs', 'cutover.md');
const SEED = path.join(ROOT, 'test', 'rehearsal', 'seed.sql');

let db;
t('the runbook declares only the PostgreSQL seed', () => {
    const block = /^```rehearse[ \t]*\n([\s\S]*?)^```/gm.exec(fs.readFileSync(RUNBOOK, 'utf8'));
    assert.ok(block, "docs/cutover.md has a ```rehearse block");
    const seeds = block[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('seed:'))
        .map((l) => l.slice(5).trim());
    assert.deepStrictEqual(seeds, ['test/rehearsal/seed.sql'], 'the only seed is test/rehearsal/seed.sql');
});

t('the seed applies after 0001–0002 and before 0003', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-base-'));
    for (const f of ['0001_initial.sql', '0002_audio_claim_owner.sql']) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(base, f));
    db = createDb({ pglite: true, service: 'rehearsal-test', log: { log() {}, warn() {}, error() {} } });
    const first = await db.migrate({ dir: base, log: { log() {} } });
    assert.deepStrictEqual(first.applied.map((a) => a.id), ['0001', '0002'], 'main\'s migrations applied');
    await db.query(fs.readFileSync(SEED, 'utf8'));
    for (const [table, n] of [['chat_messages', 3], ['dm_conversations', 1], ['dm_participants', 2], ['dm_messages', 2], ['bridge_applied', 1]]) {
        const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        assert.strictEqual(row.n, n, `${table} has ${n} seeded row(s)`);
    }
    assert.strictEqual((await db.prepare(`SELECT to_regclass('chat_ingress_applied') AS t`).get()).t, null, '0003 has not run yet');
    const second = await db.migrate({ dir: MIGRATIONS, log: { log() {} } });
    const later = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4))
        .filter((id) => id > '0002').sort();
    assert.ok(later.includes('0003'), 'migrations/0003 exists');
    assert.strictEqual(second.held.length, 0, 'no later migration is held');
    assert.deepStrictEqual(second.applied.map((a) => a.id), later, 'every migration after 0002 applies on top of the seed');
});

t('cleanup', async () => { await db.close(); });

t.run();
