'use strict';
/**
 * Loaded with `node -r` into a release booted by test/n-1/service.js (N-1 at record time, N in the
 * test), from that release's directory. With N1_SQL_OUT set, every SQL text the process prepares or
 * executes on the chat database is written as PostgreSQL SQL.
 */
const fs = require('fs');

const out = process.env.N1_SQL_OUT;
if (out) {
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
}
