'use strict';
/**
 * The SQLite → PostgreSQL import (plan T3, decision 10): a SQLite fixture is imported into a migrated
 * PGlite database, the per-table report is checked (rows, no problems), the imported rows are readable
 * and were never queued in the Live mirror, and a post-import insert gets an id past the imported max.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openSqlite } = require('../scripts/lib/sqlite');
const { createDb } = require('openvibe-sdk/db');
const { suite } = require('./helpers');
const { main } = require('../scripts/import-sqlite-to-pg');

const t = suite('import-pg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-import-'));
const fixture = path.join(tmp, 'chat.db');
const pgliteDir = path.join(tmp, 'pglite');

async function buildFixture() {
    const d = openSqlite(fixture, { readonly: false, create: true });
    d.exec(`
        CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, message TEXT NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE relay_users (platform TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT, message_count INTEGER DEFAULT 0, PRIMARY KEY (platform, username));
        CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, owner_id INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, message TEXT NOT NULL);
        CREATE TABLE chat_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE emotes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code TEXT NOT NULL, url TEXT NOT NULL, channel_owner_id INTEGER);
    `);
    const msg = d.prepare('INSERT INTO chat_messages (user_id, username, message, timestamp) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 120; i++) await msg.run(1000 + i, `user${i}`, `message ${i}`, '2026-09-29 10:00:00');
    await d.prepare('INSERT INTO relay_users (platform, username, display_name, message_count) VALUES (?, ?, ?, ?)').run('twitch', 'nightbot', 'Nightbot', 42);
    await d.prepare('INSERT INTO rooms (slug, name, owner_id, message_count) VALUES (?, ?, ?, ?)').run('general', 'General', 1001, 5);
    await d.prepare('INSERT INTO room_messages (room_id, user_id, message) VALUES (?, ?, ?)').run(1, 1001, 'hi room');
    await d.prepare('INSERT INTO chat_meta (key, value) VALUES (?, ?)').run('deploy_head', 'abc123');
    await d.prepare('INSERT INTO emotes (user_id, code, url, channel_owner_id) VALUES (?, ?, ?, ?)').run(1001, 'kek', '/e/kek.png', 1001);
    d.close();
}

let report, db;
t('import the fixture', async () => {
    await buildFixture();
    await main(['--sqlite', fixture, '--pglite', pgliteDir]);
    assert.strictEqual(process.exitCode, undefined, 'the import reported ok');
    db = createDb({ pglite: pgliteDir, service: 'chat-import-test' });
});

t('the report has every table', async () => {
    const runs = await db.prepare('SELECT counts FROM import_runs ORDER BY id DESC LIMIT 1').get();
    const counts = JSON.parse(runs.counts);
    assert.strictEqual(counts.ok, true);
    const byTable = Object.fromEntries(counts.tables.map((x) => [x.table, x.rows]));
    assert.strictEqual(byTable.chat_messages, 120, 'all messages imported');
    assert.strictEqual(byTable.relay_users, 1);
    assert.strictEqual(byTable.rooms, 1);
    assert.strictEqual(byTable.chat_meta, 1);
    assert.strictEqual(byTable.emotes, 1);
    assert.strictEqual(counts.problems.length, 0, 'no problems');
});

t('a well-known row is readable', async () => {
    const row = await db.prepare("SELECT message, username FROM chat_messages WHERE message = 'message 120'").get();
    assert.strictEqual(row.username, 'user120');
    const meta = await db.prepare('SELECT value FROM chat_meta WHERE key = ?').get('deploy_head');
    assert.strictEqual(meta.value, 'abc123');
});

t('imported rows were never queued for the Live mirror', async () => {
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM live_mirror_outbox').get()).n, 0);
});

t('a post-import insert is past the imported max', async () => {
    const max = (await db.prepare('SELECT MAX(id) AS id FROM chat_messages').get()).id;
    const res = await db.prepare('INSERT INTO chat_messages (message) VALUES (?) RETURNING id').get('after import');
    assert.ok(res.id > max, `new id ${res.id} is past ${max}`);
});

t('cleanup', async () => { await db.close().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); });

t.run();
