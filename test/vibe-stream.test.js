'use strict';
/**
 * Vibe's answer as it is written (server/ai/client.js stream(), ai-members.js; OpenVibe.AI's POST /api/v1/runs?stream=1):
 * the chat's sockets get room_ai_delta frames with the text so far (at most every DELTA_MS), then the finished answer as
 * a room message; an AI that answers JSON (no stream) still answers; the request carries the run's idempotency key.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe stream');
let h, ann, ai, config, aiClient;
const seen = [];
let mode = 'stream';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = (content) => ({ id: 'run_1', status: 'succeeded', output: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] } });

t('boot', async () => {
    ai = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers['idempotency-key'], body: JSON.parse(body) });
            if (mode === 'json') { res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ run: RUN('A whole answer.') })); }
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            send('delta', { text: 'Rice, ' });
            await pause(200);
            send('delta', { text: 'lentils ' });
            await pause(200);
            send('delta', { text: 'and greens.' });
            send('run', { run: RUN('Rice, lentils and greens.') });
            res.end();
        });
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    config = require('../server/config');
    config.ai.internalUrl = `http://127.0.0.1:${ai.address().port}`;
    aiClient = require('../server/ai/client');
    aiClient._reset();
    aiClient._setTokens({ getToken: async () => 'chat-ai-token' });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
});

async function ask(text) {
    const vibe = require('../server/rooms/vibe');
    const rooms = require('../server/rooms/rooms');
    const user = h.live.users.get(ann.id);
    const room = await vibe.createRoom(user, text);
    const message = await rooms.post(room, user, text, { ai: false });
    const frames = [];
    const reply = await require('../server/rooms/ai-members').afterPost(room, message, user, { broadcast: (f) => frames.push(f) });
    return { frames, reply, room };
}

t('the chat sees the answer as it is written, then the finished message', async () => {
    const { frames, reply, room } = await ask('What should I cook tonight?');
    const deltas = frames.filter((f) => f.type === 'room_ai_delta');
    assert.ok(deltas.length >= 2, `streamed in steps (${deltas.length})`);
    assert.deepStrictEqual(deltas.slice(0, 2).map((f) => [f.room, f.name, f.text]), [[room.slug, 'Vibe', 'Rice, '], [room.slug, 'Vibe', 'Rice, lentils ']], 'the whole text so far, each time');
    const types = frames.map((f) => f.type);
    assert.ok(types.indexOf('room_ai_typing') < types.indexOf('room_ai_delta') && types.lastIndexOf('room_ai_delta') < types.lastIndexOf('room_message'), types.join(' '));
    assert.strictEqual(reply.message, 'Rice, lentils and greens.');
    const call = seen[seen.length - 1];
    assert.match(call.url, /^\/api\/v1\/runs\?stream=1&wait=\d+$/);
    assert.deepStrictEqual([call.auth, call.body.workflow, /^chat-ai-\d+-\d+-t0$/.test(call.key)], ['Bearer chat-ai-token', 'chat.member.turn', true]);
});

t('an AI without the stream answers JSON: the answer still comes, without deltas', async () => {
    mode = 'json';
    const { frames, reply } = await ask('And for dessert?');
    assert.strictEqual(frames.filter((f) => f.type === 'room_ai_delta').length, 0);
    assert.strictEqual(reply.message, 'A whole answer.');
});

t.run(async () => { aiClient._reset(); if (h && h.close) await h.close(); await new Promise((r) => ai.close(r)); });
