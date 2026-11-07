'use strict';
/**
 * The person's own voice (server/chat/tts-person.js): the route is for the person themself, it speaks in
 * the voice it is given, it speaks one line (the contract's 220 characters), and it is on the same
 * per-person limiter as the agent voice: six lines a minute, then the route refuses.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

// The account and the engine are stood in for, so the test never needs the Network or a speech provider.
const authPath = require.resolve('../server/auth/auth');
require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
        requireAuth: (req, res, next) => {
            if (!req.headers['x-test-person']) return res.status(401).json({ error: 'Authentication required' });
            req.user = { id: 7, subject_id: String(req.headers['x-test-subject'] || 'usr_TESTONE') };
            req.authSource = String(req.headers['x-test-source'] || 'network');
            next();
        },
    },
};
const calls = [];
const enginePath = require.resolve('../server/chat/tts-engine');
require.cache[enginePath] = {
    id: enginePath, filename: enginePath, loaded: true, children: [], paths: [],
    exports: {
        synthesize: async (text, voice, who) => {
            calls.push({ text, voice, who });
            return { audio: 'QUFB', mimeType: 'audio/mpeg', voiceId: voice || 'default' };
        },
    },
};

(async () => {
    const router = require('../server/chat/tts-person');
    const app = express();
    app.use('/api/tts', router);
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const say = async (body, headers = {}) => {
        const res = await fetch(base + '/api/tts/speak', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    try {
        const none = await say({ text: 'hello' });
        assert.strictEqual(none.status, 401, 'no token, no voice');

        const one = await say({ text: 'Good evening.', voice: 'gary' }, { 'x-test-person': '1' });
        assert.strictEqual(one.status, 200, JSON.stringify(one.json));
        assert.strictEqual(one.json.audio, 'QUFB');
        assert.strictEqual(one.json.mime_type, 'audio/mpeg');
        assert.strictEqual(one.json.voice_id, 'gary', 'the voice that was asked for is the voice that answers');
        assert.deepStrictEqual(calls[calls.length - 1], { text: 'Good evening.', voice: 'gary', who: 'usr_TESTONE' });

        const api = await say({ text: 'hello' }, { 'x-test-person': '1', 'x-test-source': 'api_token' });
        assert.strictEqual(api.status, 403, 'an API token does not get a voice');

        const long = await say({ text: 'x'.repeat(400) }, { 'x-test-person': '1' });
        assert.strictEqual(long.status, 200);
        assert.strictEqual(calls[calls.length - 1].text.length, 220, 'one line: the contract caps the text at 220 characters');

        // The per-person limiter: six lines a minute, the seventh is refused.
        const who = 'usr_LIMITONE';
        const codes = [];
        for (let i = 0; i < 7; i++) {
            const r = await say({ text: 'line ' + i }, { 'x-test-person': '1', 'x-test-subject': who });
            codes.push(r.status);
        }
        assert.deepStrictEqual(codes.slice(0, 6), [200, 200, 200, 200, 200, 200], 'six lines a minute are spoken');
        assert.strictEqual(codes[6], 429, 'the seventh line in a minute is refused');
        const refused = await say({ text: 'again' }, { 'x-test-person': '1', 'x-test-subject': who });
        assert.strictEqual(refused.json.code, 'voice_rate_limited');

        const other = await say({ text: 'mine' }, { 'x-test-person': '1', 'x-test-subject': 'usr_LIMITTWO' });
        assert.strictEqual(other.status, 200, 'another person has their own count');
    } finally {
        server.close();
    }
    console.log('companion voice: the person\'s own token, the voice it is given, one line, six a minute');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
