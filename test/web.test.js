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

t('rooms: start one, post and join without JavaScript, private rooms stay private, owners manage', async () => {
    let r = await req('GET', '/rooms');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Sign in with OpenVibe<\/a> to start or join a room/);
    r = await req('POST', '/rooms/new', form(alice, { name: 'Coffee Talk', topic: 'Beans and brews' }));
    assert.deepStrictEqual([r.status, r.headers.get('location')], [303, '/r/coffee-talk']);
    r = await req('POST', '/r/coffee-talk', form(alice, { message: 'first cup <b>hot</b>' }));
    assert.strictEqual(r.status, 303);
    let page = await req('GET', '/r/coffee-talk');
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('first cup &lt;b&gt;hot&lt;/b&gt;'), 'escaped');
    assert.match(page.text, /Beans and brews/);
    assert.match(page.text, /index, follow/);
    page = await req('GET', '/r/coffee-talk', { headers: cookie(bob) });
    assert.match(page.text, /Join this room/);
    assert.strictEqual((await req('POST', '/r/coffee-talk', form(bob, { message: 'can I?' }))).headers.get('location').includes('error='), true, 'join first');
    assert.strictEqual((await req('POST', '/r/coffee-talk/join', form(bob, {}))).headers.get('location'), '/r/coffee-talk');
    assert.strictEqual((await req('POST', '/r/coffee-talk', form(bob, { message: 'now I can' }))).headers.get('location'), '/r/coffee-talk#oc-compose');
    const rooms = (await req('GET', '/rooms', { headers: cookie(bob) })).text;
    assert.match(rooms, /Your rooms/);

    r = await req('POST', '/rooms/new', form(alice, { name: 'Inner Circle', private: '1' }));
    assert.strictEqual(r.headers.get('location'), '/r/inner-circle');
    assert.strictEqual((await req('GET', '/r/inner-circle', { headers: cookie(bob) })).status, 404, 'private');
    assert.strictEqual((await req('GET', '/r/inner-circle')).status, 404);
    assert.ok(!(await req('GET', '/rooms')).text.includes('inner-circle'), 'not listed');
    assert.match((await req('GET', '/r/inner-circle', { headers: cookie(alice) })).text, /noindex, nofollow/);
    r = await req('POST', '/r/inner-circle/members', form(alice, { username: 'bob', role: 'member' }));
    assert.strictEqual(r.headers.get('location'), '/r/inner-circle/settings?saved=1');
    assert.strictEqual((await req('GET', '/r/inner-circle', { headers: cookie(bob) })).status, 200, 'invited');
    assert.strictEqual((await req('GET', '/r/inner-circle/settings', { headers: cookie(bob) })).headers.get('location'), '/r/inner-circle', 'members are not managers');
    const settings = await req('GET', '/r/inner-circle/settings', { headers: cookie(alice) });
    assert.match(settings.text, /Room settings/);
    r = await req('POST', '/r/inner-circle/settings', form(alice, { name: 'Inner Circle', topic: 'Quiet', visibility: 'private', slow_seconds: '5' }));
    assert.strictEqual(r.headers.get('location'), '/r/inner-circle/settings?saved=1');
    assert.match((await req('GET', '/r/inner-circle', { headers: cookie(alice) })).text, /slow mode 5s/);

    const sitemap = (await req('GET', '/sitemap.xml')).text;
    assert.ok(sitemap.includes('/r/coffee-talk') && !sitemap.includes('inner-circle'), 'public rooms only');
});

t('the session probe: a guest is signed out (200 { user: null }), a bad credential is 401', async () => {
    const guest = await req('GET', '/auth/me');
    assert.strictEqual(guest.status, 200, 'no cookie or token at all: not an error');
    assert.deepStrictEqual(JSON.parse(guest.text), { user: null });
    assert.strictEqual(guest.headers.get('cache-control'), 'private, no-store');
    assert.strictEqual((await req('GET', '/auth/me', { headers: { cookie: 'ov_token=expired.or.forged' } })).status, 401, 'a present but invalid cookie');
    assert.strictEqual((await req('GET', '/auth/me', { headers: { authorization: 'Bearer nope' } })).status, 401, 'a present but invalid bearer token');
    const me = await req('GET', '/auth/me', { headers: cookie(alice) });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(JSON.parse(me.text).user.username, 'alice');
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

t('unknown pages: a browser gets the site\'s HTML 404 page, the API and other clients keep JSON', async () => {
    const html = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
    const r = await req('GET', '/__ovcheck-404', { headers: html });
    assert.strictEqual(r.status, 404);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.match(r.text, /<h1>Page not found<\/h1>/);
    assert.match(r.text, /<meta name="robots" content="noindex">/);
    assert.match(r.text, /<code>\/__ovcheck-404<\/code>/);
    assert.match(r.text, /\/shared\/navbar\.js\?v=/, 'inside the Frame, like every page');
    const x = await req('GET', '/%3Cscript%3Ex', { headers: html });
    assert.strictEqual(x.status, 404);
    assert.ok(!x.text.includes('<script>x'), 'the path is escaped');
    for (const [path, headers] of [['/api/nope', html], ['/internal/nope', html], ['/nope', {}], ['/nope', { accept: 'application/json' }]]) {
        const j = await req('GET', path, { headers });
        assert.strictEqual(j.status, 404, path);
        assert.match(j.headers.get('content-type'), /^application\/json/, `${path} ${JSON.stringify(headers)}: JSON`);
    }
    const post = await req('POST', '/nope', { headers: html });
    assert.strictEqual(post.status, 404);
    assert.match(post.headers.get('content-type'), /^application\/json/, 'a form post to nowhere keeps JSON');
});

t.run(async () => { if (h && h.close) await h.close(); });
