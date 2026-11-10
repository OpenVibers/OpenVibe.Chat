'use strict';
/**
 * Activity (migration 0061_chat_activity.sql, server/chat/activity.js): what happened to a person in Chat. A mention
 * and a reply in a room, a reaction on a message, a server invite, an accepted friend request and a role given are
 * one row each with who, what, where and when; the API is newest first with a cursor and a kind filter, has an
 * unread count, and marks one or all read. A person only sees what they may still read (a room they were removed
 * from, a deleted message) and never a blocked person's activity. The bottom bar's Activity place carries a dot
 * while something is unread.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('activity');
let h, ann, bob, cat;
const api = (method, path, u, body) => h.http(method, path, { token: u && u.token, body });
const room = (method, path, u, body) => api(method, `/api/chat/rooms${path}`, u, body);
const activity = (method, path, u, body) => api(method, `/api/v1/activity${path}`, u, body);
const web = async (path, u) => {
    const r = await fetch(`${h.base}${path}`, { headers: u ? { cookie: `ov_token=${u.token}` } : {} });
    return { status: r.status, text: await r.text() };
};

let feed, roomSlug, serverSlug, bobMessage, annMessage;

t('boot and the places', async () => {
    h = await boot();
    // The routes this test drives over HTTP, named here too so the changed-file check sees them.
    require('../server/chat/activity-routes');
    require('../server/chat/contacts');
    require('../server/chat/dm-routes');
    require('../server/rooms/routes');
    require('../server/rooms/server-routes');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('the API is signed in only, and empty at first', async () => {
    assert.strictEqual((await activity('GET', '/', null)).status, 401);
    assert.strictEqual((await activity('GET', '/unread', null)).status, 401);
    const r = await activity('GET', '/', ann);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.items, r.body.unread, r.body.next_before], [[], 0, null]);
});

t('a mention and a reply in a room, and a reaction on the message', async () => {
    let r = await room('POST', '/', ann, { name: 'Activity Lab' });
    assert.strictEqual(r.status, 201, r.text);
    roomSlug = r.body.room.slug;
    assert.strictEqual((await room('POST', `/${roomSlug}/join`, bob)).status, 200);

    // bob names ann and ann answers bob: one mention for ann, one reply for bob.
    r = await room('POST', `/${roomSlug}/messages`, bob, { message: 'morning @ann, are you around?' });
    assert.strictEqual(r.status, 201, r.text);
    bobMessage = r.body.message.id;
    r = await room('POST', `/${roomSlug}/messages`, ann, { message: 'here now', reply_to_id: bobMessage });
    assert.strictEqual(r.status, 201, r.text);
    annMessage = r.body.message.id;
    assert.strictEqual(r.body.message.reply_to_id, bobMessage, 'the reply keeps the message it answers');

    // A reaction on bob's message: ann's heart is bob's activity.
    r = await room('POST', `/${roomSlug}/messages/${bobMessage}/react`, ann, { reaction: 'heart' });
    assert.deepStrictEqual([r.status, r.body.reaction], [200, 'heart']);
    // The same reaction again takes it back, and its activity goes with it.
    r = await room('POST', `/${roomSlug}/messages/${bobMessage}/react`, ann, { reaction: 'thumbsup' });
    assert.strictEqual(r.body.reaction, 'thumbsup', 'changing a reaction updates it');

    let mine = await activity('GET', '/', ann);
    assert.deepStrictEqual(mine.body.items.map((x) => x.kind), ['mention'], mine.text);
    assert.strictEqual(mine.body.items[0].actor.username, 'bob');
    assert.strictEqual(mine.body.items[0].where.label, '#Activity Lab');
    assert.match(mine.body.items[0].where.href, new RegExp(`^/r/${roomSlug}$`));
    assert.strictEqual(mine.body.items[0].read, false);
    assert.strictEqual(mine.body.unread, 1);

    mine = await activity('GET', '/', bob);
    assert.deepStrictEqual(mine.body.items.map((x) => x.kind).sort(), ['reaction', 'reply']);
    // Newest first: the reaction came after the reply.
    assert.deepStrictEqual(mine.body.items.map((x) => x.kind), ['reaction', 'reply']);
    assert.strictEqual(mine.body.items[0].what.reaction, 'thumbsup');
    assert.ok(mine.body.items[0].at, 'every row says when');
});

t('a server invite and a role given', async () => {
    let r = await api('POST', '/api/chat/servers', ann, { name: 'Activity Server' });
    assert.strictEqual(r.status, 201, r.text);
    serverSlug = r.body.server.slug;
    r = await api('POST', `/api/chat/servers/${serverSlug}/invites`, ann, { username: 'cat' });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.invite.max_uses, 1, 'a named invite is for one person');
    let mine = await activity('GET', '/', cat);
    assert.deepStrictEqual(mine.body.items.map((x) => x.kind), ['server_invite']);
    assert.strictEqual(mine.body.items[0].actor.username, 'ann');
    assert.match(mine.body.items[0].where.href, /^\/join\//);

    // The server's owner gives cat a role: that is cat's activity too.
    r = await api('POST', `/api/chat/servers/${serverSlug}/members`, ann, { username: 'cat', role: 'mod' });
    assert.strictEqual(r.status, 200, r.text);
    mine = await activity('GET', '/', cat);
    assert.deepStrictEqual(mine.body.items.map((x) => x.kind), ['role', 'server_invite']);
    assert.strictEqual(mine.body.items[0].what.role, 'mod');
    assert.strictEqual(mine.body.items[0].where.kind, 'server');
});

t('an accepted friend request', async () => {
    // ann asks bob; bob accepts: ann hears that it was accepted.
    let r = await api('POST', '/api/dm/contacts', ann, { username: 'bob' });
    assert.strictEqual(r.status, 200, r.text);
    r = await api('POST', `/api/dm/contacts/${ann.id}/accept`, bob, {});
    assert.strictEqual(r.status, 200, r.text);
    const mine = await activity('GET', '/', ann);
    assert.ok(mine.body.items.some((x) => x.kind === 'friend_accept' && x.actor.username === 'bob'), mine.text);
    assert.strictEqual(mine.body.items.find((x) => x.kind === 'friend_accept').where.href, '/messages');
});

t('newest first, a cursor and a kind filter', async () => {
    const all = (await activity('GET', '/?limit=100', ann)).body.items;
    assert.ok(all.length >= 2);
    const first = (await activity('GET', '/?limit=1', ann)).body;
    assert.strictEqual(first.items.length, 1);
    assert.strictEqual(first.next_before, first.items[0].id);
    const second = (await activity('GET', `/?limit=50&before=${first.next_before}`, ann)).body;
    assert.ok(second.items.length >= 1);
    assert.ok(second.items[0].id < first.items[0].id, 'the cursor is exclusive');
    assert.deepStrictEqual((await activity('GET', '/?kind=mention', ann)).body.items.map((x) => x.kind), ['mention']);
    const bad = await activity('GET', '/?kind=nope', ann);
    assert.deepStrictEqual([bad.status, bad.body.code], [422, 'activity.kind']);
});

t('one read, then all: the unread count follows', async () => {
    const before = (await activity('GET', '/unread', ann)).body.unread;
    assert.ok(before >= 2);
    const first = (await activity('GET', '/?limit=1', ann)).body.items[0];
    let r = await activity('POST', `/${first.id}/read`, ann, {});
    assert.deepStrictEqual([r.status, r.body.read, r.body.unread], [200, 1, before - 1]);
    r = await activity('POST', `/${first.id}/read`, ann, {});
    assert.deepStrictEqual([r.body.read, r.body.unread], [0, before - 1], 'reading it again is harmless');
    r = await activity('POST', '/read', ann, { all: 1 });
    assert.deepStrictEqual([r.body.ok, r.body.unread], [true, 0]);
    assert.strictEqual((await activity('GET', '/', ann)).body.items.every((x) => x.read), true);
});

t('a room the person was removed from, and a blocked person, are not shown', async () => {
    // A private room of bob's; ann is let in, named, then removed.
    let r = await room('POST', '/', bob, { name: 'Private Lab', visibility: 'private' });
    assert.strictEqual(r.status, 201);
    const priv = r.body.room.slug;
    r = await room('POST', `/${priv}/members`, bob, { username: 'ann', role: 'member' });
    assert.strictEqual(r.status, 200, r.text);
    r = await room('POST', `/${priv}/messages`, bob, { message: 'secret @ann' });
    assert.strictEqual(r.status, 201);
    let mine = (await activity('GET', '/', ann)).body;
    assert.ok(mine.items.some((x) => x.where.room === priv), 'the mention is in the feed while ann may read it');
    r = await room('POST', `/${priv}/members`, bob, { username: 'ann', role: 'none' });
    assert.strictEqual(r.status, 200, r.text);
    mine = (await activity('GET', '/', ann)).body;
    assert.ok(!mine.items.some((x) => x.where.room === priv), 'no mention from a room ann can no longer read');

    // A blocked person's activity is left out (Chat's own block table).
    r = await api('POST', `/api/dm/blocks/${bob.id}`, ann, {});
    assert.strictEqual(r.status, 200, r.text);
    mine = (await activity('GET', '/', ann)).body;
    assert.ok(!mine.items.some((x) => x.actor.username === 'bob'), 'a blocked person is left out');
    r = await api('POST', '/api/v1/activity/read', ann, { all: true });
    assert.strictEqual(r.body.unread, 0);
});

t('the bottom bar Activity place carries a dot while something is unread', async () => {
    // A fresh mention for ann, then the signed-in app page carries the dot on Activity.
    await api('DELETE', `/api/dm/blocks/${bob.id}`, ann, {});
    await room('POST', `/${roomSlug}/messages`, bob, { message: 'one more @ann' });
    let page = await web('/messages', ann);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /"label":"Activity"[^}]*"dot":true/, page.text.slice(0, 200));
    await api('POST', '/api/v1/activity/read', ann, { all: true });
    page = await web('/messages', ann);
    assert.match(page.text, /"label":"Activity"[^}]*"dot":false/);
});

t('a deleted message leaves the feed, and the page section renders who, what, where and when', async () => {
    // One more mention of ann, then the message is deleted by its author: the row goes with it.
    let r = await room('POST', `/${roomSlug}/messages`, bob, { message: 'delete this @ann' });
    assert.strictEqual(r.status, 201, r.text);
    const messageId = r.body.message.id;
    assert.ok((await activity('GET', '/?kind=mention', ann)).body.items.some((x) => x.what.excerpt === 'delete this @ann'));
    r = await room('DELETE', `/${roomSlug}/messages/${messageId}`, bob);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!(await activity('GET', '/?kind=mention', ann)).body.items.some((x) => x.what.excerpt === 'delete this @ann'), 'a deleted message is not shown');

    // The page's section: who, what, where and when, in the shared plain list markup.
    await room('POST', `/${roomSlug}/messages`, bob, { message: 'render me @ann' });
    const html = await require('../server/web/activity').whatHappened(ann);
    assert.match(html, /What happened/);
    assert.match(html, /bob/);
    assert.match(html, /mentioned you/);
    assert.match(html, /#Activity Lab/);
    assert.match(html, /<time datetime=/);
    assert.strictEqual((await activity('GET', '/unread', ann)).body.unread, 0, 'opening the page reads it');

    // The page itself: the section sits above the page's own sections.
    await room('POST', `/${roomSlug}/messages`, bob, { message: 'page me @ann' });
    let page = await web('/activity', ann);
    assert.strictEqual(page.status, 200, page.text.slice(0, 300));
    assert.match(page.text, /<h1[^>]*>Activity<\/h1>/);
    assert.match(page.text, /What happened/);
    assert.match(page.text, /page me @ann|page me/);
    assert.ok(page.text.indexOf('What happened') < page.text.indexOf('Friend requests') || !page.text.includes('Friend requests'), 'the feed is above the waiting sections');
    assert.strictEqual((await activity('GET', '/unread', ann)).body.unread, 0, 'opening /activity reads it');
});
