'use strict';
/**
 * Onboarding on joining a server (the plan, 2026-11-09, stage V3): the server's rules, if it has any, then the roles
 * a member may pick. Owners edit both in the server's settings (server/rooms/servers.js, server/web/server-pages.js).
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('onboarding');
let h, ann, bob, servers;
const api = (method, path, u, body) => h.http(method, `/api/chat/servers${path}`, { token: u && u.token, body });
const get = async (path, u) => {
    const r = await fetch(`${h.base}${path}`, { headers: u ? { cookie: `ov_token=${u.token}` } : {} });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
const post = async (path, u, fields) => {
    const r = await fetch(`${h.base}${path}`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: `ov_token=${u.token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });
    return { status: r.status, location: r.headers.get('location') };
};

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    servers = require('../server/rooms/servers');
});

t('a server with rules and roles shows them on joining: the rules first, then the roles', async () => {
    const made = await api('POST', '/', ann, { name: 'Book Club' });
    const slug = made.body.server.slug;
    let server = await servers.bySlug(slug);
    await servers.update(server, h.live.users.get(ann.id), { rules: 'Be kind.\nNo spoilers.', self_roles: [{ name: 'Reader', color: '#ff2255' }] });
    server = await servers.bySlug(slug);

    const joined = await post(`/s/${slug}/join`, bob, {});
    assert.deepStrictEqual([joined.status, joined.location], [303, `/s/${slug}/welcome`], 'a new member goes to onboarding');

    const welcome = await get(`/s/${slug}/welcome`, bob);
    assert.strictEqual(welcome.status, 200);
    assert.match(welcome.text, /class="oc-app"/, 'inside the app shell');
    assert.match(welcome.text, /Be kind\.\nNo spoilers\./, 'the rules, with their lines');
    assert.match(welcome.text, /name="roles" value="Reader"/, 'a role to pick');
    assert.ok(welcome.text.indexOf('Be kind.') < welcome.text.indexOf('Pick your roles'), 'the rules come first');

    const done = await post(`/s/${slug}/welcome`, bob, { roles: 'Reader' });
    assert.deepStrictEqual([done.status, done.location], [303, `/s/${slug}`]);
    assert.deepStrictEqual(await servers.memberRoles(server, bob.id), ['Reader'], 'the pick is saved');

    const channel = await get(`/s/${slug}`, ann);
    assert.match(channel.text, /@bob · Reader/, 'the people column shows the role they picked');
});

t('owners edit the rules and the roles; a member cannot', async () => {
    const server = await servers.bySlug('book-club');
    const saved = await post('/s/book-club/onboarding', ann, { rules: 'New rules' });
    assert.strictEqual(saved.status, 303);
    assert.match(saved.location, /^\/s\/book-club\/settings\?saved=1#oc-onboarding$/);
    assert.strictEqual((await servers.bySlug('book-club')).rules, 'New rules');

    const added = await post('/s/book-club/roles', ann, { name: 'Host', color: '#00ff00' });
    assert.strictEqual(added.status, 303);
    assert.deepStrictEqual(servers.selfRolesOf(await servers.bySlug('book-club')).map((r) => r.name), ['Reader', 'Host']);

    const settings = await get('/s/book-club/settings', ann);
    assert.match(settings.text, /id="oc-onboarding"/, 'the section is in the server settings');
    assert.match(settings.text, /name="rules"/, 'the rules are editable');
    assert.match(settings.text, /value="Reader"/, 'the roles are listed');

    const removed = await post('/s/book-club/roles/delete', ann, { name: 'Host' });
    assert.strictEqual(removed.status, 303);
    assert.deepStrictEqual(servers.selfRolesOf(await servers.bySlug('book-club')).map((r) => r.name), ['Reader']);

    // A permission word is not a role to pick.
    const bad = await post('/s/book-club/roles', ann, { name: 'admin' });
    assert.match(bad.location, /^\/s\/book-club\/settings\?error=/, 'refused');
    assert.deepStrictEqual(servers.selfRolesOf(await servers.bySlug('book-club')).map((r) => r.name), ['Reader']);

    // Bob is a member, not an owner or an admin.
    const refused = await post('/s/book-club/onboarding', bob, { rules: 'Hacked' });
    assert.match(refused.location, /^\/s\/book-club\/settings\?error=/);
    assert.strictEqual((await servers.bySlug('book-club')).rules, 'New rules');

    assert.ok(server, 'the server is there');
});

t('a server with no rules and no roles joins straight into its channels', async () => {
    const made = await api('POST', '/', ann, { name: 'Plain Server' });
    const slug = made.body.server.slug;
    const joined = await post(`/s/${slug}/join`, bob, {});
    assert.deepStrictEqual([joined.status, joined.location], [303, `/s/${slug}`], 'no onboarding page');
    assert.strictEqual((await get(`/s/${slug}/welcome`, bob)).status, 200, 'and the page is harmless if visited');
});

t.run(async () => { if (h && h.close) await h.close(); });
