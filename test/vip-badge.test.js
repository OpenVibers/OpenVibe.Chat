'use strict';
/**
 * The VIP member badge (roadmap Wave 10): a member's messages in a creator's room carry the
 * creator's VIP badge — a perk of the member's plan version bound to `chat badge` — resolved through
 * VIP's entitlement check (product 'chat') behind the shared product cache.
 *
 *   - sending never waits on VIP (a slow VIP: the message goes out at once, the badge follows as
 *     a chat_vip_badge frame for that id and lands in the row's metadata)
 *   - fail closed: VIP down, not a member, badge turned off, no chat binding → no badge
 *   - convergence: once VIP stops granting, the badge stops within config.vip.ttlMs (60 s; Chat has
 *     no Events inbox), and at once when handleEvent gets vip.membership.changed
 *
 * A stub OpenVibe.VIP answers /api/v1/entitlements/check from a table and checks the service token
 * (audience openvibe.vip, vip.entitlement.check).
 */
const assert = require('assert');
const http = require('http');
const { serviceAuth } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vip-badge');
const CREATOR = 'usr_01J9CREAT0R0000000000000AA';
const MEMBER = 'usr_01J9MEMBER0000000000000AAA';
const SLOWPOKE = 'usr_01J9S10WP0KE000000000000AA';
const STRANGER = 'usr_01J9STRANGER00000000000AAA';
const SHY = 'usr_01J9SHY0000000000000000AAA';
const PLAIN = 'usr_01J9P1A1N00000000000000AAA';

let h, badges, vip, streamer, member, slowpoke, stranger, shy, plain, streamId;
const clock = { t: Date.now(), now() { return clock.t; } };

/** An entitlement answer as VIP gives it with product 'chat'. */
const active = (perks, { showBadge = true } = {}) => ({
    status: 'active', active: true, expires_at: new Date(Date.now() + 30 * 86400e3).toISOString(), valid_until: new Date(Date.now() + 30 * 86400e3).toISOString(),
    source: 'projection', stale: false, product: 'chat', product_perks: perks, preferences: { show_badge: showBadge, listed: false },
});
const subscriberPerk = { key: 'subscriber-badge', name: 'Subscriber badge', kind: 'badge', scope: 'network', bindings: [{ binding: 'badge', config: { badge: 'subscriber' } }] };
const inactive = { status: 'inactive', active: false, expires_at: null, product: 'chat', product_perks: [], preferences: { show_badge: true, listed: false } };

async function startVip(keyOf) {
    const state = { answers: new Map(), calls: [], down: false, hold: new Map(), badTokens: 0 };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
            if (state.down) { req.socket.destroy(); return; }
            const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
            const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: keyOf(), issuer: 'https://openvibe.network', audience: 'openvibe.vip' });
            if (!v.ok) { state.badTokens++; return send(401, { code: v.code }); }
            if (!(v.claims.cap || []).includes('vip.entitlement.check')) return send(403, { code: 'capability.denied' });
            if (req.url !== '/api/v1/entitlements/check' || req.method !== 'POST') return send(404, { code: 'not_found' });
            const b = JSON.parse(raw || '{}');
            state.calls.push(b);
            const hold = state.hold.get(b.subject);
            if (hold) await hold;
            send(200, { member: { type: 'user', id: b.subject }, creator: { type: 'user', id: b.creator }, ...(state.answers.get(`${b.subject}|${b.creator}`) || inactive) });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { state, server, url: `http://127.0.0.1:${server.address().port}` };
}

const callsFor = (subject) => vip.state.calls.filter((c) => c.subject === subject).length;
async function until(pred, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
async function joinRoom(user, ip) {
    const ws = await h.ws({ ip, token: user.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: user.token });
    await ws.next((m) => m.type === 'auth');
    return ws;
}
let seq = 0;
async function say(ws, watcher) {
    const text = `vip line ${++seq}`;
    const started = Date.now();
    ws.sendJson({ type: 'chat', message: text });
    const got = await watcher.next((m) => m.type === 'chat' && m.message === text);
    return { msg: got, ms: Date.now() - started };
}

t('boot with a stub VIP', async () => {
    vip = await startVip(() => h.keys.publicKey);
    h = await boot({ env: { OV_VIP_INTERNAL_URL: vip.url, CHAT_VIP_BADGE_TTL_MS: '60000', CHAT_VIP_BADGE_DENY_TTL_MS: '30000', CHAT_VIP_BADGE_UNAVAILABLE_TTL_MS: '5000' } });
    badges = require('../server/vip/badges');
    badges._configure({ now: () => clock.now() });
    assert.ok(badges.enabled());
    h.chatServer.DEFAULT_RATE_LIMIT_MS = 0;                      // many lines per test, same senders

    streamer = h.addUser('streamer', { role: 'streamer', subject: CREATOR });
    member = h.addUser('member', { subject: MEMBER });
    slowpoke = h.addUser('slowpoke', { subject: SLOWPOKE });
    stranger = h.addUser('stranger', { subject: STRANGER });
    shy = h.addUser('shy', { subject: SHY });
    plain = h.addUser('plain', { subject: PLAIN });
    const ch = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, ch);
    vip.state.answers.set(`${MEMBER}|${CREATOR}`, active([subscriberPerk]));
    vip.state.answers.set(`${SLOWPOKE}|${CREATOR}`, active([{ ...subscriberPerk, bindings: [{ binding: 'badge', config: { badge: 'Bad Id!', label: '<b>Crew</b>\u0007' } }] }]));
    vip.state.answers.set(`${SHY}|${CREATOR}`, active([subscriberPerk], { showBadge: false }));
    vip.state.answers.set(`${PLAIN}|${CREATOR}`, active([{ key: 'backstage', name: 'Backstage', kind: 'gated_content', scope: 'creator', bindings: [{ binding: 'gated_post', config: {} }] }]));
});

let memberWs, watcher;
t('a member\'s message carries the creator\'s badge (looked up at join, so the first line has it), persisted in metadata', async () => {
    watcher = await joinRoom(stranger, '198.51.100.41');
    memberWs = await joinRoom(member, '198.51.100.40');
    await until(() => callsFor(MEMBER) >= 1);
    const call = vip.state.calls.find((c) => c.subject === MEMBER);
    assert.deepStrictEqual([call.creator, call.product], [CREATOR, 'chat']);
    await new Promise((r) => setTimeout(r, 50));
    const { msg } = await say(memberWs, watcher);
    assert.deepStrictEqual(msg.vip_badge, { creator: CREATOR, perk: 'subscriber-badge', name: 'Subscriber badge', badge: 'subscriber' });
    const row = h.db.getChatMessageById(msg.id);
    assert.deepStrictEqual(JSON.parse(row.metadata).vip_badge, msg.vip_badge);
    assert.ok(h.tokenRequests.some((r) => r.audience === 'openvibe.vip' && r.scope === 'vip.entitlement.check'), 'Chat asked the Network for a VIP token');
    const before = callsFor(MEMBER);
    await say(memberWs, watcher);
    assert.strictEqual(callsFor(MEMBER), before, 'the second message comes from the cache');
});

t('fail closed: not a member, badge turned off, no chat binding → no badge; the creator\'s own lines never ask VIP', async () => {
    for (const [u, ip, subject] of [[stranger, null, STRANGER], [shy, '198.51.100.43', SHY], [plain, '198.51.100.44', PLAIN]]) {
        const ws = ip ? await joinRoom(u, ip) : watcher;
        await until(() => callsFor(subject) >= 1);
        await new Promise((r) => setTimeout(r, 30));
        const { msg } = await say(ws, memberWs);
        assert.strictEqual(msg.vip_badge, undefined, `${u.username}: no badge`);
    }
    const own = await joinRoom(streamer, '198.51.100.45');
    const { msg } = await say(own, watcher);
    assert.strictEqual(msg.vip_badge, undefined);
    assert.strictEqual(vip.state.calls.filter((c) => c.subject === CREATOR).length, 0);
});

t('sending never waits on VIP: a slow lookup sends at once, the badge follows as chat_vip_badge and lands in metadata', async () => {
    let release;
    vip.state.hold.set(SLOWPOKE, new Promise((r) => { release = r; }));
    const ws = await joinRoom(slowpoke, '198.51.100.46');
    await until(() => callsFor(SLOWPOKE) >= 1);
    const { msg, ms } = await say(ws, watcher);
    assert.strictEqual(msg.vip_badge, undefined, 'sent before VIP answered');
    assert.ok(ms < 1000, `delivered in ${ms} ms while VIP was holding`);
    release();
    vip.state.hold.delete(SLOWPOKE);
    const follow = await watcher.next((m) => m.type === 'chat_vip_badge' && m.id === msg.id);
    // Creator-written binding config is cleaned: an unknown badge id becomes "member", the label is plain text.
    assert.deepStrictEqual(follow.vip_badge, { creator: CREATOR, perk: 'subscriber-badge', name: 'Subscriber badge', badge: 'member', label: 'bCrew/b' });
    await until(() => { const r = h.db.getChatMessageById(msg.id); return r.metadata && JSON.parse(r.metadata).vip_badge; });
    const next = await say(ws, watcher);
    assert.strictEqual(next.msg.vip_badge.badge, 'member', 'cached from then on');
});

t('VIP down: messages flow, without a badge', async () => {
    vip.state.down = true;
    try {
        clock.t += 61_000;                                        // every cached answer is stale
        const { msg, ms } = await say(memberWs, watcher);
        assert.strictEqual(msg.vip_badge, undefined);
        assert.ok(ms < 1000);
        await new Promise((r) => setTimeout(r, 200));
        const again = await say(memberWs, watcher);
        assert.strictEqual(again.msg.vip_badge, undefined, 'the failure is cached briefly, never as a badge');
    } finally { vip.state.down = false; }
    clock.t += 5_001;
    const warmUp = await say(memberWs, watcher);                    // miss → lookup → follow-up frame
    await watcher.next((m) => m.type === 'chat_vip_badge' && m.id === warmUp.msg.id);
    assert.strictEqual((await say(memberWs, watcher)).msg.vip_badge.badge, 'subscriber');
});

t('convergence: VIP stops granting → the badge stops within ttlMs (60 s); vip.membership.changed stops it at once', async () => {
    assert.deepStrictEqual(badges.bounds, { grantMs: 60_000, denyMs: 30_000, unavailableMs: 5_000 });
    // VIP applied a refund (billing.entitlement.changed) and emitted vip.membership.changed; Chat did not get it.
    vip.state.answers.set(`${MEMBER}|${CREATOR}`, inactive);
    clock.t += 59_000;
    assert.strictEqual((await say(memberWs, watcher)).msg.vip_badge.badge, 'subscriber', 'inside the bound the cached badge may still show');
    clock.t += 1_001;
    const past = await say(memberWs, watcher);
    assert.strictEqual(past.msg.vip_badge, undefined, 'past ttlMs: no badge');
    await until(() => vip.state.calls.filter((c) => c.subject === MEMBER).length >= 3);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!watcher.all.some((m) => m.type === 'chat_vip_badge' && m.id === past.msg.id), 'no follow-up badge either');
    assert.strictEqual((await say(memberWs, watcher)).msg.vip_badge, undefined);

    // The member rejoins; the badge is cached again. Then the event reaches Chat: gone at once.
    vip.state.answers.set(`${MEMBER}|${CREATOR}`, active([subscriberPerk]));
    clock.t += 30_001;
    const back = await say(memberWs, watcher);
    await watcher.next((m) => m.type === 'chat_vip_badge' && m.id === back.msg.id);
    assert.strictEqual((await say(memberWs, watcher)).msg.vip_badge.badge, 'subscriber');
    vip.state.answers.set(`${MEMBER}|${CREATOR}`, inactive);
    assert.strictEqual(badges.handleEvent({ event_type: 'vip.membership.changed', payload: { member: { type: 'user', id: MEMBER }, creator: { type: 'user', id: CREATOR }, active: false } }), true);
    assert.strictEqual((await say(memberWs, watcher)).msg.vip_badge, undefined, 'no clock movement needed');
});

t('global chat (no creator room) never asks VIP', async () => {
    await new Promise((r) => setTimeout(r, 200));                 // lookups started by the last step settle
    const n = vip.state.calls.length;
    const ws = await h.ws({ ip: '198.51.100.47', token: member.token });
    ws.sendJson({ type: 'join', token: member.token });
    await ws.next((m) => m.type === 'auth');
    ws.sendJson({ type: 'chat', message: 'hello global' });
    const got = await ws.next((m) => m.type === 'chat' && m.message === 'hello global');
    assert.strictEqual(got.vip_badge, undefined);
    assert.strictEqual(vip.state.calls.length, n);
    ws.close();
});

t.run(async () => {
    try { h.chatServer.close(); } catch { /* */ }
    vip.server.close();
});
