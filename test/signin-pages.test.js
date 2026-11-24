'use strict';
// A signed-out visitor (or a crawler) who opens a page linked from the site's own menus gets a real page that says what
// the page is for, answered 200 and kept out of the index, not a 401 (the owner, 11-21: "everything should be just
// crawlable"; the 11-23 network crawl counted /inbox and /feeds as broken pages). Private places keep their 401.
//
//   node test/signin-pages.test.js
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('signin-pages');
let h;
const web = async (path) => {
    const r = await fetch(`${h.base}${path}`);
    return { status: r.status, text: await r.text() };
};

t('boot', async () => {
    h = await boot();
});

t('/inbox and /feeds answer 200 signed out, say what they are for, and stay out of the index', async () => {
    for (const [path, words] of [['/inbox', /support inbox for your website/], ['/feeds', /Feeds put what your coding agent is doing/]]) {
        const page = await web(path);
        assert.strictEqual(page.status, 200, `${path} answers 200`);
        assert.match(page.text, words, `${path} says what it is for`);
        assert.match(page.text, /noindex/, `${path} stays out of the index`);
        assert.match(page.text, new RegExp(`/auth/login\\?next=${encodeURIComponent(path).replace(/[/]/g, '\\/')}`), `${path} links to sign-in and back`);
    }
});

t('a page with no line of its own keeps its 401', async () => {
    const page = await web('/messages');
    assert.strictEqual(page.status, 401, '/messages is still a sign-in wall');
});

t('done', async () => {
    await h.close();
});
