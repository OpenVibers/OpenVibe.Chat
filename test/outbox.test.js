'use strict';
/**
 * Events outbox (events.event-envelope@1, written in the same transaction as the change; relayed
 * to OpenVibe.Events only when EVENTS_URL is set, with a service token for audience
 * openvibe.events).
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('outbox');
let h, events, eventsPort, alice, bob;
const received = [];
let eventsMode = 'ok';

t('boot with a stub OpenVibe.Events', async () => {
    events = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (eventsMode !== 'ok') { res.statusCode = 503; return res.end('{"error":"down"}'); }
            const { serviceAuth } = require('openvibe-contracts');
            const r = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: h.keys.publicKey, issuer: h.ISS, audience: 'openvibe.events' });
            if (!r.ok || !r.claims.cap.includes('events.event.publish')) { res.statusCode = 401; return res.end('{}'); }
            const body = JSON.parse(raw);
            const batch = Array.isArray(body.events) ? body.events : [body];
            received.push(...batch);
            res.statusCode = 201;
            res.end(JSON.stringify(Array.isArray(body.events) ? { results: batch.map((e, i) => ({ event_id: e.event_id, seq: i + 1 })) } : { event_id: body.event_id, seq: received.length }));
        });
    });
    eventsPort = await new Promise((r) => events.listen(0, '127.0.0.1', () => r(events.address().port)));
    h = await boot({ env: { EVENTS_URL: `http://127.0.0.1:${eventsPort}`, EVENTS_RELAY_INTERVAL_MS: '3600000' } });
    await h.eventsRelay.stop();
    const status = await h.eventsRelay.status();
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(Number(status.pending), 0);
    assert.strictEqual(Number(status.rejected), 0);
    assert.strictEqual(status.last_error, null);
    alice = h.addUser('alice', { subject: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
    bob = h.addUser('bob');
    await h.ctx.sync();
});

t('a REST fallback message, a DM and a moderation action each leave one envelope', async () => {
    const sent = await h.http('POST', '/api/chat/send', { token: alice.token, body: { message: 'rest hello' } });
    assert.deepStrictEqual(sent.body, { ok: true });
    const conv = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id] } });
    await h.http('POST', `/api/dm/conversations/${conv.body.conversation.id}/messages`, { token: alice.token, body: { message: 'dm text' } });
    await h.db.logModerationAction({ scope_type: 'site', actor_user_id: alice.id, target_user_id: bob.id, action_type: 'site_timeout', details: { duration: 60 } });
    const rows = await h.db.all('SELECT envelope, sent_at FROM service_outbox ORDER BY id');
    assert.deepStrictEqual(rows.map((r) => r.envelope.event_type), ['chat.message.created', 'chat.dm.created', 'chat.moderation.action']);
    for (const r of rows) {
        const env = r.envelope;
        const v = validate('events.event-envelope@1', env);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(r.sent_at, null);
    }
    const [msg, dm, mod] = rows.map((r) => r.envelope);
    assert.strictEqual(msg.visibility, 'public');
    assert.deepStrictEqual(msg.payload.room, { type: 'global' });
    assert.strictEqual(msg.payload.text, 'rest hello');
    assert.strictEqual(dm.visibility, 'subject');
    assert.ok(!JSON.stringify(dm).includes('dm text'));
    assert.deepStrictEqual(dm.payload.participants.map((p) => p.user_id).sort(), [alice.id, bob.id].sort());
    assert.strictEqual(mod.visibility, 'internal');
    assert.deepStrictEqual(mod.actor, { type: 'user', id: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
    assert.deepStrictEqual(mod.actor.type, 'user');
    assert.deepStrictEqual(dm.actor, { type: 'user', id: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
});

t('an event and its change roll back together', async () => {
    const before = (await h.db.get('SELECT COUNT(*) AS n FROM service_outbox')).n;
    await assert.rejects(h.db.transaction(async () => {
        await h.db.run('INSERT INTO chat_meta (key, value) VALUES (?, ?)', ['outbox-rollback', 'changed']);
        await require('../server/events/service-outbox').emit({
            event_type: 'chat.moderation.action',
            subject: { type: 'moderation_action', id: 'rollback' },
            payload: { action: 'test' },
        });
        throw new Error('roll back');
    }), /roll back/);
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM service_outbox')).n, before);
    assert.ok(!(await h.db.get('SELECT value FROM chat_meta WHERE key = ?', ['outbox-rollback'])));
});

t('Events down: rows wait with the error; back up: published once, marked sent', async () => {
    eventsMode = 'down';
    await h.eventsRelay.outbox.flush();
    const waiting = await h.db.all('SELECT attempts, last_error, sent_at FROM service_outbox');
    assert.ok(waiting.every((r) => r.attempts >= 1 && r.last_error && r.sent_at === null));
    await h.db.run('UPDATE service_outbox SET next_attempt_at = 0 WHERE sent_at IS NULL');
    eventsMode = 'ok';
    const r = await h.eventsRelay.outbox.flush();
    assert.strictEqual(r.sent, 3);
    assert.strictEqual(received.length, 3);
    assert.ok((await h.db.all('SELECT sent_at FROM service_outbox')).every((x) => x.sent_at));
    assert.strictEqual((await h.eventsRelay.outbox.flush()).sent, 0, 'nothing twice');
    assert.ok(h.tokenRequests.some((x) => x.audience === 'openvibe.events' && x.scope === 'events.event.publish'));
});

t('a pending row copied by the migration is relayed by the SDK', async () => {
    const original = (await h.db.get('SELECT envelope FROM service_outbox ORDER BY id LIMIT 1')).envelope;
    const envelope = { ...original, event_id: ids.newId('event') };
    await h.db.run('INSERT INTO events_outbox (event_id, event_type, event, created_at) VALUES (?, ?, ?, ?)',
        [envelope.event_id, envelope.event_type, JSON.stringify(envelope), envelope.timestamp]);
    // The harness ran the migration as the owner; re-run its copy step, the only DML in it (the runtime role has
    // no CREATE on the CI containers' schema).
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0008_sdk_outbox.sql'), 'utf8');
    await h.db.getDb().query(migration.slice(migration.indexOf('INSERT INTO service_outbox')));
    const copied = await h.db.get('SELECT envelope, created_at FROM service_outbox WHERE event_id = ?', [envelope.event_id]);
    assert.deepStrictEqual(copied.envelope, envelope);
    assert.strictEqual(Number(copied.created_at), Date.parse(envelope.timestamp));
    assert.strictEqual((await h.eventsRelay.outbox.flush()).sent, 1);
    assert.ok(received.some((e) => e.event_id === envelope.event_id));
});

t.run(async () => { if (h) await h.close(); events.close(); });
