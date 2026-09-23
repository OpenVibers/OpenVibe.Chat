'use strict';
/**
 * Chat preferences in the Network user module chat.preferences (server/prefs/, roadmap Wave 1 item 24):
 *
 *   - GET/PUT /api/chat/preferences for the signed-in person, read and written on Network with Chat's
 *     service token (audience openvibe.network, network.modules.read + write), If-Match on every write
 *   - the cache: Chat's writes land in it, reads within CHAT_PREFS_TTL_MS never reach Network, a change
 *     made elsewhere shows after the TTL, or at once through handleEvent(network.module.updated)
 *   - a race with another writer is read again and merged; a browser If-Match is strict (412)
 *   - schema refusals (422), no subject (409), API tokens read-only, Network down (stale copy or 503)
 *
 * The stub Network (test/helpers.js) keeps records with Network's revision and If-Match rules.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('preferences');
const ANN = 'usr_01J9ANN0000000000000000AAA';
const BOB = 'usr_01J9B0B0000000000000000AAA';
const NS = 'chat.preferences';
let h, prefs, ann, bob, nosub, bot, outsider;
const clock = { t: Date.now(), now() { return clock.t; } };
const calls = (method) => h.netModules.calls.filter((c) => c.method === method).length;
const record = (subject) => h.netModules.records.get(`${NS}|${subject}`) || null;

t('boot with a stub Network that knows ann and bob', async () => {
    h = await boot({ env: { CHAT_PREFS_TTL_MS: '60000' } });
    prefs = require('../server/prefs/chat-preferences');
    prefs._configure({ now: () => clock.now() });
    ann = h.addUser('ann', { subject: ANN });
    bob = h.addUser('bob', { subject: BOB });
    nosub = h.addUser('nosub');
    bot = h.addUser('botty', { subject: 'usr_01J9B0TTY000000000000000AA', apiScopes: ['chat'] });
    outsider = h.addUser('outsider', { subject: 'usr_01J9XTRANGER0000000000000A' });
    h.netModules.subjects.add(ANN).add(BOB).add('usr_01J9B0TTY000000000000000AA');
});

t('reading needs a signed-in person; nothing stored yet is {} at revision 0', async () => {
    let r = await h.http('GET', '/api/chat/preferences');
    assert.strictEqual(r.status, 401);
    r = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { namespace: NS, version: 1, revision: 0, preferences: {} });
    assert.strictEqual(r.headers.get('etag'), '"0"');
    assert.ok(r.headers.get('cache-control').includes('no-store'));
    const tok = h.tokenRequests.find((x) => x.audience === 'openvibe.network');
    assert.ok(tok, 'a token for Network was asked for');
    assert.strictEqual(tok.scope, 'network.modules.read network.modules.write');
    assert.strictEqual(tok.client, 'chat');
});

t('a write goes to Network with If-Match and lands in the cache', async () => {
    const r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: { timestamps: true, font_scale: 1.18 } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.preferences, { timestamps: true, font_scale: 1.18 });
    assert.strictEqual(r.body.revision, 1);
    const put = h.netModules.calls.filter((c) => c.method === 'PUT').at(-1);
    assert.strictEqual(put.ifMatch, '"0"', 'names the revision it read');
    assert.deepStrictEqual(record(ANN).data, { timestamps: true, font_scale: 1.18 });
    assert.strictEqual(record(ANN).updated_by, 'svc:chat');
    const gets = calls('GET');
    const again = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.deepStrictEqual(again.body.preferences, { timestamps: true, font_scale: 1.18 });
    assert.strictEqual(calls('GET'), gets, 'served from the cache');
});

t('a patch changes only its fields; null removes one; a no-op writes nothing', async () => {
    let r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: { compact: true, timestamps: null } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.preferences, { font_scale: 1.18, compact: true });
    assert.strictEqual(r.body.revision, 2);
    const puts = calls('PUT');
    r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.revision, 2);
    assert.strictEqual(calls('PUT'), puts, 'nothing changed, nothing written');
});

t('the namespace schema is enforced', async () => {
    let r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: { font_scale: 5 } } });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.body.code, 'prefs.invalid'); assert.ok(r.body.errors.length);
    r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: { ttsVolume: 80 } } });
    assert.strictEqual(r.status, 422); assert.ok(r.body.error.includes('ttsVolume'));
    r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: [true] } });
    assert.strictEqual(r.status, 400);
    r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: {} });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(record(ANN).data, { font_scale: 1.18, compact: true }, 'nothing written');
});

t('a change made outside Chat shows after the TTL', async () => {
    h.netModules.set(NS, ANN, { compact: false });          // e.g. the person on my.openvibe.network
    let r = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.deepStrictEqual(r.body.preferences, { font_scale: 1.18, compact: true }, 'still the cached copy');
    clock.t += 60_001;
    r = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.deepStrictEqual(r.body.preferences, { compact: false });
    assert.strictEqual(r.body.revision, 3);
});

t('network.module.updated newer than the cached copy drops it at once', async () => {
    const rev = h.netModules.set(NS, ANN, { hide_emotes: true });
    const ev = (revision, over = {}) => ({ event_type: 'network.module.updated', source: 'network', payload: { owner: { type: 'user', id: ANN }, namespace: NS, revision, change: 'updated', keys: ['hide_emotes'], ...over } });
    assert.strictEqual(prefs.handleEvent(ev(3)), false, 'not newer than what the cache holds');
    assert.strictEqual(prefs.handleEvent(ev(rev, { namespace: 'chat.tts_defaults' })), false, 'another namespace');
    assert.strictEqual(prefs.handleEvent({ ...ev(rev), source: 'live' }), false, 'only Network announces modules');
    assert.strictEqual(prefs.handleEvent(ev(rev)), true);
    const r = await h.http('GET', '/api/chat/preferences', { token: ann.token });
    assert.deepStrictEqual(r.body.preferences, { hide_emotes: true });
});

t('another writer between read and write: read again, patch applied on top', async () => {
    h.netModules.beforeWrite = () => h.netModules.set(NS, ANN, { hide_emotes: true, show_badges: false });
    const r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, body: { preferences: { timestamps: true } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.preferences, { hide_emotes: true, show_badges: false, timestamps: true }, 'nothing of the other write lost');
    assert.deepStrictEqual(record(ANN).data, r.body.preferences);
});

t('a browser If-Match is strict: 412 when the record moved', async () => {
    const cur = record(ANN).revision;
    let r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, headers: { 'If-Match': `"${cur - 1}"` }, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 412); assert.strictEqual(r.body.code, 'prefs.revision_conflict');
    r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, headers: { 'If-Match': `"${cur}"` }, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.revision, cur + 1);
    r = await h.http('PUT', '/api/chat/preferences', { token: ann.token, headers: { 'If-Match': 'nope' }, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 400);
});

t('no Network subject: 409; a subject Network does not know reads empty and cannot write', async () => {
    let r = await h.http('GET', '/api/chat/preferences', { token: nosub.token });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'prefs.subject_unknown');
    r = await h.http('GET', '/api/chat/preferences', { token: outsider.token });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.preferences, {});
    r = await h.http('PUT', '/api/chat/preferences', { token: outsider.token, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'prefs.subject_unknown');
});

t('API tokens read, never write', async () => {
    let r = await h.http('GET', '/api/chat/preferences', { token: bot.token });
    assert.strictEqual(r.status, 200);
    r = await h.http('PUT', '/api/chat/preferences', { token: bot.token, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'prefs.token_denied');
});

t('Network down: the cached copy (stale) or 503; writes 503', async () => {
    await h.http('GET', '/api/chat/preferences', { token: bob.token });     // bob cached, empty
    clock.t += 60_001;
    h.netModules.down = true;
    try {
        let r = await h.http('GET', '/api/chat/preferences', { token: bob.token });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.stale, true);
        prefs.invalidate(BOB);
        r = await h.http('GET', '/api/chat/preferences', { token: bob.token });
        assert.strictEqual(r.status, 503); assert.strictEqual(r.body.code, 'prefs.unavailable');
        r = await h.http('PUT', '/api/chat/preferences', { token: bob.token, body: { preferences: { compact: true } } });
        assert.strictEqual(r.status, 503);
    } finally { h.netModules.down = false; }
    const r = await h.http('PUT', '/api/chat/preferences', { token: bob.token, body: { preferences: { compact: true } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(record(BOB).data, { compact: true });
});

t.run(async () => { if (h) await h.close(); });
