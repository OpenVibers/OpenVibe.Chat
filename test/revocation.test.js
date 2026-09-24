'use strict';
/**
 * Revocation propagation in Chat (WS-B task 4, Contracts 0.39.0 network.user.token_valid_after):
 * a sign-out everywhere closes that person's chat socket within 5 seconds, their older token is refused
 * on REST and on a new socket, a token issued after the cutoff still works, other people and bots are
 * untouched, a stale (older) event changes nothing and a redelivery is a no-op.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, suite, b64url } = require('./helpers');

const t = suite('revocation');
let h, alice, bob, bot;
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims) => {
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), h.keys.privateKey))}`;
};
const tokenFor = (u, iatOffset = -60) => jwt({ iss: h.ISS, sub: String(u.id + 7000), subject_id: u.subject_id, username: u.username, role: u.role, iat: now() + iatOffset, exp: now() + 3600 });
const event = (subject, validAfter, reason = 'signed_out_everywhere') => ({
    event_id: ids.newId('event'), event_type: 'network.user.token_valid_after', version: 1, source: 'network',
    actor: { type: 'user', id: subject }, timestamp: new Date().toISOString(), visibility: 'internal',
    subject: { type: 'user', id: subject }, payload: { subject: { type: 'user', id: subject }, valid_after: new Date(validAfter).toISOString(), reason },
});
async function signedIn(token) {
    const ws = await h.ws({ bearer: token });
    ws.sendJson({ type: 'join', token });
    const auth = await ws.next((m) => m.type === 'auth');
    return { ws, auth };
}
const closed = (ws) => new Promise((resolve) => { if (ws.readyState === 3) return resolve({ code: ws._closeCode }); ws.once('close', (code) => resolve({ code })); });

t('boot', async () => {
    h = await boot();
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    bot = h.addUser('helperbot', { subject: alice.subject_id, apiScopes: ['chat'] });
    for (const u of [alice, bob]) h.ctx.upsertUser(h.live.users.get(u.id));
    assert.ok(require('../server/events/consumer').TOPICS.includes('network.user.token_valid_after'), 'Chat subscribes to it');
});

t('a sign-out everywhere closes the person\'s socket within 5 seconds; others stay', async () => {
    const a = await signedIn(tokenFor(alice));
    const b = await signedIn(tokenFor(bob));
    assert.strictEqual(a.auth.core_username, 'alice');
    const started = Date.now();
    const out = h.eventsConsumer.apply(event(alice.subject_id, Date.now() - 5000));
    assert.strictEqual(out.outcome, 'revoked');
    const c = await closed(a.ws);
    assert.strictEqual(c.code, 4001);
    assert.ok(Date.now() - started < 5000, `closed in ${Date.now() - started} ms`);
    assert.ok(a.ws.all.some((m) => m.type === 'auth_revoked'), 'told why');
    assert.strictEqual(b.ws.readyState, 1, 'bob is untouched');
    b.ws.close();
});

t('the old token is refused afterwards; a newer one works; a redelivery and an older cutoff change nothing', async () => {
    const old = tokenFor(alice, -60);
    assert.strictEqual((await h.http('GET', '/api/chat/search?q=x', { token: old })).status, 401);
    const again = await signedIn(old);
    assert.notStrictEqual(again.auth.core_username, 'alice', 'reconnects as a guest');
    again.ws.close();
    const fresh = await signedIn(tokenFor(alice, 0));
    assert.strictEqual(fresh.auth.core_username, 'alice', 'a token issued after the cutoff works');
    const ev = event(alice.subject_id, Date.now() - 120000, 'password_changed');
    assert.strictEqual(h.eventsConsumer.apply(ev).outcome, 'unchanged', 'an older cutoff never moves it back');
    assert.strictEqual(h.eventsConsumer.apply(ev).duplicate, true);
    assert.strictEqual(fresh.ws.readyState, 1);
    fresh.ws.close();
});

t('bots on an API token and events from anyone but Network are left alone', async () => {
    const b = await signedIn(bot.token);
    assert.strictEqual(b.auth.core_username, 'helperbot');
    assert.strictEqual(h.eventsConsumer.apply(event(alice.subject_id, Date.now() + 1000)).outcome, 'revoked');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(b.ws.readyState, 1, 'API-token socket stays');
    b.ws.close();
    const forged = { ...event(bob.subject_id, Date.now()), source: 'live' };
    assert.strictEqual(h.eventsConsumer.apply(forged).outcome, 'ignored:source');
    const bad = event(bob.subject_id, Date.now()); bad.payload.valid_after = 'soon';
    assert.strictEqual(h.eventsConsumer.apply(bad).outcome, 'ignored:payload');
});

t.run(async () => { if (h && h.close) await h.close(); });
