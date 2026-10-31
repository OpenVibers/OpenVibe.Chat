'use strict';
/**
 * The home on a phone (the owner's rule, 2026-10-31): every section of the front page is on it, on every screen. The
 * chip row that picked one at a time is gone; the parts a reader rarely needs are folds that start open, so nothing
 * is hidden on a phone.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, suite } = require('./helpers');

const t = suite('home short');
let h;

t('boot', async () => { h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } }); });

t('the home shows every section: no chip row, every section in the page', async () => {
    // A public room and a public server, and a live stream, so the page has the parts it lists.
    const owner = { id: 1, subject_id: 'usr_home_short' };
    await require('../server/rooms/rooms').create(owner, { name: 'Coffee talk', slug: 'coffee-talk', topic: 'A room to talk in' });
    await require('../server/rooms/servers').create(owner, { name: 'Makers', slug: 'makers', description: 'People who build things' });
    const db = require('../server/db/database');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db.run("INSERT INTO ctx_users (username, display_name, created_at) VALUES ('streamer_x', 'Streamer X', ?)", [stamp]);
    const streamer = await db.get("SELECT id FROM ctx_users WHERE username = 'streamer_x'");
    await db.run("INSERT INTO ctx_streams (user_id, title, is_live, started_at) VALUES (?, 'Live from the studio', 1, ?)", [streamer.id, stamp]);
    const page = await fetch(`${h.base}/`).then((r) => r.text());
    assert.ok(!page.includes('pick-explore'), 'the explore chip row is gone');
    // Every section stays in the page; each keeps the id a link into it uses.
    const panes = [...page.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
    assert.ok(panes.length >= 3, `every section is in the page (${panes.length})`);
    // Nothing was removed: the sections of the front page are all there.
    for (const title of ['Stream chats on OpenVibe.Live', 'Public servers', 'Public rooms', 'What OpenVibe.Chat does', 'How it works']) {
        assert.ok(page.includes(title), `${title} is on the page`);
    }
});

t('nothing hides a home section or a Vibe suggestion on a phone', async () => {
    const page = await fetch(`${h.base}/`).then((r) => r.text());
    assert.ok(!page.includes('@supports selector(:has(*)){@media (max-width:640px){.pick:has'), 'no pick rule is written for the explore sections');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'vibe.css'), 'utf8');
    assert.ok(!/\.vb-suggest li:nth-child\(n\+3\) \{ display: none/.test(css), 'no suggestion is hidden at 520 px');
    assert.ok(!/\.vb-suggest li:nth-child\(n\+2\) \{ display: none/.test(css), 'no suggestion is hidden on a short phone');
    assert.match(css, /\.vb-suggest \{ display: flex; gap: 8px; overflow-x: auto;/, 'the suggestions scroll sideways instead');
});

t('the parts a reader rarely needs are folds that start open on every screen', async () => {
    const page = await fetch(`${h.base}/`).then((r) => r.text());
    for (const id of ['faq', 'more']) {
        assert.ok(page.includes(`<details class="oc-fold oc-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
        assert.ok(!page.includes(`document.getElementById("${id}")`), `${id} is never closed by script`);
    }
    // The content of the folds stays in the page.
    assert.match(page, /<summary>Do I need an account to read\?<\/summary>/);
    assert.match(page, /OpenVibe\.Live<\/strong><span>Go live from your browser/);
});

t.run(async () => { if (h && h.close) await h.close(); });
