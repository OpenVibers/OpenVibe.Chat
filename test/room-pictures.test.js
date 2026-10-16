'use strict';
/**
 * Pictures in rooms and channels (server/rooms/pictures.js): a member's picture goes to OpenVibe.Pics as them (their
 * own Network token, Host: openvibe.pics, their address) and its link is posted; the room page and the channel page
 * show OpenVibe.Pics links as thumbnails (no other host's, never in global chat); non-members and other types are
 * refused before Pics is asked; a Pics refusal comes back as it was; the site's form works without JavaScript; with
 * CHAT_PICS_INTERNAL_URL unset there is no form and the API says so.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('room pictures');
let h, pics, ann, bob, cat;
const api = (method, path, u, body, headers) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body, headers });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d6a1f60000000049454e44ae426082', 'hex');

function startPics() {
    const calls = [];
    let refuse = null;
    let n = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            calls.push({ host: req.headers.host, auth: req.headers.authorization, type: req.headers['content-type'], title: req.headers['x-title'], xff: req.headers['x-forwarded-for'], bytes: Buffer.concat(chunks).length, path: req.url });
            const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (refuse) return send(refuse.status, { code: refuse.code, detail: refuse.detail });
            const slug = `Ab${String(++n).padStart(6, '2')}`.replace(/[01]/g, '3');
            return send(201, { slug, links: { direct: `https://openvibe.pics/i/${slug}.png`, page: `https://openvibe.pics/i/${slug}` } });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        calls, url: `http://127.0.0.1:${server.address().port}`, refuse: (r) => { refuse = r; }, close: () => new Promise((r) => server.close(r)),
    })));
}

const page = async (path, u) => { const r = await fetch(`${h.base}${path}`, { headers: u ? { cookie: `ov_token=${u.token}` } : {}, redirect: 'manual' }); return { status: r.status, text: await r.text(), location: r.headers.get('location') }; };
function multipart(fields, file) {
    const b = `----ocpic${Date.now()}`;
    const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (file) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="picture"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.buffer, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${b}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

t('boot', async () => {
    pics = await startPics();
    h = await boot({ env: { CHAT_PICS_INTERNAL_URL: pics.url } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
    assert.strictEqual((await api('POST', '/', ann, { name: 'Photo Walk' })).status, 201);
    await api('POST', '/photo-walk/join', bob);
});

t('a member\'s picture goes to Pics as them, and its link is posted after the caption', async () => {
    const r = await h.http('POST', '/api/chat/rooms/photo-walk/pictures', { token: bob.token, raw: PNG, headers: { 'content-type': 'image/png', 'x-caption': encodeURIComponent('Sunset at the pier') } });
    assert.strictEqual(r.status, 201, r.text);
    assert.match(r.body.message.message, /^Sunset at the pier https:\/\/openvibe\.pics\/i\/[2-9a-km-zA-HJ-NP-Z]{8}\.png$/);
    const call = pics.calls[0];
    assert.deepStrictEqual([call.path, call.host, call.auth, call.type, call.bytes], ['/api/v1/images', 'openvibe.pics', `Bearer ${bob.token}`, 'image/png', PNG.length]);
    assert.strictEqual(decodeURIComponent(call.title), 'Sunset at the pier');
    assert.ok(call.xff, 'the person\'s address goes along for Pics\' own limits');
});

t('refused before Pics is asked: a non-member, another type; a Pics refusal comes back as it was', async () => {
    const before = pics.calls.length;
    let r = await h.http('POST', '/api/chat/rooms/photo-walk/pictures', { token: cat.token, raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'rooms.join_first']);
    r = await h.http('POST', '/api/chat/rooms/photo-walk/pictures', { token: bob.token, raw: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } });
    assert.deepStrictEqual([r.status, r.body.code], [415, 'pictures.type']);
    assert.strictEqual(pics.calls.length, before);
    pics.refuse({ status: 429, code: 'pics.daily_limit', detail: 'That is 200 pictures today.' });
    r = await h.http('POST', '/api/chat/rooms/photo-walk/pictures', { token: bob.token, raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.deepStrictEqual([r.status, r.body.code, r.body.error], [429, 'pics.daily_limit', 'That is 200 pictures today.']);
    pics.refuse(null);
});

t('the page: Pics links show as thumbnails linked to the picture\'s page; other links stay links', async () => {
    await api('POST', '/photo-walk/messages', ann, { message: 'not a picture: https://example.com/i/Ab222222.png' });
    const r = await page('/r/photo-walk', ann);
    assert.match(r.text, /<a class="oc-pic" href="https:\/\/openvibe\.pics\/i\/[2-9a-km-zA-HJ-NP-Z]{8}"[^>]*><img src="https:\/\/openvibe\.pics\/i\/[2-9a-km-zA-HJ-NP-Z]{8}\/thumb\.webp"/);
    assert.strictEqual((r.text.match(/class="oc-pic"/g) || []).length, 1, 'only the Pics picture');
    assert.match(r.text, /Add a picture/);
    assert.match(r.text, /"pics":"https:\/\/openvibe\.pics"/, 'chat.js gets the Pics address for live messages');
    assert.doesNotMatch((await page('/r/photo-walk', cat)).text, /Add a picture/, 'only people who may post get the form');
});

t('the form works without JavaScript, and goes back to where it was sent from', async () => {
    const m = multipart({ caption: 'From the form', back: '/r/photo-walk' }, { name: 'p.png', type: 'image/png', buffer: PNG });
    const r = await fetch(`${h.base}/r/photo-walk/picture`, { method: 'POST', headers: { cookie: `ov_token=${bob.token}`, 'content-type': m.type }, body: m.body, redirect: 'manual' });
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.get('location'), '/r/photo-walk#oc-compose');
    const msgs = (await api('GET', '/photo-walk/messages', ann)).body.messages;
    assert.match(msgs[msgs.length - 1].message, /^From the form https:\/\/openvibe\.pics\/i\//);
    const bad = multipart({ back: 'https://evil.example/' }, { name: 'p.png', type: 'image/png', buffer: PNG });
    const r2 = await fetch(`${h.base}/r/photo-walk/picture`, { method: 'POST', headers: { cookie: `ov_token=${bob.token}`, 'content-type': bad.type }, body: bad.body, redirect: 'manual' });
    assert.strictEqual(r2.headers.get('location'), '/r/photo-walk#oc-compose', 'never back to another site');
});

t('in a server\'s channel too', async () => {
    const s = (await h.http('POST', '/api/chat/servers', { token: ann.token, body: { name: 'Shutterbugs' } })).body.server;
    const room = (await h.http('GET', `/api/chat/servers/${s.slug}`, { token: ann.token })).body.channels[0].room;
    const r = await h.http('POST', `/api/chat/rooms/${room}/pictures`, { token: ann.token, raw: PNG, headers: { 'content-type': 'image/png' } });
    assert.strictEqual(r.status, 201, r.text);
    const p = await page(`/s/${s.slug}/general`, ann);
    assert.match(p.text, /class="oc-pic"/);
    assert.match(p.text, new RegExp(`action="/r/${room}/picture"`));
});

t('global chat stays text', async () => {
    const r = await page('/', ann);
    assert.doesNotMatch(r.text, /class="oc-pic"/);
});

t('off without CHAT_PICS_INTERNAL_URL: no form, and the API says so', async () => {
    const cfg = require('../server/config').pics;
    const was = cfg.internalUrl;
    cfg.internalUrl = '';
    try {
        assert.doesNotMatch((await page('/r/photo-walk', bob)).text, /Add a picture/);
        const r = await h.http('POST', '/api/chat/rooms/photo-walk/pictures', { token: bob.token, raw: PNG, headers: { 'content-type': 'image/png' } });
        assert.deepStrictEqual([r.status, r.body.code], [503, 'pictures.off']);
    } finally { cfg.internalUrl = was; }
});

t.run(async () => { if (h && h.close) await h.close(); if (pics) await pics.close(); });
