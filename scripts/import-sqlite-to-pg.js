#!/usr/bin/env node
/**
 * The one-time move of Chat's SQLite data into its PostgreSQL schema (plan T3, decision 10).
 *
 *   node scripts/import-sqlite-to-pg.js --sqlite /var/lib/openvibe-chat/chat.db \
 *        --url "$DATABASE_DIRECT_URL"            # the owner role, a direct connection
 *   node scripts/import-sqlite-to-pg.js --sqlite ./data/chat.db --pglite ./data/pglite   # a local dry run
 *
 * It wraps openvibe-sdk/db importSqlite: parents first, batched inserts, identity columns keep their
 * ids and their sequences move past the maximum, and every table is verified (row count + a checksum
 * walked in primary-key order). The per-table report is written to import_runs and printed. The
 * session runs with ov.mirror_skip = '1', so the rows (which came from Live) are never queued back
 * into Live's read mirror.
 */
'use strict';

const path = require('path');
const { createDb, importSqlite } = require('openvibe-sdk/db');
const { openSqlite } = require('./lib/sqlite');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

function usage(msg) {
    if (msg) console.error(`import-sqlite-to-pg: ${msg}`);
    console.error('usage: import-sqlite-to-pg --sqlite <file> (--url <postgres-url> | --pglite <dir>) [--truncate] [--no-verify]');
    process.exit(2);
}

async function main(argv) {
    const args = { sqlite: '', url: '', pglite: '', truncate: false, verify: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--sqlite') args.sqlite = argv[++i];
        else if (a === '--url') args.url = argv[++i];
        else if (a === '--pglite') args.pglite = argv[++i];
        else if (a === '--truncate') args.truncate = true;
        else if (a === '--no-verify') args.verify = false;
        else usage(`unknown argument ${a}`);
    }
    if (!args.sqlite) usage('--sqlite is required');
    if (!args.url && !args.pglite) args.url = process.env.DATABASE_DIRECT_URL;
    if (!args.url && !args.pglite) usage('--url, --pglite or DATABASE_DIRECT_URL is required');

    // The owner handle (or an embedded PGlite for a dry run). One connection, so the session setting below holds.
    const db = args.pglite
        ? createDb({ pglite: args.pglite, service: 'chat-import', max: 1 })
        : createDb({ url: args.url, service: 'chat-import', max: 1 });
    try {
        // The schema first (the owner applies migrations/; a no-op where the release already did).
        await db.migrate({ dir: MIGRATIONS, log: { log() {}, info() {}, warn: console.warn, error: console.error } });
        // The import's rows came from Live: they must not queue in the read mirror (decision 1).
        await db.query(`SET ov.mirror_skip = '1'`);

        const started = new Date().toISOString().replace('T', ' ').slice(0, 19);
        // Read with node:sqlite (scripts/lib/sqlite.js): better-sqlite3 is no longer a dependency (decision 11).
        const source = openSqlite(args.sqlite);
        let report;
        try { report = await importSqlite({ sqlite: source, db, truncate: args.truncate, verify: args.verify }); } finally { source.close(); }

        // Statistics for the serving role (plan T3, decision 2): the importer is the owner, and the runtime
        // role is DML-only, so its ANALYZE is silently skipped and it would have no column statistics until
        // autovacuum runs. Without them the planner mis-estimates the history page and picks a bitmap scan
        // + Sort (p95 ≈ 280 ms at 60k rows); with them it is an Index Scan Backward (p95 ≈ 2 ms). See
        // test/history-latency.test.js.
        await db.query('ANALYZE');

        // The per-table report, one line each, in the same shape import_runs stores it.
        for (const t of report.tables) {
            console.log(`[import] ${t.table.padEnd(28)} ${String(t.rows).padStart(8)} rows${t.checksum ? `  checksum ${t.checksum}` : ''}  (${t.ms} ms)`);
        }
        for (const p of report.problems) console.error(`[import] PROBLEM ${p.table}: ${p.problem}`);
        console.log(`[import] ${report.tables.length} tables, ${report.tables.reduce((n, t) => n + t.rows, 0)} rows, ${report.ok ? 'ok' : 'FAILED'}`);

        // Record the run (best effort: a failure here does not change the import's verdict).
        try {
            await db.prepare(`INSERT INTO import_runs (live_db, dry_run, counts, started_at, finished_at) VALUES (?, ?, ?, ?, ?)`)
                .run(args.sqlite, args.pglite ? 1 : 0, JSON.stringify({ ok: report.ok, tables: report.tables, problems: report.problems }), started, new Date().toISOString().replace('T', ' ').slice(0, 19));
        } catch (err) { console.warn(`[import] could not record the run: ${err.message}`); }

        await db.query(`SET ov.mirror_skip = '0'`).catch(() => {});
        if (!report.ok) process.exitCode = 1;
    } finally {
        await db.close().catch(() => {});
    }
}

if (require.main === module) main(process.argv.slice(2)).catch((err) => { console.error(`[import] ${err && err.stack || err}`); process.exit(1); });

module.exports = { main };
