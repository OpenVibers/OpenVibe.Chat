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
    for (const u of [dee, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
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
    assert.match(r.text, /<span class="oc-rail-label">Home<\/span>/);
    assert.match(r.text, /<span class="oc-rail-label">Vibe<\/span>/);
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
    assert.match(r.text, /"label":"Activity","href":"\/activity"/, 'Activity is a page that exists');
    assert.match(r.text, /"label":"You","href":"\/settings"/);
    assert.match(r.text, /"label":"Servers","href":"\/servers","icon":"fa-people-group"/, 'Servers is not the globe: that is Global chat');
    // Every place on the rail carries its name; a server carries what its sheet says (hold it, or right-click it).
    assert.match(r.text, /class="oc-rail-icon oc-rail-server is-active" href="\/s\/saturday-raiders"[^>]* data-oc-server="saturday-raiders" data-oc-name="Saturday Raiders" data-oc-role="owner" data-oc-members="2"/, 'the open server, with your rank in it');
    assert.match(r.text, /<span class="oc-rail-label">Saturday Raiders<\/span>/, 'its name, not its initials alone');
    assert.match(r.text, /<button type="button" class="oc-rail-menu" data-oc-panel="side" aria-expanded="false"[^>]*>.*<span class="oc-rail-label">Channels<\/span><\/button>/, 'the list button says what it lists');
    assert.match(r.text, /<template id="oc-srv-sheet"><dialog class="oc-ssheet"/, "a server's sheet, once a page");
    assert.ok(/data-s="settings"/.test(r.text) && /data-s="delete"/.test(r.text) && !/data-s="leave"/.test(r.text), 'the owner: settings and delete, and no leave (an owner cannot leave)');
    const asBob = await page(`/s/${slug}`, bob);
    assert.ok(/data-s="leave"/.test(asBob.text) && !/data-s="settings"/.test(asBob.text) && !/data-s="delete"/.test(asBob.text), 'a member: leave, and not a word about settings or deleting');
    // One composer: a box, Send on its right; no picture store in this run, so no Add.
    assert.match(r.text, /<form class="oc-compose" method="post" action="\/s\/saturday-raiders\/general" id="oc-compose">/);
    assert.match(r.text, /<div class="oc-compose-box"><div class="oc-compose-tray" data-oc-tray hidden><\/div>/);
    assert.match(r.text, /<textarea id="oc-input" name="message" maxlength="2000" rows="1" required placeholder="Message #general"><\/textarea><button type="submit" class="oc-send" aria-label="Send"/);
});

t('Activity: what is waiting for you, and nothing waiting said as that', async () => {
    let r = await page('/activity', bob);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /<h1[^>]*>Activity<\/h1>/);
    assert.match(r.text, /You are all caught up/, 'nothing waiting is said as that');
    assert.match(r.text, /href="\/messages">Open your messages<\/a>/);
    assert.ok(!/href="\/notifications"/.test(r.text), 'nothing links to the page that never was');
    // Dee writes in the server Bob joined: it is waiting for Bob, under the server, by channel.
    const sent = await fetch(`${h.base}/s/saturday-raiders/general`, { method: 'POST', redirect: 'manual', headers: { cookie: `ov_token=${dee.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'message=raid+at+nine' });
    assert.strictEqual(sent.status, 303);
    r = await page('/activity', bob);
    assert.match(r.text, /In your servers <span class="oc-muted">1<\/span>/);
    assert.match(r.text, /class="oc-act-server-head" href="\/s\/saturday-raiders"/);
    assert.match(r.text, /<a class="oc-chan is-unread" href="\/s\/saturday-raiders\/general">/);
    assert.ok(!/You are all caught up/.test(r.text));
    const out = await page('/activity', null);
    assert.ok(out.status !== 404 && /Sign in/.test(out.text) && !/In your servers/.test(out.text), 'signed out: the way to sign in, and nothing of anyone');
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
    assert.match(r.text, /<span class="oc-card-yours">You own it<\/span> · 2 members/, 'your rank in a server you are in');
    assert.match(r.text, /class="oc-icon-btn oc-card-more" href="\/s\/saturday-raiders" aria-label="More about Saturday Raiders"/, 'and the way to its sheet');
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

t('the rest of chat is inside the shell too: Global chat, Rooms, a room, settings and the inbox', async () => {
    // A server, so the rail has one, and a standalone room with a message.
    const made = await api('POST', '/', dee, { name: 'Shell Pages', description: 'Pages in the shell' });
    const slug = made.body.server.slug;
    const roomRes = await fetch(`${h.base}/rooms/new`, { method: 'POST', headers: { cookie: `ov_token=${dee.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Shell Room' }).toString(), redirect: 'manual' });
    assert.strictEqual(roomRes.status, 303);
    const roomPath = roomRes.headers.get('location');
    assert.match(roomPath, /^\/r\/shell-room$/);

    // Global chat: the rail's Global entry is current, Home's side column, the feed and its composer.
    let r = await page('/', dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on Global chat');
    assert.match(r.text, /class="oc-rail-icon oc-rail-global is-active" href="\/"/, 'Global chat on the rail');
    assert.match(r.text, /class="oc-side"/, 'Home down the side');
    assert.match(r.text, /id="oc-feed"/, 'the global feed');
    assert.match(r.text, /id="oc-compose"/, 'and the composer');

    // Rooms: the side column lists them.
    r = await page('/rooms', dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on Rooms');
    assert.match(r.text, /id="oc-side-your-rooms"/, 'your rooms down the side');
    assert.match(r.text, /href="\/r\/shell-room"/, 'the room is a row');
    assert.match(r.text, /id="oc-new-room"/, 'the Start form is still the page');

    // A room: the same side column and the room's feed in the middle.
    r = await page(roomPath, dee);
    assert.match(r.text, /class="oc-app"/, 'the shell in a room');
    assert.match(r.text, /class="oc-chan is-active" href="\/r\/shell-room" aria-current="page"/, 'the room is marked in the side column');
    assert.match(r.text, /id="oc-feed"/, 'the room feed');

    // Settings: the shell's page gutter and its own sections down the side.
    r = await page('/settings', dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on settings');
    assert.match(r.text, /class="oc-page"/, 'the settings page scrolls in the gutter');
    assert.match(r.text, /id="oc-side-set"/, 'the settings sections down the side');

    // A room's settings and a server's settings.
    r = await page('/r/shell-room/settings', dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on a room\'s settings');
    assert.match(r.text, /class="oc-page"/);
    r = await page(`/s/${slug}/settings`, dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on a server\'s settings');
    assert.match(r.text, /class="oc-page"/);
    assert.match(r.text, /id="oc-invites"/, 'the settings are still the page');

    // The inbox: the list is a page, the conversation like a DM.
    const madeInbox = await fetch(`${h.base}/inbox`, { method: 'POST', headers: { cookie: `ov_token=${dee.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Shell Support' }).toString(), redirect: 'manual' });
    assert.strictEqual(madeInbox.status, 303);
    const inboxId = (madeInbox.headers.get('location') || '').split('/')[2];
    assert.ok(inboxId, 'an inbox was made');
    r = await page('/inbox', dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on the inbox list');
    assert.match(r.text, /class="oc-page"/);
    assert.match(r.text, /id="oc-side-inboxes"/, 'your inboxes down the side');
    r = await page(`/inbox/${inboxId}`, dee);
    assert.match(r.text, /class="oc-app"/, 'the shell on a conversation');
    assert.match(r.text, /id="ib-rail"/, 'the conversations are the side column');
    assert.match(r.text, /data-ovt-thread/, 'the kit\'s thread is the middle');
});

t.run(async () => { if (h && h.close) await h.close(); });
