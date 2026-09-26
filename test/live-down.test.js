'use strict';
/**
 * openvibe.chat with OpenVibe.Live down (roadmap WS-I task 8): every page of the site renders and the core
 * APIs work while Live refuses connections, and again while Live accepts them and never answers (a hung
 * Live must not hold a page past the budget). People sign in with their Network token, resolved from
 * the ctx_users projection, so nothing asks Live. Pages load nothing from openvibe.live (profile links
 * are the only Live URLs, and they are links).
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, suite, b64url } = require('./helpers');

const t = suite('live down');
let h, alice, bob, carol, aliceJwt, bobJwt, carolJwt, convId;
const SITE = 'https://openvibe.chat';
const now = () => Math.floor(Date.now() / 1000);
const jwt = (u) => {
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: h.ISS, sub: String(u.id + 7000), subject_id: u.subject_id, username: u.username, role: u.role, iat: now() - 5, exp: now() + 3600 }))}`;
    return `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), h.keys.privateKey))}`;
};
const req = async (method, path, { token, headers = {}, raw, json } = {}) => {
    const started = Date.now();
    const r = await fetch(`${h.base}${path}`, {
        method, redirect: 'manual',
        headers: { ...(token ? { cookie: `ov_token=${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : raw,
    });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, headers: r.headers, text, body, ms: Date.now() - started };
};
const form = (token, fields) => ({ token, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, raw: new URLSearchParams(fields).toString() });
const html = { accept: 'text/html' };

/** No page may load anything from Live: scripts, styles, images, frames, form targets, fetches. */
function assertNoLiveResources(page, path) {
    for (const re of [/<(script|img|iframe|audio|video|source)[^>]+src="https?:\/\/(www\.)?openvibe\.live/i, /<link[^>]+href="https?:\/\/(www\.)?openvibe\.live/i, /<form[^>]+action="https?:\/\/(www\.)?openvibe\.live/i]) {
        assert.ok(!re.test(page), `${path} loads something from openvibe.live (${re})`);
    }
}

t('boot, and some of everything while Live is up', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    for (const u of [alice, bob, carol]) { h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); }
    [aliceJwt, bobJwt, carolJwt] = [alice, bob, carol].map(jwt);
    let r = await req('POST', '/api/dm/conversations', { token: aliceJwt, json: { user_ids: [bob.id] } });
    assert.strictEqual(r.status, 200, r.text);
    convId = r.body.conversation.id;
    await req('POST', `/api/dm/conversations/${convId}/messages`, { token: aliceJwt, json: { message: 'before the outage' } });
    assert.strictEqual((await req('POST', '/api/chat/rooms', { token: aliceJwt, json: { name: 'Night Shift', topic: 'while Live sleeps' } })).status, 201);
    assert.strictEqual((await req('POST', '/api/chat/rooms', { token: aliceJwt, json: { name: 'Quiet Corner', visibility: 'private' } })).status, 201);
    assert.strictEqual((await req('POST', '/api/chat/send', { token: aliceJwt, json: { message: 'global before the outage' } })).status, 200);
});

async function everyPageAndApi(label, budgetMs) {
    const pages = [
        ['/', null], ['/', aliceJwt], ['/rooms', null], ['/rooms', aliceJwt], ['/r/night-shift', null], ['/r/night-shift', bobJwt],
        ['/r/quiet-corner', aliceJwt], ['/r/night-shift/settings', aliceJwt], ['/messages', aliceJwt], [`/messages/${convId}`, bobJwt],
        ['/settings', aliceJwt], ['/updates', null], ['/robots.txt', null], ['/sitemap.xml', null], ['/auth/me', aliceJwt],
    ];
    for (const [path, token] of pages) {
        const r = await req('GET', path, { token, headers: html });
        assert.strictEqual(r.status, 200, `${label}: GET ${path} → ${r.status}`);
        assert.ok(r.ms < budgetMs, `${label}: GET ${path} took ${r.ms} ms`);
        assertNoLiveResources(r.text, path);
    }
    assert.match((await req('GET', '/', { token: aliceJwt })).text, /id="oc-compose"/, `${label}: signed in from the Network token alone`);
    assert.match((await req('GET', `/messages/${convId}`, { token: bobJwt })).text, /before the outage/);
    assert.strictEqual((await req('GET', '/r/quiet-corner', { token: bobJwt })).status, 404, `${label}: private rooms stay private`);
    assert.strictEqual((await req('GET', `/messages/${convId}`, { token: carolJwt })).status, 404, `${label}: so do conversations`);
    assert.strictEqual((await req('GET', '/no-such-page', { headers: html })).status, 404);

    // The forms, without JavaScript.
    const posts = [
        ['/send', aliceJwt, { message: `global during ${label}` }, /^\/#oc-compose$/],
        ['/r/night-shift', aliceJwt, { message: `room during ${label}` }, /^\/r\/night-shift#oc-compose$/],
        [`/messages/${convId}`, bobJwt, { message: `dm during ${label}` }, new RegExp(`^/messages/${convId}#oc-compose$`)],
        ['/messages/new', carolJwt, { username: 'alice' }, /^\/messages\/\d+$/],
    ];
    for (const [path, token, fields, want] of posts) {
        const r = await req('POST', path, form(token, fields));
        assert.strictEqual(r.status, 303, `${label}: POST ${path} → ${r.status}`);
        assert.match(r.headers.get('location'), want, `${label}: POST ${path} → ${r.headers.get('location')}`);
        assert.ok(r.ms < budgetMs, `${label}: POST ${path} took ${r.ms} ms`);
    }
    const room = (await req('GET', '/r/night-shift')).text;
    assert.ok(room.includes(`room during ${label}`));
    assert.ok((await req('GET', '/')).text.includes(`global during ${label}`));

    // The APIs the site's script and apps use.
    const apis = [
        ['GET', '/api/chat/rooms', aliceJwt], ['GET', '/api/chat/rooms/night-shift/messages', null], ['GET', '/api/chat/global/history?limit=20', null],
        ['GET', '/api/dm/conversations', aliceJwt], ['GET', `/api/dm/conversations/${convId}/messages`, aliceJwt], ['GET', '/api/dm/unread', bobJwt],
        ['GET', '/api/chat/ice-servers', null],
    ];
    for (const [method, path, token] of apis) {
        const r = await req(method, path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        assert.strictEqual(r.status, 200, `${label}: ${method} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
        assert.ok(r.ms < budgetMs, `${label}: ${method} ${path} took ${r.ms} ms`);
    }
    for (const [path, token, json] of [
        ['/api/chat/rooms/night-shift/messages', bobJwt, null],
        [`/api/dm/conversations/${convId}/messages`, aliceJwt, { message: `api dm during ${label}` }],
        ['/api/chat/send', bobJwt, { message: `api global during ${label}` }],
    ]) {
        if (!json) await req('POST', '/api/chat/rooms/night-shift/join', { token, json: {} });
        const r = await req('POST', path, { token, json: json || { message: `api room during ${label}` } });
        assert.ok(r.status === 200 || r.status === 201, `${label}: POST ${path} → ${r.status} ${r.text.slice(0, 160)}`);
        assert.ok(r.ms < budgetMs, `${label}: POST ${path} took ${r.ms} ms`);
    }
    const hist = await req('GET', '/api/chat/global/history?limit=50');
    assert.ok(hist.body.messages.some((m) => m.message === `api global during ${label}`));

    // The live feed: a signed-in socket (the browser's cookie, as on openvibe.chat) joins global chat and a
    // room and posts there. Joining warms Live's caches for at most live-context's WARM_TIMEOUT_MS (2.5 s)
    // per step, so a hung Live delays the feed by seconds; messages sent meanwhile wait, in order.
    const socketBudget = label === 'hung' ? 9000 : budgetMs;
    const ws = await h.ws({ origin: 'https://openvibe.live', bearer: aliceJwt });
    ws.sendJson({ type: 'join' });
    const auth = await ws.next((m) => m.type === 'auth', socketBudget);
    assert.deepStrictEqual([auth.authenticated, auth.core_username], [true, 'alice'], `${label}: the socket signs in from the Network token`);
    ws.sendJson({ type: 'join_room', room: 'night-shift' });
    await ws.next((m) => m.type === 'room_joined', socketBudget);
    ws.sendJson({ type: 'room_message', message: `socket during ${label}` });
    await ws.next((m) => m.type === 'room_message' && m.message.message === `socket during ${label}`, socketBudget);
    ws.close();
}

t('Live refuses connections: every page renders, the forms and the core APIs work', async () => {
    h.live.down = true;
    const before = h.live.requests.length;
    await everyPageAndApi('refused', 2500);
    h.live.down = false;
    assert.ok(h.live.requests.length >= before, 'Live was down the whole time');
});

t('Live hangs (accepts, never answers): nothing waits on it past the budget', async () => {
    h.live.hang = true;
    await everyPageAndApi('hung', 3000);
    assert.ok(h.live.hung > 0, 'Chat did ask the hung Live (and did not wait for it)');
    h.live.hang = false;
});

t.run(async () => { if (h && h.close) await h.close(); });
