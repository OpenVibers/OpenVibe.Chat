'use strict';
/**
 * openvibe.chat's Cache-Control values (openvibe-shared/cache-policy): a /web asset is immutable
 * only at the content hash its own URL carries (layout.asset()'s ?v=) and gets the module's short
 * public window otherwise; robots.txt and the public pages carry the module's HTML policy, and a
 * personalised answer is never cached by anybody.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { assetVersion } = require('../server/web/layout');

const t = suite('asset cache');
let h;
const SITE = 'https://openvibe.chat';
const cacheOf = async (path) => (await fetch(`${h.base}${path}`)).headers.get('cache-control');

t('boot', async () => { h = await boot({ env: { CHAT_WEB_URL: SITE } }); });

t('/web asset: immutable only at its own ?v=, the module window otherwise', async () => {
    const v = assetVersion('chat.css');
    assert.strictEqual(v, assetVersion('chat.css'), 'the version is the same every time');
    assert.strictEqual(await cacheOf(`/web/chat.css?v=${v}`), 'public, max-age=31536000, immutable', 'the current hash is immutable');
    assert.strictEqual(await cacheOf('/web/chat.css?v=deadbeefdeadbeef'), 'public, max-age=300, stale-while-revalidate=86400', 'a hex but wrong ?v= is not immutable');
    assert.strictEqual(await cacheOf('/web/chat.css'), 'public, max-age=300, stale-while-revalidate=86400', 'no ?v= is not immutable');
});

t('robots.txt and a public page carry the module\'s HTML policy', async () => {
    assert.strictEqual(await cacheOf('/robots.txt'), 'public, max-age=3600, stale-while-revalidate=3600');
    assert.strictEqual(await cacheOf('/updates'), 'public, max-age=300, stale-while-revalidate=3600');
});

t('a personalised answer is private, no-store', async () => {
    assert.strictEqual(await cacheOf('/auth/me'), 'private, no-store');
});

t.run(async () => { if (h && h.close) await h.close(); });
