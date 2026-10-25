'use strict';
/**
 * A chat room on any website (server/web/room-embed-pages.js): only public rooms embed (not private ones, Vibe chats or
 * server channels); the frame may sit on any site; a person signs in through a window and the frame collects their
 * token once with a ticket; with it the socket joins the room as them and they post; anyone reads live; the owner's
 * room settings give the tag.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('room embed');
const SITE = 'https://openvibe.chat';
let h, ann, bob;
const page = (path, u, opts = {}) => fetch(`${h.base}${path}`, { redirect: 'manual', ...opts, headers: { ...(u ? { cookie: `ov_token=${u.token}` } : {}), ...(opts.headers || {}) } })
    .then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
const ticket = () => crypto.randomBytes(32).toString('base64url');
const collect = (tk) => fetch(`${h.base}/embed/ticket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: tk }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    assert.strictEqual((await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Pixel Fans', slug: 'pixel-fans' } })).status, 201);
    assert.strictEqual((await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Secret Club', slug: 'secret-club', visibility: 'private' } })).status, 201);
    await h.http('POST', '/api/chat/rooms/pixel-fans/messages', { token: ann.token, body: { message: 'Welcome! New lamps on https://pixellamp.example/new' } });
});

t('only a public room embeds, on any site, with its latest messages', async () => {
    const r = await page('/embed/room/pixel-fans');
    assert.strictEqual(r.status, 200);
    assert.ok(/frame-ancestors \*/.test(r.headers.get('content-security-policy')));
    assert.ok(r.text.includes('data-room="pixel-fans"') && r.text.includes('Welcome! New lamps on https://pixellamp.example/new'));
    assert.ok(r.text.includes('Sign in with OpenVibe to chat') && !r.text.includes('data-close'), 'inline: no close button');
    assert.ok((await page('/embed/room/pixel-fans?bubble=1')).text.includes('data-close'), 'in a bubble it closes');
    assert.strictEqual((await page('/embed/room/secret-club')).status, 404, 'private rooms stay home');
    const vibe = (await h.http('POST', '/api/chat/vibe', { token: ann.token, body: { message: 'hi' } })).body;
    if (vibe && vibe.room) assert.strictEqual((await page(`/embed/room/${vibe.room.slug}`)).status, 404, 'a Vibe chat is private');
    assert.strictEqual((await page('/embed/room/no-such-room')).status, 404);
});

t('signing in from the frame: a window binds the ticket, the frame collects the token once', async () => {
    const tk = ticket();
    assert.deepStrictEqual(await collect(tk), { status: 202, body: { pending: true } });
    const out = await page(`/embed/signin?ticket=${tk}`);
    assert.strictEqual(out.status, 303);
    assert.ok(out.headers.get('location').startsWith('/auth/login?next=%2Fembed%2Fsignin%3Fticket%3D'), 'sign in first, then back');
    const ok = await page(`/embed/signin?ticket=${tk}`, ann);
    assert.ok(ok.status === 200 && ok.text.includes('signed in as Ann') && /frame-ancestors 'none'/.test(ok.headers.get('content-security-policy')));
    assert.strictEqual(ok.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await collect(tk), { status: 200, body: { token: ann.token } });
    assert.deepStrictEqual(await collect(tk), { status: 202, body: { pending: true } }, 'once');
    assert.strictEqual((await collect('short')).status, 400);
    assert.strictEqual((await page('/embed/signin?ticket=bad', ann)).status, 400);
});

t('with the token the socket joins as them: a newcomer joins, posts, and everyone reading sees it', async () => {
    const reader = await h.ws({});
    reader.sendJson({ type: 'join_room', room: 'pixel-fans' });
    const r = await reader.next((m) => m.type === 'room_joined');
    assert.strictEqual(r.can.post, false, 'anyone reads, nobody anonymous writes');
    const tk = ticket();
    await page(`/embed/signin?ticket=${tk}`, bob);
    const token = (await collect(tk)).body.token;
    const writer = await h.ws({});
    writer.sendJson({ type: 'join_room', room: 'pixel-fans', token });
    const first = await writer.next((m) => m.type === 'room_joined');
    assert.deepStrictEqual([first.role, first.can.post], [null, false], 'not a member yet');
    assert.strictEqual((await h.http('POST', '/api/chat/rooms/pixel-fans/join', { token })).status, 200);
    writer.sendJson({ type: 'join_room', room: 'pixel-fans', token });
    const joined = await writer.next((m) => m.type === 'room_joined' && m.can.post);
    assert.strictEqual(joined.role, 'member');
    writer.sendJson({ type: 'room_message', message: 'Hi from a fan site!' });
    const got = await reader.next((m) => m.type === 'room_message' && m.message.message === 'Hi from a fan site!');
    assert.strictEqual(got.message.username, 'bob');
    reader.close(); writer.close();
});

t('the tag: widget.js knows rooms (bubble or inline), and the owner\'s settings give it', async () => {
    const js = await (await fetch(`${h.base}/widget.js`)).text();
    assert.ok(js.includes("'/embed/room/'") && js.includes('data-target'));
    const settings = await page('/r/pixel-fans/settings', ann);
    assert.ok(settings.text.includes('Put this room on your site') && settings.text.includes('data-room=&quot;pixel-fans&quot;'));
    assert.ok(!(await page('/r/secret-club/settings', ann)).text.includes('Put this room on your site'), 'a private room has no tag');
});

t.run(async () => { require('../server/web/room-embed-pages')._reset(); if (h && h.close) await h.close(); });
