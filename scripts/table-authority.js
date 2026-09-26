#!/usr/bin/env node
/**
 * Who writes each staged table (roadmap C-04, docs/staged-tables-cutover.md), from Chat's side.
 *
 *   node scripts/table-authority.js                               → { tables: { t: { authority, rows, mirror_pending } } }
 *   node scripts/table-authority.js set <table> <live|chat> --force
 *
 * The normal way to move a table is Live's handoff (POST /internal/chat-tables/:table on Live), which
 * drains both sides and moves Chat and Live together. `set` changes only Chat's table_authority, for
 * when Live cannot run the handoff (Live down during a rollback); afterwards make Live agree with the
 * same handoff call. Back to 'live' is refused while changes of the table still wait for the Live
 * mirror (scripts/mirror-flush.js sends them). Uses the service's env (CHAT_DB_PATH).
 */
'use strict';

const db = require('../server/db/database');

function status() {
    const tables = {};
    for (const t of Object.keys(db.STAGED_KEYS)) {
        tables[t] = { authority: db.tableAuthority(t), rows: db.get(`SELECT COUNT(*) AS n FROM ${t}`).n, mirror_pending: db.mirrorPending(t) };
    }
    return { tables };
}

function set(table, authority) {
    if (!db.STAGED_KEYS[table]) throw new Error(`${table} is not a staged table (${Object.keys(db.STAGED_KEYS).join(', ')})`);
    if (authority !== 'live' && authority !== 'chat') throw new Error('authority is live or chat');
    const pending = db.mirrorPending(table);
    if (authority === 'live' && pending) throw new Error(`${pending} change(s) to ${table} have not reached Live yet: run scripts/mirror-flush.js first`);
    return { table, before: db.tableAuthority(table), after: db.setTableAuthority(table, authority) };
}

if (require.main === module) {
    const [cmd, table, authority] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const force = process.argv.includes('--force');
    try {
        db.initDb({ captureMirror: false });
        if (!cmd || cmd === 'status') console.log(JSON.stringify(status(), null, 2));
        else if (cmd === 'set') {
            if (!force) throw new Error('set changes Chat alone; the handoff is Live\'s POST /internal/chat-tables/:table. Add --force if Live cannot run it.');
            console.log(JSON.stringify(set(table, authority), null, 2));
        } else throw new Error('usage: table-authority.js [status] | set <table> <live|chat> --force');
        db.close();
    } catch (err) {
        console.error(err.message);
        process.exit(2);
    }
}

module.exports = { status, set };
