'use strict';
/**
 * Network-token auth in Chat (WS-I task 3, server/auth/network-session.js): a Network session JWT is
 * verified with the Network's key and resolved through the ctx_users projection by subject, so a
 * signed-in person keeps chatting while Live is down; Live is asked only for hbt_ tokens, non-JWTs,
 * a key we do not hold, and subjects the projection cannot place. Staff powers come from the token's
 * staff_caps; a role in the token only ever raises the projection's.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, suite, b64url } = require('./helpers');

const t = suite('network session');
let h, session, alice, carol, modSubject;
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims, key = h.keys.privateKey, header = { alg: 'RS256', typ: 'JWT' }) => {
    const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), key))}`;
};
const claimsFor = (u, extra = {}) => ({ iss: h.ISS, sub: String(u.id + 7000), subject_id: u.subject_id, username: u.username, role: u.role, iat: now(), exp: now() + 3600, ...extra });

t('boot', async () => {
    h = await boot();
    session = require('../server/auth/network-session');
    alice = h.addUser('alice', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user'), role: 'global_mod' });
    modSubject = ids.newId('user');
    for (const u of [alice, carol]) h.ctx.upsertUser(h.live.users.get(u.id));
});

t('a Network token for a projected subject resolves here, without Live', async () => {
    const before = h.live.requests.filter((p) => p.endsWith('/auth')).length;
    const u = await session.authenticate(jwt(claimsFor(alice)));
    assert.deepStrictEqual([u.id, u.username, u.subject_id, u.auth_source, u.role], [alice.id, 'alice', alice.subject_id, 'network', 'user']);
    assert.strictEqual(h.live.requests.filter((p) => p.endsWith('/auth')).length, before, 'Live was not asked');
    assert.ok(session.stats().local >= 1);
});

t('staff_caps come from the token; its role only raises the projection\'s', async () => {
    const u = await session.authenticate(jwt(claimsFor(alice, { staff_caps: ['staff.moderation.chat'] })));
    assert.deepStrictEqual(u.staff_caps, ['staff.moderation.chat']);
    assert.strictEqual(require('../server/auth/permissions').can(u, 'staff.moderation.chat'), true);
    assert.strictEqual((await session.authenticate(jwt(claimsFor(alice, { role: 'global_mod' })))).role, 'global_mod', 'an upgrade applies at once');
    assert.strictEqual((await session.authenticate(jwt(claimsFor(carol, { role: 'user' })))).role, 'global_mod', 'a stale lower role is ignored');
});

t('expired, wrong-issuer, not-yet-valid and service tokens are refused here', async () => {
    const before = h.live.requests.filter((p) => p.endsWith('/auth')).length;
    for (const bad of [
        claimsFor(alice, { exp: now() - 5 }),
        claimsFor(alice, { iss: 'https://evil.example' }),
        claimsFor(alice, { nbf: now() + 600 }),
        claimsFor(alice, { typ: 'service' }),
        claimsFor(alice, { actor_type: 'service' }),
        (() => { const c = claimsFor(alice); delete c.exp; return c; })(),
    ]) {
        const tok = jwt(bad);
        assert.strictEqual(await session.authenticate(tok), null, JSON.stringify(bad));
        assert.strictEqual(session.failureReason(tok), 'invalid');
    }
    assert.strictEqual(session.verify(jwt(claimsFor(alice), h.keys.privateKey, { alg: 'none' }), h.keys.publicKey).ok, false, 'alg none');
    assert.strictEqual(session.verify(jwt(claimsFor(alice), h.keys.privateKey, { alg: 'HS256' }), h.keys.publicKey).ok, false, 'RS256 only');
    assert.strictEqual(h.live.requests.filter((p) => p.endsWith('/auth')).length, before, 'no Live call for a token we can judge');
});

t('Live answers what the projection cannot: unknown subjects, other keys, hbt_ and opaque tokens', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const count = () => h.live.requests.filter((p) => p.endsWith('/auth')).length;
    let n = count();
    assert.strictEqual(await session.authenticate(jwt({ ...claimsFor(alice), subject_id: modSubject })), null, 'Live does not know this stub token');
    assert.strictEqual(count(), n + 1, 'unknown subject → Live (it creates first-time accounts)');
    n = count();
    await session.authenticate(jwt(claimsFor(alice), other.privateKey));
    assert.strictEqual(count(), n + 1, 'another key → Live');
    n = count();
    const bot = h.addUser('botty', { apiScopes: ['chat'] });
    const u = await session.authenticate(bot.token);
    assert.deepStrictEqual([u.id, u.auth_source], [bot.id, 'api_token'], 'API (and opaque) tokens still resolve through Live');
    assert.strictEqual(count(), n + 1);
});

t('REST and the WebSocket keep working for a Network token while Live is down', async () => {
    const tok = jwt(claimsFor(alice));
    h.live.down = true;
    try {
        const r = await h.http('GET', '/api/chat/search?q=hello', { token: tok });
        assert.notStrictEqual(r.status, 401, `REST authenticated without Live (${r.status})`);
        const ws = await h.ws({ token: tok });
        ws.sendJson({ type: 'join', token: tok });
        const auth = await ws.next((m) => m.type === 'auth');
        assert.deepStrictEqual([auth.authenticated, auth.core_username, auth.user_id], [true, 'alice', alice.id]);
        ws.close();
        assert.strictEqual((await h.http('GET', '/api/chat/search?q=hello', { token: jwt(claimsFor(alice, { exp: now() - 1 })) })).status, 401);
    } finally { h.live.down = false; }
});

t('/metrics counts where sign-ins were decided', async () => {
    const m = (await h.http('GET', '/metrics')).text;
    for (const via of ['local', 'live', 'rejected']) assert.match(m, new RegExp(`chat_auth_resolutions\\{[^}]*via="${via}"[^}]*\\} [1-9]`), via);
});

t('a token in the WebSocket URL still works (deprecated, C-05) and is counted', async () => {
    const before = require('../server/auth/auth').urlTokenUses().jwt;
    const ws = await h.ws({ token: jwt(claimsFor(alice)) });
    ws.sendJson({ type: 'join' });
    const auth = await ws.next((m) => m.type === 'auth');
    assert.strictEqual(auth.core_username, 'alice');
    ws.close();
    assert.strictEqual(require('../server/auth/auth').urlTokenUses().jwt, before + 1);
    assert.match((await h.http('GET', '/metrics')).text, /chat_ws_url_token_uses\{[^}]*kind="jwt"[^}]*\} [1-9]/);
});

t('bots authenticate the upgrade with an Authorization header, no token in the URL', async () => {
    const before = require('../server/auth/auth').urlTokenUses();
    const ws = await h.ws({ bearer: jwt(claimsFor(carol)) });
    ws.sendJson({ type: 'join' });
    const auth = await ws.next((m) => m.type === 'auth');
    assert.deepStrictEqual([auth.authenticated, auth.core_username], [true, 'carol']);
    ws.close();
    assert.deepStrictEqual(require('../server/auth/auth').urlTokenUses(), before, 'not counted as a URL token');
});

t.run(async () => { if (h && h.close) await h.close(); });
