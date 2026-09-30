#!/usr/bin/env node
/**
 * Copy OpenVibe.Live's chat tables into OpenVibe.Chat's database.
 *
 *   node scripts/import-from-live.js --live-db <copy of live.db> [--apply [--backup <path> | --no-backup]]
 *                                    [--headroom <n>] [--tables a,b] [--no-projections]
 *
 * Chat's database is the service's (DATABASE_URL / DATABASE_DIRECT_URL, or the development PGlite); Live's
 * snapshot is read with node:sqlite (scripts/lib/sqlite.js).
 *
 * Run it against a SNAPSHOT (sqlite3 live.db ".backup /tmp/live-snapshot.db"), never the live file.
 *
 * - A dry run unless --apply: the report says what a run would do and nothing is written. --apply
 *   first copies the rows of every table it may write (the twelve chat tables, the ctx_* projections,
 *   import_hold, import_runs) to a JSON file (./data/chat-pre-import-<time>.json, or --backup <path>)
 *   and says where in the report. A whole-database backup is Host's (pg_dump).
 *
 * - Idempotent: a row already in Chat is recognised by its primary key and never written twice;
 *   running it again after the cutover copies only what Live wrote since the first run.
 * - Ids are kept (a message, DM or sound keeps its Live id). Chat's own id sequences start
 *   `--headroom` (default 10000) above Live's highest id (setval), so rows Live writes between the
 *   first import and the flag flip still fit below and a second pass can bring them over.
 * - Nothing it writes is queued for Live's read mirror (ov.mirror_skip) or announced to Events.
 * - Never drops a row. What cannot be represented goes to import_hold with the reason:
 *   an id already used by a DIFFERENT row, a constraint the row breaks, rows of Live's
 *   transient *_new migration tables.
 * - Chat's tables: an existing Chat row always wins (after the cutover Chat is the authority and may
 *   have edited it). The six tables Chat owns (channel moderators/settings, emotes, user tags,
 *   chat-AI summaries/timeline; C-04 done) are not imported — Chat is their only writer.
 * - New columns: *subject_id is filled from Live's linked_accounts (the Network subject).
 * - media_requests / media_request_settings stay in Live (decision: docs/cutover.md) and are
 *   only reported.
 * - Also seeds the ctx_* projections (users, streams, slots, channels) so a rehearsal can read
 *   history before Chat's first sync (--no-projections to skip).
 *
 * Prints counts per table as JSON and records the run in import_runs. Exit code 1 when Live has
 * columns Chat does not know (schema drift: fix the schema first, nothing is written).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { openSqlite } = require('./lib/sqlite');

function parseArgs(argv) {
    const out = { dryRun: true, backup: true, headroom: 10000, projections: true, tables: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--live-db') out.liveDb = argv[++i];
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--apply') out.dryRun = false;
        else if (a === '--backup') out.backupPath = argv[++i];
        else if (a === '--no-backup') out.backup = false;
        else if (a === '--headroom') out.headroom = Math.max(0, parseInt(argv[++i], 10) || 0);
        else if (a === '--tables') out.tables = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--no-projections') out.projections = false;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

// Columns Live keeps for itself on a table Chat owns (not moved; they stay in Live's copy).
const LIVE_ONLY_COLUMNS = {
    channel_sounds: ['media_url', 'media_asset_id'],
};
// Columns that never change once a row exists: equal = the same row, different = an id conflict.
const IDENTITY = {
    chat_messages: ['stream_id', 'user_id', 'anon_id', 'message', 'timestamp'],
    dm_conversations: ['created_by', 'created_at'],
    dm_participants: ['conversation_id', 'user_id'],
    dm_messages: ['conversation_id', 'sender_id', 'message', 'created_at'],
    dm_blocks: ['blocker_id', 'blocked_id'],
    channel_sounds: ['channel_owner_id', 'url', 'created_at'],
    hidden_relay_users: ['platform', 'external_username', 'created_at'],
    pending_ip_messages: ['channel_id', 'ip_address', 'message', 'created_at'],
    moderation_actions: ['action_type', 'actor_user_id', 'created_at'],
};
// Subject columns filled from the author's Live user id.
const SUBJECT_COLUMNS = {
    chat_messages: [['subject_id', 'user_id']],
    dm_messages: [['sender_subject_id', 'sender_id']],
    dm_participants: [['subject_id', 'user_id']],
    dm_blocks: [['blocker_subject_id', 'blocker_id']],
    moderation_actions: [['actor_subject_id', 'actor_user_id']],
    channel_sounds: [['created_by_subject_id', 'created_by']],
};
const TRANSIENT = ['chat_messages_new', 'emotes_new', 'channel_sounds_new'];
const NOT_MOVED = ['media_requests', 'media_request_settings'];
const PROJECTIONS = ['ctx_users', 'ctx_streams', 'ctx_managed_streams', 'ctx_channels'];
class Rollback extends Error {}

// Table and column names come from db.CHAT_TABLES and the two schemas, never from input; still, only plain names.
const ident = (n) => { if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error(`unexpected identifier ${n}`); return n; };
// A value read back from PostgreSQL equals Live's: numbers and text compare as text where a column changed type
// (chat_messages.deleted_by, moderation_actions.scope_id).
const same = (a, b) => a === b || (a == null && b == null) || (a != null && b != null && String(a) === String(b));

/** Copy the rows of every table this run may write, before it writes (a JSON file; the whole database is pg_dump's). */
async function backupChat(chat, tables, target) {
    const file = path.resolve(target || path.join('data', `chat-pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    if (fs.existsSync(file)) throw new Error(`backup ${file} already exists`);
    const out = { taken_at: new Date().toISOString(), tables: {} };
    for (const t of tables) out.tables[t] = await chat.prepare(`SELECT * FROM ${ident(t)}`).all();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
    return file;
}

async function run(opts) {
    if (!opts.liveDb) throw new Error('--live-db <snapshot> is required');
    const db = require('../server/db/database');
    await db.initDb();
    const chat = db.getDb();
    const live = openSqlite(path.resolve(opts.liveDb));
    // Rows written here came from Live: never queued back into Live's read mirror.
    const noMirror = () => chat.query("SET LOCAL ov.mirror_skip = '1'");

    const liveTables = new Set(live.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const colsOfLive = (t) => live.prepare(`PRAGMA table_info(${ident(t)})`).all().map((c) => c.name);
    const colsOfChat = async (t) => (await chat.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`).all(t)).map((c) => c.column_name);

    // The six tables Chat owns (C-04 done) are not imported: Chat is their only writer.
    const plan = [
        ...Object.entries(db.CHAT_TABLES).map(([t, pk]) => ({ table: t, pk: t === 'relay_users' ? ['platform', 'username'] : pk })),
    ].filter((p) => !opts.tables || opts.tables.includes(p.table));

    // Schema drift check first: nothing is written when Live has columns Chat cannot hold. (relay_users' id is
    // Chat's own identity column: Live's rows have none.)
    const drift = [];
    for (const p of plan) {
        if (!liveTables.has(p.table)) continue;
        const chatCols = new Set(await colsOfChat(p.table));
        const extra = colsOfLive(p.table).filter((c) => !chatCols.has(c) && !(LIVE_ONLY_COLUMNS[p.table] || []).includes(c));
        if (extra.length) drift.push(`${p.table}: ${extra.join(', ')}`);
    }
    if (drift.length) {
        live.close();
        const err = new Error(`Live has columns Chat does not know — add them in a migration first:\n  ${drift.join('\n  ')}`);
        err.code = 'SCHEMA_DRIFT';
        throw err;
    }

    // Network subjects by Live user id (newest link wins, as Live resolves them).
    const subjects = new Map();
    if (liveTables.has('linked_accounts') && colsOfLive('linked_accounts').includes('subject_id')) {
        for (const r of live.prepare("SELECT user_id, subject_id FROM linked_accounts WHERE service = 'network' AND subject_id IS NOT NULL ORDER BY id").iterate()) subjects.set(r.user_id, r.subject_id);
    }

    const holdStmt = chat.prepare('INSERT INTO import_hold (source_table, source_pk, reason, row_json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
    const hold = async (table, pkObj, reason, row) => (await holdStmt.run(table, JSON.stringify(pkObj), String(reason).slice(0, 300), JSON.stringify(row))).changes;

    const report = { live_db: path.resolve(opts.liveDb), dry_run: !!opts.dryRun, backup: null, tables: {} };
    if (!opts.dryRun && opts.backup) report.backup = await backupChat(chat, [...Object.keys(db.CHAT_TABLES), ...PROJECTIONS, 'import_hold', 'import_runs'], opts.backupPath);

    for (const p of plan) {
        const r = { live: 0, inserted: 0, identical: 0, chat_kept: 0, held: 0 };
        report.tables[p.table] = r;
        if (!liveTables.has(p.table)) { r.missing_in_live = true; continue; }
        const chatCols = new Set(await colsOfChat(p.table));
        const cols = colsOfLive(p.table).filter((c) => chatCols.has(c)).map(ident);
        const subjectCols = (SUBJECT_COLUMNS[p.table] || []).filter(([sc]) => chatCols.has(sc));
        const insertCols = cols.concat(subjectCols.map(([sc]) => ident(sc)));
        const where = p.pk.map((k) => `${ident(k)} = ?`).join(' AND ');
        const getChat = chat.prepare(`SELECT * FROM ${ident(p.table)} WHERE ${where}`);
        const ins = chat.prepare(`INSERT INTO ${ident(p.table)} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`);
        const identity = IDENTITY[p.table] || null;
        const orderBy = p.pk.map(ident).join(', ');

        const apply = async () => {
            for (const row of live.prepare(`SELECT ${cols.join(', ')} FROM ${ident(p.table)} ORDER BY ${orderBy}`).iterate()) {
                r.live++;
                const pkVals = p.pk.map((k) => row[k]);
                const pkObj = Object.fromEntries(p.pk.map((k) => [k, row[k]]));
                const existing = await getChat.get(...pkVals);
                if (!existing) {
                    // A savepoint per row: a row that breaks a constraint is held, the rest of the table still goes.
                    try {
                        await chat.tx(() => ins.run(...cols.map((c) => row[c]), ...subjectCols.map(([, uidCol]) => subjects.get(row[uidCol]) || null)));
                        r.inserted++;
                    } catch (err) {
                        r.held += await hold(p.table, pkObj, `insert failed: ${err.message}`, row);
                    }
                    continue;
                }
                if (cols.every((c) => same(existing[c], row[c]))) { r.identical++; continue; }
                if (identity && !identity.every((c) => !cols.includes(c) || same(existing[c], row[c]))) {
                    // Same id, different row: Chat's stays, Live's is held for a person to look at.
                    r.held += await hold(p.table, pkObj, 'id already used by a different row in chat', row);
                    continue;
                }
                r.chat_kept++;
            }
        };

        try {
            await chat.tx(async () => { await noMirror(); await apply(); if (opts.dryRun) throw new Rollback(); });
        } catch (err) {
            if (!(err instanceof Rollback)) throw err;
        }
    }

    // Transient migration tables (Live rebuilds a table through <name>_new): never expected to
    // hold rows; if a snapshot caught one mid-rebuild, keep every row for review.
    for (const t of TRANSIENT) {
        if (!liveTables.has(t)) continue;
        const r = { live: 0, held: 0 };
        report.tables[t] = r;
        try {
            await chat.tx(async () => {
                const pkCol = colsOfLive(t).includes('id') ? 'id' : 'rowid';
                for (const row of live.prepare(`SELECT rowid AS _rowid, * FROM ${ident(t)}`).iterate()) {
                    r.live++;
                    r.held += await hold(t, { [pkCol]: pkCol === 'id' ? row.id : row._rowid }, 'row of a transient migration table (Live rebuilds tables through <name>_new)', row);
                }
                if (opts.dryRun) throw new Rollback();
            });
        } catch (err) { if (!(err instanceof Rollback)) throw err; }
    }
    for (const t of NOT_MOVED) {
        if (liveTables.has(t)) report.tables[t] = { live: live.prepare(`SELECT COUNT(*) AS n FROM ${ident(t)}`).get().n, not_moved: 'stays in Live (media queue is Live-owned in W6)' };
    }

    if (!opts.dryRun) {
        // Chat's new ids start above Live's highest id plus headroom (never lowered): the identity's sequence.
        await chat.tx(async () => {
            for (const [t] of Object.entries(db.CHAT_TABLES)) {
                // (only the tables this run imported: --tables leaves the others as they are)
                if (!report.tables[t] || !liveTables.has(t) || !colsOfLive(t).includes('id')) continue;
                const liveMax = live.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${ident(t)}`).get().m;
                const chatMax = (await chat.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${ident(t)}`).get()).m;
                const seq = (await chat.prepare("SELECT pg_get_serial_sequence(?, 'id') AS s").get(t)).s;
                const cur = Number((await chat.prepare('SELECT pg_sequence_last_value(?::regclass) AS v').get(seq)).v) || 0;
                const target = Math.max(liveMax + opts.headroom, chatMax, cur);
                if (target > cur) await chat.prepare('SELECT setval(?::regclass, ?)').get(seq, target);
                report.tables[t].next_id = target + 1;
            }
        });

        if (opts.projections) {
            const seed = async (table, sql, cols) => {
                if (!liveTables.has(sql.table)) return 0;
                const have = new Set(colsOfLive(sql.table));
                const pick = cols.filter((c) => have.has(c.from || c.to));
                const st = chat.prepare(`INSERT INTO ${ident(table)} (${pick.map((c) => ident(c.to)).join(', ')}, synced_at) VALUES (${pick.map(() => '?').join(', ')}, 0)
                    ON CONFLICT(id) DO NOTHING`);
                let n = 0;
                await chat.tx(async () => {
                    for (const row of live.prepare(`SELECT ${pick.map((c) => ident(c.from || c.to)).join(', ')} FROM ${ident(sql.table)}`).iterate()) {
                        n += (await st.run(...pick.map((c) => (c.to === 'subject_id' ? (subjects.get(row.id) || null) : row[c.from || c.to])))).changes;
                    }
                });
                return n;
            };
            const c = (to, from) => ({ to, from });
            report.projections = {
                ctx_users: await seed('ctx_users', { table: 'users' }, [c('id'), c('username'), c('display_name'), c('avatar_url'), c('profile_color'), c('role'), c('is_banned'), c('ban_reason'), c('is_owner'), c('created_at'), c('subject_id', 'id')]),
                ctx_streams: await seed('ctx_streams', { table: 'streams' }, [c('id'), c('user_id'), c('channel_id'), c('managed_stream_id'), c('title'), c('is_live'), c('started_at'), c('ended_at'), c('created_at')]),
                ctx_managed_streams: await seed('ctx_managed_streams', { table: 'managed_streams' }, [c('id'), c('user_id'), c('slug'), c('title'), c('sort_order'), c('created_at')]),
                ctx_channels: await seed('ctx_channels', { table: 'channels' }, [c('id'), c('user_id'), c('title')]),
            };
        }
        await chat.prepare('INSERT INTO import_runs (live_db, dry_run, counts, finished_at) VALUES (?, 0, ?, ov_now())').run(report.live_db, JSON.stringify(report.tables));
    }
    report.held_total = (await chat.prepare('SELECT COUNT(*) AS n FROM import_hold').get()).n;
    live.close();
    return report;
}

const USAGE = 'usage: node scripts/import-from-live.js --live-db <snapshot> [--apply [--backup <path> | --no-backup]] [--headroom <n>] [--tables a,b] [--no-projections]';

/** The command line: → { code, stdout, stderr } (exit 0; 1 schema drift; 2 usage; 3 failure). */
async function cli(argv) {
    let opts;
    try { opts = parseArgs(argv); } catch (err) { return { code: 2, stdout: '', stderr: `${err.message}\n` }; }
    if (opts.help || !opts.liveDb) return { code: opts.help ? 0 : 2, stdout: `${USAGE}\n`, stderr: '' };
    try {
        const report = await run(opts);
        return { code: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
    } catch (err) {
        return { code: err.code === 'SCHEMA_DRIFT' ? 1 : 3, stdout: '', stderr: `${err.message}\n` };
    }
}

if (require.main === module) {
    cli(process.argv.slice(2)).then(async (r) => {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        try { await require('../server/db/database').close(); } catch { /* */ }
        process.exit(r.code);
    });
}

module.exports = { run, cli, parseArgs, IDENTITY, SUBJECT_COLUMNS, LIVE_ONLY_COLUMNS };
