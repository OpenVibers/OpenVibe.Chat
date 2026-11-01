'use strict';
/**
 * The deterministic net for the Dock's timer (plan L48 R2; server/rooms/ai-members.js afterPost): a plain "start a
 * 25 minute timer" is set even when the model only promised it (small models often do), and the answer says what was
 * set — but only when the timer really is set. When the Network refuses, the answer says nothing about a timer.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe timer net');
let h, ann, ai, config, aiClient;
const RUN = (content) => ({ id: 'run_1', status: 'succeeded', output: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] } });

t('boot', async () => {
    // The model answers in words and calls no tool: the case the net is there for.
    ai = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            send('delta', { text: 'Sure, I will start that timer for you.' });
            send('run', { run: RUN('Sure, I will start that timer for you.') });
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
    timer = require('../server/rooms/vibe-timer');   // after the boot: the config reads the environment
    realStart = timer.start;
    realStop = timer.stop;
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
});

let timer = null;
const asked = [];
const TIMER = { kind: 'focus', label: null, started_at: '2026-11-01T09:00:00.000Z', ends_at: '2026-11-01T09:25:00.000Z', round: 1, rounds: 4, focus_min: 25, break_min: 5 };
let realStart = null;
let realStop = null;

async function ask(text) {
    const vibe = require('../server/rooms/vibe');
    const rooms = require('../server/rooms/rooms');
    const user = h.live.users.get(ann.id);
    const room = await vibe.createRoom(user, text);
    const message = await rooms.post(room, user, text, { ai: false });
    const frames = [];
    const reply = await require('../server/rooms/ai-members').afterPost(room, message, user, { broadcast: (f) => frames.push(f) });
    return { frames, reply };
}

t('a plain "start a 25 minute timer" is set even when the model only promised it, and the answer says so', async () => {
    asked.length = 0;
    timer.start = async (subject, want) => { asked.push({ subject, want }); return { timer: TIMER, said: timer.sayOf(TIMER) }; };
    try {
        const { reply } = await ask('start a 25 minute timer');
        assert.strictEqual(asked.length, 1, 'the timer was set');
        assert.strictEqual(asked[0].subject, h.live.users.get(ann.id).subject_id, 'it is the person\'s own timer');
        assert.deepStrictEqual(asked[0].want, { minutes: 25, kind: 'timer' });
        assert.match(reply.message, /Timer set: 25 min/);
        assert.match(reply.message, /It's in the Dock on every site\./);
    } finally { timer.start = realStart; }
});

t('when the Network refuses, the answer does not say a timer was set', async () => {
    asked.length = 0;
    timer.start = async (subject, want) => { asked.push({ subject, want }); return { error: 'the timer is not available right now' }; };
    try {
        const { reply } = await ask('start a 25 minute timer');
        assert.strictEqual(asked.length, 1, 'it was tried');
        assert.ok(!/Timer set/.test(reply.message), `the answer says nothing about a timer: ${reply.message}`);
    } finally { timer.start = realStart; }
});

t('"stop the timer" stops it, and says so', async () => {
    asked.length = 0;
    timer.stop = async (subject) => { asked.push({ subject }); return { stopped: true, said: 'Timer stopped.' }; };
    try {
        const { reply } = await ask('stop the timer');
        assert.strictEqual(asked.length, 1);
        assert.match(reply.message, /Timer stopped\./);
    } finally { timer.stop = realStop; }
});

t.run(async () => { aiClient._reset(); if (h && h.close) await h.close(); await new Promise((r) => ai.close(r)); });
