'use strict';
/**
 * The cards of a message (server/chat/link-previews.js, server/rooms/routes.js):
 *
 *   - taking them back: the message's author, the room's owner and its moderators may hide them, nobody else
 *     may; a hidden card is not sent on a read, the room is told at once, and the cards can be put back;
 *   - the room's switch: its owner and its moderators turn the cards off and on again;
 *   - the page's own picture: it is brought into OpenVibe.Media (server/chat/media-import.js) and the card
 *     shows the Media address, never a hot-linked one.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const t = suite('link preview cards');
let h, alice, mod, bob, carol, previews, mediaImport;

const page = (head) => `<html><head>${head}</head><body>body</body></html>`;
/** The picture Media brings in: its id (the one a keep names) and the address the card shows. */
const PICTURE = 'att_01JZ0M0Q8F3K2V7YB6N4T5R9WQ';
/** Media is stubbed here: the import answers with the picture, the keep answers that it is kept. */
const mediaStub = (calls) => async (url, opts) => {
    calls.push({ url: String(url), auth: String((opts && opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || ''), body: JSON.parse(opts.body) });
    const keep = String(url).endsWith('/keep');
    return {
        status: keep ? 200 : 201,
        json: async () => (keep
            ? { id: PICTURE, message_id: (JSON.parse(opts.body) || {}).message_id, kept_for: [] }
            : { id: PICTURE, kind: 'image', mime: 'image/png', url: `https://openvibe.media/a/${PICTURE}/picture.png` }),
    };
};
const type = (body) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
const room = (method, path, user, body) => h.http(method, `/api/chat/rooms${path}`, { token: user && user.token, body });
/** A form the site's own pages post (a cookie, not a bearer). */
const form = async (p, body, token) => {
    const res = await fetch(`${h.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ov_token=${token}` }, body: new URLSearchParams(body).toString(), redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') };
};
/** A room of its own, so one test's messages never count against another's posting budget. */
const newRoom = async (name) => {
    const made = await room('POST', '/', alice, { name });
    assert.strictEqual(made.status, 201, made.text);
    return made.body.room;
};
/**
 * A room of bob's own, with alice in it: the room budget is per caller, and this file already makes as many
 * rooms as alice may make in a minute.
 */
const newRoomFor = async (name) => {
    const made = await room('POST', '/', bob, { name });
    assert.strictEqual(made.status, 201, made.text);
    await room('POST', `/${made.body.room.slug}/join`, alice);
    return made.body.room;
};
const withPreview = async (slug, text, html) => {
    previews._setRequest(async () => type(html));
    const sent = await room('POST', `/${slug}/messages`, alice, { message: text });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    return sent.body.message;
};

t('boot', async () => {
    h = await boot();
    previews = require('../server/chat/link-previews');
    mediaImport = require('../server/chat/media-import');
    alice = h.addUser('alice', { subject: ids.newId('user') });
    mod = h.addUser('mod', { subject: ids.newId('user'), role: 'global_mod' });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    for (const u of [alice, mod, bob, carol]) {
        await h.ctx.upsertUser(h.live.users.get(u.id));
        h.netModules.subjects.add(u.subject_id);
    }
    await h.ctx.sync();
});

t('the author takes the cards back: they are not sent on a read, and the room is told at once', async () => {
    const r = await newRoom('Taken back');
    const message = await withPreview(r.slug, 'https://93.184.216.34/take-me-back', page('<meta property="og:title" content="Take me back">'));
    const before = await room('GET', `/${r.slug}/messages`, alice);
    assert.strictEqual(before.body.messages.find((m) => m.id === message.id).embeds.length, 1, 'the card is there to begin with');

    const ws = await h.ws({ token: bob.token });
    ws.sendJson({ type: 'join_room', room: r.slug, token: bob.token });
    await ws.next((m) => m.type === 'room_joined');

    const hidden = await room('POST', `/${r.slug}/messages/${message.id}/embeds/hidden`, alice, { hidden: true });
    assert.strictEqual(hidden.status, 200, hidden.text);
    assert.strictEqual(hidden.body.hidden, true);
    assert.deepStrictEqual(hidden.body.embeds, [], 'the answer carries no cards');
    const event = await ws.next((m) => m.type === 'room_message_embeds' && Number(m.id) === message.id);
    assert.strictEqual(event.hidden, true, 'open clients are told at once');
    assert.deepStrictEqual(event.embeds, []);

    const after = await room('GET', `/${r.slug}/messages`, alice);
    const row = after.body.messages.find((m) => m.id === message.id);
    assert.deepStrictEqual(row.embeds, [], 'a hidden card is not sent on a read');
    assert.ok(row.embeds_hidden, 'the message says its cards are gone');
    ws.close();
});

t('the cards come back when the author says so', async () => {
    const r = await newRoom('Put back');
    const message = await withPreview(r.slug, 'https://93.184.216.34/put-me-back', page('<meta property="og:title" content="Put me back">'));
    await room('POST', `/${r.slug}/messages/${message.id}/embeds/hidden`, alice, { hidden: true });
    const back = await room('POST', `/${r.slug}/messages/${message.id}/embeds/hidden`, alice, { hidden: false });
    assert.strictEqual(back.status, 200, back.text);
    assert.strictEqual(back.body.hidden, false);
    assert.strictEqual(back.body.embeds.length, 1, 'the cards are back');
    const got = await room('GET', `/${r.slug}/messages`, alice);
    const row = got.body.messages.find((m) => m.id === message.id);
    assert.strictEqual(row.embeds.length, 1, 'and they are sent on a read again');
    assert.ok(!row.embeds_hidden);
});

t('a room moderator may take them back; another member may not', async () => {
    const r = await newRoom('Moderated cards');
    const message = await withPreview(r.slug, 'https://93.184.216.34/moderated-cards', page('<meta property="og:title" content="Moderated">'));
    await room('POST', `/${r.slug}/join`, carol);
    const refused = await room('POST', `/${r.slug}/messages/${message.id}/embeds/hidden`, carol, { hidden: true });
    assert.strictEqual(refused.status, 403, 'a member is not the author and not a moderator');
    const done = await room('POST', `/${r.slug}/messages/${message.id}/embeds/hidden`, mod, { hidden: true });
    assert.strictEqual(done.status, 200, done.text);
    assert.strictEqual(done.body.hidden, true);
    const got = await room('GET', `/${r.slug}/messages`, alice);
    assert.deepStrictEqual(got.body.messages.find((m) => m.id === message.id).embeds, []);
});

t('the owner and the moderators turn the cards off and on again', async () => {
    const r = await newRoom('Switch room');
    const off = await room('PATCH', `/${r.slug}/link-previews`, mod, { link_previews: 'off' });
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(off.body.room.link_previews, false, 'a moderator may switch them off');
    const refused = await room('PATCH', `/${r.slug}/link-previews`, carol, { link_previews: 'off' });
    assert.strictEqual(refused.status, 403, 'a member may not');

    previews._setRequest(async () => { throw new Error('off must not fetch'); });
    const sent = await room('POST', `/${r.slug}/messages`, alice, { message: 'https://93.184.216.34/while-off' });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    const got = await room('GET', `/${r.slug}/messages`, alice);
    assert.deepStrictEqual(got.body.messages.find((m) => m.id === sent.body.message.id).embeds, [], 'no fetch and no cards while off');

    const on = await room('PATCH', `/${r.slug}/link-previews`, alice, { link_previews: 'on' });
    assert.strictEqual(on.status, 200, on.text);
    assert.strictEqual(on.body.room.link_previews, true, 'the owner may switch them on');
    const again = await withPreview(r.slug, 'https://93.184.216.34/after-switch', page('<meta property="og:title" content="Back on">'));
    const after = await room('GET', `/${r.slug}/messages`, alice);
    assert.strictEqual(after.body.messages.find((m) => m.id === again.id).embeds[0].title, 'Back on', 'new messages get their cards again');
});

t('the picture of a page is brought into Media, and the card never hot-links it', async () => {
    const r = await newRoom('Picture room');
    const calls = [];
    mediaImport._setFetch(mediaStub(calls));
    const message = await withPreview(r.slug, 'https://93.184.216.34/with-a-picture',
        page('<meta property="og:title" content="With a picture"><meta property="og:image" content="https://pictures.example/og.png">'));
    const got = await room('GET', `/${r.slug}/messages`, alice);
    const embed = got.body.messages.find((m) => m.id === message.id).embeds[0];
    assert.strictEqual(embed.image, `https://openvibe.media/a/${PICTURE}/picture.png`, 'the card shows the Media address');
    assert.ok(!JSON.stringify(embed).includes('pictures.example'), 'the other host is nowhere on the card');
    const imports = calls.filter((c) => c.url.endsWith('/attachments/import'));
    assert.strictEqual(imports.length, 1, 'Media is asked once');
    assert.match(imports[0].auth, /^Bearer /, 'the call carries a service token');
    assert.deepStrictEqual(imports[0].body, { url: 'https://pictures.example/og.png' }, 'Media is asked for that picture');
    const asked = h.tokenRequests.find((t2) => t2.audience === 'openvibe.media');
    assert.ok(asked, 'a service token for Media was asked for');
    assert.match(asked.scope, /media\.object\.upload/);
});

t('the picture of a stored preview is kept with the message it is shown under', async () => {
    const r = await newRoomFor('Kept picture room');
    const calls = [];
    mediaImport._setFetch(mediaStub(calls));
    const message = await withPreview(r.slug, 'https://93.184.216.34/kept-picture',
        page('<meta property="og:title" content="Kept"><meta property="og:image" content="https://pictures.example/kept.png">'));
    const keeps = calls.filter((c) => c.url.endsWith('/keep'));
    assert.strictEqual(keeps.length, 1, 'the picture is kept once');
    assert.ok(keeps[0].url.includes(`/attachments/${PICTURE}/keep`), 'Media is asked to keep that picture');
    assert.deepStrictEqual(keeps[0].body, { message_id: String(message.id) }, 'and it is kept with the message it is shown under');
    assert.match(keeps[0].auth, /^Bearer /, 'the keep carries Chat\'s own service token');
});

t('a picture the cache shows again for a second message is kept again for it', async () => {
    const r = await newRoomFor('Kept twice room');
    const calls = [];
    mediaImport._setFetch(mediaStub(calls));
    const address = 'https://93.184.216.34/kept-twice';
    const html = page('<meta property="og:title" content="Kept twice"><meta property="og:image" content="https://pictures.example/twice.png">');
    const first = await withPreview(r.slug, address, html);
    const second = await withPreview(r.slug, address, html);
    assert.strictEqual(calls.filter((c) => c.url.endsWith('/attachments/import')).length, 1, 'the picture is brought in once');
    const keeps = calls.filter((c) => c.url.endsWith('/keep'));
    assert.strictEqual(keeps.length, 2, 'and it is kept twice');
    assert.deepStrictEqual(keeps.map((c) => c.body.message_id), [String(first.id), String(second.id)], 'once for each message that shows it');
});

t('a picture Media refuses leaves the card without one', async () => {
    const r = await newRoom('No picture room');
    mediaImport._setFetch(async () => ({ status: 422, json: async () => ({ error: 'that address is not a picture' }) }));
    const message = await withPreview(r.slug, 'https://93.184.216.34/not-a-picture',
        page('<meta property="og:title" content="No picture"><meta property="og:image" content="https://pictures.example/page.html">'));
    const got = await room('GET', `/${r.slug}/messages`, alice);
    const embed = got.body.messages.find((m) => m.id === message.id).embeds[0];
    assert.strictEqual(embed.image, null, 'no picture on the card');
    assert.ok(!JSON.stringify(embed).includes('pictures.example'), 'and no address from the other host');
});

t('a picture that is too large leaves the card without one', async () => {
    const r = await newRoom('Big picture room');
    mediaImport._setFetch(async () => ({ status: 413, json: async () => ({ error: 'that picture is too large (2 MB at most)' }) }));
    const message = await withPreview(r.slug, 'https://93.184.216.34/big-picture',
        page('<meta property="og:title" content="Big picture"><meta property="og:image" content="https://pictures.example/big.png">'));
    const got = await room('GET', `/${r.slug}/messages`, alice);
    const embed = got.body.messages.find((m) => m.id === message.id).embeds[0];
    assert.strictEqual(embed.image, null, 'no picture on the card');
    assert.ok(!JSON.stringify(embed).includes('pictures.example'));
});

t('the room page draws the × for those who may hide the cards, and for nobody else', async () => {
    const r = await newRoom('Drawn room');
    const message = await withPreview(r.slug, 'https://93.184.216.34/drawn', page('<meta property="og:title" content="Drawn">'));
    const mine = await (await fetch(`${h.base}/r/${r.slug}`, { headers: { cookie: `ov_token=${alice.token}` } })).text();
    assert.ok(mine.includes('aria-label="Hide the preview"'), 'the author gets the ×');
    assert.ok(mine.includes(`/r/${r.slug}/embeds/${message.id}/hidden`), 'and the form that hides them');
    const other = await (await fetch(`${h.base}/r/${r.slug}`, { headers: { cookie: `ov_token=${carol.token}` } })).text();
    assert.ok(!other.includes('aria-label="Hide the preview"'), 'a member gets no ×');
    const modPage = await (await fetch(`${h.base}/r/${r.slug}`, { headers: { cookie: `ov_token=${mod.token}` } })).text();
    assert.ok(modPage.includes('aria-label="Hide the preview"'), 'a moderator does');
});

t('the settings page shows the switch to the moderators, and its form saves it', async () => {
    const r = await newRoom('Settings room');
    const settings = await (await fetch(`${h.base}/r/${r.slug}/settings`, { headers: { cookie: `ov_token=${mod.token}` } })).text();
    assert.ok(settings.includes('Link previews'), 'the switch is in the room settings');
    assert.ok(settings.includes('name="link_previews"'), 'and it is a switch');
    const refused = await form(`/r/${r.slug}/link-previews`, { has_link_previews: '1' }, carol.token);
    assert.strictEqual(refused.status, 303, 'a member is sent back with the reason');
    assert.strictEqual((await room('GET', `/${r.slug}`, mod)).body.room.link_previews, true, 'and the switch stays on');
    const saved = await form(`/r/${r.slug}/link-previews`, { has_link_previews: '1' }, mod.token);
    assert.strictEqual(saved.status, 303, 'a moderator saves it');
    assert.strictEqual((await room('GET', `/${r.slug}`, mod)).body.room.link_previews, false, 'the switch is off');
});

t('the pages own form takes the cards back and puts them back', async () => {
    const r = await newRoom('Form room');
    const message = await withPreview(r.slug, 'https://93.184.216.34/by-form', page('<meta property="og:title" content="By form">'));
    const hidden = await form(`/r/${r.slug}/embeds/${message.id}/hidden`, { hidden: '1' }, alice.token);
    assert.strictEqual(hidden.status, 303, 'the form answers with a redirect');
    const got = await room('GET', `/${r.slug}/messages`, alice);
    assert.deepStrictEqual(got.body.messages.find((m) => m.id === message.id).embeds, [], 'the cards are gone');
    const back = await form(`/r/${r.slug}/embeds/${message.id}/hidden`, { hidden: '0' }, alice.token);
    assert.strictEqual(back.status, 303);
    const again = await room('GET', `/${r.slug}/messages`, alice);
    assert.strictEqual(again.body.messages.find((m) => m.id === message.id).embeds.length, 1, 'and they are back');
});

t.run(async () => {
    previews._reset();
    mediaImport._setFetch(null);
    await h.close();
});
