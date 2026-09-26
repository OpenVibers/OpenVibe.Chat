'use strict';
/**
 * openvibe.chat's DM inbox (roadmap WS-I task 8, server/web/pages.js): the inbox lists your conversations
 * with unread counts (and the navigation counts unread messages and room messages); a conversation is
 * for its participants only, and a guessed id looks exactly like one that does not exist; blocking the
 * other person of a 1:1 conversation closes it both ways (neither can send, nor start a new one, and the
 * user search hides them), the inbox lists who you blocked, and unblocking opens it again; groups have
 * no one to block.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('dm inbox');
let h, alice, bob, carol, conv;
const SITE = 'https://openvibe.chat';
const cookie = (u) => ({ cookie: `ov_token=${u.token}` });
const req = async (method, path, { headers = {}, raw } = {}) => {
    const r = await fetch(`${h.base}${path}`, { method, headers, body: raw, redirect: 'manual' });
    return { status: r.status, headers: r.headers, text: await r.text() };
};
const form = (u, fields, extra = {}) => ({ headers: { ...cookie(u), 'content-type': 'application/x-www-form-urlencoded', origin: SITE, ...extra }, raw: new URLSearchParams(fields).toString() });
const dmApi = (method, path, u, body) => h.http(method, `/api/dm${path}`, { token: u && u.token, body });
const navLabel = (page, key) => {
    const cfg = JSON.parse(page.match(/window\.__OV_PAGE = (.*);\n/)[1]);
    return cfg.navbar.links.find((l) => l.href === key).label;
};

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    for (const u of [alice, bob, carol]) { h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); }
});

t('the inbox: your conversations only, unread counts in the list and the navigation', async () => {
    let r = await req('POST', '/messages/new', form(alice, { username: 'bob' }));
    conv = Number(/^\/messages\/(\d+)$/.exec(r.headers.get('location'))[1]);
    await req('POST', `/messages/${conv}`, form(alice, { message: 'hi bob' }));
    await req('POST', `/messages/${conv}`, form(alice, { message: 'are you there?' }));
    let inbox = await req('GET', '/messages', { headers: cookie(bob) });
    assert.strictEqual(inbox.status, 200);
    assert.match(inbox.text, /<span class="oc-badge">2 new<\/span>/);
    assert.match(inbox.text, /id="oc-inbox-status"[^>]*>2 unread</);
    assert.strictEqual(navLabel(inbox.text, '/messages'), 'Messages (2)');
    assert.ok(inbox.text.includes('are you there?'), 'the last message as a preview');
    const carolInbox = await req('GET', '/messages', { headers: cookie(carol) });
    assert.ok(!carolInbox.text.includes(`/messages/${conv}`), 'not in anyone else\'s inbox');
    assert.strictEqual(navLabel(carolInbox.text, '/messages'), 'Messages');
    assert.ok(!(await dmApi('GET', '/conversations', carol)).body.conversations.some((c) => c.id === conv));

    // Opening it reads it.
    assert.strictEqual((await req('GET', `/messages/${conv}`, { headers: cookie(bob) })).status, 200);
    inbox = await req('GET', '/messages', { headers: cookie(bob) });
    assert.ok(!/\d+ new<\/span>/.test(inbox.text));
    assert.strictEqual(navLabel(inbox.text, '/messages'), 'Messages');
    assert.strictEqual((await dmApi('GET', '/unread', bob)).body.unread, 0);

    // Rooms count too.
    await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Book Club' } });
    await h.http('POST', '/api/chat/rooms/book-club/join', { token: bob.token, body: {} });
    for (const m of ['chapter one', 'chapter two', 'chapter three']) await h.http('POST', '/api/chat/rooms/book-club/messages', { token: alice.token, body: { message: m } });
    assert.strictEqual(navLabel((await req('GET', '/', { headers: cookie(bob) })).text, '/rooms'), 'Rooms (3)');
});

t('participants only: a guessed conversation looks like no conversation', async () => {
    const theirs = await req('GET', `/messages/${conv}`, { headers: cookie(carol) });
    const none = await req('GET', '/messages/999999', { headers: cookie(carol) });
    assert.deepStrictEqual([theirs.status, none.status], [404, 404]);
    const h1 = (x) => (x.text.match(/<h1>(.*?)<\/h1>/) || [])[1];
    assert.strictEqual(h1(theirs), h1(none), 'the same page either way');
    assert.ok(!theirs.text.includes('hi bob'));
    assert.strictEqual((await dmApi('GET', `/conversations/${conv}/messages`, carol)).status, 403);
    assert.strictEqual((await dmApi('GET', `/conversations/${conv}`, carol)).status, 403);
    const r = await req('POST', `/messages/${conv}`, form(carol, { message: 'let me in' }));
    assert.match(r.headers.get('location'), /error=/);
    assert.ok(!h.db.all('SELECT message FROM dm_messages WHERE conversation_id = ?', [conv]).some((m) => m.message === 'let me in'));
    assert.strictEqual((await req('POST', `/messages/${conv}/block`, form(carol, {}))).headers.get('location'), '/messages', 'nor block from it');
});

t('block: the conversation closes both ways; the inbox lists who you blocked; unblock opens it again', async () => {
    assert.strictEqual((await req('POST', `/messages/${conv}/block`, form(bob, {}, { origin: 'https://evil.example' }))).status, 403, 'forms from elsewhere are refused');
    let page = await req('GET', `/messages/${conv}`, { headers: cookie(bob) });
    assert.match(page.text, /Block Alice<\/button>/);
    let r = await req('POST', `/messages/${conv}/block`, form(bob, {}));
    assert.strictEqual(r.headers.get('location'), `/messages/${conv}`);

    page = await req('GET', `/messages/${conv}`, { headers: cookie(bob) });
    assert.match(page.text, /You blocked Alice/);
    assert.match(page.text, /Unblock Alice<\/button>/);
    assert.ok(!page.text.includes('id="oc-compose"'), 'no composer');
    page = await req('GET', `/messages/${conv}`, { headers: cookie(alice) });
    assert.match(page.text, /You cannot message this person\./);
    assert.ok(!page.text.includes('id="oc-compose"'));
    assert.ok(!page.text.includes('blocked'), 'the other side is not told who blocked whom');

    r = await dmApi('POST', `/conversations/${conv}/messages`, alice, { message: 'still there?' });
    assert.strictEqual(r.status, 403, 'blocked people cannot send');
    r = await req('POST', `/messages/${conv}`, form(alice, { message: 'still there?' }));
    assert.match(r.headers.get('location'), /error=/);
    r = await req('POST', '/messages/new', form(alice, { username: 'bob' }));
    assert.match(r.headers.get('location'), /^\/messages\?error=/, 'nor start a new conversation');
    assert.strictEqual((await dmApi('POST', '/conversations', bob, { user_ids: [alice.id] })).status, 403, 'the blocker cannot either');
    assert.ok(!(await dmApi('GET', '/users/search?q=bo', alice)).body.users.some((u) => u.id === bob.id), 'the user search hides them');

    const inbox = await req('GET', '/messages', { headers: cookie(bob) });
    assert.match(inbox.text, /People you blocked \(1\)/);
    assert.ok(inbox.text.includes(`action="/messages/unblock/${alice.id}"`));
    r = await req('POST', `/messages/unblock/${alice.id}`, form(bob, { back: `/messages/${conv}` }));
    assert.strictEqual(r.headers.get('location'), `/messages/${conv}`);
    r = await req('POST', `/messages/unblock/${alice.id}`, form(bob, { back: 'https://evil.example/' }));
    assert.strictEqual(r.headers.get('location'), '/messages?unblocked=1', 'back goes to a conversation or the inbox, nowhere else');
    assert.strictEqual((await dmApi('POST', `/conversations/${conv}/messages`, alice, { message: 'back again' })).status, 200);
    assert.match((await req('GET', `/messages/${conv}`, { headers: cookie(bob) })).text, /back again/);
});

t('groups have no one to block', async () => {
    const r = await dmApi('POST', '/conversations', alice, { user_ids: [bob.id, carol.id], name: 'Trio' });
    assert.strictEqual(r.status, 200, r.text);
    const gid = r.body.conversation.id;
    const page = await req('GET', `/messages/${gid}`, { headers: cookie(alice) });
    assert.ok(!/Block /.test(page.text));
    assert.match((await req('POST', `/messages/${gid}/block`, form(alice, {}))).headers.get('location'), new RegExp(`^/messages/${gid}\\?error=`));
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM dm_blocks WHERE blocker_id = ?', [alice.id]).n, 0);
});

t.run(async () => { if (h && h.close) await h.close(); });
