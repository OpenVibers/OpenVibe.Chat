'use strict';
/**
 * Events outbox (events.event-envelope@1, written in the same transaction as the change; relayed
 * to OpenVibe.Events only when EVENTS_URL is set, with a service token for audience
 * openvibe.events) and the Live read mirror (every change to Chat's tables copied to Live's
 * tables of the same name; held while Live refuses, drained when it accepts).
 */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('outbox-mirror');
let h, events, eventsPort, alice, bob, streamer, streamId;
const received = [];
let eventsMode = 'ok';

t('boot with the mirror on and a stub OpenVibe.Events', async () => {
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
    h = await boot({ env: { LIVE_MIRROR: '1', LIVE_MIRROR_INTERVAL_MS: '3600000', EVENTS_URL: `http://127.0.0.1:${eventsPort}`, EVENTS_RELAY_INTERVAL_MS: '3600000' } });
    streamer = h.addUser('streamer', { role: 'streamer' });
    alice = h.addUser('alice', { subject: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
    bob = h.addUser('bob');
    streamId = h.addStream(streamer.id, h.addChannel(streamer.id));
    await h.ctx.sync();
});

t('a REST fallback message, a DM and a moderation action each leave one envelope', async () => {
    const sent = await h.http('POST', '/api/chat/send', { token: alice.token, body: { message: 'rest hello' } });
    assert.deepStrictEqual(sent.body, { ok: true });
    const conv = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id] } });
    await h.http('POST', `/api/dm/conversations/${conv.body.conversation.id}/messages`, { token: alice.token, body: { message: 'dm text' } });
    h.db.logModerationAction({ scope_type: 'site', actor_user_id: alice.id, target_user_id: bob.id, action_type: 'site_timeout', details: { duration: 60 } });
    const rows = h.db.all('SELECT event_type, event, sent_at FROM events_outbox ORDER BY seq');
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
    const waiting = h.db.all('SELECT attempts, last_error, sent_at FROM events_outbox');
    assert.ok(waiting.every((r) => r.attempts === 1 && /503/.test(r.last_error) && r.sent_at === null));
    eventsMode = 'ok';
    const r = await h.eventsRelay.flush();
    assert.strictEqual(r.sent, 3);
    assert.strictEqual(received.length, 3);
    assert.ok(h.db.all('SELECT sent_at FROM events_outbox').every((x) => x.sent_at));
    assert.strictEqual((await h.eventsRelay.flush()).sent, 0, 'nothing twice');
    assert.ok(h.tokenRequests.some((x) => x.audience === 'openvibe.events' && x.scope === 'events.event.publish'));
});

t('mirror: every change to Chat’s tables reaches Live, newest state per row', async () => {
    const id = Number(h.db.saveChatMessage({ stream_id: streamId, user_id: bob.id, username: 'Bob', message: 'to be deleted', message_type: 'chat' }).lastInsertRowid);
    h.db.deleteChatMessage(id, streamer.id);
    h.db.recordFirstChat(`user:${bob.id}`, streamer.id);
    await h.mirrorRelay.flush();
    const byTable = (tbl) => h.live.mirror.filter((c) => c.table === tbl);
    const msgChanges = byTable('chat_messages').filter((c) => c.row && c.row.id === id);
    assert.strictEqual(msgChanges.length, 1, 'insert + update collapsed into one upsert');
    assert.strictEqual(msgChanges[0].row.is_deleted, 1);
    assert.strictEqual(msgChanges[0].row.channel_user_id, streamer.id);
    assert.ok(byTable('chat_messages').some((c) => c.row && c.row.message === 'rest hello'));
    assert.ok(byTable('dm_messages').length === 1 && byTable('dm_participants').length === 2 && byTable('dm_conversations').length >= 1);
    assert.ok(byTable('moderation_actions').length === 1);
    assert.deepStrictEqual(byTable('stream_first_chats')[0].row.chatter_key, `user:${bob.id}`);
    assert.strictEqual(h.mirrorRelay.pending(), 0);
    // A delete travels as a delete.
    const dmId = h.db.get('SELECT id FROM dm_messages').id;
    const conv = h.db.get('SELECT conversation_id FROM dm_messages').conversation_id;
    assert.strictEqual((await h.http('DELETE', `/api/dm/conversations/${conv}/messages/${dmId}`, { token: alice.token })).status, 200);
    await h.mirrorRelay.flush();
    assert.deepStrictEqual(h.live.mirror.at(-1), { table: 'dm_messages', op: 'delete', pk: { id: dmId } });
});

t('mirror: Live refusing (not yet CHAT_AUTHORITY=chat) keeps the queue; accepted later', async () => {
    h.live.mirrorStatus = 409;
    h.db.recordRelayUser('twitch', 'Zed');
    const r = await h.mirrorRelay.flush();
    assert.ok(r.pending >= 1 && /409/.test(r.error));
    h.live.mirrorStatus = 200;
    const r2 = await h.mirrorRelay.flush();
    assert.strictEqual(r2.pending, 0);
    assert.deepStrictEqual(h.live.mirror.at(-1).row.username, 'zed');
    assert.ok(h.tokenRequests.some((x) => x.audience === 'openvibe.live' && x.scope === 'live.chat_mirror.write'));
});

t('scripts/mirror-flush.js drains the queue without the service (rollback)', async () => {
    const { spawn } = require('child_process');
    const path = require('path');
    h.live.mirrorStatus = 409;
    h.db.recordRelayUser('twitch', 'Late');
    await h.mirrorRelay.flush();
    assert.ok(h.mirrorRelay.pending() >= 1);
    h.live.mirrorStatus = 200;
    const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'mirror-flush.js')], { env: { ...process.env } });
        let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(JSON.parse(r.out.slice(r.out.indexOf('{'))).pending, 0);
    assert.strictEqual(h.mirrorRelay.pending(), 0);
    assert.strictEqual(h.live.mirror.at(-1).row.username, 'late');
});

t.run(async () => { if (h) await h.close(); events.close(); });
