'use strict';
/**
 * Chat fetches no URL a user chose (roadmap WS-R task 5, the SSRF class), and the one URL it takes
 * from a third party, the 101soundboards audio file, cannot be steered inward.
 *
 *   - A ratchet: every file in server/ that makes an outbound request itself is on a reviewed list
 *     with the reason its URLs are not a user's choice (configured services, fixed provider hosts).
 *     A new one fails until it uses openvibe-shared/egress or is reviewed here.
 *   - The soundboard's audio URL comes from 101soundboards' API answer: only https on
 *     101soundboards.com is accepted, every DNS answer must be public (the platform's rule, which
 *     also knows ::ffff:127.0.0.1 and the other IPv6 spellings of internal addresses; the old
 *     check did not), and the download connects through safeLookup, so a name that answers
 *     "public" to the check and 127.0.0.1 to the download (rebinding) is refused where the
 *     connection is made. Before this suite, both got through.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const path = require('path');

// DNS for the test's 101soundboards names, installed before anything captures dns.lookup.
const PUBLIC_IP = '93.184.216.34';
let rebind = 0;
const FAKE = {
    'ok.101soundboards.com': () => [PUBLIC_IP],
    'mapped.101soundboards.com': () => ['::ffff:127.0.0.1'],
    'loop.101soundboards.com': () => ['127.0.0.1'],
    'meta.101soundboards.com': () => ['169.254.169.254'],
    'v6.101soundboards.com': () => ['::1'],
    'cgnat.101soundboards.com': () => ['100.64.0.1'],
    'mixed.101soundboards.com': () => [PUBLIC_IP, '10.0.0.1'],
    'rebind.101soundboards.com': () => (++rebind === 1 ? [PUBLIC_IP] : ['127.0.0.1']),
};
const answers = (host) => { const f = FAKE[String(host).toLowerCase()]; return f ? f().map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })) : null; };
const realLookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const a = answers(host);
    if (!a) return realLookup.call(this, host, opts, cb);
    const o = typeof opts === 'number' ? { family: opts } : (opts || {});
    process.nextTick(() => (o.all ? cb(null, a) : cb(null, a[0].address, a[0].family)));
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, opts) {
    const a = answers(host);
    if (!a) return realPromiseLookup.call(this, host, opts);
    return opts && opts.all ? a : a[0];
};
// Every connection attempt, by address (the download must never try an internal one).
const connects = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (o && typeof o === 'object' && o.host) connects.push(`${o.host}:${o.port}`);
    return realConnect.apply(this, args);
};

const { boot, suite } = require('./helpers');
const { noNetwork } = require('./security-crawl');

const t = suite('security: ssrf');
let h, sb;
let audioUrl = null;

t('boot (the 101soundboards API answers from the test)', async () => {
    h = await boot();
    noNetwork();
    const loopbackFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
        const u = String((url && url.url) || url);
        if (u.startsWith('https://www.101soundboards.com/')) {
            return Promise.resolve(new Response(JSON.stringify({ data: { sound_name: 'Horn', sound_file_url: audioUrl } }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return loopbackFetch(url, opts);
    };
    h.live.settings.soundboard_101_api_key = 'sentinel-not-a-secret-soundboard';
    await h.ctx.ensureSettings(true);
    sb = require('../server/chat/soundboard-service');
});

let soundId = 1000;
const fetchSound = async (url) => { audioUrl = url; return sb.getSoundboardAudio(String(++soundId)); };

t('the audio URL must be https on 101soundboards.com', async () => {
    for (const u of ['http://ok.101soundboards.com/a.mp3', 'https://127.0.0.1/a.mp3', 'https://2130706433/a.mp3', 'https://[::1]/a.mp3',
        'https://101soundboards.com.evil.example/a.mp3', 'https://evil.example/101soundboards.com/a.mp3', 'https://ok.101soundboards.com@127.0.0.1/a.mp3',
        'https://evil.example/a.mp3?x=.101soundboards.com']) {
        await assert.rejects(fetchSound(u), /./, u);
    }
});

t('a 101soundboards name that resolves inward (in any spelling, or with one internal answer) is refused, and never connected to', async () => {
    const before = connects.length;
    for (const host of ['mapped', 'loop', 'meta', 'v6', 'cgnat', 'mixed']) {
        await assert.rejects(fetchSound(`https://${host}.101soundboards.com/a.mp3`), /restricted|resolved/, host);
    }
    const inward = connects.slice(before).filter((c) => !c.startsWith(PUBLIC_IP));
    assert.deepStrictEqual(inward, []);
});

t('DNS rebinding: public at the check, loopback at the download — refused where the connection is made', async () => {
    rebind = 0;
    const before = connects.length;
    const r = await fetchSound('https://rebind.101soundboards.com/a.mp3').catch((e) => ({ error: e.message }));
    assert.ok(rebind >= 2, `the download resolved again (${rebind} lookups)`);
    assert.ok(!r || r.error || !r.audio, 'no audio came back');
    const tried = connects.slice(before);
    assert.ok(!tried.some((c) => /^(127\.|::1|::ffff:127)/.test(c)), `connected to ${tried.join(', ')}`);
});

t('ratchet: every file that makes an outbound request itself is reviewed', () => {
    const REVIEWED = {
        'server/net/service-auth.js': 'Network JWKS (configured)',
        'server/prefs/network-modules.js': 'Network user modules (configured)',
        'server/chat/routes.js': 'GIF providers (fixed hosts)',
        'server/chat/soundboard-service.js': '101soundboards (host allowlist; audio via safeLookup)',
        'server/chat/tts-engine.js': 'Google / AWS TTS (fixed hosts)',
    };
    const root = path.join(__dirname, '..');
    const found = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) walk(f);
            else if (e.name.endsWith('.js')) {
                const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                if (/(^|[^.\w])fetch\(|\bhttps?\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
            }
        }
    };
    walk(path.join(root, 'server'));
    assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a user-chosen URL goes through openvibe-shared/egress; then add the file here with the reason');
});

t.run(() => h && h.close());
