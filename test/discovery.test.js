'use strict';
/**
 * openvibe.chat's crawl artifacts (server/web/discovery.js): llms.txt, robots.txt and sitemap.xml,
 * plus the home page's JSON-LD. Everything they carry is public — a private room, a direct message
 * or a per-person path must never appear in any of them.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('discovery');
let h, alice;
const SITE = 'https://openvibe.chat';
const req = async (path) => {
    const r = await fetch(`${h.base}${path}`, { redirect: 'manual' });
    return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', text: await r.text() };
};
// Anything that would only exist for one person, or that a crawler must not follow.
const PRIVATE = [/\/messages/, /\/settings/, /\/auth\//, /\/api\//, /\/internal\//, /\/ws\//, /private-room/, /token/, /secret/i];

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    alice = h.addUser('alice', { subject: ids.newId('user') });
    h.ctx.upsertUser(h.live.users.get(alice.id));
    const rooms = require('../server/rooms/rooms');
    rooms.create(alice, { name: 'Night Owls', topic: 'Late chats' });
    rooms.create(alice, { name: 'Closed Room', slug: 'private-room', visibility: 'private' });
    await h.http('POST', '/api/chat/send', { token: alice.token, body: { message: 'hello from the test' } });
    // Backdate the message so "lastmod is the data's own day" is checkable against "not today".
    const db = require('../server/db/database');
    db.run("UPDATE chat_messages SET timestamp = '2026-01-02 03:04:05' WHERE id = (SELECT MAX(id) FROM chat_messages)");
    h.db.run("UPDATE rooms SET last_message_at = '2026-02-03 04:05:06' WHERE slug = 'night-owls'");
    require('../server/chat/history-store').invalidate('global');
});

t('/llms.txt describes the site, its public pages and its machine-readable endpoints', async () => {
    const r = await req('/llms.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /^text\/plain/);
    assert.match(r.cache, /public/, 'cached like the site\'s other public answers');
    assert.match(r.text, /^# OpenVibe\.Chat/, 'llmstxt.org: the name first');
    for (const of_ of [`${SITE}/`, `${SITE}/rooms`, `${SITE}/updates`, `${SITE}/sitemap.xml`]) {
        assert.ok(r.text.includes(of_), `mentions ${of_}`);
    }
    for (const re of PRIVATE) assert.ok(!re.test(r.text), `no private path in llms.txt (${re})`);
});

t('/robots.txt keeps every Disallow and welcomes the search and AI crawlers', async () => {
    const r = await req('/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /^text\/plain/);
    for (const d of ['/r/*/settings', '/messages', '/settings', '/auth/', '/api/']) {
        assert.ok(r.text.includes(`Disallow: ${d}`), `still disallows ${d}`);
    }
    for (const a of ['/', '/updates', '/rooms', '/r/']) assert.ok(r.text.includes(`Allow: ${a}`), `allows ${a}`);
    assert.match(r.text, /Sitemap: https:\/\/openvibe\.chat\/sitemap\.xml/);
    assert.match(r.text, /User-agent: GPTBot/);
    assert.match(r.text, /User-agent: ClaudeBot/);
});

t('/sitemap.xml is the public pages with a real lastmod, never today', async () => {
    const r = await req('/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /^application\/xml/);
    assert.match(r.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    for (const p of ['/', '/rooms', '/updates', '/r/night-owls']) {
        assert.ok(r.text.includes(`<loc>${SITE}${p === '/' ? '/' : p}</loc>`), `lists ${p}`);
    }
    assert.ok(!r.text.includes('private-room'), 'a private room is not in the sitemap');
    for (const re of PRIVATE) assert.ok(!re.test(r.text), `no private path in the sitemap (${re})`);
    const today = new Date().toISOString().slice(0, 10);
    const mods = [...r.text.matchAll(/<lastmod>([\d-]+)<\/lastmod>/g)].map((m) => m[1]);
    assert.ok(mods.length >= 2, 'at least the room and the global chat carry a lastmod');
    for (const m of mods) {
        assert.match(m, /^\d{4}-\d{2}-\d{2}$/);
        assert.notStrictEqual(m, today, 'lastmod is never the day the sitemap was fetched');
    }
    // The global chat's lastmod is the newest public message's own day, not the fetch day.
    const home = r.text.split('<url>').find((u) => u.includes(`<loc>${SITE}/</loc>`));
    assert.ok(home.includes('<lastmod>2026-01-02</lastmod>'), 'the home page lastmod is the message\'s own day');
    const room = r.text.split('<url>').find((u) => u.includes(`<loc>${SITE}/r/night-owls</loc>`));
    assert.ok(room.includes('<lastmod>2026-02-03</lastmod>'), 'the room lastmod is its last_message_at');
});

t('the home page carries JSON-LD: WebSite plus the site\'s primary type', async () => {
    const r = await req('/');
    assert.strictEqual(r.status, 200);
    const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
    const types = blocks.flatMap((b) => [b['@type'], ...(b['@type'] === 'WebSite' ? [] : [])]).filter(Boolean);
    assert.ok(types.includes('WebSite'), 'WebSite');
    assert.ok(types.includes('WebApplication'), 'the chat itself (softwareApp)');
    const site = blocks.find((b) => b['@type'] === 'WebSite');
    assert.strictEqual(site.url, SITE);
    assert.strictEqual(site.name, 'OpenVibe.Chat');
    const app = blocks.find((b) => b['@type'] === 'WebApplication');
    assert.strictEqual(app.url, SITE);
    const ldOnly = blocks.map((b) => JSON.stringify(b)).join('\n');
    for (const re of PRIVATE) assert.ok(!re.test(ldOnly), `no private path in the JSON-LD (${re})`);
    assert.ok(!/alice|\/r\/night-owls/.test(ldOnly), 'no person and no room in the JSON-LD');
    // The reader's own identity never reaches the head: the same markup signed in or out.
    const me = await req('/');
    const asUser = await fetch(`${h.base}/`, { headers: { cookie: `ov_token=${alice.token}` } }).then((r) => r.text());
    assert.strictEqual([...asUser.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => m[1]).join(''),
        [...me.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => m[1]).join(''),
        'the JSON-LD is the same for every reader');
});

t.run(async () => { if (h && h.close) await h.close(); });
