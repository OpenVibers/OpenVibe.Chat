'use strict';
/**
 * Behind tts_exchange (off by default) cloud voices synthesize through AI's POST /v1/audio/speech
 * instead of the providers directly:
 *   - a Google voice and a Polly voice speak through the fake Exchange with their Chat voice id
 *     unchanged (the one-to-one map), and the same shape as direct synthesis;
 *   - no request reaches a provider host (googleapis.com, amazonaws.com) with the setting on.
 *
 * The network is a stand-in: fetch answers for Exchange, https.request records (and would fail)
 * provider calls. The AI token client is stubbed; nothing reaches AI or the providers.
 */
const assert = require('assert');
const https = require('https');

const ctx = require('../server/live-context');
const SETTINGS = { tts_enabled: 'true', tts_exchange: 'true', tts_default_voice: 'gary' };
ctx.getSetting = (k) => (Object.prototype.hasOwnProperty.call(SETTINGS, k) ? SETTINGS[k] : null);

const aiClient = require('../server/ai/client');
aiClient._setTokens({ getToken: async () => 'test-token' });

const askedFetch = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
    askedFetch.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization, body: JSON.parse(opts.body) });
    assert.match(String(url), /\/v1\/audio\/speech$/, 'chat calls the Exchange speech route');
    return {
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        arrayBuffer: async () => Buffer.from(`mp3 of ${JSON.parse(opts.body).voice}:${JSON.parse(opts.body).input}`),
    };
};

const askedProviders = [];
https.request = (url, opts, cb) => {
    if (typeof url === 'object') { cb = opts; url = `https://${url.hostname || url.host}${url.path || '/'}`; }
    askedProviders.push(String(url));
    throw new Error(`provider host must not be called with tts_exchange on: ${url}`);
};
console.warn = () => {};
console.error = () => {};

const tts = require('../server/chat/tts-engine');

(async () => {
    const google = await tts.synthesize('Ladies and gentlemen', 'voice_vegas', 'josh');
    assert.strictEqual(google.voiceId, 'voice_vegas');
    assert.strictEqual(google.engine, 'google-cloud', 'the voice keeps its engine label');
    assert.strictEqual(Buffer.from(google.audio, 'base64').toString(), 'mp3 of voice_vegas:Ladies and gentlemen');
    assert.strictEqual(askedFetch.length, 1);
    assert.strictEqual(askedFetch[0].auth, 'Bearer test-token', 'chat uses its own service token');
    assert.deepStrictEqual(askedFetch[0].body, { model: 'tts-1', input: 'Ladies and gentlemen', voice: 'voice_vegas', response_format: 'mp3' },
        'the Chat voice id travels unchanged');

    const polly = await tts.synthesize('hello there', 'pl_matthew_neural', 'ann');
    assert.strictEqual(polly.voiceId, 'pl_matthew_neural');
    assert.strictEqual(polly.engine, 'amazon-polly', 'the voice keeps its engine label');
    assert.strictEqual(Buffer.from(polly.audio, 'base64').toString(), 'mp3 of pl_matthew_neural:hello there');
    assert.strictEqual(askedFetch.length, 2);

    assert.deepStrictEqual(askedProviders, [], 'no provider host was called with the setting on');
    console.log('tts-via-exchange: ok');
})().catch((err) => { console.log('FAIL', err); process.exit(err ? 1 : 0); }).finally(() => { globalThis.fetch = realFetch; });
