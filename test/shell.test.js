'use strict';
/**
 * The app shell (the plan, 2026-11-09, stage V2) and Explore (stage V3).
 *
 * The shell: the rail (Home, Vibe, your servers, Add, Explore), the side column (Home's DMs and Friends; a
 * server's channels with their categories and the people in each voice channel, and the you-bar), the members
 * column grouped by role, the phone's bottom bar (Shared's app bar), and the shared user popout on every name.
 *
 * Explore: the category chips, the featured servers as cards, the Start sheet with its templates, and a server
 * that starts with the template's channels and ends with its invite link.
 *
 * Friends and requests: the people you talk to, on the side column and over the API.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('shell');
let h, dee, bob, cat;
let contactsMod, viewDefaults, serverPages, dmRoutes;
const api = (method, path, u, body) => h.http(method, `/api/chat/servers${path}`, { token: u && u.token, body });
const dmApi = (method, path, u, body) => h.http(method, `/api/dm${path}`, { token: u && u.token, body });
const page = async (path, u) => {
    const headers = u ? { cookie: `ov_token=${u.token}` } : {};
    const r = await fetch(`${h.base}${path}`, { headers });
    return { status: r.status, text: await r.text() };
};

t('boot', async () => {
    h = await boot();
    dee = h.addUser('dee', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [dee, bob, cat]) {
        await h.ctx.upsertUser(h.live.users.get(u.id));
        h.netModules.subjects.add(u.subject_id);
    }
    // Require after boot so config reads the env vars set by helpers.js.
    contactsMod = require('../server/chat/contacts');
    viewDefaults = require('../server/chat/view-defaults');
    serverPages = require('../server/web/server-pages');
    dmRoutes = require('../server/chat/dm-routes');
});

t('the shell: the rail, the side column, the members column and the bottom bar', async () => {
    const made = await api('POST', '/', dee, { name: 'Saturday Raiders', description: 'Raids on Saturdays' });
    const slug = made.body.server.slug;
    await api('POST', `/${slug}/channels`, dee, { name: 'planning' });
    await api('POST', `/${slug}/channels`, dee, { name: 'Lounge', kind: 'voice' });
    await api('POST', `/${slug}/join`, bob);
    const r = await page(`/s/${slug}`, dee);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /class="oc-app"/, 'the shell');
    assert.match(r.text, /<nav class="oc-rail" aria-label="Chat destinations">/, 'the rail');
    assert.match(r.text, /title="Home"/);
    assert.match(r.text, /title="Vibe"/);
    assert.match(r.text, /class="oc-rail-icon oc-rail-add" href="\/servers#oc-new-server"/, 'Add a server');
    assert.match(r.text, /class="oc-rail-icon oc-rail-explore"/, 'Explore');
    assert.match(r.text, /class="oc-side"/, 'the side column');
    assert.match(r.text, /Text channels/, 'the channel categories');
    assert.match(r.text, /Voice channels/);
    assert.match(r.text, /class="oc-you"/, 'the you-bar');
    assert.match(r.text, /class="oc-col oc-col-members"/, 'the members column');
    assert.match(r.text, /<h3 class="oc-side-group">Owner/, 'the people, grouped by role');
    assert.match(r.text, /data-oc-user="\d+"/, 'every name opens the shared user popout');
    // The phone's bottom bar is Shared's app bar (five places).
    assert.match(r.text, /"label":"Home","href":"\/messages"/);
    assert.match(r.text, /"label":"Servers","href":"\/servers"/);
    assert.match(r.text, /"label":"Vibe","href":"\/vibe"/);
    assert.match(r.text, /"label":"Activity","href":"\/notifications"/);
    assert.match(r.text, /"label":"You","href":"\/settings"/);
});

t('Home: the DMs and the people you talk to down the side', async () => {
    const conv = await dmApi('POST', '/conversations', dee, { user_ids: [bob.id] });
    const id = (conv.body.conversation && conv.body.conversation.id) || conv.body.id;
    await dmApi('POST', `/conversations/${id}/messages`, dee, { message: 'Saturday?' });
    const r = await page('/messages', dee);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /id="oc-side-dms"/, 'the DMs in the side column');
    assert.match(r.text, /id="oc-side-friends"/, 'Friends');
    assert.match(r.text, /id="oc-side-requests"/, 'Requests');
    assert.match(r.text, /Find or start a conversation/);
    assert.match(r.text, /Saturday\\?/, 'the last line of the conversation');
});

t('friends and requests: add, list, accept and remove', async () => {
    const added = await dmApi('POST', '/contacts', dee, { username: 'bob' });
    assert.strictEqual(added.status, 200);
    assert.strictEqual(added.body.status, 'outgoing');
    const list = await dmApi('GET', '/contacts', dee);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.requests.length, 0, 'the request waits for them');
    assert.strictEqual(list.body.asked.length, 1, 'and you see that you asked');
    const theirs = await dmApi('GET', '/contacts', bob);
    assert.strictEqual(theirs.body.requests.length, 1, 'and they see the request');
    assert.strictEqual((await dmApi('POST', `/contacts/${dee.id}/accept`, bob)).status, 200);
    const friends = await dmApi('GET', '/contacts', dee);
    assert.strictEqual(friends.body.friends.length, 1, 'both are friends now');
    assert.match((await page('/messages', dee)).text, /id="oc-side-friends"/);
    assert.strictEqual((await dmApi('DELETE', `/contacts/${bob.id}`, dee)).status, 200);
    assert.strictEqual((await dmApi('GET', '/contacts', dee)).body.friends.length, 0);
    // A blocked person is never a friend.
    await dmApi('POST', `/blocks/${bob.id}`, dee);
    assert.strictEqual((await dmApi('POST', '/contacts', dee, { username: 'bob' })).status, 403);
});

t('Explore: the chips, the cards and the Start sheet', async () => {
    const r = await page('/servers', dee);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /class="oc-chips"/);
    for (const c of ['Gaming', 'Streams', 'Dev', 'Art', 'Music', 'Study', 'AI']) assert.match(r.text, new RegExp(`>${c}</a>`), `the ${c} chip`);
    assert.match(r.text, /oc-server-card/, 'the servers as cards');
    assert.match(r.text, /id="oc-new-server"/, 'the Start sheet');
    for (const [id, name] of [['friends', 'Friends'], ['gaming', 'Gaming group'], ['streams', 'Stream community'], ['study', 'Study group'], ['creators', 'Creators'], ['blank', 'Blank']]) {
        assert.match(r.text, new RegExp(`value="${id}"`), `the ${name} template`);
    }
    assert.match(r.text, /name="visibility" value="public"/);
    assert.match(r.text, /name="visibility" value="private"/);
    assert.doesNotMatch(r.text, /No other public server yet\\./);
    // A search and a category filter.
    assert.match(r.text, /name="q"/);
    assert.match((await page('/servers?category=Gaming', dee)).text, /class="oc-chip is-active"[^>]*>Gaming</);
});

t('a server starts from a template and ends with its invite link', async () => {
    const form = new URLSearchParams({ name: 'Book Club', template: 'gaming', category: 'Study', visibility: 'public' });
    const res = await fetch(`${h.base}/servers/new`, { method: 'POST', headers: { cookie: `ov_token=${dee.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
    assert.strictEqual(res.status, 303);
    const location = res.headers.get('location');
    assert.match(location, /^\/s\/book-club\?invite=[a-z0-9]+$/, 'the invite link at the end');
    const slug = location.split('/')[2].split('?')[0];
    const server = await api('GET', `/${slug}`, dee);
    const names = server.body.channels.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['clips', 'general', 'looking-for-group', 'voice'], 'the template\'s channels');
    assert.strictEqual(server.body.server.category, 'Study');
    assert.strictEqual(server.body.server.template, 'gaming');
    const shown = await page(location, dee);
    assert.match(shown.text, /Your invite link/, 'the invite is shown');
    assert.match(shown.text, /\/join\/[a-z0-9]+/);
});

t('contacts module: add, accept and remove directly', async () => {
    await contactsMod.add(cat.id, dee.id);
    let c = await contactsMod.of(cat.id);
    assert.strictEqual(c.asked.length, 1, 'cat asked dee');
    assert.ok(await contactsMod.accept(dee.id, cat.id), 'dee accepts');
    c = await contactsMod.of(cat.id);
    assert.strictEqual(c.friends.length, 1, 'they are friends');
    assert.ok(await contactsMod.remove(cat.id, dee.id), 'cat removes dee');
    c = await contactsMod.of(cat.id);
    assert.strictEqual(c.friends.length, 0, 'no longer friends');
});

t('view defaults: Chat table and DM-routes view endpoints', async () => {
    // Chat's own dm_view_defaults table (used while Contracts lacks a view_defaults field).
    assert.deepStrictEqual(await viewDefaults.of(dee.id), viewDefaults.FALLBACK, 'fallbacks when empty');
    await viewDefaults.save(dee.id, { one_to_one: 'room', group: 'bubbles' });
    const saved = await viewDefaults.of(dee.id);
    assert.strictEqual(saved.one_to_one, 'room');
    assert.strictEqual(saved.group, 'bubbles');
    assert.strictEqual(saved.ai, viewDefaults.FALLBACK.ai);
    // The DM-routes view endpoint reads the Network chat.preferences default, then a per-conversation override.
    h.netModules.set('chat.preferences', dee.subject_id, { view_defaults: { one_to_one: 'room', group: 'room' } });
    // Drop any cached empty record from earlier page renders so the Network write is read.
    require('../server/prefs/stores').preferences.invalidate(dee.subject_id);
    // Use cat (bob was blocked in the previous contacts test).
    const conv = await dmApi('POST', '/conversations', dee, { user_ids: [cat.id] });
    const id = conv.body.conversation.id;
    const get = await dmApi('GET', `/conversations/${id}/view`, dee);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.body.view, 'room', 'conversation inherits the one_to_one default');
    const put = await dmApi('PUT', `/conversations/${id}/view`, dee, { view: 'bubbles' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.view, 'bubbles');
    assert.strictEqual((await dmApi('GET', `/conversations/${id}/view`, dee)).body.view, 'bubbles');
    const bad = await dmApi('PUT', `/conversations/${id}/view`, dee, { view: 'tiles' });
    assert.strictEqual(bad.status, 400);
});

t('server-pages module exports the page mount function', async () => {
    assert.strictEqual(typeof serverPages.mountServerPages, 'function');
});

t('dm-routes module is an Express router', async () => {
    assert.ok(dmRoutes, 'dm-routes loaded');
    assert.strictEqual(typeof dmRoutes, 'function');
    assert.strictEqual(typeof dmRoutes.get, 'function');
});

t('chat-shell.js runs in a browser sandbox and opens the Start sheet', async () => {
    const vm = require('vm');
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../public/web/chat-shell.js'), 'utf8');
    let opened = false;
    let focused = false;
    let panelName = 'main';
    const sheet = {
        open: false,
        id: 'oc-new-server',
        set open(v) { this._open = v; opened = v; },
        get open() { return this._open; },
        closest: () => ({ offsetTop: 100, scrollTo() {} }),
        querySelector: (sel) => {
            if (sel.includes('input')) return { focus() { focused = true; } };
            return null;
        },
    };
    const appEl = {
        getAttribute: () => panelName,
        setAttribute: (k, v) => { if (k === 'data-oc-panel') panelName = v; },
        classList: { toggle: () => {} },
        addEventListener: () => {},
        querySelectorAll: () => [],
    };
    const document = {
        cookie: `ov_token=${dee.token}`,
        querySelector: (sel) => (sel === '[data-oc-app]' ? appEl : null),
        querySelectorAll: () => [],
        getElementById: (id) => (id === 'oc-new-server' ? sheet : null),
        documentElement: { classList: { add: () => {} } },
        addEventListener: () => {},
        createElement: () => ({ setAttribute: () => {}, addEventListener: () => {} }),
        head: { appendChild: () => {} },
    };
    const window = {
        OpenVibeUserCard: null,
        OpenVibeUserMenu: null,
        matchMedia: () => ({ matches: false }),
        addEventListener: () => {},
        location: { hash: '#oc-new-server' },
        history: { replaceState: () => {} },
        navigator: { clipboard: null },
    };
    vm.runInNewContext(src, { window, document, navigator: window.navigator, location: window.location });
    assert.strictEqual(opened, true, 'the Start sheet opens on #oc-new-server');
    assert.strictEqual(focused, true, 'the first field is focused');
});

t.run(async () => { if (h && h.close) await h.close(); });
