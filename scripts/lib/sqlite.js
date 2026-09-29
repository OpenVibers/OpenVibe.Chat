'use strict';
/**
 * Read (or, for a test fixture, write) a SQLite file without better-sqlite3 (plan T3 decision 11: the service no
 * longer depends on it). node:sqlite (Node 22) behind the better-sqlite3 shape the one-time tools use:
 * prepare(sql).all/get/run/iterate, exec, pragma, close — so openvibe-sdk/db importSqlite takes it as its `sqlite`
 * source. BLOBs come back as Buffers, as they did.
 *
 *   const { openSqlite } = require('./lib/sqlite');
 *   const live = openSqlite('/tmp/live-snapshot.db');                 // read-only, must exist
 *   const fixture = openSqlite(file, { readonly: false, create: true });
 */
const fs = require('fs');

let quieted = false;
function quietExperimentalWarning() {
    // node:sqlite prints an ExperimentalWarning on first use in Node 22; the tools' output is their report.
    if (quieted) return;
    quieted = true;
    const emit = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
        if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning && warning.message ? warning.message : warning))) return;
        return emit.call(process, warning, ...rest);
    };
}

function fixRow(row) {
    if (!row) return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v;
    return out;
}

function openSqlite(file, { readonly = true, create = false } = {}) {
    if (!create && !fs.existsSync(file)) throw new Error(`${file}: no such SQLite file`);
    quietExperimentalWarning();
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(file, { readOnly: readonly });
    return {
        name: file,
        prepare(sql) {
            const st = d.prepare(sql);
            return {
                all: (...a) => st.all(...a).map(fixRow),
                get: (...a) => fixRow(st.get(...a)),
                run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
                *iterate(...a) { for (const r of st.iterate(...a)) yield fixRow(r); },
            };
        },
        exec: (sql) => d.exec(sql),
        pragma: (p) => d.exec(`PRAGMA ${p}`),
        close: () => d.close(),
    };
}

module.exports = { openSqlite };
