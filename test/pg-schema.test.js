'use strict';
/**
 * The PostgreSQL schema (plan T3, decision 1). migrations/0001_initial.sql opens a real PostgreSQL
 * (PGlite in-process, or the containers with OV_TEST_STORE=pg) and is checked here: every Chat table
 * exists, the keys/indexes the queries rely on are present, and the retired Live read mirror captures
 * nothing any more (0006 dropped its twelve triggers; live_mirror_outbox stays until a contract migration).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { createTestDb } = require('openvibe-sdk/testing');
const { createDb } = require('openvibe-sdk/db');
const { suite } = require('./helpers');

const t = suite('pg-schema');
const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const quiet = { log() {}, info() {}, warn() {}, error() {} };

let db, close;
async function all(sql, params) { return await db.prepare(sql).all(...(params || [])); }
async function get(sql, params) { return await db.prepare(sql).get(...(params || [])); }

// Every table Chat owns, including the Chat ingress retry ledger and runtime-created modules.
const TABLES = [
    'chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks', 'tts_voice_overrides',
    'channel_sounds', 'relay_users', 'hidden_relay_users', 'pending_ip_messages', 'stream_first_chats', 'moderation_actions',
    'channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events',
    'ctx_users', 'ctx_streams', 'ctx_managed_streams', 'ctx_channels', 'ctx_sync', 'events_outbox', 'live_mirror_outbox', 'service_outbox',
    'chat_ingress_applied', 'audio_requests', 'import_hold', 'import_runs', 'chat_meta', 'deploy_releases',
    'chat_event_inbox', 'calls', 'rooms', 'room_members', 'room_messages', 'room_attachments', 'token_revocations',
    'network_blocks', 'account_data_events', 'ticket_conversations', 'ticket_messages',
];
const INDEXES = [
    'idx_chat_ts_deleted', 'idx_chat_page_live', 'idx_chat_channel_user_ts', 'idx_chat_stream_ts', 'idx_emotes_channel_code', 'idx_chat_tl_dedup',
    'idx_calls_open', 'idx_ctx_users_subject', 'idx_ctx_users_username', 'idx_audio_requests_room_state', 'idx_events_outbox_unsent', 'service_outbox_due', 'service_outbox_sent',
    'idx_room_messages_room', 'idx_room_members_user', 'idx_network_blocks_blocked', 'idx_mod_actions_created',
];
const MIRRORED = ['chat_messages', 'dm_conversations', 'dm_participants', 'dm_messages', 'dm_blocks', 'tts_voice_overrides',
    'channel_sounds', 'relay_users', 'hidden_relay_users', 'pending_ip_messages', 'stream_first_chats', 'moderation_actions'];

t('migrate', async () => {
    const tst = await createTestDb({ migrations: MIGRATIONS, service: 'chat' });
    db = tst.db; close = tst.close;
    // createTestDb migrates the production way, so a contract migration (ADR-028) stays held for its
    // N-1 window. This test wants the final schema: apply it now, windowDays 0, on the owner under
    // store 'pg' (the handle createTestDb returns is DML only) or on the handle itself on PGlite.
    const owner = tst.directUrl ? createDb({ url: tst.directUrl, service: 'chat-test-migrate', max: 1, log: quiet }) : db;
    try { await owner.migrate({ dir: MIGRATIONS, windowDays: 0, log: quiet }); }
    finally { if (owner !== db) await owner.close(); }
    assert.ok(db, 'a database handle');
});

t('every table exists', async () => {
    const rows = await all(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
    const have = new Set(rows.map((r) => r.table_name));
    for (const name of TABLES) assert.ok(have.has(name), `table ${name} exists`);
    assert.strictEqual(have.size, TABLES.length + 1, 'exactly the Chat tables plus ov_migrations');
});

// 0005 (contract) drops the retired Live chat bridge: the tables exist on an N-1 database, but
// this release migrates them away (ADR-028).
t('the retired bridge tables are gone', async () => {
    for (const name of ['bridge_applied', 'bridge_refs']) {
        assert.strictEqual((await get(`SELECT to_regclass('${name}') AS t`)).t, null, `${name} is dropped`);
    }
});

t('every index exists', async () => {
    const rows = await all(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
    const have = new Set(rows.map((r) => r.indexname));
    for (const name of INDEXES) assert.ok(have.has(name), `index ${name} exists`);
});

t('SDK migration copies pending legacy envelopes and preserves UTC milliseconds', async () => {
    const env = { event_id: 'evt_01J9AAAAAAAAAAAAAAAAAAAAAA', event_type: 'chat.message.created',
        source: 'chat', timestamp: '2026-09-29T10:00:00.123Z' };
    await db.query(`INSERT INTO events_outbox (event_id, event_type, event, created_at, attempts)
        VALUES ($1, $2, $3, $4, $5)`, [env.event_id, env.event_type, JSON.stringify(env), env.timestamp, 2]);
    await db.query(`INSERT INTO events_outbox (event_id, event_type, event, created_at)
        VALUES ($1, $2, $3, $4)`, ['evt_01J9BBBBBBBBBBBBBBBBBBBBBB', env.event_type,
        JSON.stringify({ ...env, event_id: 'evt_01J9BBBBBBBBBBBBBBBBBBBBBB' }), 'bad-date']);
    await db.query(`INSERT INTO events_outbox (event_id, event_type, event, created_at, sent_at)
        VALUES ($1, $2, $3, $4, $5)`, ['evt_01J9CCCCCCCCCCCCCCCCCCCCCC', env.event_type,
        JSON.stringify({ ...env, event_id: 'evt_01J9CCCCCCCCCCCCCCCCCCCCCC' }), env.timestamp, env.timestamp]);
    // The test database already ran the migration as the owner; re-run its copy step, the only DML in it (the CI
    // containers give the runtime role no CREATE on the schema).
    const full = fs.readFileSync(path.join(MIGRATIONS, '0008_sdk_outbox.sql'), 'utf8');
    const sql = full.slice(full.indexOf('INSERT INTO service_outbox'));
    assert.match(sql, /^INSERT INTO service_outbox[\s\S]*ON CONFLICT \(event_id\) DO NOTHING;/);
    await db.query(sql);
    await db.query(sql);
    const copied = await db.maybe('SELECT envelope, created_at, attempts FROM service_outbox WHERE event_id = $1', [env.event_id]);
    assert.deepStrictEqual(copied.envelope, env);
    assert.strictEqual(Number(copied.created_at), Date.parse(env.timestamp));
    assert.strictEqual(copied.attempts, 2);
    assert.strictEqual(Number(await db.value('SELECT created_at FROM service_outbox WHERE event_id = $1', ['evt_01J9BBBBBBBBBBBBBBBBBBBBBB'])), 0);
    assert.strictEqual(await db.maybe('SELECT id FROM service_outbox WHERE event_id = $1', ['evt_01J9CCCCCCCCCCCCCCCCCCCCCC']), null);
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

t('the retired Live mirror captures nothing (0006 dropped its triggers)', async () => {
    const triggers = await all("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'mirror\\_%'");
    assert.deepStrictEqual(triggers, [], 'no mirror_* capture trigger remains');
    const before = (await get('SELECT COUNT(*) AS n FROM live_mirror_outbox')).n;
    await db.prepare('INSERT INTO chat_messages (message) VALUES (?)').run('hello');
    assert.strictEqual((await get('SELECT COUNT(*) AS n FROM live_mirror_outbox')).n, before, 'a Chat write queues nothing');
});

t('cleanup', async () => { await close(); });

t.run();
