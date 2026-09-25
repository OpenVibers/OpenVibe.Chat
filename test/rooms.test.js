'use strict';
/**
 * Chat rooms (WS-I task 4, server/rooms/): create, join, post, history, unread; private rooms are
 * invisible to outsiders; owners and mods moderate (delete, block) and it is logged; sockets that
 * joined a room get its messages live, nobody else does; site bans and slow mode apply.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('rooms');
let h, ann, bob, cat, mod;
const api = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    mod = h.addUser('staffmod', { subject: ids.newId('user'), role: 'global_mod' });
    for (const u of [ann, bob, cat, mod]) h.ctx.upsertUser(h.live.users.get(u.id));
});

t('create, list, join, post, history and unread', async () => {
    let r = await api('POST', '/', ann, { name: 'Night Owls', topic: 'Late chats' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.room.slug, r.body.room.role, r.body.room.members], ['night-owls', 'owner', 1]);
    assert.strictEqual((await api('POST', '/', bob, { name: 'Night Owls' })).status, 409, 'address taken');
    assert.strictEqual((await api('POST', '/', bob, { name: 'x' })).status, 422);
    assert.strictEqual((await api('POST', '/', bob, { name: 'Global', slug: 'global' })).status, 422, 'reserved address');
    assert.strictEqual((await api('POST', '/', null, { name: 'Anon room' })).status, 401);

    r = await api('POST', '/night-owls/messages', bob, { message: 'hi' });
    assert.strictEqual(r.status, 403, 'join first');
    assert.strictEqual((await api('POST', '/night-owls/join', bob)).body.role, 'member');
    r = await api('POST', '/night-owls/messages', ann, { message: 'welcome in' });
    assert.strictEqual(r.status, 201);
    const first = r.body.message.id;
    await api('POST', '/night-owls/messages', ann, { message: 'second' });
    let list = (await api('GET', '/', bob)).body;
    assert.strictEqual(list.mine.find((x) => x.slug === 'night-owls').unread, 2);
    assert.ok(list.public.some((x) => x.slug === 'night-owls'));
    await api('POST', '/night-owls/read', bob, {});
    list = (await api('GET', '/', bob)).body;
    assert.strictEqual(list.mine.find((x) => x.slug === 'night-owls').unread, 0);
    const hist = (await api('GET', '/night-owls/messages', null)).body;
    assert.deepStrictEqual(hist.messages.map((m) => m.message), ['welcome in', 'second'], 'public rooms are readable signed out');
    assert.deepStrictEqual((await api('GET', `/night-owls/messages?after=${first}`, null)).body.messages.map((m) => m.message), ['second']);
});

t('private rooms: invisible to outsiders, members by invitation', async () => {
    let r = await api('POST', '/', ann, { name: 'Secret Club', visibility: 'private' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await api('GET', '/secret-club', bob)).status, 404);
    assert.strictEqual((await api('GET', '/secret-club/messages', null)).status, 404);
    assert.strictEqual((await api('POST', '/secret-club/join', bob)).status, 403);
    assert.ok(!(await api('GET', '/', bob)).body.public.some((x) => x.slug === 'secret-club'), 'not listed');
    assert.strictEqual((await api('POST', '/secret-club/members', bob, { username: 'cat' })).status, 404, 'a non-member cannot even see it to invite');
    r = await api('POST', '/secret-club/members', ann, { username: 'bob', role: 'member' });
    assert.deepStrictEqual([r.status, r.body.role], [200, 'member']);
    assert.strictEqual((await api('GET', '/secret-club', bob)).status, 200);
    assert.strictEqual((await api('POST', '/secret-club/messages', bob, { message: 'thanks for the invite' })).status, 201);
    assert.strictEqual((await api('GET', '/secret-club', mod)).status, 200, 'chat staff can look in');
});

t('moderation: delete and block, owner-only mods, logged; live delivery only to the room', async () => {
    const annWs = await h.ws({ token: ann.token }); annWs.sendJson({ type: 'join_room', room: 'night-owls' });
    assert.strictEqual((await annWs.next((m) => m.type === 'room_joined')).role, 'owner');
    const outsider = await h.ws({ token: cat.token }); outsider.sendJson({ type: 'join', token: cat.token });
    await outsider.next((m) => m.type === 'auth');
    const bobWs = await h.ws({ token: bob.token }); bobWs.sendJson({ type: 'join_room', room: 'night-owls' });
    await bobWs.next((m) => m.type === 'room_joined');

    bobWs.sendJson({ type: 'room_message', message: 'live hello' });
    const got = await annWs.next((m) => m.type === 'room_message' && m.message.message === 'live hello');
    assert.strictEqual(got.room, 'night-owls');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!outsider.all.some((m) => m.type === 'room_message'), 'global sockets never see room messages');

    assert.strictEqual((await api('POST', '/night-owls/members', bob, { username: 'cat', role: 'mod' })).status, 403, 'members do not appoint mods');
    let r = await api('DELETE', `/night-owls/messages/${got.message.id}`, ann);
    assert.strictEqual(r.status, 200);
    await bobWs.next((m) => m.type === 'room_message_deleted' && m.id === got.message.id);
    r = await api('POST', '/night-owls/members', ann, { username: 'bob', role: 'blocked' });
    assert.strictEqual(r.body.role, 'blocked');
    await bobWs.next((m) => m.type === 'room_left');
    assert.strictEqual((await api('POST', '/night-owls/messages', bob, { message: 'let me back' })).status, 404, 'blocked: the room is gone for them');
    const logged = h.db.all("SELECT action_type FROM moderation_actions WHERE scope_type = 'room' ORDER BY id");
    assert.deepStrictEqual(logged.map((x) => x.action_type), ['delete_message', 'room_block']);
    for (const ws of [annWs, bobWs, outsider]) ws.close();
});

t('slow mode and site bans', async () => {
    let r = await api('PATCH', '/night-owls', ann, { slow_seconds: 30 });
    assert.strictEqual(r.body.room.slow_seconds, 30);
    assert.strictEqual((await api('PATCH', '/night-owls', cat, { slow_seconds: 0 })).status, 403);
    await api('POST', '/night-owls/join', cat);
    assert.strictEqual((await api('POST', '/night-owls/messages', cat, { message: 'one' })).status, 201);
    r = await api('POST', '/night-owls/messages', cat, { message: 'two' });
    assert.deepStrictEqual([r.status, r.body.code], [429, 'rooms.slow_mode']);
    assert.strictEqual((await api('POST', '/night-owls/messages', ann, { message: 'owners skip slow mode' })).status, 201);
    await api('PATCH', '/night-owls', ann, { slow_seconds: 0 });
    h.live.addBan({ user_id: cat.id });
    await h.ctx.invalidateBans();
    r = await api('POST', '/night-owls/messages', cat, { message: 'banned now' });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'rooms.banned'], 'a site ban applies in rooms');
});

t.run(async () => { if (h && h.close) await h.close(); });
