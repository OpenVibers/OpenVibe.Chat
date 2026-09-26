'use strict';
// deploy/nginx/openvibe.chat.conf: the shared navbar asks /auth/me on every page view, so the session probe has its own location on
// the API zone; the sign-in routes keep the strict zone (10 a minute). Both answer 429 when limited, not
// nginx's default 503 (the browser check, OpenVibe.Host scripts/browser-check.js, found /auth/me answering
// 503 after about ten quick page loads, which the navbar reads as signed out).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', ...'deploy/nginx/openvibe.chat.conf'.split('/')), 'utf8');
const block = (loc) => { const m = conf.match(new RegExp(`\\n    location ${loc} \\{\\n([\\s\\S]*?)\\n    \\}`)); return m && m[1]; };
const probe = block('= /auth/me'), auth = block('/auth/');
assert.ok(probe && auth, 'both locations');
assert.ok(conf.indexOf('location = /auth/me') < conf.indexOf('location /auth/ {'));
assert.match(probe, /limit_req zone=ovchat_api burst=30 nodelay;/);
assert.match(auth, /limit_req zone=ovchat_auth burst=10 nodelay;/);
for (const b of [probe, auth]) assert.match(b, /limit_req_status 429;/);
const upstream = (b) => (b.match(/proxy_pass (\S+);/) || [])[1];
assert.ok(upstream(probe) && upstream(probe) === upstream(auth), 'the same upstream');
console.log('nginx auth limit: /auth/me on the API zone, 429 when limited');
