'use strict';
/**
 * Loaded with `node -r` into a release booted by test/n-1/service.js (N-1 at record time, N in the
 * test), from that release's directory. With N1_SQL_OUT set, every SQL text the process prepares or
 * executes on the chat database (CHAT_DB_PATH, read when the statement runs) is written there as JSON
 * when it exits.
 */
const fs = require('fs');
const path = require('path');

const out = process.env.N1_SQL_OUT;
if (out) {
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
