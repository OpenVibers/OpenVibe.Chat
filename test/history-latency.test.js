'use strict';
/**
 * The history page on PostgreSQL (plan T3, decision 2). page('global') over a large chat_messages
 * must be an Index Scan straight from the ordering — no Sort, no Seq Scan — and stay fast.
 *
 * The page order is `id DESC` alone (server/chat/history-store.js readPage), served by the partial
 * index idx_chat_page_live (id DESC) WHERE is_deleted = 0. The same query with the firehose-order
 * plan (a bitmap scan on idx_chat_ts_deleted + Sort) measured p95 ≈ 1.5 s at 200k rows on PGlite;
 * the partial index brings it to ~12 ms. This test guards the index and the plan, not the wall clock.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createTestDb } = require('openvibe-sdk/testing');
const { createDb } = require('openvibe-sdk/db');
const { suite } = require('./helpers');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const HISTORY = path.join(__dirname, '..', 'server', 'chat', 'history-store.js');

// The global page of history-store.js GLOBAL_SELECT, with PostgreSQL's $1 limit and the portable
// datetime('now') visibility predicate. A drift guard below fails this test if the source moves on.
const PAGE_SQL = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
              u.username AS core_username,
              COALESCE(su.username, cu.username) AS stream_channel,
              s.is_live AS source_is_live,
              s.managed_stream_id AS source_managed_id,
              COALESCE(ms.title, s.title) AS source_stream_title,
              ms.slug AS source_slug
       FROM chat_messages cm
       LEFT JOIN ctx_users u ON cm.user_id = u.id
       LEFT JOIN ctx_streams s ON cm.stream_id = s.id
       LEFT JOIN ctx_users su ON s.user_id = su.id
       LEFT JOIN ctx_users cu ON cm.channel_user_id = cu.id
       LEFT JOIN ctx_managed_streams ms ON s.managed_stream_id = ms.id
       WHERE cm.is_deleted = 0 AND cm.message_type IN ('chat', 'system', 'channel-sound', 'soundboard', 'donation')
         AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > datetime('now'))
       ORDER BY cm.id DESC LIMIT $1`;

const N = 60000;
const REPS = 100;
const p95 = (times) => [...times].sort((a, b) => a - b)[Math.min(times.length - 1, Math.ceil(0.95 * times.length) - 1)];

const t = suite('history-latency');
let db, close, ownerUrl;

// On the real containers the serving role is DML-only and its ANALYZE is silently skipped (no column
// statistics, so the planner picked a bitmap scan + Sort); the owner runs it here, as autovacuum and
// scripts/import-sqlite-to-pg.js do in production. On PGlite the one role owns everything.
async function analyze() {
    if (!ownerUrl) { await db.query('ANALYZE chat_messages'); return; }
    const owner = createDb({ url: ownerUrl, service: 'chat-latency-owner', max: 1 });
    try { await owner.query('ANALYZE chat_messages'); } finally { await owner.close(); }
}

t('the page order is id DESC alone on PostgreSQL', () => {
    const src = fs.readFileSync(HISTORY, 'utf8');
    assert.ok(src.includes("ORDER BY cm.id DESC LIMIT ?"), 'readPage orders by the primary key alone (decision 2)');
    assert.ok(!src.includes('ORDER BY cm.timestamp DESC'), 'the timestamp order is gone from the page read');
    assert.ok(src.includes("datetime('now')"), 'the visibility predicate uses the portable datetime(\'now\')');
});

t(`page('global') over ${N} rows is an index scan`, async () => {
    const tst = await createTestDb({ migrations: MIGRATIONS, service: 'chat' });
    db = tst.db; close = tst.close; ownerUrl = tst.directUrl;
    await db.query(`INSERT INTO ctx_users (id, username, display_name) VALUES (1,'u1','U1'),(2,'u2','U2')`);
    await db.query(`INSERT INTO ctx_streams (id, user_id, title, is_live) VALUES (1,1,'S1',1)`);
    await db.query(`INSERT INTO ctx_managed_streams (id, title, slug) VALUES (1,'M1','m1')`);
    await db.query(`INSERT INTO chat_messages (stream_id, user_id, username, message, message_type, is_deleted, timestamp, channel_user_id)
        SELECT (i % 500) + 1, 1, 'user' || ((i % 20000)::text), 'm' || (i::text),
               CASE i % 5 WHEN 0 THEN 'system' WHEN 4 THEN 'channel-sound' ELSE 'chat' END, 0,
               to_char(timestamp '2026-09-29 10:00:00' + make_interval(mins => (i / 60)::int), 'YYYY-MM-DD HH24:MI:SS'),
               (i % 500) + 1
        FROM generate_series(1, ${N}) AS g(i)`);
    await analyze();

    const plan = (await db.many(`EXPLAIN ${PAGE_SQL.replace('LIMIT $1', 'LIMIT 60')}`)).map((r) => r['QUERY PLAN']).join('\n');
    // An index scan straight from the ordering — idx_chat_page_live, or the primary key walked backward
    // (the partial index skips deleted rows the pkey still visits). Never a Sort, never a Seq Scan.
    assert.match(plan, /Index Scan (Backward )?using (chat_messages_pkey|idx_chat_page_live)/, `an index scan without a sort:\n${plan}`);
    assert.ok(!/\bSort\b/.test(plan), `no Sort node:\n${plan}`);
    assert.ok(!/Seq Scan on chat_messages/.test(plan), `no Seq Scan:\n${plan}`);

    const times = [];
    let rows = 0;
    for (let i = 0; i < REPS; i++) {
        const t0 = process.hrtime.bigint();
        rows = (await db.many(PAGE_SQL, [60])).length;
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.strictEqual(rows, 60, 'a full page');
    const ms = p95(times);
    assert.ok(ms < 100, `p95 ${ms.toFixed(2)} ms stays under 100 ms on PGlite`);
    console.log(`  page('global') p95 ${ms.toFixed(2)} ms over ${N} rows (index scan)`);
});

t('cleanup', async () => { if (close) await close().catch(() => {}); });

t.run();
