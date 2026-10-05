'use strict';
/**
 * Events outbox (events.event-envelope@1, written in the same transaction as the change; relayed
 * to OpenVibe.Events only when EVENTS_URL is set, with a service token for audience
 * openvibe.events).
 */
const assert = require('assert');
const http = require('http');
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
            received.push(...body.events);
            res.statusCode = 201;
            res.end(JSON.stringify({ accepted: body.events.length }));
        });
    });
    eventsPort = await new Promise((r) => events.listen(0, '127.0.0.1', () => r(events.address().port)));
    h = await boot({ env: { EVENTS_URL: `http://127.0.0.1:${eventsPort}`, EVENTS_RELAY_INTERVAL_MS: '3600000' } });
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
    const rows = await h.db.all('SELECT event_type, event, sent_at FROM events_outbox ORDER BY seq');
    assert.deepStrictEqual(rows.map((r) => r.event_type), ['chat.message.created', 'chat.dm.created', 'chat.moderation.action']);
    for (const r of rows) {
        const env = JSON.parse(r.event);
        const v = validate('events.event-envelope@1', env);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(r.sent_at, null);
    }
    const [msg, dm, mod] = rows.map((r) => JSON.parse(r.event));
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

t('Events down: rows wait with the error; back up: published once, marked sent', async () => {
    eventsMode = 'down';
    await h.eventsRelay.flush();
    const waiting = await h.db.all('SELECT attempts, last_error, sent_at FROM events_outbox');
    assert.ok(waiting.every((r) => r.attempts === 1 && /503/.test(r.last_error) && r.sent_at === null));
    eventsMode = 'ok';
    const r = await h.eventsRelay.flush();
    assert.strictEqual(r.sent, 3);
    assert.strictEqual(received.length, 3);
    assert.ok((await h.db.all('SELECT sent_at FROM events_outbox')).every((x) => x.sent_at));
    assert.strictEqual((await h.eventsRelay.flush()).sent, 0, 'nothing twice');
    assert.ok(h.tokenRequests.some((x) => x.audience === 'openvibe.events' && x.scope === 'events.event.publish'));
});

t.run(async () => { if (h) await h.close(); events.close(); });
