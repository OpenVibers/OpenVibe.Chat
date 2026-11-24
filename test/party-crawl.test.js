'use strict';
// openvibe.party for crawlers (the 11-23 network crawl: no robots.txt or sitemap of its own, and the full footer's
// Updates link answered 404 there): a robots.txt that welcomes every bot and names the sitemap, a sitemap with the
// home, and /updates going to Chat's (the party host is served by OpenVibe.Chat).
//
//   node test/party-crawl.test.js
const assert = require('assert');
const http = require('http');
const { boot, suite } = require('./helpers');

const t = suite('party crawl');
let h;
function raw(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: h.port, path, method: 'GET', headers: { host: 'openvibe.party' } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end();
    });
}

t('boot', async () => { h = await boot(); });

t('robots.txt welcomes every bot, keeps parties out, and names the sitemap', async () => {
    const r = await raw('/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /text\/plain/);
    assert.match(r.text, /User-agent: \*/);
    assert.match(r.text, /Disallow: \/p\//);
    assert.match(r.text, /Sitemap: \S+\/sitemap\.xml/);
    assert.doesNotMatch(r.text, /Disallow: \/\s*$/m, 'no stray Disallow: /');
});

t('the sitemap lists the home', async () => {
    const r = await raw('/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /<urlset[\s\S]*<loc>[^<]*\/<\/loc>/);
});

t('/updates goes to Chat\'s updates', async () => {
    const r = await raw('/updates');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.location, 'https://openvibe.chat/updates');
});

t('done', async () => { await h.close(); });
