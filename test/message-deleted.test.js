'use strict';
/**
 * chat.message.deleted: every way a public-room message is deleted (one message by a moderator or
 * through Live's bridge, a user's / anon's / relay user's history, a time-range purge, the
 * auto-delete sweep) adds one outbox envelope per 500 ids, in the same transaction, carrying only
 * ids and payload.redacts. The relay publishes it after the message's chat.message.created.
 *
 * End to end (when a sibling OpenVibe.Events checkout with redaction is present, or
 * OPENVIBE_EVENTS_DIR points at one): Chat's relay publishes to a real Events, and after the
 * deletion neither anonymous nor signed-in SSE replay, pull or delivery returns the text; the
 * sequence has no hole; only svc:chat can redact Chat's events.
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const nodeHttp = require('http');
const { validate, serviceAuth } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('message-deleted');
const EVENTS_DIR = process.env.OPENVIBE_EVENTS_DIR || path.join(__dirname, '..', '..', 'OpenVibe.Events');
const haveEvents = ['server/index.js', 'server/redaction.js', 'node_modules/better-sqlite3'].every((f) => fs.existsSync(path.join(EVENTS_DIR, f)));
const SECRET = 'my number is 555-0199';
let h, events, eventsPort, admin, alice, streamer, streamId;

/** Outbox chat.message.deleted envelopes after `afterSeq`. */
function deletions(afterSeq = 0) {
    return h.db.all("SELECT seq, event FROM events_outbox WHERE event_type = 'chat.message.deleted' AND seq > ? ORDER BY seq", [afterSeq])
        .map((r) => JSON.parse(r.event));
}
const outboxSeq = () => h.db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM events_outbox').s;
function say(message, over = {}) {
    return Number(h.db.saveChatMessage({ stream_id: null, user_id: null, anon_id: 'anon7', username: 'anon7', message, message_type: 'chat', is_global: 1, ...over }).lastInsertRowid);
}
function assertDeletion(env, ids) {
    const v = validate('events.event-envelope@1', env);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.strictEqual(env.event_type, 'chat.message.deleted');
    assert.strictEqual(env.source, 'chat');
    assert.strictEqual(env.visibility, 'public');
    assert.deepStrictEqual(env.actor, { type: 'service', id: 'chat' }, 'who deleted it is not published');
    assert.deepStrictEqual(env.subject, { type: 'chat_message', id: String(ids[0]) });
    assert.deepStrictEqual(env.payload, { message_ids: ids, redacts: { subject_type: 'chat_message', subject_ids: ids.map(String) } });
}

async function freePort() {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
}

t('boot (a real OpenVibe.Events on a reserved port when one is checked out next to this repo)', async () => {
    eventsPort = await freePort();
    h = await boot({ env: { EVENTS_URL: `http://127.0.0.1:${eventsPort}`, EVENTS_RELAY_INTERVAL_MS: '3600000' } });
    admin = h.addUser('admin', { role: 'admin' });
    alice = h.addUser('alice', { subject: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
    streamer = h.addUser('streamer', { role: 'streamer' });
    streamId = h.addStream(streamer.id, h.addChannel(streamer.id));
    await h.ctx.sync();
    if (haveEvents) {
        const { load } = require(path.join(EVENTS_DIR, 'server', 'config'));
        const { start } = require(path.join(EVENTS_DIR, 'server', 'index'));
        const quiet = { log() {}, warn() {}, error() {} };
        events = await start({
            config: load({ NODE_ENV: 'test', PORT: String(eventsPort), EVENTS_DB_PATH: path.join(h.tmp, 'events.db'), OV_NETWORK_PUBLIC_KEY: h.keys.publicKey, EVENTS_WORKER: 'off' }),
            log: quiet,
        });
    } else {
        console.log(`  (no OpenVibe.Events with redaction at ${EVENTS_DIR}: the end-to-end tests are skipped)`);
    }
});

t('one message deleted (a moderator, or Live’s bridge): one deletion event, ids only', async () => {
    const id = say(SECRET);
    const from = outboxSeq();
    h.db.deleteChatMessage(id, admin.id);
    const [d] = deletions(from);
    assertDeletion(d, [id]);
    assert.ok(!JSON.stringify(d).includes('555-0199') && !JSON.stringify(d).includes('anon7'));
    // Through the bridge, the way Live's /api/mod forwards it.
    const id2 = say('via the bridge');
    const r = await h.http('POST', '/internal/live/calls', { token: h.serviceToken(['chat.live_bridge.write']), body: { boot: 'b1', ops: [{ seq: 1, op: 'db', args: ['deleteChatMessage', id2, admin.id] }] } });
    assert.strictEqual(r.status, 200, r.text);
    assertDeletion(deletions(from).at(-1), [id2]);
    const before = outboxSeq();
    h.db.deleteChatMessage(999999, admin.id);
    assert.strictEqual(outboxSeq(), before, 'nothing announced for a message that does not exist');
});

t('a user’s, an anon’s and a relay user’s history (self-delete, /api/mod purge)', async () => {
    const mine = [say('a1', { user_id: alice.id, anon_id: null, username: 'alice' }), say('a2', { user_id: alice.id, anon_id: null, username: 'alice' })];
    const anon = [say('n1', { anon_id: 'anon99', username: 'anon99' })];
    const relay = [say('r1', { username: '[Twitch] zed', anon_id: null })];
    let from = outboxSeq();
    assert.deepStrictEqual(h.db.deleteUserChatMessages(alice.id, { deletedBy: alice.id }), mine, 'return value unchanged');
    assertDeletion(deletions(from)[0], mine);
    from = outboxSeq();
    assert.deepStrictEqual(h.db.deleteAnonChatMessages('anon99', { deletedBy: null }), anon);
    assertDeletion(deletions(from)[0], anon);
    from = outboxSeq();
    assert.deepStrictEqual(h.db.deleteRelayUserMessages('[Twitch] zed', { deletedBy: admin.id }), relay);
    assertDeletion(deletions(from)[0], relay);
    from = outboxSeq();
    assert.deepStrictEqual(h.db.deleteUserChatMessages(alice.id, { deletedBy: alice.id }), [], 'nothing left');
    assert.deepStrictEqual(deletions(from), [], 'no empty deletion events');
});

t('self-delete over the socket announces what it deleted', async () => {
    const ws = await h.ws({ ip: '198.51.100.77', token: alice.token });
    ws.sendJson({ type: 'join', token: alice.token });
    await ws.next((m) => m.type === 'auth');
    const id = say('from alice', { user_id: alice.id, anon_id: null, username: 'alice' });
    const from = outboxSeq();
    ws.sendJson({ type: 'self-delete-history' });
    const res = await ws.next((m) => m.type === 'self-delete-result');
    assert.strictEqual(res.count, 1);
    assertDeletion(deletions(from)[0], [id]);
    ws.close();
});

t('a time-range purge (REST) and the auto-delete sweep', async () => {
    const inRoom = [say('s1', { stream_id: streamId, is_global: 0 }), say('s2', { stream_id: streamId, is_global: 0 })];
    const global = say('g1');
    let from = outboxSeq();
    const r = await h.http('DELETE', '/api/chat/admin/purge', { token: admin.token, body: { streamId, from: h.sqliteNow(-60000), to: h.sqliteNow(60000) } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.deleted, 2);
    assertDeletion(deletions(from)[0], inRoom);
    assert.ok(!h.db.getChatMessageById(global).is_deleted, 'the other room is untouched');
    // The dashboard sends ISO instants ('…T…Z'); rows keep 'YYYY-MM-DD HH:MM:SS'. Read as TEXT,
    // a same-day range matched nothing. Preview, purge and the log filter read both forms.
    const older = say('s-older', { stream_id: streamId, is_global: 0 });
    h.db.run('UPDATE chat_messages SET timestamp = ? WHERE id = ?', [h.sqliteNow(-10 * 60e3), older]);
    const recent = [say('s3', { stream_id: streamId, is_global: 0 }), say('s4', { stream_id: streamId, is_global: 0 })];
    const range = { streamId, from: new Date(Date.now() - 60e3).toISOString(), to: new Date(Date.now() + 60e3).toISOString() };
    assert.strictEqual((await h.http('POST', '/api/chat/admin/purge/preview', { token: admin.token, body: range })).body.count, 2);
    const logs = await h.http('GET', `/api/chat/admin/logs?streamId=${streamId}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, { token: admin.token });
    assert.deepStrictEqual(logs.body.rows.map((m) => m.id).sort(), [...recent].sort(), 'the log filter reads ISO too');
    from = outboxSeq();
    const iso = await h.http('DELETE', '/api/chat/admin/purge', { token: admin.token, body: range });
    assert.strictEqual(iso.body.deleted, 2, iso.text);
    assertDeletion(deletions(from)[0], recent);
    assert.ok(!h.db.getChatMessageById(older).is_deleted, 'ten minutes ago is outside the range');
    const expiring = say('ephemeral', { auto_delete_at: h.sqliteNow(-1000) });
    from = outboxSeq();
    const swept = h.db.deleteExpiredChatMessages(500);
    assert.deepStrictEqual(swept.map((x) => x.id), [expiring]);
    assertDeletion(deletions(from)[0], [expiring]);
});

t('more than 500 ids: one event per 500, in order', async () => {
    const ids = [];
    h.db.transaction(() => { for (let i = 0; i < 1203; i++) ids.push(say(`bulk ${i}`, { anon_id: 'anon500', username: 'anon500' })); });
    const from = outboxSeq();
    h.db.deleteAnonChatMessages('anon500', { deletedBy: admin.id });
    const d = deletions(from);
    assert.deepStrictEqual(d.map((e) => e.payload.message_ids.length), [500, 500, 203]);
    assert.deepStrictEqual(d.flatMap((e) => e.payload.message_ids), ids);
    for (const e of d) assert.ok(Buffer.byteLength(JSON.stringify(e.payload)) < 64 * 1024, 'fits Events’ payload limit');
});

t('a failed delete leaves no event (same transaction)', async () => {
    const id = say('stays');
    const from = outboxSeq();
    assert.throws(() => h.db.transaction(() => { h.db.deleteChatMessage(id, admin.id); throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(deletions(from), []);
    assert.ok(!h.db.getChatMessageById(id).is_deleted);
});

// ── End to end with OpenVibe.Events ──────────────────────────────

function sse(pathAndQuery, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = nodeHttp.get({ host: '127.0.0.1', port: eventsPort, path: pathAndQuery, headers }, (res) => {
            let body = '';
            const c = {
                status: res.statusCode,
                body: () => body,
                // Complete blocks only; `event: gap` data has no envelope and is left out.
                events: () => body.split('\n\n').slice(0, -1).map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
                    .filter(Boolean).map((l) => JSON.parse(l.slice(6))).filter((m) => m.event),
                async waitFor(pred, ms = 3000) {
                    const until = Date.now() + ms;
                    while (!pred(c)) { if (Date.now() > until) throw new Error(`sse timeout: ${body}`); await h.sleep(20); }
                    return c;
                },
                close: () => req.destroy(),
            };
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            resolve(c);
        });
        req.on('error', reject);
    });
}
const userJwt = (subjectId) => serviceAuth.signServiceToken({
    sub: 57, subject_id: subjectId, role: 'user', iss: h.ISS, aud: ['openvibe.network'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
}, h.keys.privateKey);

let firstSeq, msgId;
t('e2e: the relay publishes the message, then its deletion; replay serves only the tombstone', async () => {
    if (!haveEvents) return;
    h.db.run('UPDATE events_outbox SET sent_at = ? WHERE sent_at IS NULL', [new Date().toISOString()]);   // earlier tests' rows
    msgId = say(SECRET, { user_id: alice.id, anon_id: null, username: 'alice' });
    assert.strictEqual((await h.eventsRelay.flush()).sent, 1);
    firstSeq = events.store.lastSeq();
    const before = await sse(`/realtime/stream?topics=chat.message.*&last_event_id=${firstSeq - 1}`);
    await before.waitFor((c) => c.events().length === 1);
    assert.ok(before.body().includes('555-0199'), 'before the deletion the text is there (the leak)');
    before.close();

    h.db.deleteChatMessage(msgId, admin.id);
    assert.strictEqual((await h.eventsRelay.flush()).sent, 1);
    const views = [
        ['anonymous', {}],
        ['signed in (cookie)', { Cookie: `ov_token=${userJwt('usr_01J9AAAAAAAAAAAAAAAAAAAAAA')}` }],
        ['signed in (Bearer)', { Authorization: `Bearer ${userJwt('usr_01J9BBBBBBBBBBBBBBBBBBBBBB')}` }],
        ['service', { Authorization: `Bearer ${h.serviceToken(['events.event.read'], { aud: 'openvibe.events', sub: 'svc:search' })}` }],
    ];
    for (const [who, headers] of views) {
        const c = await sse(`/realtime/stream?topics=chat.message.*&last_event_id=${firstSeq - 1}`, headers);
        await c.waitFor((x) => x.events().length === 2);
        const [created, deleted] = c.events();
        assert.deepStrictEqual([created.seq, deleted.seq], [firstSeq, firstSeq + 1], `${who}: sequence intact`);
        assert.strictEqual(created.event.event_type, 'chat.message.created');
        assert.strictEqual(created.event.payload.redacted, true, who);
        assert.deepStrictEqual(created.event.subject, { type: 'chat_message', id: String(msgId) });
        assert.strictEqual(deleted.event.event_type, 'chat.message.deleted');
        assert.ok(!c.body().includes('555-0199') && !c.body().includes('usr_01J9AAAAAAAAAAAAAAAAAAAAAA'), `${who}: no text, no author`);
        c.close();
    }
    const pull = await fetch(`http://127.0.0.1:${eventsPort}/api/v1/events?topic=chat.message.*&after_seq=${firstSeq - 1}`, {
        headers: { Authorization: `Bearer ${h.serviceToken(['events.event.read'], { aud: 'openvibe.events', sub: 'svc:search' })}` },
    }).then((r) => r.json());
    assert.deepStrictEqual(pull.events.map((e) => e.seq), [firstSeq, firstSeq + 1]);
    assert.ok(!JSON.stringify(pull).includes('555-0199'));
});

t('e2e: only svc:chat can redact Chat’s events', async () => {
    if (!haveEvents) return;
    const id = say('not yours to delete');
    await h.eventsRelay.flush();
    const created = events.store.scan(0, { patterns: ['chat.message.created'], limit: 1000 }).rows.find((r) => r.subject_id === String(id));
    const env = deletions(0).at(-1);   // a well-formed deletion, re-sourced by another service
    const post = (sub, body) => fetch(`http://127.0.0.1:${eventsPort}/api/v1/events`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.serviceToken(['events.event.publish'], { aud: 'openvibe.events', sub })}` },
    });
    let r = await post('svc:live', { ...env, event_id: 'evt_01J9CCCCCCCCCCCCCCCCCCCCCC', source: 'live', event_type: 'live.chat.deleted', payload: { redacts: { event_ids: [created.id] } } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).code, 'events.redaction_not_allowed');
    r = await post('svc:live', { ...env, event_id: 'evt_01J9DDDDDDDDDDDDDDDDDDDDDD', payload: { redacts: { subject_type: 'chat_message', subject_ids: [String(id)] } } });
    assert.strictEqual(r.status, 403, 'svc:live cannot publish as chat');
    assert.ok(events.store.getEvent(created.id).payload.includes('not yours to delete'), 'still intact');
    h.db.deleteChatMessage(id, admin.id);
    await h.eventsRelay.flush();
    assert.ok(events.store.getEvent(created.id).redacted_at, 'Chat itself can');
});

t.run(async () => { if (events) await events.close(); if (h) await h.close(); });
