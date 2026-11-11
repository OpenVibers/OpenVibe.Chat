'use strict';
/**
 * Owner settings (D11) for Chat's voice keys (server/settings.js, chat.voices):
 *   - every field carries a plain-English title, a 30+ character description, x-owner-input and,
 *     where a feature waits on it, x-required-for; the region enum names every option;
 *   - the admin proxy's capability is required, a secret is write-only and its marker never a value;
 *   - the read path prefers the owner's value and falls back to the environment;
 *   - the test route answers ok/failed in one line and never echoes a key (captured logs too).
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot, suite } = require('./helpers');
const { createSettings } = require('../server/settings');

const t = suite('owner-settings');
const CAP = 'chat.config.manage';
const NS = 'chat.voices';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const ACCESS_ID = 'AKIAOWNERSETTINGSTEST';
const SECRET = 'owner-secret-value-sentinel';
let h;

function listen(app) {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

t('boot', async () => {
    h = await boot({ env: { CHAT_POLLY_REGION: 'eu-west-1' } });
});

t('the namespace publishes every voice field with owner words', async () => {
    const r = await h.http('GET', `/internal/config/${NS}`, { token: h.serviceToken([CAP]) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.namespace, NS);
    assert.strictEqual(r.body.service, 'chat');
    const props = r.body.schema.properties;
    for (const [key, p] of Object.entries(props)) {
        assert.ok(p.title && p.title.length >= 3, `${key} has a plain title`);
        assert.ok(p.description && p.description.length >= 30, `${key} has a 30+ character description`);
        assert.ok(p['x-owner-input'] && p['x-owner-input'].group === 'voices', `${key} has an owner group`);
        assert.ok(typeof p['x-owner-input'].unlocks === 'string' && p['x-owner-input'].unlocks.length > 20, `${key} says what it unlocks`);
        assert.ok(/^https:\/\//.test(p['x-owner-input'].get_it_at), `${key} says where to get it`);
        assert.ok(p['x-required-for'], `${key} names the feature that waits on it`);
    }
    assert.deepStrictEqual(Object.keys(props).sort(), ['actor_members_enabled', 'amazon_polly_access_key_id', 'amazon_polly_region', 'amazon_polly_secret_access_key', 'forum_channels_enabled', 'google_cloud_service_account_json', 'stage_channels_enabled']);
    const region = props.amazon_polly_region;
    assert.ok(Array.isArray(region.enum) && region.enum.length >= 3);
    for (const v of region.enum) {
        assert.ok(region['x-enum-labels'][v].label && region['x-enum-labels'][v].description, `region ${v} has words`);
    }
});

t('the proxy capability is required and the environment is the fallback', async () => {
    assert.strictEqual((await h.http('GET', `/internal/config/${NS}`)).status, 401);
    assert.strictEqual((await h.http('GET', `/internal/config/${NS}`, { token: h.serviceToken(['chat.stats.read']) })).status, 403);
    const settings = require('../server/settings').current();
    assert.ok(settings, 'server/index.js created the settings');
    assert.strictEqual(settings.value('amazon_polly_region', 'CHAT_POLLY_REGION'), 'eu-west-1', 'env fallback when the owner has not set it');
    assert.strictEqual(settings.value('amazon_polly_region', 'CHAT_POLLY_REGION', 'us-east-1'), 'eu-west-1');
    assert.strictEqual(settings.value('amazon_polly_access_key_id', 'CHAT_POLLY_ACCESS_KEY_ID', 'none'), 'none', 'no value, no env: the caller fallback');
});

t('a secret is write-only and sealed in a marker', async () => {
    const token = h.serviceToken([CAP]);
    const put = (key, value) => h.http('PUT', `/internal/config/${NS}/secrets/${key}`, {
        token, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' }, body: { value, reason: 'owner test' },
    });
    const a = await put('amazon_polly_access_key_id', ACCESS_ID);
    assert.strictEqual(a.status, 200, a.text);
    assert.ok(a.body.fingerprint && a.body.hint, 'the answer is a marker');
    assert.ok(!a.text.includes(ACCESS_ID), 'the answer never carries the value');
    const b = await put('amazon_polly_secret_access_key', SECRET);
    assert.strictEqual(b.status, 200, b.text);

    const r = await h.http('GET', `/internal/config/${NS}`, { token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.values.amazon_polly_secret_access_key.redacted, 'the summary shows a marker');
    assert.ok(!r.text.includes(SECRET) && !r.text.includes(ACCESS_ID), 'no value in the summary');

    const settings = require('../server/settings').current();
    assert.strictEqual(settings.value('amazon_polly_access_key_id', 'CHAT_POLLY_ACCESS_KEY_ID'), ACCESS_ID, 'the code reads the owner value when set');
    assert.strictEqual(settings.value('amazon_polly_secret_access_key', 'CHAT_POLLY_SECRET_ACCESS_KEY'), SECRET);
});

t('the test hook says ok/failed in one line and never echoes a key', async () => {
    const logs = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => logs.push(a.join(' '));
    console.warn = (...a) => logs.push(a.join(' '));
    console.error = (...a) => logs.push(a.join(' '));
    let fake;
    try {
        fake = createSettings({
            db: h.db.getDb(), env: {}, log: console,
            probes: { 'amazon-polly': async (creds) => { throw new Error(`refused the key ${creds.awsSecretAccessKey}`); } },
        });
        await fake.ready;
        const app = express();
        app.use(express.json());
        fake.mount(app, { guard: (_req, _res, next) => next(), log: console });
        const { server, base } = await listen(app);
        try {
            const r = await fetch(`${base}/internal/config/${NS}/test/amazon_polly_secret_access_key`, { method: 'POST' });
            const body = await r.json();
            assert.strictEqual(r.status, 200);
            assert.strictEqual(body.ok, false);
            assert.ok(/^failed — /.test(body.detail), body.detail);
            assert.ok(!String(body.detail).includes(SECRET), 'the provider answer is redacted');
            assert.ok(!body.detail.includes('\n'), 'one line');
        } finally { server.close(); }
    } finally {
        console.log = real.log; console.warn = real.warn; console.error = real.error;
    }
    assert.ok(!logs.join('\n').includes(SECRET), 'no key in a captured log line');
});

t.run(async () => { if (h) await h.close(); });
