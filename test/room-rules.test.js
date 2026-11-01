'use strict';
/**
 * Every room states how it works on its page (market outcome: "every room shows its rules and rate limits"): the
 * length a message may be, how fast a person may post, slow mode when it is on, what is filtered, and who reads. The
 * numbers are the ones rooms.post enforces (rooms.LIMITS), so the page and the rule cannot drift.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('room-rules');
let h, alice;
const page = async (slug) => (await fetch(`${h.base}/r/${slug}`)).text();
const rules = (html) => (/<details class="oc-rules"><summary>How this room works<\/summary><ul>([\s\S]*?)<\/ul><\/details>/.exec(html) || [])[1] || '';

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    alice = h.addUser('alice', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(alice.id));
    const rooms = require('../server/rooms/rooms');
    await rooms.create(alice, { name: 'Night Owls', topic: 'Late chats' });
});

t('a public room: its limits as rooms.post enforces them, no slow mode, anyone reads', async () => {
    const { LIMITS } = require('../server/rooms/rooms');
    const r = rules(await page('night-owls'));
    assert.ok(r, 'the room says how it works');
    assert.ok(r.includes(`<li>Messages up to ${LIMITS.maxText.toLocaleString('en-US')} characters</li>`));
    assert.ok(r.includes(`<li>At most ${LIMITS.rateMax} messages in ${LIMITS.rateSeconds} seconds each</li>`));
    assert.ok(r.includes('<li>No slow mode</li>'));
    assert.ok(r.includes('<li>Anyone can read; members post</li>'));
});

t('slow mode, when a room has it, is stated with its seconds', async () => {
    const db = require('../server/db/database');
    await db.run("UPDATE rooms SET slow_seconds = 15 WHERE slug = 'night-owls'");
    const html = await page('night-owls');
    assert.ok(rules(html).includes('<li>Slow mode: one message every 15 seconds (moderators are not slowed)</li>'));
    assert.ok(!/<p class="oc-muted oc-room-sub">[^<]*<details/.test(html), 'the fold is not inside the paragraph');
});

t('done', async () => { await h.close(); });
