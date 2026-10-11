'use strict';
// Compatibility register C-05: Chat reads the Bearer header and the Network `ov_token` cookie only. Live's legacy
// `token` cookie (the same token under another name; Live no longer sets it) authenticates nothing, on REST or on
// the ban-exemption check of a WebSocket upgrade.
const assert = require('assert');
const { extractToken, banExemptionToken } = require('../server/auth/auth');

assert.strictEqual(extractToken({ headers: { authorization: 'Bearer bot' } }), 'bot');
assert.strictEqual(extractToken({ headers: {}, cookies: { ov_token: 'net' } }), 'net');
assert.strictEqual(extractToken({ headers: { cookie: 'ov_token=net' } }), 'net', 'the raw Cookie header (upgrades)');
assert.strictEqual(extractToken({ headers: {}, cookies: { token: 'legacy' } }), null, 'a lone legacy cookie authenticates nothing');
assert.strictEqual(extractToken({ headers: { cookie: 'token=legacy' } }), null, 'nor through the raw Cookie header');
assert.strictEqual(extractToken({ headers: {}, cookies: { token: 'legacy', ov_token: 'net' } }), 'net');
assert.strictEqual(banExemptionToken({ headers: { cookie: 'token=legacy' } }), null);
assert.strictEqual(banExemptionToken({ headers: { cookie: 'ov_token=net' } }), 'net');

console.log('legacy token cookie: Chat reads the bearer and ov_token only — all checks passed');
