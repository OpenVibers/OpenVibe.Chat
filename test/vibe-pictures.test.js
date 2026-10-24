'use strict';
/**
 * Vibe sees pictures (server/rooms/pictures.js forModel, ai-members.js picturesFor, vibe-routes.js POST /picture): a new
 * chat can start with a picture (it goes to OpenVibe.Pics as the person, and the chat is named after the question);
 * the AI member's turn carries the picture as an image part, fetched from Pics on this host; a question right after a
 * picture sees that picture; a picture Pics refuses leaves no chat behind; the app's composer offers the picture button.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, vibe;

const t = suite('vibe pictures');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d6a1f60000000049454e44ae426082', 'hex');
let h, pics, ann;
const turns = [];

function startPics() {
    let n = 0, refuse = null;
    const gets = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (req.method === 'GET' && /^\/i\/[2-9a-km-zA-HJ-NP-Z]{8}\.png$/.test(req.url)) {
                gets.push({ path: req.url, host: req.headers.host });
                res.writeHead(200, { 'content-type': 'image/png' });
                return res.end(PNG);
            }
            const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (refuse) return send(refuse.status, { code: refuse.code, detail: refuse.detail });
            const slug = `Pc${String(++n).padStart(6, '2')}`.replace(/[01]/g, '3');
            return send(201, { slug, links: { direct: `https://openvibe.pics/i/${slug}.png`, page: `https://openvibe.pics/i/${slug}` } });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        gets, url: `http://127.0.0.1:${server.address().port}`, refuse: (r) => { refuse = r; }, close: () => new Promise((r) => server.close(r)),
    })));
}
const raw = (path, u, body, headers) => fetch(`${h.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${u.token}`, ...headers }, body })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
async function answers(slug, n) {
    for (let i = 0; i < 80; i++) {
        const got = ((await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token })).body.messages || []).filter((m) => m.ai_member_id);
        if (got.length >= n) return got;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`fewer than ${n} answers`);
}
const imagesIn = (turn) => (Array.isArray(turn.input.messages[1].content) ? turn.input.messages[1].content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []);

t('boot', async () => {
    pics = await startPics();
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat', CHAT_PICS_INTERNAL_URL: pics.url } });
    aiClient = require('../server/ai/client');
    vibe = require('../server/rooms/vibe');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    aiClient._setClient({ runs: { create: async (workflow, input) => {
        turns.push({ workflow, input });
        return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'A tiny white square.' } }] } } };
    } } });
});

t('a chat that starts with a picture: Pics has it, the chat is named after the question, and Vibe sees it', async () => {
    const r = await raw('/api/chat/vibe/picture', ann, PNG, { 'content-type': 'image/png', 'x-caption': encodeURIComponent('what is in this picture?') });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.room.name, 'what is in this picture?');
    assert.ok(r.body.message.message.startsWith('what is in this picture? https://openvibe.pics/i/'), r.body.message.message);
    const [a] = await answers(r.body.room.slug, 1);
    assert.strictEqual(a.message, 'A tiny white square.');
    const turn = turns.find((x) => x.workflow === 'chat.member.turn');
    const imgs = imagesIn(turn);
    assert.deepStrictEqual(imgs, [`data:image/png;base64,${PNG.toString('base64')}`], 'the picture rides with the question, as Pics serves it');
    assert.strictEqual(pics.gets[0].host, 'openvibe.pics', 'fetched from Pics on this host as the public would');
    assert.ok(turn.input.messages[1].content[0].text.includes('The picture they sent is attached.'));
    assert.ok(turn.input.messages[0].content.includes('When they send a picture you see it'));

    // A question right after a picture sees that picture.
    const before = turns.length;
    assert.strictEqual((await h.http('POST', `/api/chat/rooms/${r.body.room.slug}/messages`, { token: ann.token, body: { message: 'and what colour is it?' } })).status, 201);
    await answers(r.body.room.slug, 2);
    assert.strictEqual(imagesIn(turns.slice(before).find((x) => x.workflow === 'chat.member.turn')).length, 1, 'the follow-up sees the picture before it');
    // A question two messages on, after Vibe has answered in between, does not carry it again.
    const later = turns.length;
    assert.strictEqual((await h.http('POST', `/api/chat/rooms/${r.body.room.slug}/messages`, { token: ann.token, body: { message: 'thanks!' } })).status, 201);
    await answers(r.body.room.slug, 3);
    assert.strictEqual(imagesIn(turns.slice(later).find((x) => x.workflow === 'chat.member.turn')).length, 0);
});

t('a picture Pics refuses leaves no chat behind; another type is refused before Pics is asked', async () => {
    const count = (await vibe.list({ id: ann.id })).length;
    pics.refuse({ status: 422, code: 'pics.too_small', detail: 'That picture is too small.' });
    const r = await raw('/api/chat/vibe/picture', ann, PNG, { 'content-type': 'image/png' });
    pics.refuse(null);
    assert.deepStrictEqual([r.status, r.body.code], [422, 'pics.too_small']);
    const t2 = await raw('/api/chat/vibe/picture', ann, Buffer.from('hello'), { 'content-type': 'text/plain' });
    assert.strictEqual(t2.status, 415);
    assert.strictEqual((await vibe.list({ id: ann.id })).length, count, 'no empty chat left');
});

t('the composer offers the picture button when pictures are on', async () => {
    const page = await (await fetch(`${h.base}/vibe`, { headers: { cookie: `ov_token=${ann.token}` } })).text();
    assert.ok(page.includes('id="vb-file"') && page.includes('data-vb-attach'));
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (pics) await pics.close(); if (h && h.close) await h.close(); });
