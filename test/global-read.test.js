'use strict';
// Where the person stopped reading Global (the owner, 11-17: "remember where you were in the chat last and … save it
// locally and on the server … new messages … wherever you last read"): GET /api/chat/global/read says the last message
// they read and how many came after it (their own lines are not news); POST moves it forward only, never past the
// newest message; the menu on any OpenVibe site reaches it with its Bearer; and the account's erasure takes it.
//   node test/global-read.test.js
const assert = require('assert');
const crypto = require('crypto');
const { boot, suite, b64url } = require('./helpers');

const t = suite('global read');
let h, ann, ben;
// Its own people and lines each run: the test database outlives a run.
const RUN = crypto.randomBytes(3).toString('hex');
const sub = (c) => `usr_01J8Z3Q4R5S6T7V8W9X${RUN.slice(0, 5).toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0')}${c}`;
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims) => {
    const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    return `${head}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(head), h.keys.privateKey))}`;
};
const bearer = (u) => jwt({ iss: h.ISS, sub: String(u.id), subject_id: u.subject_id, username: u.username, role: u.role, iat: now(), exp: now() + 3600 });
const say = async (u, message) => {
    const r = await h.http('POST', '/api/chat/send', { token: u.token, body: { message } });
    assert.ok(r.status < 300, `${u.username} says ${message}: ${r.status} ${r.text}`);
};
const lineIds = async () => (await h.http('GET', '/api/chat/global/history?limit=50', { token: ann.token })).body.messages.filter((m) => m.message.startsWith(`gr${RUN} `)).map((m) => Number(m.id)).sort((a, b) => a - b);

t('boot', async () => {
    h = await boot();
    ann = h.addUser(`gra${RUN}`, { subject: sub('A1') });
    ben = h.addUser(`grb${RUN}`, { subject: sub('B2') });
    await h.ctx.sync();
    // User ids restart at 1001 in each process while a direct run's database stays: start these two from nothing.
    await require('../server/db/database').run('DELETE FROM global_reads WHERE user_id IN (?, ?)', [ann.id, ben.id]);
});

t('nothing read yet: 0, and nothing counted', async () => {
    const r = await h.http('GET', '/api/chat/global/read', { token: ann.token });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { last_read_id: 0, unread: 0, more: false });
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    assert.strictEqual((await h.http('GET', '/api/chat/global/read')).status, 401, 'signed out: no marker');
});

t('read up to a line: what came after it is counted, and her own lines are not', async () => {
    await say(ben, `gr${RUN} one`); await say(ben, `gr${RUN} two`); await say(ann, `gr${RUN} mine`); await say(ben, `gr${RUN} three`);
    const ids = await lineIds();
    assert.strictEqual(ids.length, 4, `four lines (${ids})`);
    const r = await h.http('POST', '/api/chat/global/read', { token: ann.token, body: { id: ids[0] } });
    assert.deepStrictEqual([r.status, r.body.last_read_id], [200, ids[0]]);
    const g = await h.http('GET', '/api/chat/global/read', { token: ann.token });
    assert.deepStrictEqual([g.body.last_read_id, g.body.unread], [ids[0], 2], 'ben\'s two later lines; her own is not news');
});

t('it only moves forward, and never past the newest line', async () => {
    const ids = await lineIds();
    await h.http('POST', '/api/chat/global/read', { token: ann.token, body: { id: ids[3] } });
    const back = await h.http('POST', '/api/chat/global/read', { token: ann.token, body: { id: ids[1] } });
    assert.strictEqual(back.body.last_read_id, ids[3], 'a stale tab cannot move it back');
    const far = await h.http('POST', '/api/chat/global/read', { token: ann.token, body: { id: ids[3] + 100000 } });
    assert.ok(far.body.last_read_id <= ids[3] + 5, `clamped to the newest message (${far.body.last_read_id})`);
    assert.strictEqual((await h.http('GET', '/api/chat/global/read', { token: ann.token })).body.unread, 0);
    assert.strictEqual((await h.http('POST', '/api/chat/global/read', { token: ann.token, body: { id: 'x' } })).status, 400);
    assert.strictEqual((await h.http('GET', '/api/chat/global/read', { token: ben.token })).body.last_read_id, 0, 'each person their own');
});

t('the menu on any OpenVibe site reads and moves it with its Bearer, never with credentials', async () => {
    const origin = 'https://openvibe.live';
    for (const [method, body] of [['GET'], ['POST', { id: 1 }]]) {
        const r = await h.http(method, '/api/chat/global/read', { token: bearer(ann), headers: { origin }, ...(body ? { body } : {}) });
        assert.ok(r.status < 400, `${method} from ${origin}: ${r.status} ${r.text}`);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), origin);
    }
    const pre = await h.http('OPTIONS', '/api/chat/global/read', { headers: { origin: 'https://openvibe.actor', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://openvibe.actor', 'a site outside the credentialed list gets the Bearer grant');
    assert.strictEqual((await h.http('GET', '/api/chat/global/read', { token: bearer(ann), headers: { origin: 'https://evil.example' } })).status, 403, 'a foreign web origin is refused');
});

t('the account\'s erasure takes the marker', async () => {
    const d = require('../server/db/database');
    assert.ok(await d.get('SELECT 1 AS x FROM global_reads WHERE user_id = ?', [ann.id]));
    const accountData = require('../server/chat/account-data');
    await accountData.erase(d.getDb(), [ann.subject_id]);
    assert.ok(!(await d.get('SELECT 1 AS x FROM global_reads WHERE user_id = ?', [ann.id])), 'gone');
});

t.run(async () => { await h.shutdown(); });
