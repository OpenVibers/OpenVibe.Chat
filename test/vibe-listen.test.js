'use strict';
/**
 * Vibe by voice for browsers without their own speech recognition (plan L48 V2; server/rooms/vibe-api.js
 * POST /api/vibe/listen): a short recording goes to OpenVibe.AI inline (chat.vibe.listen → live.stt) and comes
 * back as { text }. Only the person themself, 20 a minute / 200 an hour, the audio never written down or logged.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { boot, suite, b64url } = require('./helpers');

const t = suite('vibe listen');
const now = () => Math.floor(Date.now() / 1000);
const jwt = (h, claims) => {
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), h.keys.privateKey))}`;
};
const dock = (h, u) => jwt(h, { iss: `${h.ISS}/dock`, sub: String(u.id), id: u.id, subject_id: u.subject_id, username: u.username, client_id: 'companion', scope: 'chat.read', fam: `fam_${'a'.repeat(24)}`, iat: now(), exp: now() + 3600 });
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from('vibe-listen-test-audio')]);
const MARKER = 'OV-LISTEN-AUDIO-MARKER';

let h, ann, apiUser;
let seen = null;
let fail = false;

const listen = (token, body, { type = 'audio/ogg', query = '', headers = {} } = {}) =>
    h.http('POST', `/api/vibe/listen${query}`, { token, raw: body, headers: { 'Content-Type': type, ...headers } });

function filesUnder(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

t('boot with a stand-in OpenVibe.AI', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    const aiClient = require('../server/ai/client');
    aiClient._setClient({
        runs: {
            create: async (workflow, input, opts) => {
                if (fail) throw new Error('AI is down');
                seen = { workflow, input, opts };
                return { run: { status: 'succeeded', output: { text: 'Remind me to stretch.', language: 'en', segments: [{ start: 0, end: 2, text: 'Remind me to stretch.' }] } } };
            },
        },
    });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    apiUser = h.addUser('bot', { subject: ids.newId('user'), apiScopes: ['chat'] });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    await h.ctx.upsertUser(h.live.users.get(apiUser.id));
});

t('a recording comes back as text, sent to AI inline', async () => {
    const r = await listen(ann.token, OGG, { query: '?lang=en' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { text: 'Remind me to stretch.' });
    assert.strictEqual(seen.workflow, 'chat.vibe.listen');
    assert.strictEqual(seen.input.audio.mime, 'audio/ogg');
    assert.strictEqual(seen.input.language, 'en');
    assert.deepStrictEqual(seen.opts.attribution, { service: 'chat', type: 'user', id: ann.subject_id }, 'the run is attributed to the person who spoke');
    assert.ok(seen, 'AI was called although CHAT_AI_ENABLED is off: the person is waiting, not a background job');
    const b64 = /^data:audio\/ogg;base64,(.+)$/.exec(seen.input.audio.data_url);
    assert.ok(b64, seen.input.audio.data_url.slice(0, 40));
    assert.deepStrictEqual(Buffer.from(b64[1], 'base64'), OGG, 'the same bytes AI received');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
});

t('a MediaRecorder content type with codecs is accepted', async () => {
    const r = await listen(ann.token, OGG, { type: 'audio/webm;codecs=opus' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(seen.input.audio.mime, 'audio/webm');
    assert.ok(seen.input.audio.data_url.startsWith('data:audio/webm;base64,'));
});

t('only the person themself: signed out, an API token and the Dock token are refused', async () => {
    assert.strictEqual((await listen(null, OGG)).status, 401);
    assert.strictEqual((await listen(apiUser.token, OGG)).status, 403);
    assert.strictEqual((await listen(dock(h, ann), OGG)).status, 401, 'a Dock token is a read-only DM token and never authenticates a write');
});

t('a wrong type, an empty body and a bad lang are refused', async () => {
    let r = await listen(ann.token, Buffer.from('{"a":1}'), { type: 'application/json' });
    assert.strictEqual(r.status, 415, r.text);
    r = await listen(ann.token, Buffer.alloc(0));
    assert.strictEqual(r.status, 422, r.text);
    r = await listen(ann.token, OGG, { query: '?lang=english' });
    assert.strictEqual(r.status, 422, r.text);
});

t('more than 1 MB is refused before AI is called', async () => {
    seen = null;
    const r = await listen(ann.token, Buffer.alloc(1024 * 1024 + 2, 1));
    assert.strictEqual(r.status, 413, r.text);
    assert.strictEqual(seen, null, 'nothing reached AI');
});

t('20 a minute per person', async () => {
    const rita = h.addUser('rita', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(rita.id));
    for (let i = 0; i < 20; i++) assert.strictEqual((await listen(rita.token, OGG)).status, 200, `request ${i + 1}`);
    assert.strictEqual((await listen(rita.token, OGG)).status, 429);
});

t('AI down answers a problem, and the recording is never written down', async () => {
    fail = true;
    try {
        const r = await listen(ann.token, Buffer.concat([OGG, Buffer.from(MARKER)]));
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.body.code, 'vibe.listen_unavailable');
    } finally { fail = false; }
    const leaked = filesUnder(h.tmp).filter((f) => fs.readFileSync(f).includes(MARKER));
    assert.deepStrictEqual(leaked, [], 'no file under Chat\'s data directory holds the audio');
});

t('done', async () => {
    require('../server/ai/client')._setClient(null);
    await h.close();
});

t.run();
