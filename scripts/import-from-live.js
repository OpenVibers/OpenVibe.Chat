#!/usr/bin/env node
/**
 * Copy OpenVibe.Live's chat tables into OpenVibe.Chat's database.
 *
 *   node scripts/import-from-live.js --live-db <copy of live.db> [--dry-run] [--chat-db <path>]
 *                                    [--headroom <n>] [--tables a,b] [--no-projections]
 *
 * Run it against a SNAPSHOT (sqlite3 live.db ".backup /tmp/live-snapshot.db"), never the live file.
 *
 * - Idempotent: a row already in Chat is recognised by its primary key and never written twice;
 *   running it again after the cutover copies only what Live wrote since the first run.
 * - Ids are kept (a message, DM or sound keeps its Live id). Chat's own id sequences start
 *   `--headroom` (default 10000) above Live's highest id, so rows Live writes between the
 *   first import and the flag flip still fit below and a second pass can bring them over.
 * - Never drops a row. What cannot be represented goes to import_hold with the reason:
 *   an id already used by a DIFFERENT row, a constraint the row breaks, rows of Live's
 *   transient *_new migration tables.
 * - Chat's tables: an existing Chat row always wins (after the cutover Chat is the authority
 *   and may have edited it). Staged tables (Live still writes them in W6): refreshed from Live.
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

const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
    const out = { dryRun: false, headroom: 10000, projections: true, tables: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--live-db') out.liveDb = argv[++i];
        else if (a === '--chat-db') out.chatDb = argv[++i];
        else if (a === '--dry-run') out.dryRun = true;
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
const STAGED_PKS = {
    channel_moderators: ['id'],
    channel_moderation_settings: ['channel_id'],
    emotes: ['id'],
    user_tags: ['id'],
    chat_ai_summaries: ['id'],
    chat_timeline_events: ['id'],
};

class Rollback extends Error {}

function run(opts) {
    if (!opts.liveDb) throw new Error('--live-db <snapshot> is required');
    if (opts.chatDb) process.env.CHAT_DB_PATH = opts.chatDb;
    const db = require('../server/db/database');
    // No mirror capture: these rows came from Live.
    db.initDb({ captureMirror: false });
    const chat = db.getDb();
    const live = new Database(path.resolve(opts.liveDb), { readonly: true, fileMustExist: true });

    const liveTables = new Set(live.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const colsOf = (conn, t) => conn.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

    const plan = [
        ...Object.entries(db.CHAT_TABLES).map(([t, pk]) => ({ table: t, pk, kind: 'chat' })),
        ...Object.entries(STAGED_PKS).map(([t, pk]) => ({ table: t, pk, kind: 'staged' })),
    ].filter((p) => !opts.tables || opts.tables.includes(p.table));

    // Schema drift check first: nothing is written when Live has columns Chat cannot hold.
    const drift = [];
    for (const p of plan) {
        if (!liveTables.has(p.table)) continue;
        const chatCols = new Set(colsOf(chat, p.table));
        const extra = colsOf(live, p.table).filter((c) => !chatCols.has(c) && !(LIVE_ONLY_COLUMNS[p.table] || []).includes(c));
        if (extra.length) drift.push(`${p.table}: ${extra.join(', ')}`);
    }
    if (drift.length) {
        live.close();
        const err = new Error(`Live has columns Chat does not know — update server/db/schema.sql first:\n  ${drift.join('\n  ')}`);
        err.code = 'SCHEMA_DRIFT';
        throw err;
    }

    // Network subjects by Live user id (newest link wins, as Live resolves them).
    const subjects = new Map();
    if (liveTables.has('linked_accounts') && colsOf(live, 'linked_accounts').includes('subject_id')) {
        for (const r of live.prepare("SELECT user_id, subject_id FROM linked_accounts WHERE service = 'network' AND subject_id IS NOT NULL ORDER BY id").iterate()) subjects.set(r.user_id, r.subject_id);
    }

    const holdStmt = chat.prepare('INSERT OR IGNORE INTO import_hold (source_table, source_pk, reason, row_json) VALUES (?, ?, ?, ?)');
    const hold = (table, pkObj, reason, row) => holdStmt.run(table, JSON.stringify(pkObj), String(reason).slice(0, 300), JSON.stringify(row)).changes;

    const report = { live_db: path.resolve(opts.liveDb), dry_run: !!opts.dryRun, tables: {} };

    for (const p of plan) {
        const r = { live: 0, inserted: 0, identical: 0, refreshed: 0, chat_kept: 0, held: 0 };
        report.tables[p.table] = r;
        if (!liveTables.has(p.table)) { r.missing_in_live = true; continue; }
        const chatCols = new Set(colsOf(chat, p.table));
        const cols = colsOf(live, p.table).filter((c) => chatCols.has(c));
        const subjectCols = (SUBJECT_COLUMNS[p.table] || []).filter(([sc]) => chatCols.has(sc));
        const insertCols = cols.concat(subjectCols.map(([sc]) => sc));
        const where = p.pk.map((k) => `${k} = ?`).join(' AND ');
        const getChat = chat.prepare(`SELECT * FROM ${p.table} WHERE ${where}`);
        const ins = chat.prepare(`INSERT INTO ${p.table} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`);
        const upd = cols.filter((c) => !p.pk.includes(c));
        const refresh = upd.length ? chat.prepare(`UPDATE ${p.table} SET ${upd.map((c) => `${c} = ?`).join(', ')} WHERE ${where}`) : null;
        const identity = IDENTITY[p.table] || null;
        const orderBy = p.pk.join(', ');

        const apply = () => {
            for (const row of live.prepare(`SELECT ${cols.join(', ')} FROM ${p.table} ORDER BY ${orderBy}`).iterate()) {
                r.live++;
                const pkVals = p.pk.map((k) => row[k]);
                const pkObj = Object.fromEntries(p.pk.map((k) => [k, row[k]]));
                const existing = getChat.get(...pkVals);
                if (!existing) {
                    try {
                        ins.run(...cols.map((c) => row[c]), ...subjectCols.map(([, uidCol]) => subjects.get(row[uidCol]) || null));
                        r.inserted++;
                    } catch (err) {
                        r.held += hold(p.table, pkObj, `insert failed: ${err.message}`, row);
                    }
                    continue;
                }
                const same = cols.every((c) => existing[c] === row[c] || (existing[c] == null && row[c] == null));
                if (same) { r.identical++; continue; }
                if (identity && !identity.every((c) => !cols.includes(c) || existing[c] === row[c] || (existing[c] == null && row[c] == null))) {
                    // Same id, different row: Chat's stays, Live's is held for a person to look at.
                    r.held += hold(p.table, pkObj, 'id already used by a different row in chat', row);
                    continue;
                }
                if (p.kind === 'staged' && refresh) {
                    refresh.run(...upd.map((c) => row[c]), ...pkVals);
                    r.refreshed++;
                } else {
                    r.chat_kept++;
                }
            }
        };

        try {
            chat.transaction(() => { apply(); if (opts.dryRun) throw new Rollback(); })();
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
            chat.transaction(() => {
                const pkCol = colsOf(live, t).includes('id') ? 'id' : 'rowid';
                for (const row of live.prepare(`SELECT rowid AS _rowid, * FROM ${t}`).iterate()) {
                    r.live++;
                    r.held += hold(t, { [pkCol]: pkCol === 'id' ? row.id : row._rowid }, 'row of a transient migration table (Live rebuilds tables through <name>_new)', row);
                }
                if (opts.dryRun) throw new Rollback();
            })();
        } catch (err) { if (!(err instanceof Rollback)) throw err; }
    }
    for (const t of NOT_MOVED) {
        if (liveTables.has(t)) report.tables[t] = { live: live.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, not_moved: 'stays in Live (media queue is Live-owned in W6)' };
    }

    if (!opts.dryRun) {
        // Chat's new ids start above Live's highest id plus headroom (never lowered).
        chat.transaction(() => {
            for (const [t] of Object.entries(db.CHAT_TABLES)) {
                if (!liveTables.has(t) || !colsOf(live, t).includes('id')) continue;
                const liveMax = live.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get().m;
                const chatMax = chat.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get().m;
                const target = Math.max(liveMax + opts.headroom, chatMax);
                const cur = chat.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t);
                if (!cur) chat.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(t, target);
                else if (cur.seq < target) chat.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(target, t);
                report.tables[t].next_id = Math.max(target, cur ? cur.seq : 0) + 1;
            }
        })();

        if (opts.projections) {
            const seed = (table, sql, cols) => {
                if (!liveTables.has(sql.table)) return 0;
                const have = new Set(colsOf(live, sql.table));
                const pick = cols.filter((c) => have.has(c.from || c.to));
                const st = chat.prepare(`INSERT INTO ${table} (${pick.map((c) => c.to).join(', ')}, synced_at) VALUES (${pick.map(() => '?').join(', ')}, 0)
                    ON CONFLICT(id) DO NOTHING`);
                let n = 0;
                chat.transaction(() => {
                    for (const row of live.prepare(`SELECT ${pick.map((c) => c.from || c.to).join(', ')} FROM ${sql.table}`).iterate()) {
                        n += st.run(...pick.map((c) => (c.to === 'subject_id' ? (subjects.get(row.id) || null) : row[c.from || c.to]))).changes;
                    }
                })();
                return n;
            };
            const c = (to, from) => ({ to, from });
            report.projections = {
                ctx_users: seed('ctx_users', { table: 'users' }, [c('id'), c('username'), c('display_name'), c('avatar_url'), c('profile_color'), c('role'), c('is_banned'), c('ban_reason'), c('is_owner'), c('created_at'), c('subject_id', 'id')]),
                ctx_streams: seed('ctx_streams', { table: 'streams' }, [c('id'), c('user_id'), c('channel_id'), c('managed_stream_id'), c('title'), c('is_live'), c('started_at'), c('ended_at'), c('created_at')]),
                ctx_managed_streams: seed('ctx_managed_streams', { table: 'managed_streams' }, [c('id'), c('user_id'), c('slug'), c('title'), c('sort_order'), c('created_at')]),
                ctx_channels: seed('ctx_channels', { table: 'channels' }, [c('id'), c('user_id'), c('title')]),
            };
        }
        chat.prepare('INSERT INTO import_runs (live_db, dry_run, counts, finished_at) VALUES (?, 0, ?, CURRENT_TIMESTAMP)').run(report.live_db, JSON.stringify(report.tables));
    }
    report.held_total = chat.prepare('SELECT COUNT(*) AS n FROM import_hold').get().n;
    live.close();
    return report;
}

if (require.main === module) {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
    if (opts.help || !opts.liveDb) {
        console.log('usage: node scripts/import-from-live.js --live-db <snapshot> [--dry-run] [--chat-db <path>] [--headroom <n>] [--tables a,b] [--no-projections]');
        process.exit(opts.help ? 0 : 2);
    }
    try {
        const report = run(opts);
        console.log(JSON.stringify(report, null, 2));
        try { require('../server/db/database').close(); } catch { /* */ }
    } catch (err) {
        console.error(err.message);
        process.exit(err.code === 'SCHEMA_DRIFT' ? 1 : 3);
    }
}

module.exports = { run, parseArgs, IDENTITY, SUBJECT_COLUMNS, LIVE_ONLY_COLUMNS };
