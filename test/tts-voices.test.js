'use strict';
/**
 * Every voice a person equips speaks as itself (server/chat/tts-engine.js; 2026-10-22: in production Amazon Polly
 * answered 403 "The security token included in the request is invalid", so every Polly voice became Gary, and Live's
 * voice_vegas was not in the catalog at all):
 *   - voice_vegas and vs_mine_dwarf_lord are in the catalog; voice_vegas is a Google voice with its own pitch and rate;
 *   - a Polly voice whose request is refused, or with no AWS key, speaks with its own Google stand-in;
 *   - every stand-in is a different Google voice, and none is a voice another entry already uses.
 * The network is a stand-in (https.request): Google answers with the voice it was asked for, Polly refuses.
 */
const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

const ctx = require('../server/live-context');
const SETTINGS = { tts_enabled: 'true', tts_google_api_key: 'test-google-key', tts_aws_access_key_id: 'AKIATESTTESTTESTTEST', tts_aws_secret_access_key: 'secret', tts_aws_region: 'us-east-1', tts_default_voice: 'gary' };
ctx.getSetting = (k) => (Object.prototype.hasOwnProperty.call(SETTINGS, k) ? SETTINGS[k] : null);

const asked = [];
https.request = (url, opts, cb) => {
    // Google is called as request(url, options, cb); Polly as request(options, cb).
    if (typeof url === 'object') { cb = opts; url = `https://${url.hostname || url.host}${url.path || '/'}`; }
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = (c) => {
        if (c) body += c;
        const host = new URL(String(url)).host;
        asked.push({ host, body });
        const res = new EventEmitter();
        let status = 200;
        let payload;
        if (host.includes('polly')) { status = 403; payload = { message: 'The security token included in the request is invalid.' }; }
        else { const voice = JSON.parse(body).voice.name; payload = { audioContent: Buffer.from(`mp3 of ${voice}`).toString('base64') }; }
        res.statusCode = status;
        res.headers = { 'content-type': 'application/json' };
        setImmediate(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify(payload))); res.emit('end'); });
    };
    req.on = req.addListener.bind(req);
    req.setTimeout = () => req;
    req.destroy = () => {};
    return req;
};
console.warn = () => {};
console.error = () => {};

const tts = require('../server/chat/tts-engine');
const voiceOf = (r) => Buffer.from(String(r.audio), 'base64').toString().replace('mp3 of ', '');

(async () => {
    const C = tts.VOICE_CATALOG;
    assert.ok(C.voice_vegas && C.voice_vegas.engine === 'google-cloud', 'voice_vegas is in the catalog');
    assert.ok(C.vs_mine_dwarf_lord && C.vs_mine_dwarf_lord.engine === 'espeak-ng', 'the Dwarf Lord is in the catalog');

    asked.length = 0;
    const vegas = await tts.synthesize('Ladies and gentlemen', 'voice_vegas', 'josh');
    assert.deepStrictEqual([vegas.engine, vegas.voiceId, voiceOf(vegas)], ['google-cloud', 'voice_vegas', 'en-US-Neural2-J']);
    const sent = JSON.parse(asked[0].body).audioConfig;
    assert.deepStrictEqual([sent.pitch, sent.speakingRate], [-4, 0.9], 'its own pitch and rate reach Google');
    // 2fat's Bass Boss (2026-10-23): one of a kind too, deeper still.
    const boss = await tts.synthesize('Bangers only', 'voice_twofat', '2fat');
    assert.deepStrictEqual([boss.engine, boss.voiceId, voiceOf(boss)], ['google-cloud', 'voice_twofat', 'en-US-Neural2-D']);
    assert.strictEqual(JSON.parse(asked[asked.length - 1].body).audioConfig.pitch, -8);
    const plain = await tts.synthesize('hello', 'gc_studio_m', 'x');
    assert.deepStrictEqual(JSON.parse(asked[asked.length - 1].body).audioConfig, { audioEncoding: 'MP3', speakingRate: 1, pitch: 0 }, 'other Google voices keep the defaults');
    assert.strictEqual(voiceOf(plain), 'en-US-Studio-Q');

    // Polly refuses (a bad AWS key): each voice speaks with its own stand-in, not Gary.
    const joanna = await tts.synthesize('hi', 'pl_joanna_std', 'x');
    const matthew = await tts.synthesize('hi', 'pl_matthew_std', 'x');
    assert.ok(asked.some((a) => a.host.includes('polly')), 'Polly was asked first');
    assert.deepStrictEqual([joanna.engine, joanna.fallback, joanna.voiceId, voiceOf(joanna)], ['google-cloud', 'google', 'pl_joanna_std', 'en-US-Standard-F']);
    assert.strictEqual(voiceOf(matthew), 'en-US-Standard-B');

    // No AWS key at all: the same stand-ins, without asking Polly.
    SETTINGS.tts_aws_access_key_id = '';
    tts.invalidateSettingsCache();
    asked.length = 0;
    const ivy = await tts.synthesize('hi', 'pl_ivy_std', 'x');
    assert.ok(!asked.some((a) => a.host.includes('polly')));
    assert.deepStrictEqual([ivy.fallback, voiceOf(ivy)], ['google', 'en-US-Standard-G']);

    // Every Polly voice has a stand-in; all are different and none is a voice another entry uses.
    const used = new Set(Object.values(C).filter((v) => v.cloudVoice).map((v) => v.cloudVoice.name));
    const polly = Object.entries(C).filter(([, v]) => v.engine === 'amazon-polly');
    const standIns = polly.map(([id, v]) => { assert.ok(v.googleStandIn, `${id} has a stand-in`); return v.googleStandIn.name; });
    assert.strictEqual(new Set(standIns).size, standIns.length, 'every stand-in is a different voice');
    for (const n of standIns) assert.ok(!used.has(n), `${n} is not already another voice`);
    console.log('tts voices: all checks passed');
})().catch((e) => { console.log(e); process.exit(1); });
