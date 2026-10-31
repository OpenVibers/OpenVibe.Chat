'use strict';
// The Dock's private-issuer token in Chat (2026-10-30): only `chat.read` and only DM reads (GET/HEAD
// plus the read receipt). Sending, creating and every chat route are refused. An extension origin gets
// no CORS grant and never authenticates with a cookie — only its Bearer counts.
const assert = require('assert');
const crypto = require('crypto');
const { boot, suite, b64url } = require('./helpers');

const t = suite('dock signin');
let h, alice, bob, convId;
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims, key = h.keys.privateKey) => {
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), key))}`;
};
const normal = (u) => jwt({ iss: h.ISS, sub: String(u.id), subject_id: u.subject_id, username: u.username, role: u.role, iat: now(), exp: now() + 3600 });
const dock = (u, scope = 'chat.read') => jwt({
    iss: `${h.ISS}/dock`, sub: String(u.id), id: u.id, subject_id: u.subject_id, username: u.username,
    client_id: 'companion', scope, fam: `fam_${'a'.repeat(24)}`, iat: now(), exp: now() + 3600,
});

t('boot', async () => {
    h = await boot();
    alice = h.addUser('dockalice', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' });
    bob = h.addUser('dockbob', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4' });
    for (const u of [alice, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const r = await h.http('POST', '/api/dm/conversations', { token: normal(alice), body: { user_ids: [bob.id] } });
    assert.strictEqual(r.status, 200, r.text);
    convId = r.body.conversation.id;
});

t('a Dock token reads DM conversations and messages, and marks read', async () => {
    const tok = dock(alice);
    const list = await h.http('GET', '/api/dm/conversations', { token: tok });
    assert.strictEqual(list.status, 200, list.text);
    assert.ok(list.body.conversations.some((c) => c.id === convId));
    assert.strictEqual((await h.http('GET', `/api/dm/conversations/${convId}/messages`, { token: tok })).status, 200);
    assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: tok })).status, 200);
    assert.strictEqual((await h.http('POST', `/api/dm/conversations/${convId}/read`, { token: tok })).status, 200);
});

t('the same token cannot send, create, rename or reach another chat route', async () => {
    const tok = dock(alice);
    const send = await h.http('POST', `/api/dm/conversations/${convId}/messages`, { token: tok, body: { message: 'no' } });
    assert.strictEqual(send.status, 403, send.text);
    assert.strictEqual((await h.http('POST', '/api/dm/conversations', { token: tok, body: { user_ids: [bob.id] } })).status, 403);
    assert.strictEqual((await h.http('PATCH', `/api/dm/conversations/${convId}`, { token: tok, body: { name: 'x' } })).status, 403);
    assert.strictEqual((await h.http('GET', '/api/chat/search?q=hello', { token: tok })).status, 401);
});

t('scope is enforced: a Dock token without chat.read is refused', async () => {
    assert.strictEqual((await h.http('GET', '/api/dm/conversations', { token: dock(alice, 'dock') })).status, 401);
    assert.strictEqual((await h.http('GET', '/api/dm/conversations', { token: normal(alice) })).status, 200);
});

t('an extension origin gets no CORS grant and never authenticates with a cookie', async () => {
    const origin = 'chrome-extension://bjcjcfcecpkkmfndegkjekoipdmbgakd';
    const tok = dock(alice);
    const r = await h.http('GET', '/api/dm/conversations', { token: tok, headers: { origin } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null, 'no echoed origin');
    assert.strictEqual(r.headers.get('access-control-allow-credentials'), null, 'no credentialed grant');
    const cookieOnly = await h.http('GET', '/api/dm/conversations', { headers: { origin, cookie: `ov_token=${normal(alice)}` } });
    assert.strictEqual(cookieOnly.status, 401, 'a cookie is not a session for an extension');
    const both = await h.http('GET', '/api/dm/conversations', { token: tok, headers: { origin, cookie: `ov_token=${normal(alice)}` } });
    assert.strictEqual(both.status, 200, 'the Bearer acts, the cookie is ignored');
    assert.strictEqual((await h.http('GET', '/api/dm/conversations', { token: tok, headers: { origin: 'https://evil.example' } })).status, 403, 'a foreign web origin is still refused');
    const moz = await h.http('GET', '/api/dm/conversations', { token: tok, headers: { origin: 'moz-extension://8d3b2a5e-0a9c-4f7e-9c3b-2a1f6d4e8c11' } });
    assert.strictEqual(moz.status, 200);
    assert.strictEqual(moz.headers.get('access-control-allow-origin'), null);
});

t.run(async () => { await h.shutdown(); });
