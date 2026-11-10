'use strict';
/**
 * Address previews (part 1): the addresses a message carries, the guarded page read, the day cache, and the rows a
 * read gets back. The fetches are stubbed with _setRequest; the address check is the real openvibe-shared/egress one
 * (a private literal or a name answering a private address is refused before the stub is called).
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let previews;

const t = suite('link-previews');
let h, alice, room;

const page = (head) => `<html><head>${head}</head><body>body</body></html>`;
const type = (body) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });

t('boot', async () => {
    h = await boot();
    previews = require('../server/chat/link-previews');
    alice = h.addUser('alice', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(alice.id));
    h.netModules.subjects.add(alice.subject_id);
    await h.ctx.sync();
    const created = await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Preview room' } });
    assert.strictEqual(created.status, 201, created.text);
    room = created.body.room;
});

t('addresses: https only, in order, three at most, sentence punctuation dropped', async () => {
    const found = previews.addresses('see https://one.example/a, and https://two.example/b. also http://plain.example and https://one.example/a https://three.example/c https://four.example/d');
    assert.deepStrictEqual(found, ['https://one.example/a', 'https://two.example/b', 'https://three.example/c']);
    assert.deepStrictEqual(previews.addresses('https://user:pass@one.example/a'), []);
    assert.deepStrictEqual(previews.addresses('nothing to preview'), []);
});

t('a message gets embeds: [] at once, then its previews from the background job', async () => {
    const calls = [];
    previews._setRequest(async (url) => {
        calls.push(url);
        if (url === 'https://93.184.216.34/story') {
            return type(page('<meta property="og:title" content="A story &amp; its title"><meta property="og:site_name" content="Example"><meta property="og:description" content="What happened"><meta property="og:image" content="https://openvibe.media/pic.jpg"><meta property="og:image:width" content="640"><meta property="og:image:height" content="360">'));
        }
        return { status: 404, headers: { 'content-type': 'text/html' }, body: '' };
    });
    const sent = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token, body: { message: 'look at https://93.184.216.34/story' } });
    assert.strictEqual(sent.status, 201, sent.text);
    assert.deepStrictEqual(sent.body.message.embeds, [], 'the message goes out before the preview');
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token });
    const message = got.body.messages.find((m) => m.id === sent.body.message.id);
    assert.strictEqual(message.embeds.length, 1, got.text);
    assert.deepStrictEqual(message.embeds[0], {
        url: 'https://93.184.216.34/story',
        site_name: 'Example',
        title: 'A story & its title',
        description: 'What happened',
        image: 'https://openvibe.media/pic.jpg',
        kind: 'link',
        width: 640,
        height: 360,
    });
    assert.deepStrictEqual(calls, ['https://93.184.216.34/story']);
});

t('the same address is fetched once a day', async () => {
    let calls = 0;
    previews._setRequest(async () => { calls++; return type(page('<meta property="og:title" content="Cached">')); });
    const one = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token, body: { message: 'https://93.184.216.34/cached' } });
    await previews.idle();
    const two = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token, body: { message: 'again https://93.184.216.34/cached' } });
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token });
    const titles = got.body.messages.filter((m) => [one.body.message.id, two.body.message.id].includes(m.id)).map((m) => m.embeds[0] && m.embeds[0].title);
    assert.deepStrictEqual(titles, ['Cached', 'Cached']);
    assert.strictEqual(calls, 1, 'the second message reads the cache');
});

t('a private address is never fetched and gets no preview', async () => {
    let called = false;
    previews._setLookup((host, options, callback) => callback(null, [{ address: '10.0.0.1', family: 4 }]));
    previews._setRequest(async () => { called = true; return type(page('<meta property="og:title" content="Never">')); });
    const sent = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token, body: { message: 'https://private.example/secret and https://10.0.0.1/also' } });
    await previews.idle();
    assert.strictEqual(called, false, 'no request for a private address');
    const got = await h.http('GET', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token });
    assert.deepStrictEqual(got.body.messages.find((m) => m.id === sent.body.message.id).embeds, []);
    previews._setLookup(null);
});

t('YouTube is read from its oEmbed endpoint and the response is video', async () => {
    let calls = [];
    previews._setLookup((host, options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
    previews._setRequest(async (url) => {
        calls.push(url);
        if (url.startsWith('https://www.youtube.com/oembed?')) {
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'A video', author_name: 'Someone', provider_name: 'YouTube', width: 480, height: 270 }) };
        }
        return { status: 404, headers: {}, body: '' };
    });
    const sent = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token, body: { message: 'https://www.youtube.com/watch?v=abc12345678' } });
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token });
    const embed = got.body.messages.find((m) => m.id === sent.body.message.id).embeds[0];
    assert.strictEqual(embed.kind, 'video');
    assert.strictEqual(embed.title, 'A video');
    assert.strictEqual(embed.site_name, 'YouTube');
    assert.deepStrictEqual(calls, ['https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc12345678']);
});

t('markup in a page title stays text, and an outside picture is left out', async () => {
    previews._setRequest(async () => type(page('<meta property="og:title" content="&lt;b&gt;not bold&lt;/b&gt;"><meta name="twitter:image" content="https://hotlink.example/x.jpg">')));
    const sent = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token, body: { message: 'https://93.184.216.34/markup' } });
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${room.slug}/messages`, { token: alice.token });
    const embed = got.body.messages.find((m) => m.id === sent.body.message.id).embeds[0];
    assert.strictEqual(embed.title, '<b>not bold</b>', 'the words are text; a renderer escapes the angle brackets');
    assert.strictEqual(embed.image, null, 'a picture is never hot-linked');
});

t('three addresses at most, and a redirect is followed only once it is judged public', async () => {
    const calls = [];
    previews._setRequest(async (url) => {
        calls.push(url);
        if (url === 'https://93.184.216.34/redirect') return { status: 302, headers: { location: '/target' }, body: '' };
        return type(page(`<meta property="og:title" content="${url.endsWith('target') ? 'Redirected' : 'One'}">`));
    });
    const made = await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Redirect room' } });
    assert.strictEqual(made.status, 201, made.text);
    const sent = await h.http('POST', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token, body: { message: 'one https://93.184.216.34/redirect and two https://93.184.216.34/b and three https://93.184.216.34/c here' } });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token });
    const embeds = got.body.messages.find((m) => m.id === sent.body.message.id).embeds;
    assert.strictEqual(embeds.length, 3);
    assert.strictEqual(new URL(embeds[0].url).pathname, '/redirect', 'the preview keeps the address the writer sent');
    assert.ok(calls.includes('https://93.184.216.34/target'));
});

t('a Live channel is a live kind from its public API, with no page fetch', async () => {
    process.env.CHAT_LINK_LIVE_URL = 'https://93.184.216.34';
    const calls = [];
    previews._setRequest(async (url) => {
        calls.push(url);
        if (url.includes('/api/streams/channel/streamer')) {
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                channel: { username: 'streamer', display_name: 'The Streamer', bio: 'Live every Friday', avatar_url: 'https://openvibe.media/avatars/s.jpg' },
                streams: [{ id: 7 }],
            }) };
        }
        return { status: 404, headers: {}, body: '' };
    });
    const made = await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Live kinds' } });
    const sent = await h.http('POST', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token, body: { message: 'watch https://openvibe.live/@streamer tonight' } });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token });
    const embed = got.body.messages.find((m) => m.id === sent.body.message.id).embeds[0];
    assert.strictEqual(embed.kind, 'live');
    assert.strictEqual(embed.title, 'The Streamer');
    assert.strictEqual(embed.by, 'streamer');
    assert.strictEqual(embed.live, true);
    assert.strictEqual(embed.image, 'https://openvibe.media/avatars/s.jpg');
    assert.deepStrictEqual(calls, ['https://93.184.216.34/api/streams/channel/streamer?pollOnly=1'], 'the page itself is never fetched');
});

t('an offline Live channel is the same kind with live: false', async () => {
    previews._setRequest(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        channel: { username: 'quiet', display_name: 'Quiet Corner' }, streams: [],
    }) }));
    const made = await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Offline kind' } });
    const sent = await h.http('POST', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token, body: { message: 'https://openvibe.live/@quiet' } });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token });
    const embed = got.body.messages.find((m) => m.id === sent.body.message.id).embeds[0];
    assert.strictEqual(embed.kind, 'live');
    assert.strictEqual(embed.live, false);
});

t('a Video watch page is resolved by Video and never page-fetched', async () => {
    process.env.CHAT_LINK_VIDEO_URL = 'https://93.184.216.34';
    const calls = [];
    previews._setRequest(async (url) => {
        calls.push(url);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Friday film', channel: 'ann', thumbnail_url: 'https://openvibe.media/vod/friday.jpg', duration_s: 3725 }) };
    });
    const made = await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Video kind' } });
    const sent = await h.http('POST', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token, body: { message: 'https://openvibe.video/watch?v=dQw4w9WgXcQ' } });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    const got = await h.http('GET', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token });
    const embed = got.body.messages.find((m) => m.id === sent.body.message.id).embeds[0];
    assert.strictEqual(embed.kind, 'video');
    assert.strictEqual(embed.title, 'Friday film');
    assert.strictEqual(embed.by, 'ann');
    assert.deepStrictEqual(calls, ['https://93.184.216.34/api/v1/video/watchable?url=https%3A%2F%2Fopenvibe.video%2Fwatch%3Fv%3DdQw4w9WgXcQ']);
});

t('an own site with no resolver yet is neither page-fetched nor previewed', async () => {
    let called = false;
    previews._setRequest(async () => { called = true; return { status: 200, headers: { 'content-type': 'text/html' }, body: '<meta property="og:title" content="Should not be read">' }; });
    const made = await h.http('POST', '/api/chat/rooms', { token: alice.token, body: { name: 'Unreached kind' } });
    const sent = await h.http('POST', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token, body: { message: 'https://openvibe.pics/p/some-picture' } });
    assert.strictEqual(sent.status, 201, sent.text);
    await previews.idle();
    assert.strictEqual(called, false);
    const got = await h.http('GET', `/api/chat/rooms/${made.body.room.slug}/messages`, { token: alice.token });
    assert.deepStrictEqual(got.body.messages.find((m) => m.id === sent.body.message.id).embeds, []);
});

t.run(async () => { previews._reset(); await h.close(); });
