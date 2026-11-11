'use strict';
// The room's AI overview in a header (server/web/insight-block.js): its own mark (a list), not the sparkle that opens
// Vibe beside it, and the page puts it among the header's tools rather than on a row of its own.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { insightBlock } = require('../server/web/insight-block');
const html = insightBlock({ state: 'ready', overview: { text: 'People are planning a game night.', topics: [], people: 3, messages: 12 }, timeline: [] });
assert.match(html, /aria-label="AI overview of this room"/);
assert.ok(html.includes('M9 6h11M9 12h11M9 18h11'), 'the overview has the list mark');
const pages = fs.readFileSync(path.join(__dirname, '../server/web/pages.js'), 'utf8');
assert.match(pages, /<span class="oc-chan-tools"><span class="oc-live" id="oc-live" hidden>● live<\/span>\$\{insightHtml\}/, 'Global chat puts it among the tools');
console.log('insight-block-icon: the overview has its own mark and sits among the header tools');
