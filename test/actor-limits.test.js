'use strict';
/**
 * Per-actor rate limits on the REST API (server/net/actor-limits.js, roadmap WS-R task 4): past its
 * limit one caller gets 429 problem+json `rate_limited` with Retry-After, before the route does any
 * work, while another caller still passes; each API has its own read budget and the window reopens
 * on the clock. A person's API token counts against the person; signed-out reads are left to the per-address limit;
 * media files are left to the per-address limit. Writes have their own, tighter numbers. Health,
 * ready, release.json, metrics and /internal/* are never limited; refusals are logged and counted.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('actor-limits');
let h, alice, bob, limitsMod;
// The limiter's clock: 15 s into a minute, so the minute window has 45 s left.
let clock = Date.UTC(2026, 8, 27, 12, 0, 15);

t('boot (reads: 3 a minute per caller)', async () => {
    h = await boot({ env: { CHAT_LIMITS_MINUTE: '3', CHAT_LIMITS_HOUR: '100' } });
    limitsMod = require('../server/net/actor-limits');
    limitsMod.clock.now = () => clock;
    alice = h.addUser('alice', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1ZAAA' });
    bob = h.addUser('bob', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1ZBBB' });
    await h.ctx.sync();
});

t('a read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: alice.token })).status, 200);
    const r = await h.http('GET', '/api/dm/unread', { token: alice.token });
    assert.strictEqual(r.status, 429, r.text);
    assert.strictEqual(r.headers.get('retry-after'), '45');
    assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
    assert.deepStrictEqual([r.body.code, r.body.status, r.body.retry_after_seconds], ['rate_limited', 429, 45]);
    assert.ok(r.body.detail.includes('chat.dm.read'), r.body.detail);
    assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: bob.token })).status, 200, 'another person still passes');
});

t('the person\'s API token counts against the person; another API has its own budget', async () => {
    h.live.tokens.set('hbt_alice_bot', { userId: alice.id, apiScopes: ['read', 'chat'] });
    const bot = await h.http('GET', '/api/dm/unread', { token: 'hbt_alice_bot' });
    assert.deepStrictEqual([bot.status, bot.body.code], [429, 'rate_limited']);
    assert.strictEqual((await h.http('GET', '/api/chat/online?users=alice', { token: alice.token })).status, 200, '/api/chat is another budget');
});

t('signed-out reads keep only the per-address limit (many viewers share an address); media files too', async () => {
    const from = (ip) => h.http('GET', '/api/chat/online?users=alice', { headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 8; i++) assert.strictEqual((await from('203.0.113.7')).status, 200, `signed-out read ${i + 1}`);
    for (let i = 0; i < 6; i++) {
        assert.strictEqual((await h.http('GET', '/api/sounds/file/none.mp3', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 404);
    }
});

t('the next minute opens the window again', async () => {
    clock += 45 * 1000;
    assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: alice.token })).status, 200);
});

t('a write has its own number: 20 REST sends a minute, the 21st refused before it is stored', async () => {
    clock = Date.UTC(2026, 8, 27, 12, 5, 0);
    const stored = () => h.db.get("SELECT COUNT(*) AS n FROM chat_messages WHERE message LIKE 'limits %'").n;
    for (let i = 0; i < 20; i++) {
        const r = await h.http('POST', '/api/chat/send', { token: alice.token, body: { message: `limits ${i} from alice` } });
        assert.strictEqual(r.status, 200, `send ${i + 1}: ${r.text}`);
    }
    const before = stored();
    const r = await h.http('POST', '/api/chat/send', { token: alice.token, body: { message: 'limits one more' } });
    assert.deepStrictEqual([r.status, r.body.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
    assert.ok(r.body.detail.includes('chat.message.send'), r.body.detail);
    assert.strictEqual(stored(), before, 'nothing stored');
    assert.strictEqual((await h.http('POST', '/api/chat/send', { token: bob.token, body: { message: 'limits hi from bob' } })).status, 200, 'another person still sends');
    assert.strictEqual((await h.http('POST', '/api/chat/send', { token: 'nope', body: { message: 'x' } })).status, 401, 'a bad token: 401 from auth');
});

t('health, ready, release.json, metrics and /internal/* are never limited', async () => {
    for (let i = 0; i < 6; i++) {
        assert.strictEqual((await h.http('GET', '/health')).status, 200);
        assert.notStrictEqual((await h.http('GET', '/ready')).status, 429);
        assert.strictEqual((await h.http('GET', '/release.json')).status, 200);
        assert.strictEqual((await h.http('GET', '/metrics')).status, 200);
        assert.notStrictEqual((await h.http('POST', '/internal/events', { body: {} })).status, 429);
        assert.notStrictEqual((await h.http('POST', '/internal/live/calls', { body: { ops: [] } })).status, 429);
    }
});

t('refusals are counted in chat_rate_limited_total', async () => {
    const m = (await h.http('GET', '/metrics')).text;
    const lines = m.split('\n').filter((l) => l.includes('chat_rate_limited_total')).join('\n');
    assert.ok(/chat_rate_limited_total\{limit="chat.dm.read",window="minute"\} 2/.test(m), lines);
    assert.ok(!/limit="chat.read"/.test(m), 'signed-out reads were never refused per actor');
    assert.ok(/chat_rate_limited_total\{limit="chat.message.send",window="minute"\} 1/.test(m), lines);
});

t('who is counted', () => {
    const { actor } = limitsMod;
    assert.strictEqual(actor({ user: { id: 7, subject_id: 'usr_a' }, ip: '203.0.113.1' }), 'user:usr_a');
    assert.strictEqual(actor({ user: { id: 7, subject_id: null }, ip: '203.0.113.1' }), 'user:7', 'before the subject is known');
    assert.strictEqual(actor({ ovActorUser: { id: 7, subject_id: 'usr_a' }, ip: '203.0.113.1' }), 'user:usr_a', 'resolved before requireAuth');
    assert.strictEqual(actor({ ip: '203.0.113.1' }), 'ip:203.0.113.1');
});

t.run(async () => { if (h) await h.close(); });
