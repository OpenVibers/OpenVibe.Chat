// Loaded with `node --import` into every test process (test/run.js): one migrated database for the process (ADR-035),
// an in-memory PGlite by default or, with OV_TEST_STORE=pg (npm run test:pg), PostgreSQL through PgBouncer with roles
// and a schema of its own (openvibe-sdk/testing createTestDb). server/db/database.js takes it on first use, so test
// files open no database themselves. A Chat the test spawns as its own process (a restart) gets the same database:
// DATABASE_URL/DATABASE_DIRECT_URL of the run's schema, or, on PGlite, this process's instance served over the
// PostgreSQL protocol (openChildDatabase below, with a one-connection pool: PGlite is one session).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createTestDb } = require('openvibe-sdk/testing');
const { createDb } = require('openvibe-sdk/db');

const migrations = path.join(root, 'migrations');
const quiet = { log() {}, info() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };

if ((process.env.OV_TEST_STORE || 'pglite') === 'pg') {
    const t = await createTestDb({ migrations, store: 'pg', service: 'chat', max: 4, log: quiet });
    globalThis.__ovChatTestDb = t.db;
    globalThis.__ovChatTestChildEnv = async () => ({ DATABASE_URL: t.url, DATABASE_DIRECT_URL: t.directUrl });
    // The owner role on a direct connection, for a test that changes the schema (the runtime role is DML only).
    let owner = null;
    globalThis.__ovChatTestOwnerDb = () => (owner ||= createDb({ url: t.directUrl, service: 'chat-test-owner', max: 1, log: quiet }));
    globalThis.__ovChatTestDbClose = async () => { if (owner) await owner.close().catch(() => {}); await t.close(); };
} else {
    const { PGlite } = require('@electric-sql/pglite');
    const { PARSERS } = require('openvibe-sdk/db');
    const parsers = {};
    for (const [oid, fn] of Object.entries(PARSERS)) parsers[oid] = (v) => fn(v);
    const instance = new PGlite(undefined, { parsers });
    const db = createDb({ pglite: instance, service: 'chat-test', log: quiet });
    await db.migrate({ dir: migrations, log: quiet });
    let server = null;
    globalThis.__ovChatTestDb = db;
    globalThis.__ovChatTestOwnerDb = () => db;
    globalThis.__ovChatTestDbClose = async () => { if (server) await server.stop().catch(() => {}); await db.close().catch(() => {}); };
    globalThis.__ovChatTestChildEnv = async () => {
        if (!server) {
            const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
            // Several connections may be open at once (the child's migrator closing as its pool opens); the pool has one.
            server = new PGLiteSocketServer({ db: instance, port: 0, host: '127.0.0.1', maxConnections: 4 });
            await server.start();
        }
        const url = `postgres://postgres:test@127.0.0.1:${server.server.address().port}/postgres`;
        return { DATABASE_URL: url, DATABASE_DIRECT_URL: url, DATABASE_POOL_MAX: '1' };
    };
}
