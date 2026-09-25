'use strict';
/**
 * The chat.* user modules Chat owns since openvibe-contracts 0.41.0 (server/prefs/stores.js):
 *
 *   - /api/chat/tts-settings, /api/chat/dm-settings, /api/chat/presence read and write chat.tts_defaults,
 *     chat.dm_settings and chat.presence_prefs on Network, like /api/chat/preferences
 *   - chat.dm_settings is enforced: "nobody" refuses a new direct conversation (an existing one stays
 *     open), group_invites false refuses a group and being added to one
 *   - chat.presence_prefs is enforced: someone hidden is counted in the user list, not named; a change
 *     made elsewhere (network.module.updated) refreshes the list
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('chat modules');
const ANN = 'usr_01J9ANN0000000000000000AAA';
const BOB = 'usr_01J9B0B0000000000000000AAA';
const CAT = 'usr_01J9CAT0000000000000000AAA';
let h, ann, bob, cat;

t('boot with a stub Network that knows ann, bob and cat', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ANN });
    bob = h.addUser('bob', { subject: BOB });
    cat = h.addUser('cat', { subject: CAT });
    h.netModules.subjects.add(ANN).add(BOB).add(CAT);
});

t('each module has its route; the body key is settings', async () => {
    for (const [path, ns] of [['tts-settings', 'chat.tts_defaults'], ['dm-settings', 'chat.dm_settings'], ['presence', 'chat.presence_prefs']]) {
        const r = await h.http('GET', `/api/chat/${path}`, { token: ann.token });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.namespace, ns);
        assert.deepStrictEqual(r.body.settings, {});
    }
    let r = await h.http('PUT', '/api/chat/tts-settings', { token: ann.token, body: { settings: { volume: 40, sources: { kick: false } } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.settings, { volume: 40, sources: { kick: false } });
    assert.strictEqual(r.body.version, 2, 'chat.tts_defaults v2');
    r = await h.http('PUT', '/api/chat/tts-settings', { token: ann.token, body: { settings: { volume: 400 } } });
    assert.strictEqual(r.status, 422, 'the schema is enforced');
    r = await h.http('PUT', '/api/chat/tts-settings', { token: ann.token, body: { settings: { voice: 'x' } } });
    assert.strictEqual(r.status, 422, 'v1 fields are gone');
    r = await h.http('PUT', '/api/chat/tts-settings', { token: ann.token, body: { preferences: { volume: 1 } } });
    assert.strictEqual(r.status, 400, 'these routes take { settings }');
});

t('chat.dm_settings: nobody refuses a new direct conversation, an existing one stays open', async () => {
    const existing = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(existing.status, 200, existing.text);
    let r = await h.http('PUT', '/api/chat/dm-settings', { token: bob.token, body: { settings: { new_conversations: 'nobody', group_invites: false } } });
    assert.strictEqual(r.status, 200, r.text);
    r = await h.http('POST', '/api/dm/conversations', { token: cat.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'dm.not_accepting');
    r = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(r.status, 200, 'the conversation they already have still opens');
    assert.strictEqual(r.body.conversation.id, existing.body.conversation.id);
    r = await h.http('POST', `/api/dm/conversations/${existing.body.conversation.id}/messages`, { token: ann.token, body: { message: 'still here' } });
    assert.strictEqual(r.status, 200, r.text);
});

t('chat.dm_settings: group_invites false refuses a group and being added to one', async () => {
    let r = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [bob.id, cat.id], name: 'trio' } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'dm.no_group_invites');
    const dave = h.addUser('dave', { subject: 'usr_01J9DAVE000000000000000AAA' });
    h.netModules.subjects.add('usr_01J9DAVE000000000000000AAA');
    r = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [cat.id, dave.id], name: 'trio' } });
    assert.strictEqual(r.status, 200, r.text);
    r = await h.http('POST', `/api/dm/conversations/${r.body.conversation.id}/participants`, { token: ann.token, body: { user_id: bob.id } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'dm.no_group_invites');
});

t('chat.presence_prefs: someone hidden is counted, not named; a change elsewhere refreshes the list', async () => {
    let r = await h.http('PUT', '/api/chat/presence', { token: cat.token, body: { settings: { show_in_user_list: false } } });
    assert.strictEqual(r.status, 200, r.text);
    const wsCat = await h.ws({ ip: '198.51.100.21', token: cat.token });
    wsCat.sendJson({ type: 'join', token: cat.token });
    await wsCat.next((m) => m.type === 'auth');
    const wsAnn = await h.ws({ ip: '198.51.100.22', token: ann.token });
    wsAnn.sendJson({ type: 'join', token: ann.token });
    await wsAnn.next((m) => m.type === 'auth');
    wsAnn.sendJson({ type: 'get-users' });
    let list = (await wsAnn.next((m) => m.type === 'users-list')).users;
    assert.ok(list.logged.some((u) => u.username === 'ann'));
    assert.ok(!list.logged.some((u) => u.username === 'cat'), 'cat is not named');
    assert.strictEqual(list.hiddenCount, 1, 'cat is counted');

    // Cat turns it back on somewhere else (Network announces it): the list names them again.
    const rec = h.netModules.records.get(`chat.presence_prefs|${CAT}`);
    rec.data = { show_in_user_list: true }; rec.revision += 1;
    const stores = require('../server/prefs/stores');
    const chatServer = require('../server/chat/chat-server');
    assert.ok(stores.presence.handleEvent({ event_type: 'network.module.updated', source: 'network', payload: { namespace: 'chat.presence_prefs', owner: { type: 'user', id: CAT }, revision: rec.revision } }));
    chatServer.presenceChanged(CAT);
    list = (await wsAnn.next((m) => m.type === 'users-list' && m.users.logged.some((u) => u.username === 'cat'), 4000)).users;
    assert.strictEqual(list.hiddenCount, 0);
    wsCat.close(); wsAnn.close();
});

t.run(async () => { if (h) await h.close(); });
