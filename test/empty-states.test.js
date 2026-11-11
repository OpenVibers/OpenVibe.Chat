'use strict';
/** Owner ask 81: a sidebar with nothing uses the shared kit's empty state, not a bare "No X yet" line. */
const assert = require('assert');
const shell = require('../server/web/shell');

const has = (html, s) => assert.ok(html.includes(s), `expected to find: ${s}`);

const home = shell.sideHome({ dms: [], friends: [], requests: [] });
has(home, 'class="ovk-empty"');
has(home, 'No friends yet');
has(home, 'No requests');
has(home, 'No conversations yet');
has(home, 'class="oc-side-empty"');

const inbox = shell.sideInbox({ inboxes: [] });
has(inbox, 'class="ovk-empty"');
has(inbox, 'No inboxes yet');
has(inbox, 'Make an inbox');
has(inbox, 'ovk-btn');

console.log('ok - Chat sidebars draw the kit empty state');
