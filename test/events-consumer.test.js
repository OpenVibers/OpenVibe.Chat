'use strict';
/**
 * OpenVibe.Events → Chat (server/events/consumer.js, subscriptions.js; compatibility register C-84):
 *
 *   - POST /internal/events takes signature v2 only: a bad signature, a timestamp outside ±300 s and a
 *     v1-only delivery are 401; no secret is 503; a forwarded request is 403
 *   - live.release.deployed makes the deploy card exactly as the bridge's deployNotice does; the inbox
 *     makes a redelivered event a no-op (one card)
 *   - a bridge notice and an event for the same head are one card, whichever comes first
 *   - folding as before: a later deploy folds into the last card, a message in a stream room in
 *     between starts a new card; the two paths fold into each other's cards
 *   - network.module.updated drops a cached chat.preferences copy when newer, ignores an older revision
 *   - boot creates the subscriptions once (idempotent), never re-enables a disabled one, and the
 *     secret it hands Events is the one the consumer verifies
 *
 * A stub OpenVibe.Events (below) checks Chat's token (audience openvibe.events,
 * events.subscription.manage) and keeps subscriptions the way Events does (409 on a duplicate).
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, suite } = require('./helpers');

const t = suite('events-consumer');
const SECRET = 'e'.repeat(64);
const OTHER = 'f'.repeat(64);
const ANN = 'usr_01J9ANN0000000000000000AAA';
let h, BRIDGE, streamer, viewer, streamId, prefs;
let seq = 0;
let n = 0;

// ── Stub OpenVibe.Events: subscriptions (token-checked, 409 on a duplicate) and publishing ──
const stubEvents = { subs: [], posts: 0 };
/** Chat's token: audience openvibe.events, events.subscription.manage (null = accepted). */
stubEvents.verify = (req) => {
    if (!h) return { status: 503, code: 'not_ready' };
    const { serviceAuth } = require('openvibe-contracts');
    const auth = String(req.headers.authorization || '');
    const v = auth.startsWith('Bearer ') ? serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: h.keys.publicKey, issuer: h.ISS, audience: 'openvibe.events' }) : { ok: false, code: 'token.missing' };
    if (!v.ok) return { status: 401, code: v.code };
    if (!(v.claims.cap || []).includes('events.subscription.manage')) return { status: 403, code: 'capability.denied' };
    return null;
};
const eventsServer = http.createServer(async (req, res) => {
    const raw = await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s)); });
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://events');
    if (req.method === 'POST' && url.pathname === '/api/v1/events') return send(200, { results: [] });   // the outbox relay
    const bad = stubEvents.verify(req);
    if (bad) return send(bad.status, { code: bad.code });
    let m;
    if (req.method === 'GET' && url.pathname === '/api/v1/subscriptions') {
        return send(200, { subscriptions: stubEvents.subs.map(({ secret, ...s }) => s) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/subscriptions') {
        stubEvents.posts++;
        const b = JSON.parse(raw || '{}');
        const endpoint = new URL(b.endpoint).toString();
        const dup = stubEvents.subs.find((s) => s.topic_pattern === b.topic_pattern && s.endpoint === endpoint);
        if (dup) return send(409, { code: 'events.subscription_exists', subscription_id: dup.id });
        const sub = { id: `sub_${ids.ulid()}`, consumer: 'chat', topic_pattern: b.topic_pattern, endpoint, enabled: true, secret: b.secret };
        stubEvents.subs.push(sub);
        return send(201, { ...sub });
    }
    if (req.method === 'POST' && (m = /^\/api\/v1\/subscriptions\/([^/]+)\/(disable|enable)$/.exec(url.pathname))) {
        const sub = stubEvents.subs.find((s) => s.id === m[1]);
        if (!sub) return send(404, { code: 'events.not_found' });
        sub.enabled = m[2] === 'enable';
        const { secret, ...view } = sub;
        return send(200, view);
    }
    send(404, { code: 'not_found' });
});

const commit = (tag, subject = `change ${tag}`) => ({ hash: tag.repeat(40).slice(0, 40), short: tag.repeat(7).slice(0, 7), date: '2026-09-23T10:00:00Z', subject });
/** A live.release.deployed envelope as Live's server/events/release-events.js builds it. */
function release(commits, { eventId = ids.newId('event'), deployedAt = new Date().toISOString() } = {}) {
    const head = commits[0].hash;
    return {
        event_id: eventId, event_type: 'live.release.deployed', version: 1, source: 'live',
        actor: { type: 'service', id: 'live' }, timestamp: deployedAt, priority: 'low', visibility: 'internal',
        subject: { type: 'release', id: head },
        payload: {
            service: 'live', release: commits[0].short, commit: head, previous: null, commit_count: commits.length,
            commits: commits.map((c) => ({ hash: c.hash, short: c.short, subject: c.subject, date: c.date })),
            deployed_at: deployedAt, notes_url: 'https://openvibe.live/updates',
        },
    };
}
function moduleUpdated(revision, { namespace = 'chat.preferences', owner = ANN, source = 'network', eventId = ids.newId('event') } = {}) {
    return {
        event_id: eventId, event_type: 'network.module.updated', version: 1, source, actor: { type: 'user', id: owner },
        timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal',
        subject: { type: 'user_module', id: `${owner}:${namespace}`, revision },
        payload: { owner: { type: 'user', id: owner }, namespace, namespace_owner: 'chat', schema_version: 1, revision, change: 'updated', reason: 'write', keys: ['timestamps'] },
    };
}

/** POST a delivery the way Events does (all three signature headers), or with changes. */
function deliver(event, { secret = SECRET, now = Date.now(), headers = {}, strip = [] } = {}) {
    const raw = JSON.stringify({ event, seq: ++seq });
    const signed = signDeliveryHeaders(raw, secret, { now });
    for (const k of strip) delete signed[k];
    return h.http('POST', '/internal/events', { raw, headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Event-Id': event.event_id, ...signed, ...headers } });
}
const bridge = (commits) => h.http('POST', '/internal/live/calls', { token: BRIDGE, body: { boot: 'live-boot-1', ops: [{ seq: ++n, op: 'deployNotice', args: [commits] }] } });
const cards = () => h.db.all("SELECT id, metadata FROM chat_messages WHERE message_type = 'system' AND metadata LIKE '%\"kind\":\"deploy\"%' ORDER BY id").map((r) => ({ id: r.id, ...JSON.parse(r.metadata) }));
const card = (id) => cards().find((c) => c.id === id);
const speak = (text) => h.db.saveChatMessage({ stream_id: streamId, user_id: viewer.id, username: viewer.username, message: text, message_type: 'chat', is_global: false });
const releaseRow = (head) => h.db.get('SELECT * FROM deploy_releases WHERE head = ?', [head]);

t('boot with the consumer on and a stub Events', async () => {
    const eventsPort = await new Promise((r) => eventsServer.listen(0, '127.0.0.1', () => r(eventsServer.address().port)));
    h = await boot({ env: { CHAT_EVENTS_SECRET: `${SECRET}, short-is-ignored`, EVENTS_URL: `http://127.0.0.1:${eventsPort}`, CHAT_PREFS_TTL_MS: '60000' } });
    BRIDGE = h.serviceToken(['chat.live_bridge.write', 'chat.message.send']);
    streamer = h.addUser('streamer', { role: 'streamer' });
    viewer = h.addUser('viewer');
    streamId = h.addStream(streamer.id, h.addChannel(streamer.id));
    await h.ctx.sync();
    prefs = require('../server/prefs/chat-preferences');
});

t('boot created one subscription per topic, to /internal/events, with the consumer’s secret', async () => {
    const results = await h.subscriptions.done;
    assert.deepStrictEqual(results.map((r) => [r.topic, r.result]), [['live.release.deployed', 'created'], ['network.module.updated', 'created'], ['network.user.token_valid_after', 'created'], ['vip.membership.changed', 'created']]);
    assert.strictEqual(stubEvents.subs.length, 4);
    for (const s of stubEvents.subs) {
        assert.strictEqual(s.endpoint, `http://127.0.0.1:${h.port}/internal/events`);
        assert.strictEqual(s.secret, SECRET, 'the first CHAT_EVENTS_SECRET is handed to Events');
    }
    const tok = h.tokenRequests.find((x) => x.audience === 'openvibe.events');
    assert.deepStrictEqual(tok, { audience: 'openvibe.events', scope: 'events.subscription.manage', client: 'chat' });
});

t('a second boot changes nothing, and never re-enables a subscription an operator disabled', async () => {
    const config = require('../server/config');
    const subs = require('../server/events/subscriptions');
    const endpoint = subs.endpointFor(config, h.port);
    const posts = stubEvents.posts;
    let r = await subs.ensure({ config, endpoint });
    assert.deepStrictEqual(r.map((x) => x.result), ['exists', 'exists', 'exists', 'exists']);
    assert.strictEqual(stubEvents.posts, posts, 'nothing was created again');
    r = await subs.ensure({ config, endpoint, action: 'disable', topics: ['live.release.deployed'] });
    assert.deepStrictEqual(r.map((x) => [x.result, x.enabled]), [['disabled', false]]);
    r = await subs.ensure({ config, endpoint });
    assert.deepStrictEqual(r.map((x) => [x.topic, x.result, x.enabled]), [['live.release.deployed', 'exists', false], ['network.module.updated', 'exists', true], ['network.user.token_valid_after', 'exists', true], ['vip.membership.changed', 'exists', true]]);
    assert.strictEqual(stubEvents.subs[0].enabled, false, 'still disabled');
    r = await subs.ensure({ config, endpoint, action: 'enable', topics: ['live.release.deployed'] });
    assert.strictEqual(stubEvents.subs[0].enabled, true);
    r = await subs.ensure({ config, endpoint, action: 'list' });
    assert.deepStrictEqual(r.map((x) => x.result), ['exists', 'exists', 'exists', 'exists']);
});

t('signature v2 only: bad signature, stale or future timestamp, v1-only, unsigned → 401', async () => {
    const ev = release([commit('0')]);
    let r = await deliver(ev, { secret: OTHER });
    assert.strictEqual(r.status, 401, r.text);
    assert.strictEqual(r.body.code, 'chat.bad_signature');
    r = await deliver(ev, { now: Date.now() - 6 * 60 * 1000 });
    assert.strictEqual(r.status, 401, 'a timestamp older than 300 s is refused (a replayed capture)');
    r = await deliver(ev, { now: Date.now() + 6 * 60 * 1000 });
    assert.strictEqual(r.status, 401, 'and one from the future');
    r = await deliver(ev, { strip: ['X-OpenVibe-Signature-V2'] });
    assert.strictEqual(r.status, 401, 'v1 alone is not enough');
    r = await h.http('POST', '/internal/events', { raw: JSON.stringify({ event: ev, seq: 1 }), headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(r.status, 401);
    // A v2 header that names another time than X-OpenVibe-Timestamp.
    r = await deliver(ev, { headers: { 'X-OpenVibe-Timestamp': String(Math.floor(Date.now() / 1000) - 5) } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(cards().length, 0, 'nothing was applied');
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM chat_event_inbox').n, 0);
    // Signed but not an envelope.
    r = await deliver({ event_type: 'live.release.deployed' });
    assert.strictEqual(r.status, 400);
    // Through nginx: refused whatever it carries.
    r = await deliver(ev, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    assert.strictEqual(r.status, 403);
    // A timestamp within the window verifies.
    r = await deliver(release([commit('8')]), { now: Date.now() - 200 * 1000 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.outcome, 'announced');
});

t('no CHAT_EVENTS_SECRET: the route answers 503', async () => {
    const express = require('express');
    const { createEventsConsumer } = require('../server/events/consumer');
    const off = createEventsConsumer({ chatServer: h.chatServer, secrets: ['too-short'] });
    assert.strictEqual(off.enabled, false);
    const app = express();
    app.use('/internal/events', off.router);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const raw = JSON.stringify({ event: release([commit('9')]), seq: 1 });
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/internal/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(raw, 'too-short') }, body: raw });
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).code, 'chat.webhook_disabled');
    srv.close();
});

t('live.release.deployed makes the deploy card; the same event again is one card (inbox)', async () => {
    speak('before the first card');
    const ev = release([commit('a', 'events: first'), commit('b', 'events: second')]);
    let r = await deliver(ev);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.duplicate, r.body.outcome], [false, 'announced']);
    const id = r.body.detail.message_id;
    const c = card(id);
    assert.deepStrictEqual(c.commits.map((x) => x.subject), ['events: first', 'events: second']);
    assert.strictEqual(c.deploys, 1);
    const row = h.db.getChatMessageById(id);
    assert.strictEqual(row.message_type, 'system');
    assert.strictEqual(row.is_global, 1);
    assert.strictEqual(row.username, 'OpenVibe.Live');
    assert.strictEqual(row.message, '🚀 2 updates shipped: events: first · events: second');
    const before = cards().length;
    r = await deliver(ev);                              // Events redelivers (a lost acknowledgement)
    assert.deepStrictEqual([r.status, r.body.duplicate, r.body.outcome], [200, true, null]);
    r = await deliver(ev, { now: Date.now() + 1000 });   // a later attempt, new signature
    assert.strictEqual(r.body.duplicate, true);
    assert.strictEqual(cards().length, before, 'still one card');
    assert.strictEqual(card(id).deploys, 1, 'not folded into itself');
    // Late joiners get this announcement once, keyed by the row id (as with the bridge).
    const late = await h.ws({ ip: '198.51.100.70' });
    late.sendJson({ type: 'join' });
    const upd = await late.next((m) => m.type === 'update' && m.kind === 'deploy', 4000);
    assert.strictEqual(upd.id, id);
    assert.deepStrictEqual(upd.fresh, [commit('a').hash, commit('b').hash]);
    late.close();
    const rel = releaseRow(commit('a').hash);
    assert.deepStrictEqual([rel.first_via, rel.message_id, rel.event_id, rel.bridge_at], ['events', id, ev.event_id, null]);
});

t('bridge first, then the event for the same head: one card', async () => {
    speak('a stream message, so the next deploy is a new card');
    const commits = [commit('c', 'bridge: head'), commit('d', 'bridge: parent')];
    const b = await bridge(commits);
    const id = b.body.results[0].result.id;
    assert.strictEqual(b.body.results[0].result.announced, 2);
    const before = cards().length;
    const r = await deliver(release(commits));
    assert.deepStrictEqual([r.status, r.body.duplicate, r.body.outcome], [200, false, 'duplicate:release']);
    assert.strictEqual(r.body.detail.message_id, id);
    assert.strictEqual(cards().length, before, 'no second card');
    assert.strictEqual(card(id).deploys, 1, 'the card was not folded again');
    const rel = releaseRow(commits[0].hash);
    assert.strictEqual(rel.first_via, 'bridge');
    assert.ok(rel.bridge_at && rel.event_at, 'both paths are recorded as having delivered it');
});

t('the event first, then the bridge for the same head: one card', async () => {
    speak('another stream message');
    const commits = [commit('e', 'event: head')];
    const r = await deliver(release(commits));
    assert.strictEqual(r.body.outcome, 'announced');
    const id = r.body.detail.message_id;
    const before = cards().length;
    const b = await bridge(commits);
    assert.deepStrictEqual(b.body.results[0].result, { announced: 0, id, duplicate: true });
    // A retried bridge op (Live's durable queue after a lost response) is the same.
    const again = await bridge(commits);
    assert.strictEqual(again.body.results[0].result.duplicate, true);
    assert.strictEqual(cards().length, before);
    assert.strictEqual(card(id).deploys, 1);
    const rel = releaseRow(commits[0].hash);
    assert.deepStrictEqual([rel.first_via, !!rel.event_at, !!rel.bridge_at], ['events', true, true]);
});

t('folding as before: the next deploy folds into the last card; a stream message in between starts a new card', async () => {
    speak('new card next');
    let r = await deliver(release([commit('1', 'fold: one')]));
    const first = r.body.detail.message_id;
    assert.strictEqual(r.body.outcome, 'announced');
    // Nobody spoke: the next deploy (from either path) folds into that card.
    const b = await bridge([commit('2', 'fold: two')]);
    assert.strictEqual(b.body.results[0].result.id, first, 'the bridge folds into the card the event made');
    r = await deliver(release([commit('3', 'fold: three')]));
    assert.deepStrictEqual([r.body.outcome, r.body.detail.message_id], ['folded', first]);
    assert.strictEqual(card(first).deploys, 3);
    assert.deepStrictEqual(card(first).commits.map((c) => c.subject), ['fold: three', 'fold: two', 'fold: one']);
    r = await deliver(release([commit('2', 'fold: two')]));
    assert.strictEqual(r.body.outcome, 'duplicate:release', 'the bridge already announced that head');
    assert.strictEqual(card(first).deploys, 3);
    // Someone speaks in a stream room (the global feed shows it): the next deploy is a new card.
    speak('hello brother');
    r = await deliver(release([commit('4', 'fold: four')]));
    assert.strictEqual(r.body.outcome, 'announced');
    const next = r.body.detail.message_id;
    assert.notStrictEqual(next, first);
    assert.strictEqual(card(next).deploys, 1);
    assert.strictEqual(card(first).deploys, 3, 'the old card is left as it was');
});

t('what a release event must be: from Live, a release subject, commits, not stale', async () => {
    const before = cards().length;
    const ev = release([commit('5')]);
    let r = await deliver({ ...ev, event_id: ids.newId('event'), source: 'media' });
    assert.strictEqual(r.body.outcome, 'ignored:source');
    r = await deliver({ ...ev, event_id: ids.newId('event'), subject: { type: 'release', id: 'not-a-sha' } });
    assert.strictEqual(r.body.outcome, 'ignored:subject');
    r = await deliver({ ...ev, event_id: ids.newId('event'), payload: { ...ev.payload, commits: [] } });
    assert.strictEqual(r.body.outcome, 'ignored:payload');
    r = await deliver(release([commit('6')], { deployedAt: new Date(Date.now() - 7 * 3600e3).toISOString() }));
    assert.strictEqual(r.body.outcome, 'ignored:stale', 'an operator replay of an old deploy says nothing');
    r = await deliver({ ...ev, event_id: ids.newId('event'), event_type: 'live.stream.started' });
    assert.strictEqual(r.body.outcome, 'ignored:type');
    assert.strictEqual(cards().length, before);
    assert.strictEqual(releaseRow(commit('6').hash), undefined);
});

t('network.module.updated drops a cached chat.preferences copy when newer; an older revision is ignored', async () => {
    const ann = h.addUser('ann', { subject: ANN });
    h.netModules.subjects.add(ANN);
    h.netModules.set('chat.preferences', ANN, { timestamps: true });                  // revision 1
    h.netModules.set('chat.preferences', ANN, { timestamps: true, compact: true });   // revision 2
    let g = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.deepStrictEqual([g.status, g.body.revision], [200, 2], g.text);
    // Changed at Network directly (the account page): Chat still serves its cached copy...
    h.netModules.set('chat.preferences', ANN, { timestamps: false, compact: true }); // revision 3
    g = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.strictEqual(g.body.revision, 2, 'cached for CHAT_PREFS_TTL_MS');
    // ...an older or equal revision (a late or reordered delivery, or Chat's own write) changes nothing...
    let r = await deliver(moduleUpdated(1));
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'unchanged']);
    r = await deliver(moduleUpdated(2));
    assert.strictEqual(r.body.outcome, 'unchanged');
    assert.strictEqual(prefs._cached(ANN).revision, 2);
    // ...other namespaces and other sources are acknowledged and not recorded...
    const inbox = h.db.get('SELECT COUNT(*) AS n FROM chat_event_inbox').n;
    r = await deliver(moduleUpdated(9, { namespace: 'tools.usage' }));
    assert.strictEqual(r.body.outcome, 'ignored:namespace');
    r = await deliver(moduleUpdated(9, { source: 'live' }));
    assert.strictEqual(r.body.outcome, 'ignored:source');
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM chat_event_inbox').n, inbox);
    assert.strictEqual(prefs._cached(ANN).revision, 2);
    // ...and the newer revision drops it at once: the next read is Network's.
    const ev = moduleUpdated(3);
    r = await deliver(ev);
    assert.strictEqual(r.body.outcome, 'invalidated');
    assert.strictEqual(prefs._cached(ANN), null);
    g = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.deepStrictEqual([g.body.revision, g.body.preferences], [3, { timestamps: false, compact: true }]);
    r = await deliver(ev);
    assert.strictEqual(r.body.duplicate, true, 'a redelivery is a no-op');
    assert.strictEqual(prefs._cached(ANN).revision, 3);
});

t('vip.membership.changed from VIP drops the cached badge answers at once; from anyone else it is ignored', async () => {
    const vipBadges = require('../server/vip/badges');
    const calls = [];
    const orig = vipBadges.handleEvent;
    vipBadges.handleEvent = (e) => { calls.push(e.event_id); return true; };
    try {
        const ev = (source) => ({
            event_id: ids.newId('event'), event_type: 'vip.membership.changed', version: 1, source, actor: { type: 'service', id: 'vip' },
            timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal', subject: { type: 'membership', id: 'mbr_1', revision: 2 },
            payload: { member: { type: 'user', id: ANN }, creator: { type: 'user', id: ANN }, status: 'canceled' },
        });
        const good = ev('vip');
        let r = await deliver(good);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.outcome, 'invalidated');
        assert.deepStrictEqual(calls, [good.event_id]);
        r = await deliver(ev('live'));
        assert.strictEqual(r.body.outcome, 'ignored:source');
        assert.strictEqual(calls.length, 1, 'only VIP speaks for memberships');
    } finally { vipBadges.handleEvent = orig; }
});

t('an event delivered with the secret the subscription holds verifies; /ready reports the consumer', async () => {
    const sub = stubEvents.subs.find((s) => s.topic_pattern === 'live.release.deployed');
    speak('end-to-end next');
    const r = await deliver(release([commit('7', 'through the subscription')]), { secret: sub.secret, headers: { 'X-OpenVibe-Subscription-Id': sub.id } });
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'announced']);
    const ready = await h.http('GET', '/ready');
    const c = ready.body.events.consumer;
    assert.strictEqual(c.enabled, true);
    assert.ok(c.received >= 10 && c.applied >= 5 && c.duplicates >= 3 && c.refused >= 6, JSON.stringify(c));
    assert.strictEqual(c.last_type, 'live.release.deployed');
    assert.strictEqual(c.last_outcome, 'announced');
});

t('inbox receipts older than Events’ retention are pruned', async () => {
    h.db.run("INSERT INTO chat_event_inbox (consumer, event_id, processed_at) VALUES ('chat', 'evt_OLD', ?)", [Date.now() - 40 * 86400e3]);
    const kept = h.db.get('SELECT COUNT(*) AS n FROM chat_event_inbox').n - 1;
    assert.strictEqual(h.eventsConsumer.prune(), 1);
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM chat_event_inbox').n, kept);
});

t.run(async () => { if (h) await h.close(); eventsServer.close(); });
