'use strict';
const assert = require('assert');
const { render } = require('../server/chat/emoji-text');
const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const map = new Map([['party', { url: 'https://openvibe.media/chat/party.png' }]]);
assert.strictEqual(render('hi :party: :gone: <script>', map, escape, escape), 'hi <img class="oc-server-emoji" src="https://openvibe.media/chat/party.png" alt=":party:" width="22" height="22" loading="lazy"> :gone: &lt;script>');
assert.strictEqual(render(':party:', new Map(), escape, escape), ':party:');
console.log('emoji-text: render and removed fallback passed');
