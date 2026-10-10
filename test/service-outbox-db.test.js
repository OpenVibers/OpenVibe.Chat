'use strict';
/** Chat's SDK outbox joins the ambient transaction and keeps rows while publishing is disabled. */
const assert = require('assert');
const path = require('path');
const { createTestDb } = require('openvibe-sdk/testing');
const { createDb } = require('openvibe-sdk/db');
const { suite } = require('./helpers');
const database = require('../server/db/database');
const serviceOutbox = require('../server/events/service-outbox');

const t = suite('service-outbox-db');
let store;

const event = () => ({
    event_type: 'chat.moderation.action',
    subject: { type: 'moderation_action', id: '1' },
    payload: { action_id: 1, action_type: 'test' },
});

t('configure the SDK outbox with a migrated database', async () => {
    const migrations = path.join(__dirname, '..', 'migrations');
    store = await createTestDb({ migrations, service: 'chat' });
    const owner = store.directUrl ? createDb({ url: store.directUrl, service: 'chat-test-migrate', max: 1 }) : store.db;
    try { await owner.migrate({ dir: migrations, windowDays: 0 }); }
    finally { if (owner !== store.db) await owner.close(); }
    database.setDb(store.db);
    serviceOutbox.configure({ config: {
        events: { url: '', intervalMs: 5000 }, networkInternalUrl: 'http://127.0.0.1:4000',
        oauth: { clientId: 'chat', clientSecret: '' },
    } });
});

t('rolled-back changes leave no event; committed changes leave one', async () => {
    await assert.rejects(store.db.tx(async () => {
        await store.db.query('INSERT INTO chat_meta (key, value) VALUES ($1, $2)', ['outbox-test', 'rolled-back']);
        await serviceOutbox.emit(event());
        throw new Error('abort');
    }), /abort/);
    assert.strictEqual(await store.db.value('SELECT count(*) FROM service_outbox'), 0);
    assert.strictEqual(await store.db.maybe('SELECT value FROM chat_meta WHERE key = $1', ['outbox-test']), null);

    await store.db.tx(async () => {
        await store.db.query('INSERT INTO chat_meta (key, value) VALUES ($1, $2)', ['outbox-test', 'committed']);
        await serviceOutbox.emit(event());
    });
    const rows = await store.db.many('SELECT envelope, sent_at FROM service_outbox');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].envelope.event_type, 'chat.moderation.action');
    assert.deepStrictEqual(rows[0].envelope.actor, { type: 'service', id: 'chat' });
    assert.strictEqual(rows[0].sent_at, null);
    const status = await serviceOutbox.current().status();
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(Number(status.pending), 1);
    await serviceOutbox.current().kick();
    assert.strictEqual((await store.db.maybe('SELECT sent_at FROM service_outbox')).sent_at, null);
});

t.run(async () => {
    serviceOutbox.reset();
    database.setDb(null);
    if (store) await store.close();
});
