'use strict';
/**
 * Loaded with `node -r` into a release booted by test/n-1/service.js (N-1 at record time, N in the
 * test), from that release's directory. With N1_SQL_OUT set, every SQL text the process prepares or
 * executes on the chat database is written there as JSON when it exits: on a release on SQLite, what
 * better-sqlite3 prepares on CHAT_DB_PATH; on a release on PostgreSQL (openvibe-sdk/db, no better-sqlite3),
 * the statements its handles run, as PostgreSQL received them ($n parameters).
 */
const fs = require('fs');
const path = require('path');

const out = process.env.N1_SQL_OUT;
const onPostgres = out && require('./engine').onPostgres(process.cwd());
if (out && onPostgres) {
    const sdkDb = require(require.resolve('openvibe-sdk/db', { paths: [process.cwd()] }));
    const seen = new Set();
    const createDb = sdkDb.createDb;
    sdkDb.createDb = function (o) {
        const d = createDb(o);
        const query = d.query;
        d.query = (q, values) => {
            try { seen.add(typeof q === 'string' ? q : q.compile().text); } catch { /* */ }
            return query(q, values);
        };
        return d;
    };
    process.on('exit', () => { try { fs.writeFileSync(out, JSON.stringify([...seen])); } catch { /* */ } });
} else if (out) {
    const Database = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'));
    const seen = new Set();
    const note = (db, sql) => {
        try { if (process.env.CHAT_DB_PATH && path.resolve(db.name) === path.resolve(process.env.CHAT_DB_PATH)) seen.add(String(sql)); } catch { /* */ }
    };
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (sql, ...rest) { note(this, sql); return prepare.call(this, sql, ...rest); };
    const exec = Database.prototype.exec;
    Database.prototype.exec = function (sql, ...rest) { note(this, sql); return exec.call(this, sql, ...rest); };
    process.on('exit', () => { try { fs.writeFileSync(out, JSON.stringify([...seen])); } catch { /* */ } });
}
