'use strict';
/**
 * Chat's secrets never leave in a response, an event or a log line (roadmap WS-R task 5, the
 * internal-secret class). Chat boots with a sentinel in every secret it holds: its Network OAuth
 * client secret, its OpenVibe.Events subscription secret, and the provider keys it reads from Live's
 * site settings (GIF, TTS, soundboard). Then every route the booted app has (listed from Express's
 * router stack, test/security-crawl.js) is requested as anonymous, a viewer, a streamer, a global
 * mod, an admin and the site owner, along with the probes (/health, /ready), unknown paths, every
 * write route with a broken body, the internal routes with a wrong or missing service token and the
 * events webhook with a forged signature. No body or header may contain an environment secret;
 * the stored provider keys are shown to the site owner only (the TTS settings page, where they are
 * edited). The events outbox and the log lines written meanwhile may not contain them either.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { ids } = require('openvibe-contracts');
const { getPaths, crawl, listRoutes, expand, leaks, noNetwork } = require('./security-crawl');

noNetwork();

const t = suite('security: secrets');
const ENV = {
    OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-chat-oauth-client',
    CHAT_EVENTS_SECRET: 'sentinel-not-a-secret-chat-events-subscription',
};
const SETTINGS = {
    gif_tenor_api_key: 'sentinel-not-a-secret-tenor',
    gif_giphy_api_key: 'sentinel-not-a-secret-giphy',
    tts_google_api_key: 'sentinel-not-a-secret-google-tts',
    tts_aws_access_key_id: 'sentinel-not-a-secret-aws-id',
    tts_aws_secret_access_key: 'sentinel-not-a-secret-aws-key',
    soundboard_101_api_key: 'sentinel-not-a-secret-soundboard',
};
let h, people;
const logs = [];

t('boot with a sentinel in every secret', async () => {
    h = await boot({ env: { ...ENV, CHAT_WEB_URL: 'https://openvibe.chat' } });
    Object.assign(h.live.settings, SETTINGS, { tts_enabled: true, tts_provider: 'google' });
    await h.ctx.ensureSettings(true);
    const mk = (name, opts = {}) => { const u = h.addUser(name, { subject: ids.newId('user'), ...opts }); h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); return u; };
    people = {
        anonymous: null, viewer: mk('viewer'), streamer: mk('streamer', { role: 'streamer' }), 'global mod': mk('staffmod', { role: 'global_mod' }),
        admin: mk('admin', { role: 'admin' }), 'site owner': mk('owner', { role: 'admin', is_owner: 1 }),
    };
    people.stream = h.addStream(people.streamer.id, h.addChannel(people.streamer.id), { title: 'Live now', is_live: 1 });
});

t('control: the site owner\'s TTS settings show the stored key (so a crawl that finds none means something)', async () => {
    const r = await h.http('GET', '/api/tts/admin/settings', { token: people['site owner'].token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.text.includes(SETTINGS.tts_google_api_key), 'the owner edits them here');
    const a = await h.http('GET', '/api/tts/admin/settings', { token: people.admin.token });
    assert.strictEqual(a.status, 200);
    assert.ok(!a.text.includes(SETTINGS.tts_google_api_key), 'an admin who is not the owner gets them masked');
});

t('every GET route, page and probe, as six people: no environment secret to anyone, no stored key to anyone but the owner', async () => {
    const orig = {};
    for (const m of ['log', 'info', 'warn', 'error']) { orig[m] = console[m]; console[m] = (...a) => { logs.push(a.map(String).join(' ')); }; }
    let r;
    try {
        const nonsense = ['-1', '99999999999', "'\"<x>", 'x'.repeat(300)];
        const values = () => [people.stream, people.streamer.id, 'streamer', 1, ...nonsense];
        const paths = getPaths(h.server, values, {
            query: 'q=x&provider=tenor&limit=-1&before=%27',
            extra: ['/health', '/ready', '/api/nope', '/nope/nope', '/.env', '/api/%', '/api/chat/gif/trending?provider=tenor', '/api/chat/gif/search?provider=giphy&q=cats',
                '/api/tts/settings', '/api/tts/voices', '/sitemap.xml', '/robots.txt'],
        });
        const all = { ...ENV, ...SETTINGS };
        r = await crawl(h, paths, people, (who) => (who === 'site owner' ? ENV : all));
        process.stdout.write(`    (${paths.length} paths × 6 people; answers ${JSON.stringify(r.statuses)})\n`);
    } finally { Object.assign(console, orig); }
    assert.ok(r.answered > 0);
    assert.deepStrictEqual(r.found, []);
});

t('every write route with a broken body, anonymous and as an admin: the error names no secret', async () => {
    const found = [];
    const values = () => [people.streamer.id, 'streamer', 1];
    for (const route of listRoutes(h.server)) {
        const method = route.methods.find((m) => ['post', 'put', 'patch', 'delete'].includes(m));
        if (!method) continue;
        for (const p of expand(route.path, values).slice(0, 1)) {
            for (const who of [null, people.admin]) {
                const res = await h.http(method.toUpperCase(), p, { token: who && who.token, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.200' }, raw: '{"broken": ' });
                for (const l of leaks(res, { ...ENV, ...SETTINGS })) found.push(`${who ? 'admin' : 'anonymous'}: ${method} ${p} → ${res.status} carries ${l.label}`);
            }
        }
    }
    assert.deepStrictEqual(found, []);
});

t('internal routes with a wrong, missing or other-audience service token, and the events webhook with a forged signature, echo nothing', async () => {
    const found = [];
    const internal = listRoutes(h.server).filter((r) => r.path.startsWith('/internal'));
    assert.ok(internal.length > 0, 'internal routes listed');
    const tokens = [null, 'not-a-token', h.serviceToken(['chat.context.read'], { aud: 'openvibe.somewhere-else' })];
    for (const route of internal) {
        for (const p of expand(route.path, () => [1])) {
            for (const method of route.methods.filter((m) => m !== '_all').concat(route.methods.includes('_all') ? ['post', 'get'] : [])) {
                for (const tok of tokens) {
                    const res = await h.http(method.toUpperCase(), p, { headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json', 'openvibe-signature': 't=1,v1=00', 'x-openvibe-signature': 'sha256=00' }, raw: method === 'get' ? undefined : '{"event_id":"evt_x"}' });
                    for (const l of leaks(res, { ...ENV, ...SETTINGS })) found.push(`${method} ${p} → ${res.status} carries ${l.label}`);
                    if (!tok) assert.ok(res.status >= 400, `${method} ${p} answered ${res.status} without a token`);
                }
            }
        }
    }
    assert.deepStrictEqual(found, []);
});

t('the events outbox and the log lines carry no secret', async () => {
    const rows = JSON.stringify(h.db.all('SELECT * FROM events_outbox'));
    for (const [k, v] of Object.entries({ ...ENV, ...SETTINGS })) {
        assert.ok(!rows.includes(v), `outbox carries ${k}`);
        const line = logs.find((l) => l.includes(v));
        assert.ok(!line, `a log line carries ${k}: ${line && line.slice(0, 160)}`);
    }
});

t.run(() => h && h.close());
