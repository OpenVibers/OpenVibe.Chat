'use strict';
/**
 * openvibe.chat, the site (server/web/): global chat reads without JavaScript and posts through the same
 * handler as the API; messages, a conversation (participants only) and settings need a signed-in
 * person; forms from another origin are refused; user text is escaped; sign-in goes to the Network with
 * the site's callback; the Frame's files, robots, sitemap and /updates are served.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('web');
let h, alice, bob, carol;
const SITE = 'https://openvibe.chat';
const cookie = (u) => ({ cookie: `ov_token=${u.token}` });
// Like h.http, but redirects are answers here, not followed.
const req = async (method, path, { headers = {}, raw } = {}) => {
    const r = await fetch(`${h.base}${path}`, { method, headers, body: raw, redirect: 'manual' });
    return { status: r.status, headers: r.headers, text: await r.text() };
};
const form = (u, fields, extra = {}) => ({ headers: { ...cookie(u), 'content-type': 'application/x-www-form-urlencoded', origin: SITE, ...extra }, raw: new URLSearchParams(fields).toString() });

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    for (const u of [alice, bob, carol]) { h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); }
});

t('global chat reads without JavaScript; signing in shows the composer', async () => {
    const r = await req('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /<h1 id="oc-h">Global chat<\/h1>/);
    assert.match(r.text, /Sign in with OpenVibe/);
    assert.match(r.text, /<meta name="robots" content="index, follow">/);
    assert.match(r.text, /\/shared\/navbar\.js\?v=/, 'the Frame from this site\'s own /shared/');
    assert.ok(!/id="oc-compose"/.test(r.text), 'no composer for a guest');
    const me = await req('GET', '/', { headers: cookie(alice) });
    assert.match(me.text, /id="oc-compose"/);
});

t('the composer posts without JavaScript, through the API\'s checks; other origins are refused', async () => {
    let r = await req('POST', '/send', form(alice, { message: 'hello <script>alert(1)</script> https://example.org/x' }));
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.get('location'), '/#oc-compose');
    const page = (await req('GET', '/')).text;
    assert.ok(page.includes('hello &lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped');
    assert.ok(page.includes('<a href="https://example.org/x" rel="nofollow ugc noopener"'), 'links are links');
    assert.ok(!page.includes('<script>alert(1)</script>'));
    r = await req('POST', '/send', form(alice, { message: 'from elsewhere' }, { origin: 'https://evil.example' }));
    assert.strictEqual(r.status, 403);
    r = await req('POST', '/send', form(alice, { message: '' }));
    assert.strictEqual(r.status, 303);
    assert.match(r.headers.get('location'), /^\/\?error=/, 'the API\'s refusal comes back as a notice');
    r = await req('POST', '/send', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, raw: 'message=hi' });
    assert.strictEqual(r.status, 303);
    assert.match(r.headers.get('location'), /^\/auth\/login\?next=/, 'signed out: sign in first');
});

t('messages: start a conversation by username, reply without JavaScript, participants only', async () => {
    assert.match((await req('GET', '/messages')).headers.get('location'), /^\/auth\/login\?next=%2Fmessages/);
    let r = await req('POST', '/messages/new', form(alice, { username: 'bob' }));
    assert.strictEqual(r.status, 303);
    const m = /^\/messages\/(\d+)$/.exec(r.headers.get('location'));
    assert.ok(m, r.headers.get('location'));
    r = await req('POST', `/messages/${m[1]}`, form(alice, { message: 'hi bob' }));
    assert.strictEqual(r.status, 303);
    const thread = await req('GET', `/messages/${m[1]}`, { headers: cookie(bob) });
    assert.strictEqual(thread.status, 200);
    assert.ok(thread.text.includes('hi bob'));
    assert.match(thread.text, /noindex, nofollow/);
    const inbox = await req('GET', '/messages', { headers: cookie(bob) });
    assert.ok(inbox.text.includes(`/messages/${m[1]}`));
    assert.strictEqual((await req('GET', `/messages/${m[1]}`, { headers: cookie(carol) })).status, 404, 'not a participant');
    r = await req('POST', `/messages/${m[1]}`, form(carol, { message: 'let me in' }));
    assert.match(r.headers.get('location'), /error=/, 'the API refuses a non-participant');
    r = await req('POST', '/messages/new', form(alice, { username: 'nobody_like_this' }));
    assert.match(r.headers.get('location'), /^\/messages\?error=/);
});

t('settings save to the chat.preferences record', async () => {
    let r = await req('GET', '/settings', { headers: cookie(alice) });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /name="timestamps"/);
    r = await req('POST', '/settings', form(alice, { timestamps: '1', compact: '1', font_size: 'large' }));
    assert.strictEqual(r.headers.get('location'), '/settings?saved=1');
    const rec = h.netModules.records.get(h.netModules.key('chat.preferences', alice.subject_id));
    assert.deepStrictEqual(rec && rec.data, { timestamps: true, compact: true, show_badges: false, font_scale: 1.18 });
    const page = await req('GET', '/', { headers: cookie(alice) });
    assert.match(page.text, /<body class="oc-compact oc-times oc-nobadges" style="--oc-scale:1.18">/, 'the site follows them too');
});

t('sign-in, the Frame, robots, sitemap and /updates', async () => {
    const r = await req('GET', '/auth/login?next=%2Fmessages');
    assert.strictEqual(r.status, 302);
    const u = new URL(r.headers.get('location'));
    assert.deepStrictEqual([u.pathname, u.searchParams.get('client_id'), u.searchParams.get('redirect_uri')], ['/oauth/authorize', 'chat', `${SITE}/auth/callback`]);
    assert.strictEqual((await req('GET', '/shared/navbar.js')).status, 200);
    assert.strictEqual((await req('GET', '/web/chat.css')).status, 200);
    assert.match((await req('GET', '/robots.txt')).text, /Disallow: \/messages/);
    assert.match((await req('GET', '/sitemap.xml')).text, /<loc>https:\/\/openvibe\.chat\/updates<\/loc>/);
    const up = await req('GET', '/updates');
    assert.strictEqual(up.status, 200);
    assert.match(up.text, /data-ov-shipped/);
    assert.strictEqual((await req('GET', '/api/nope')).status, 404, 'the API keeps its JSON 404');
});

t.run(async () => { if (h && h.close) await h.close(); });
