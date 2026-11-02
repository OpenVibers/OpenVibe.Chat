'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the front page's sections are one pick block, a row
 * of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for
 * the chips; every section stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, suite } = require('./helpers');

const t = suite('home short');
let h;

t('boot', async () => { h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } }); });

t('the home is one pick block: a chip per section, the first picked, every section in the page', async () => {
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
    const start = page.indexOf('<div class="pick" id="pick-explore">');
    assert.ok(start > 0, 'the pick block is on the home');
    const block = page.slice(start, page.indexOf('<div class="pick" id="pick-', start + 10) > 0 ? page.indexOf('<div class="pick" id="pick-', start + 10) : start + 60000);
    assert.match(block, /<nav class="pick-row" aria-label="Explore OpenVibe.Chat">/);
    const chips = [...block.matchAll(/<a class="pick-chip" href="#(?:pp-explore-)?([a-z-]+)">()([^<]+)<\/a>/g)];
    assert.ok(chips.length >= 3, `a chip per section (${chips.length})`);
    assert.ok(!/type="radio"/.test(block), 'no chip is a radio: nothing is picked, every pane shows');
    // Every section stays in the page, with the id its chip picks.
    const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every section is in the page, one per chip');
    // Nothing was removed: the sections of the front page are all there.
    for (const title of ['Stream chats on OpenVibe.Live', 'Public servers', 'Public rooms', 'What OpenVibe.Chat does', 'How it works']) {
        assert.ok(page.includes(title), `${title} is on the page`);
    }
});

t('the CSS guard: the chips are hidden and the sections all show until 640 px and where :has() is understood', async () => {
    const page = await fetch(`${h.base}/`).then((r) => r.text());
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'chat.css'), 'utf8');
    assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
});

t('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
    const page = await fetch(`${h.base}/`).then((r) => r.text());
    for (const id of ['faq', 'more']) {
        assert.ok(page.includes(`<details class="oc-fold oc-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
        assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
    }
    // The content of the folds stays in the page.
    assert.match(page, /<summary>Do I need an account to read\?<\/summary>/);
    assert.match(page, /OpenVibe\.Live<\/strong><span>Go live from your browser/);
});

t.run(async () => { if (h && h.close) await h.close(); });
