'use strict';
// The agent voice route (Agent Streams S4, server/chat/tts-machine.js): no token is refused, and a person gets at most
// 6 lines a minute (the desk speaks one every 20 s; the cap is for a leaked token, since TTS spends Chat's budget).
const assert = require('assert');
const http = require('http');
const express = require('express');

(async () => {
    const router = require('../server/chat/tts-machine');
    const allow = router._allow;
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) assert.strictEqual(allow('usr_A', t0 + i), true, `line ${i + 1} is spoken`);
    assert.strictEqual(allow('usr_A', t0 + 10), false, 'the seventh in a minute is refused');
    assert.strictEqual(allow('usr_B', t0 + 10), true, 'another person has their own count');
    assert.strictEqual(allow('usr_A', t0 + 61_000), true, 'a minute later it speaks again');

    const app = express();
    app.use('/api/agent-voice', router);
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/agent-voice/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hello"}' });
        assert.strictEqual(r.status, 401, 'no token, no voice');
        const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/agent-voice/speak`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-token' }, body: '{"text":"hello"}' });
        assert.ok([401, 503].includes(bad.status), 'a bad token, no voice (503 when the keys cannot be read: closed, never open)');
    } finally { server.close(); }
    console.log('agent voice: tokens required, six lines a minute per person');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
