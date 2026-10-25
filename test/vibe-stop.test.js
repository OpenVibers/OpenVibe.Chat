'use strict';
/**
 * Stop while Vibe writes (server/rooms/ai-members.js stop, vibe-routes.js POST /:slug/stop, server/ai/client.js stream):
 * the answer so far stays as Vibe's message, marked as stopped, and the run is cancelled at AI; with nothing written,
 * the message says so; a chat with nothing being written answers stopped: false; another person's chat is not there.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe stop');
let h, ann, bob, ai, aiClient;
const cancels = [];
let wordsBeforeFirst = 0;   // how long the fake AI "thinks" before its first word, in 150 ms steps
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const vibeApi = (method, path, u, body) => h.http(method, `/api/chat/vibe${path}`, { token: u.token, body });
async function lastAi(slug) {
    for (let i = 0; i < 120; i++) {
        const ai2 = ((await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token })).body.messages || []).filter((m) => m.ai_member_id);
        if (ai2.length) return ai2[ai2.length - 1];
        await pause(25);
    }
    throw new Error('no answer');
}

t('boot', async () => {
    ai = http.createServer((req, res) => {
        req.resume();
        req.on('end', async () => {
            const cancel = /^\/api\/v1\/runs\/(run_\w+)\/cancel$/.exec(req.url);
            if (cancel) { cancels.push(cancel[1]); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ run: { id: cancel[1], status: 'cancelled' } })); }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-openvibe-run-id': 'run_slow1' });
            let closed = false;
            res.on('close', () => { closed = true; });
            for (let i = 0; i < wordsBeforeFirst && !closed; i++) await pause(150);
            for (let i = 0; i < 40 && !closed; i++) { res.write(`event: delta\ndata: ${JSON.stringify({ text: `word${i} ` })}\n\n`); await pause(150); }
            if (!closed) { res.write(`event: run\ndata: ${JSON.stringify({ run: { id: 'run_slow1', status: 'succeeded', output: { choices: [{ message: { content: 'all words' } }] } } })}\n\n`); res.end(); }
        });
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    require('../server/config').ai.internalUrl = `http://127.0.0.1:${ai.address().port}`;
    aiClient = require('../server/ai/client');
    aiClient._reset();
    aiClient._setTokens({ getToken: async () => 'chat-ai-token' });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('Stop keeps what was written, marked as stopped, and cancels the run at AI', async () => {
    const r = await vibeApi('POST', '', ann, { message: 'Write me a long list of words' });
    assert.strictEqual(r.status, 201, r.text);
    await pause(700);   // a few words in
    const s = await vibeApi('POST', `/${r.body.room.slug}/stop`, ann);
    assert.deepStrictEqual([s.status, s.body.stopped], [202, true]);
    const m = await lastAi(r.body.room.slug);
    assert.match(m.message, /^word0 word1 [\s\S]*\n\n\*Stopped\.\*$/, m.message);
    assert.ok(!m.message.includes('word39'), 'not the whole answer');
    for (let i = 0; i < 40 && !cancels.length; i++) await pause(25);
    assert.deepStrictEqual(cancels, ['run_slow1'], 'the run is cancelled at AI');
    assert.strictEqual(require('../server/rooms/ai-members').stop(999999), false, 'a room with nothing being written');
});

t('stopped before a word: the message says so; nothing being written answers stopped: false; others cannot', async () => {
    wordsBeforeFirst = 20;
    const r = await vibeApi('POST', '', ann, { message: 'Think hard first' });
    await pause(300);
    assert.strictEqual((await vibeApi('POST', `/${r.body.room.slug}/stop`, bob)).status, 404, 'another person\'s chat');
    assert.strictEqual((await vibeApi('POST', `/${r.body.room.slug}/stop`, ann)).body.stopped, true);
    assert.strictEqual((await lastAi(r.body.room.slug)).message, 'Stopped before I wrote anything.');
    assert.strictEqual((await vibeApi('POST', `/${r.body.room.slug}/stop`, ann)).body.stopped, false, 'nothing is being written now');
});

t.run(async () => { aiClient._reset(); if (h && h.close) await h.close(); await new Promise((r) => ai.close(r)); });
