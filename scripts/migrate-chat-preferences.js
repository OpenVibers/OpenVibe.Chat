#!/usr/bin/env node
/**
 * Move the chat preferences Live kept (user_preferences.chat_settings) into the OpenVibe.Network user
 * module chat.preferences, which Chat owns. One-off and idempotent; logic in server/prefs/from-live.js.
 *
 *   node scripts/migrate-chat-preferences.js --live-db <live.db>                             # dry run (default)
 *   node scripts/migrate-chat-preferences.js --live-db <live.db> --apply --backup <file>     # write
 *   node scripts/migrate-chat-preferences.js --rollback <file> [--apply]                     # undo a run
 *
 * Options:
 *   --live-db <file>   Live's database (a snapshot is best: sqlite3 live.db ".backup /tmp/live.db"), opened read-only
 *   --apply            write; without it nothing is written and the report says what would be
 *   --backup <file>    required with --apply; must not exist. Written (0600) and read back before any
 *                      write: every record the run will create (none existed before) and its data; the
 *                      revision each creation got is added when the run ends. --rollback takes it.
 *   --rollback <file>  delete the records that run created, each only while still at the revision it
 *                      got (a record the person changed since is kept). Dry run unless --apply.
 *
 * Reads the same environment as the server (.env / /etc/openvibe/chat.env): OV_NETWORK_INTERNAL_URL,
 * OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET. Chat's principal needs network.modules.read and
 * network.modules.write on chat.preferences (Network default grants). Every write goes through Network,
 * which validates it, gives it a revision and emits network.module.updated.
 *
 * Only choices move (a value equal to Live's default is not one): showTimestamps, compactMode, fontSize,
 * showBadges. Prints a JSON report. Exit codes: 0 done (or dry run), 2 refused (bad options), 1 failed.
 */
'use strict';

const fs = require('fs');

function usage(msg, code = msg ? 2 : 0) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/migrate-chat-preferences.js --live-db <live.db> [--apply --backup <file>]\n'
        + '       node scripts/migrate-chat-preferences.js --rollback <file> [--apply]');
    process.exit(code);
}

function parseArgs(argv) {
    const out = { liveDb: null, apply: false, backup: null, rollback: null };
    const value = (i, name) => { const v = argv[i]; if (!v || v.startsWith('--')) usage(`${name} needs a value`); return v; };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--live-db') out.liveDb = value(++i, a);
        else if (a === '--backup') out.backup = value(++i, a);
        else if (a === '--rollback') out.rollback = value(++i, a);
        else if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '-h' || a === '--help') usage();
        else usage(`unknown argument ${a}`);
    }
    if (out.rollback) {
        if (out.liveDb || out.backup) usage('--rollback takes only the backup file (and --apply)');
        if (!fs.existsSync(out.rollback)) usage(`no backup at ${out.rollback}`);
        return out;
    }
    if (!out.liveDb) usage('missing --live-db');
    if (!fs.existsSync(out.liveDb)) usage(`no Live database at ${out.liveDb}`);
    if (out.apply && !out.backup) usage('--apply needs --backup <file>: what the run creates is recorded there first');
    if (out.backup && fs.existsSync(out.backup)) usage(`${out.backup} exists already; pick a new backup file`);
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = require('../server/config');
    if (!config.oauth.clientSecret) usage('OV_OAUTH_CLIENT_SECRET is not set (Chat\'s service principal writes the records)');
    const migration = require('../server/prefs/from-live');
    if (args.rollback) {
        const report = await migration.rollback(args.rollback, { apply: args.apply });
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    const Database = require('better-sqlite3');
    const liveDb = new Database(args.liveDb, { readonly: true, fileMustExist: true });
    let planned;
    try { planned = migration.plan(liveDb); } finally { liveDb.close(); }
    const report = await migration.migrate(planned, { apply: args.apply, backup: args.backup, liveDbPath: args.liveDb, log: (m) => console.error(m) });
    console.log(JSON.stringify(report, null, 2));
    if (!args.apply) console.error('dry run: nothing written (add --apply --backup <file> to write)');
}

main().catch((err) => { console.error(`migrate-chat-preferences failed: ${err.message}`); process.exit(1); });
