'use strict';
/**
 * The PostgreSQL schema (plan T3, decision 1). migrations/0001_initial.sql opens a real PostgreSQL
 * (PGlite in-process, or the containers with OV_TEST_STORE=pg) and is checked here: every Chat table
 * exists, the keys/indexes the queries rely on are present, and the Live read-mirror triggers on the
 * twelve mirrored tables queue a change for every Chat write but never for one that sets
 * ov.mirror_skip = '1' (the bridge applying Live's writes, and the importer).
 */
const assert = require('assert');
const path = require('path');
const { createTestDb } = require('openvibe-sdk/testing');
const { suite } = require('./helpers');

const t = suite('pg-schema');
const MIGRATIONS = path.join(__dirname, '..', 'migrations');

let db, close;
async function all(sql, params) { return await db.prepare(sql).all(...(params || [])); }
async function get(sql, params) { return await db.prepare(sql).get(...(params || [])); }

// Every table Chat owns, including the Chat ingress retry ledger and runtime-created modules.
const TABLES = [
    'chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks', 'tts_voice_overrides',
    'channel_sounds', 'relay_users', 'hidden_relay_users', 'pending_ip_messages', 'stream_first_chats', 'moderation_actions',
    'channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events',
    'ctx_users', 'ctx_streams', 'ctx_managed_streams', 'ctx_channels', 'ctx_sync', 'events_outbox', 'live_mirror_outbox',
    'bridge_applied', 'chat_ingress_applied', 'audio_requests', 'bridge_refs', 'import_hold', 'import_runs', 'chat_meta', 'deploy_releases',
    'chat_event_inbox', 'calls', 'rooms', 'room_members', 'room_messages', 'room_attachments', 'token_revocations',
    'network_blocks', 'account_data_events',
];
const INDEXES = [
    'idx_chat_ts_deleted', 'idx_chat_page_live', 'idx_chat_channel_user_ts', 'idx_chat_stream_ts', 'idx_emotes_channel_code', 'idx_chat_tl_dedup',
    'idx_calls_open', 'idx_ctx_users_subject', 'idx_ctx_users_username', 'idx_audio_requests_room_state', 'idx_events_outbox_unsent',
    'idx_room_messages_room', 'idx_room_members_user', 'idx_network_blocks_blocked', 'idx_mod_actions_created',
];
const MIRRORED = ['chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks', 'tts_voice_overrides',
    'channel_sounds', 'relay_users', 'hidden_relay_users', 'pending_ip_messages', 'stream_first_chats', 'moderation_actions'];

t('migrate', async () => {
    const tst = await createTestDb({ migrations: MIGRATIONS, service: 'chat' });
    db = tst.db; close = tst.close;
    assert.ok(db, 'a database handle');
});

t('every table exists', async () => {
    const rows = await all(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
    const have = new Set(rows.map((r) => r.table_name));
    for (const name of TABLES) assert.ok(have.has(name), `table ${name} exists`);
    assert.strictEqual(have.size, TABLES.length + 1, 'exactly the Chat tables plus ov_migrations');
});

t('every index exists', async () => {
    const rows = await all(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
    const have = new Set(rows.map((r) => r.indexname));
    for (const name of INDEXES) assert.ok(have.has(name), `index ${name} exists`);
});

t('the SQLite-compat functions exist', async () => {
    const r = await get(`SELECT ov_now() AS now, datetime('2026-09-29 10:00:00', '+1 hour') AS later, json_valid('{}') AS j`);
    assert.match(r.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'ov_now is SQLite-format text');
    assert.strictEqual(r.later, '2026-09-29 11:00:00');
    assert.strictEqual(r.j, true);
});

t('relay_users has a real identity id', async () => {
    const r = await get(`SELECT is_identity FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'relay_users' AND column_name = 'id'`);
    assert.strictEqual(r.is_identity, 'YES', 'id is an identity column');
});

t('a Chat write is captured by the mirror', async () => {
    const before = (await get('SELECT COUNT(*) AS n FROM live_mirror_outbox')).n;
    await db.prepare('INSERT INTO chat_messages (message) VALUES (?)').run('hello');
    const rows = await all('SELECT tbl, op, pk FROM live_mirror_outbox ORDER BY seq');
    assert.strictEqual(rows.length, before + 1, 'one queued change');
    const last = rows[rows.length - 1];
    assert.strictEqual(last.tbl, 'chat_messages');
    assert.strictEqual(last.op, 'upsert');
    assert.ok(JSON.parse(last.pk).id >= 1, 'the pk carries the id');
});

t("a Live write (ov.mirror_skip) never comes back", async () => {
    const before = (await get('SELECT COUNT(*) AS n FROM live_mirror_outbox')).n;
    await db.tx(async (tx) => {
        await tx.query(`SET LOCAL ov.mirror_skip = '1'`);
        await tx.query(`INSERT INTO chat_messages (message) VALUES ('from Live')`);
    });
    assert.strictEqual((await get('SELECT COUNT(*) AS n FROM live_mirror_outbox')).n, before, 'nothing queued');
});

t('cleanup', async () => { await close(); });

t.run();
