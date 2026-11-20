'use strict';
// Guests' chat, capped by the day (server/chat/guest-caps.js; 2026-11-20, the plan's §V.1 guests, the owner's register
// #801: "Let guests/anons use OpenVibe.chat … with abuse prevention, severe rate limits, and possibly a global cap").
//   - the caps alone: a guest's messages a day, the links among them, all guests' messages a day, the next day afresh,
//     and no address kept in the clear;
//   - in a stream chat over a real socket: a guest's messages go out until the cap, then a system line says to sign in
//     (free) and the message does not go out; an account is never capped; another guest has its own count.
//   node test/guest-chat-caps.test.js
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const { createGuestCaps } = require('../server/chat/guest-caps');
const t = suite('guest chat caps');
let h;

t('the caps: per guest, its links, all guests, the next day', async () => {
    let now = Date.parse('2026-11-20T10:00:00Z');
    const c = createGuestCaps({ perDay: 3, linksPerDay: 1, allPerDay: 5, now: () => now });
    assert.strictEqual(c.take('203.0.113.1', 'hello'), null);
    assert.strictEqual(c.take('203.0.113.1', 'look https://openvibe.live/x'), null);
    assert.match(c.take('203.0.113.1', 'and www.example.com too'), /Guests can share 1 links a day\. Sign in \(free\)/, 'the second link');
    assert.strictEqual(c.take('203.0.113.1', 'third'), null, 'a refused link did not count');
    assert.match(c.take('203.0.113.1', 'fourth'), /That was today's 3 guest messages\. Sign in \(free\) to keep chatting\./);
    assert.strictEqual(c.left('203.0.113.1'), 0);
    assert.strictEqual(c.take('203.0.113.2', 'another guest'), null, 'another guest has its own count');
    assert.strictEqual(c.take('203.0.113.3', 'a third guest'), null);
    assert.match(c.take('203.0.113.4', 'a fourth guest'), /Guest chat is resting until tomorrow/, 'all guests: five a day here');
    assert.deepStrictEqual(c.stats(), { day: '2026-11-20', guests: 3, messages: 5 });
    now += 24 * 3600e3;
    assert.strictEqual(c.take('203.0.113.1', 'a new day'), null, 'the next day starts afresh');
    assert.strictEqual(c.left('203.0.113.1'), 2);
    assert.strictEqual(c.left('203.0.113.9'), null);
});

t('boot', async () => { h = await boot(); });

t('a stream chat: a guest up to the cap, then the sign-in line; an account is never capped', async () => {
    const owner = h.addUser('capowner', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(owner.id));
    const channel = h.addChannel(owner.id);
    const stream = h.addStream(owner.id, channel);
    await h.ctx.sync();
    h.chatServer.DEFAULT_RATE_LIMIT_MS = 0;   // the per-second limit is its own test
    h.chatServer.guestCaps = createGuestCaps({ perDay: 2, linksPerDay: 1, allPerDay: 100 });

    const guest = await h.ws({ ip: '198.51.100.61', stream });
    guest.sendJson({ type: 'join', streamId: stream, anonId: null });
    await guest.next((m) => m.type === 'auth' || m.type === 'connected');
    for (const text of ['guest one', 'guest two']) {
        guest.sendJson({ type: 'chat', message: text });
        await guest.next((m) => m.type === 'chat' && m.message === text);
    }
    guest.sendJson({ type: 'chat', message: 'guest three' });
    const said = await guest.next((m) => m.type === 'system' && /guest messages/.test(String(m.message)));
    assert.strictEqual(said.message, "That was today's 2 guest messages. Sign in (free) to keep chatting.");
    assert.ok(await guest.none((m) => m.type === 'chat' && m.message === 'guest three'), 'the third did not go out');

    const other = await h.ws({ ip: '198.51.100.62', stream });
    other.sendJson({ type: 'join', streamId: stream, anonId: null });
    await other.next((m) => m.type === 'auth' || m.type === 'connected');
    other.sendJson({ type: 'chat', message: 'another guest' });
    await other.next((m) => m.type === 'chat' && m.message === 'another guest');

    const me = await h.ws({ ip: '198.51.100.61', token: owner.token, stream });
    me.sendJson({ type: 'join', streamId: stream, token: owner.token });
    await me.next((m) => m.type === 'auth');
    for (const text of ['mine one', 'mine two', 'mine three']) {
        me.sendJson({ type: 'chat', message: text });
        await me.next((m) => m.type === 'chat' && m.message === text);
    }
    guest.close(); other.close(); me.close();
});

t.run(async () => { if (h) await h.close(); });
