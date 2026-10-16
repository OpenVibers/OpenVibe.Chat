'use strict';
/**
 * Servers (migration 0013, server/rooms/servers.js): a server starts with #general and a voice Lounge; a public one is
 * read by anyone and joined by signed-in people, a private one is a 404 to outsiders and is joined through an invite
 * (uses, expiry, revoke). One membership and one set of roles for every channel: the owner appoints admins, admins
 * appoint moderators and manage channels and invites, moderators remove and ban members, nobody acts on their own rank
 * or above; it is all logged. A channel is a room: messages over REST and the socket, unread counts, the voice
 * channel's call roles; the rooms API refuses room-level joins and roles there, and rooms lists leave channels out.
 * The site: the directory, a server's page, settings by rank, an invite page, /r/<channel> going to its server.
 * Deleting an account removes its memberships; a server it owned stays without an owner while anyone is in it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('servers');
let h, ann, bob, cat, dee, eve, staff;
const api = (method, path, u, body) => h.http(method, `/api/chat/servers${path}`, { token: u && u.token, body });
const roomApi = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const page = async (path, u, { method = 'GET', form = null } = {}) => {
    const headers = { ...(u ? { cookie: `ov_token=${u.token}` } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
const ev = (type, payload) => ({ event_id: ids.newId('event'), event_type: type, version: 1, source: 'network', actor: { type: 'user', id: payload.subject },
    timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: payload.subject }, payload });
let general, lounge;

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    dee = h.addUser('dee', { subject: ids.newId('user') });
    eve = h.addUser('eve', { subject: ids.newId('user') });
    staff = h.addUser('staffer', { subject: ids.newId('user'), role: 'global_mod' });
    for (const u of [ann, bob, cat, dee, eve, staff]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('create: #general and a voice Lounge, the owner, and the rules on names', async () => {
    const r = await api('POST', '/', ann, { name: 'Saturday Raiders', description: 'Raids on Saturdays' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.server.slug, r.body.server.role, r.body.server.members], ['saturday-raiders', 'owner', 1]);
    assert.strictEqual((await api('POST', '/', bob, { name: 'Saturday Raiders' })).status, 409);
    assert.strictEqual((await api('POST', '/', bob, { name: 'x' })).status, 422);
    assert.strictEqual((await api('POST', '/', bob, { name: 'Settings', slug: 'settings' })).status, 422, 'reserved');
    assert.strictEqual((await api('POST', '/', null, { name: 'Anon' })).status, 401);
    const s = (await api('GET', '/saturday-raiders', ann)).body;
    assert.deepStrictEqual(s.channels.map((c) => [c.slug, c.kind]), [['general', 'text'], ['lounge', 'voice']]);
    general = s.channels[0].room; lounge = s.channels[1].room;
    assert.match(general, /^ch[a-z2-9]{12}$/);
    assert.deepStrictEqual(s.can, { read: true, member: true, moderate: true, manage: true, owner: true });
    assert.ok(!(await roomApi('GET', '/', ann)).body.public.some((x) => x.slug === general), 'channels are not in the rooms list');
});

t('a public server: anyone reads, signed-in people join and write; unread counts; the rooms API defers to the server', async () => {
    assert.strictEqual((await api('GET', '/saturday-raiders', null)).status, 200);
    assert.strictEqual((await roomApi('GET', `/${general}/messages`, null)).status, 200, 'its channels read signed out');
    let r = await roomApi('POST', `/${general}/messages`, bob, { message: 'hi' });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'rooms.join_first']);
    assert.deepStrictEqual([(await roomApi('POST', `/${general}/join`, bob)).status, (await roomApi('POST', `/${general}/join`, bob)).body.code], [409, 'rooms.server_channel']);
    assert.strictEqual((await api('POST', '/saturday-raiders/join', bob)).body.role, 'member');
    assert.strictEqual((await roomApi('POST', `/${general}/messages`, bob, { message: 'hello raiders' })).status, 201);
    assert.strictEqual((await roomApi('POST', `/${general}/messages`, bob, { message: 'anyone on tonight?' })).status, 201);
    let mine = (await api('GET', '/', ann)).body.mine;
    assert.strictEqual(mine.find((x) => x.slug === 'saturday-raiders').unread, 2);
    assert.strictEqual((await api('GET', '/saturday-raiders', ann)).body.channels[0].unread, 2);
    await roomApi('POST', `/${general}/read`, ann, {});
    mine = (await api('GET', '/', ann)).body.mine;
    assert.strictEqual(mine.find((x) => x.slug === 'saturday-raiders').unread, 0);
    assert.strictEqual((await api('GET', '/', null)).body.public.find((x) => x.slug === 'saturday-raiders').members, 2);
    r = await roomApi('GET', `/${general}/members`, ann);
    assert.deepStrictEqual(r.body.members.map((m) => [m.username, m.role]), [['ann', 'owner'], ['bob', 'member']], 'a channel\'s people are the server\'s');
    assert.strictEqual((await roomApi('POST', `/${general}/members`, ann, { username: 'cat', role: 'member' })).body.code, 'rooms.server_channel');
});

t('the socket: a member joins a channel like a room and gets its messages live', async () => {
    const annWs = await h.ws({ token: ann.token }); annWs.sendJson({ type: 'join_room', room: general });
    assert.strictEqual((await annWs.next((m) => m.type === 'room_joined')).role, 'owner');
    const bobWs = await h.ws({ token: bob.token }); bobWs.sendJson({ type: 'join_room', room: general });
    assert.strictEqual((await bobWs.next((m) => m.type === 'room_joined')).role, 'member');
    bobWs.sendJson({ type: 'room_message', message: 'live in #general' });
    const got = await annWs.next((m) => m.type === 'room_message' && m.message.message === 'live in #general');
    assert.strictEqual(got.room, general);
    annWs.close(); bobWs.close();
});

t('roles: the owner appoints admins, admins appoint mods, mods remove and ban members, never upward; logged', async () => {
    for (const u of [cat, dee, eve]) await api('POST', '/saturday-raiders/join', u);
    assert.strictEqual((await api('POST', '/saturday-raiders/members', bob, { username: 'cat', role: 'mod' })).status, 403, 'a member manages nobody');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', ann, { username: 'bob', role: 'admin' })).body.role, 'admin');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', bob, { username: 'cat', role: 'admin' })).status, 403, 'only the owner appoints admins');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', bob, { username: 'cat', role: 'mod' })).body.role, 'mod');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', cat, { username: 'dee', role: 'mod' })).status, 403, 'mods do not appoint mods');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', cat, { username: 'bob', role: 'none' })).status, 403, 'a mod cannot remove an admin');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', bob, { username: 'ann', role: 'member' })).status, 403, 'nobody changes the owner');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', cat, { username: 'dee', role: 'none' })).body.role, null, 'a mod removes a member');
    assert.strictEqual((await api('POST', '/saturday-raiders/members', cat, { username: 'eve', role: 'blocked' })).body.role, 'blocked');
    assert.deepStrictEqual([(await api('POST', '/saturday-raiders/join', eve)).status, (await api('POST', '/saturday-raiders/join', eve)).body.code], [403, 'servers.blocked']);
    assert.strictEqual((await roomApi('GET', `/${general}/messages`, eve)).status, 404, 'banned: not even reading');
    const lounges = (await roomApi('GET', `/${lounge}`, cat)).body.can;
    assert.ok(lounges.talk && lounges.moderate, 'a mod talks and moderates in voice');
    assert.ok((await roomApi('GET', `/${lounge}`, bob)).body.can.manage, 'an admin manages the channels');
    const log = await require('../server/db/database').all("SELECT action_type FROM moderation_actions WHERE scope_type = 'server' ORDER BY id");
    assert.deepStrictEqual(log.map((x) => x.action_type), ['server_role_admin', 'server_role_mod', 'server_kick', 'server_ban']);
    assert.strictEqual((await api('GET', '/saturday-raiders/members', bob)).body.members.some((m) => m.role === 'blocked'), true, 'moderators see bans');
    assert.strictEqual((await api('GET', '/saturday-raiders/members', null)).body.members.some((m) => m.role === 'blocked'), false);
});

t('channels: admins add, rename, move and delete them; a server keeps one text channel; voice follows the join role', async () => {
    assert.strictEqual((await api('POST', '/saturday-raiders/channels', cat, { name: 'mods only' })).status, 403, 'mods do not add channels');
    let r = await api('POST', '/saturday-raiders/channels', bob, { name: 'Announcements', topic: 'News' });
    assert.deepStrictEqual([r.status, r.body.channel.slug, r.body.channel.kind], [201, 'announcements', 'text']);
    r = await api('POST', '/saturday-raiders/channels', bob, { name: 'Settings', kind: 'voice' });
    assert.strictEqual(r.body.channel.slug, 'settings-voice', 'a channel never takes a page\'s address');
    await api('PATCH', '/saturday-raiders/channels/announcements', bob, { move: 'up' });
    assert.deepStrictEqual((await api('GET', '/saturday-raiders', bob)).body.channels.filter((c) => c.kind === 'text').map((c) => c.slug), ['announcements', 'general']);
    r = await api('PATCH', '/saturday-raiders/channels/lounge', bob, { join_role: 'participant' });
    assert.strictEqual(r.body.channel.join_role, 'participant');
    assert.strictEqual((await roomApi('GET', `/${lounge}`, cat)).body.can.talk, true, 'mods still talk');
    const dee2 = (await api('POST', '/saturday-raiders/join', dee)).body.role;
    assert.strictEqual(dee2, 'member');
    assert.strictEqual((await roomApi('GET', `/${lounge}`, dee)).body.can.talk, false, 'members listen in a participant channel');
    assert.strictEqual((await api('DELETE', '/saturday-raiders/channels/announcements', bob)).status, 204);
    assert.deepStrictEqual([(await api('DELETE', '/saturday-raiders/channels/general', bob)).status, (await api('DELETE', '/saturday-raiders/channels/general', bob)).body.code], [409, 'servers.last_channel']);
    assert.strictEqual((await roomApi('PATCH', `/${general}`, ann, { visibility: 'private' })).body.code, 'rooms.server_channel', 'a channel is as public as its server');
});

t('private servers: invisible to outsiders, joined through an invite with uses and expiry, revocable', async () => {
    const r = await api('POST', '/', ann, { name: 'Ann and Bob', visibility: 'private' });
    assert.strictEqual(r.status, 201);
    const room = (await api('GET', '/ann-and-bob', ann)).body.channels[0].room;
    assert.strictEqual((await api('GET', '/ann-and-bob', bob)).status, 404);
    assert.strictEqual((await api('POST', '/ann-and-bob/join', bob)).status, 404, 'as missing as a server that does not exist');
    assert.strictEqual((await roomApi('GET', `/${room}/messages`, bob)).status, 404);
    assert.ok(!(await api('GET', '/', bob)).body.public.some((x) => x.slug === 'ann-and-bob'), 'not listed');
    const inv = await api('POST', '/ann-and-bob/invites', ann, { max_uses: 1, expires_hours: 24 });
    assert.strictEqual(inv.status, 201, inv.text);
    assert.match(inv.body.url, /\/join\/[a-z2-9]{10}$/);
    const code = inv.body.invite.code;
    assert.strictEqual((await api('GET', `/invites/${code}`, null)).body.server.name, 'Ann and Bob', 'the code shows what it opens');
    assert.strictEqual((await api('POST', '/ann-and-bob/join', bob, { invite: code })).body.role, 'member');
    assert.strictEqual((await roomApi('POST', `/${room}/messages`, bob, { message: 'thanks for the invite' })).status, 201);
    const used = await api('POST', '/ann-and-bob/join', cat, { invite: code });
    assert.deepStrictEqual([used.status, used.body.code], [410, 'servers.invite_invalid'], 'used up (the code already told cat the server exists)');
    assert.strictEqual((await api('GET', `/invites/${code}`, null)).status, 404);
    const again = (await api('POST', '/ann-and-bob/invites', ann, {})).body.invite.code;
    assert.strictEqual((await api('POST', '/ann-and-bob/invites', bob, {})).status, 403, 'members do not invite to a private server');
    assert.strictEqual((await api('DELETE', `/ann-and-bob/invites/${again}`, ann)).status, 204);
    assert.strictEqual((await api('POST', '/ann-and-bob/join', cat, { invite: again })).status, 410, 'revoked');
    assert.strictEqual((await api('GET', '/ann-and-bob', cat)).status, 404, 'still not there for cat');
    assert.strictEqual((await api('GET', '/ann-and-bob', staff)).status, 200, 'chat staff can look in');
});

t('going private: the channels follow and outsiders lose them; deleting the server takes everything', async () => {
    assert.strictEqual((await api('PATCH', '/saturday-raiders', bob, { visibility: 'private' })).body.server.visibility, 'private');
    assert.strictEqual((await require('../server/db/database').get('SELECT visibility FROM rooms WHERE slug = ?', [general])).visibility, 'private');
    assert.strictEqual((await roomApi('GET', `/${general}/messages`, null)).status, 404);
    assert.strictEqual((await roomApi('GET', `/${general}/messages`, dee)).status, 200, 'members still read');
    await api('PATCH', '/saturday-raiders', bob, { visibility: 'public' });
    const tmp = (await api('POST', '/', bob, { name: 'Short Lived' })).body.server;
    assert.strictEqual((await api('DELETE', `/${tmp.slug}`, ann)).status, 403, 'only its owner deletes a server');
    assert.strictEqual((await api('DELETE', `/${tmp.slug}`, bob)).status, 204);
    assert.strictEqual((await api('GET', `/${tmp.slug}`, bob)).status, 404);
});

t('the site: directory, a server page, settings by rank, an invite page, /r/<channel> goes to its server', async () => {
    let r = await page('/servers', null);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Saturday Raiders/);
    assert.doesNotMatch(r.text, /Ann and Bob/, 'private servers are not listed');
    r = await page('/s/saturday-raiders', dee);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /class="oc-srv"/);
    assert.match(r.text, /aria-current="page"[^>]*>.*general/s);
    assert.match(r.text, /Voice channels/);
    assert.match(r.text, /<h3 class="oc-srv-group">Owner/);
    assert.match(r.text, /id="oc-compose"/, 'a member writes');
    assert.doesNotMatch(r.text, /Server settings/, 'a member sees no settings');
    r = await page('/s/saturday-raiders/lounge', null);
    assert.match(r.text, /<section class="oc-call"/, 'a voice channel shows its call (here: calls are off in tests)');
    assert.match(r.text, /Sign in with OpenVibe/);
    r = await page(`/r/${general}`, dee);
    assert.deepStrictEqual([r.status, r.location], [302, '/s/saturday-raiders/general']);
    r = await page('/s/saturday-raiders/settings', ann);
    assert.match(r.text, /<h2>Channels<\/h2>/);
    assert.match(r.text, /id="oc-invites"/);
    assert.match(r.text, /Delete the server/);
    r = await page('/s/saturday-raiders/settings', cat);
    assert.doesNotMatch(r.text, /<h2>Channels<\/h2>/, 'a mod sees members and invites, not channels');
    assert.match(r.text, /<h2>Members/);
    assert.strictEqual((await page('/s/saturday-raiders/settings', dee)).status, 303, 'a member is sent back');
    r = await page('/s/saturday-raiders/general', dee, { method: 'POST', form: { message: 'from the form' } });
    assert.strictEqual(r.status, 303);
    assert.match((await page('/s/saturday-raiders/general', dee)).text, /from the form/);
    r = await page('/servers/new', cat, { method: 'POST', form: { name: 'Book Club', private: '1' } });
    assert.deepStrictEqual([r.status, r.location], [303, '/s/book-club']);
    const code = (await api('POST', '/book-club/invites', cat, {})).body.invite.code;
    r = await page(`/join/${code}`, dee);
    assert.match(r.text, /You are invited to/);
    assert.match(r.text, /Book Club/);
    r = await page(`/join/${code}`, dee, { method: 'POST', form: {} });
    assert.deepStrictEqual([r.status, r.location], [303, '/s/book-club']);
    assert.strictEqual((await page('/join/nosuchcode', dee)).status, 404);
    assert.match((await page('/sitemap.xml', null)).text, /\/s\/saturday-raiders/);
    assert.doesNotMatch((await page('/sitemap.xml', null)).text, /book-club/);
});

t('account deletion: memberships go; an owned server stays without an owner while people are in it', async () => {
    const accountData = require('../server/chat/account-data');
    const d = require('../server/db/database');
    const sent = [];
    const send = async (p, body) => { sent.push({ path: p, body }); return { ok: true, status: 200 }; };
    const solo = (await api('POST', '/', ann, { name: 'Just Ann' })).body.server;
    const del = ev('network.account.deleted', { deletion_id: `del_${ids.ulid()}`, subject: ann.subject_id, aliases: [], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() });
    assert.strictEqual(await accountData.apply(del, { send }), 'erased');
    const raiders = await d.get("SELECT owner_subject, archived_at FROM chat_servers WHERE slug = 'saturday-raiders'");
    assert.deepStrictEqual([raiders.owner_subject, raiders.archived_at], [null, null], 'the server stays for its people');
    assert.strictEqual(await d.get('SELECT 1 FROM chat_servers WHERE id = ?', [solo.id]), undefined, 'a server with nobody else goes');
    assert.strictEqual((await d.all('SELECT * FROM chat_server_members WHERE user_id = ?', [ann.id])).length, 0);
    assert.ok(sent[0].body.erased.servers >= 1 && sent[0].body.retained.servers_without_owner >= 1, JSON.stringify(sent[0].body));
});

t.run(async () => { if (h && h.close) await h.close(); });
