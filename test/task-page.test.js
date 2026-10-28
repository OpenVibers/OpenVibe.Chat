'use strict';
/**
 * A task's page and the queue's preview (server/web/workspace-pages.js; the owner, 2026-10-28: "there's no formatting of
 * the text"): an agent writes Markdown, so the queue's one-line preview drops the marks and keeps the words, and the
 * page's facts say how long it took in plain words. The page's icons (server/web/icons.js) are decorative: the control
 * around each one carries its name. The live room client (public/web/chat.js) renders an AI member's Markdown with the
 * same escaping renderer as the server and makes its delete control an icon.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { plain, took } = require('../server/web/workspace-pages');
const { ICONS } = require('../server/web/icons');

assert.strictEqual(
    plain("I couldn't do it: **no computer is open to me**.\n\n**What I did**\n1. Asked for `list_my_computers`\n- see [the machines page](https://openvibe.bot/machines)"),
    "I couldn't do it: no computer is open to me. What I did Asked for list_my_computers see the machines page");
assert.strictEqual(plain('```\ncode\n```\nafter'), 'after');
assert.strictEqual(plain('snake_case and 2*3*4 stay'), 'snake_case and 2*3*4 stay');

assert.strictEqual(took({ started_at: '2026-10-28 10:00:00', finished_at: '2026-10-28 10:00:02' }), 'a few seconds');
assert.strictEqual(took({ started_at: '2026-10-28 10:00:00', finished_at: '2026-10-28 10:00:40' }), '40 seconds');
assert.strictEqual(took({ created_at: '2026-10-28 10:00:00', finished_at: '2026-10-28 10:07:10' }), '7 min');
assert.strictEqual(took({ started_at: '2026-10-28 10:00:00', finished_at: '2026-10-28 11:30:00' }), '1 h 30 min');
assert.strictEqual(took({ started_at: '2026-10-28 10:00:00', finished_at: null }), null);

for (const [name, svg] of Object.entries(ICONS)) {
    assert.match(svg, /^<svg class="oc-i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/, `${name} is decorative`);
    assert.doesNotMatch(svg, /<script|on\w+=/i, `${name} is markup only`);
}

const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'chat.js'), 'utf8');
assert.match(client, /if \(ai && window\.VibeMarkdown\) \{ t = el\('div', 'oc-text vb-md'\); t\.innerHTML = window\.VibeMarkdown\.render\(m\.message\); \}/);
assert.match(client, /x\.innerHTML = TRASH;/);
assert.ok(!/el\('button', null, '×'\)/.test(client), 'no bare × for delete');

console.log('task page: preview, durations, icons and the room client checked');
