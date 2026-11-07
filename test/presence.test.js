'use strict';
/**
 * Chat's Network presence (plan 2026-10-22 track X item 9; Contracts 0.318.0):
 *   - server/presence.js reads GET /internal/presence for one viewer, caches it 30 s, and fails closed;
 *   - DM lists and DM headers carry `presence` per participant;
 *   - room member lists carry `presence` per person, built separately for each viewer;
 *   - DND mutes Chat's own DM ping (`silent: true`) and the Network push;
 *   - POST /internal/chat/dm/peers answers the shared-conversation set for Network
 *     (chat.dm.peers.read, chat.dm-peers-result@1).
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('presence');
const ANN = 'usr_01J9ANN0000000000000000AAA';
const BOB = 'usr_01J9B0B0000000000000000AAA';
const CAT = 'usr_01J9CAT0000000000000000AAA';
let h, ann, bob, cat, conv;

const view = (subject, state, extra = {}) => ({
    subject, state, status_text: extra.status_text || null, emoji: extra.emoji || null,
    live: !!extra.live, updated_at: '2026-11-07T09:00:00.000Z',
});

t('boot with a stub Network that knows ann, bob and cat', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ANN });
    bob = h.addUser('bob', { subject: BOB });
    cat = h.addUser('cat', { subject: CAT });
    h.netModules.subjects.add(ANN).add(BOB).add(CAT);
    h.netPresence.rows.set(BOB, view(BOB, 'online', { status_text: 'Around' }));
    h.netPresence.rows.set(CAT, view(CAT, 'dnd'));
});

t('a DM list and a DM header carry the presence Network returned for this viewer', async () => {
    let r = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(r.status, 200, r.text);
    conv = r.body.conversation.id;
    assert.deepStrictEqual(r.body.conversation.participants.find((p) => p.id === bob.id).presence.state, 'online');
    assert.strictEqual(h.netPresence.calls.at(-1).for, ANN, 'read as the person who asked');

    r = await h.http('GET', '/api/dm/conversations', { token: ann.token });
    assert.strictEqual(r.status, 200, r.text);
    const listed = r.body.conversations.find((c) => c.id === conv);
    assert.deepStrictEqual(listed.participants.find((p) => p.id === bob.id).presence, view(BOB, 'online', { status_text: 'Around' }));

    r = await h.http('GET', `/api/dm/conversations/${conv}`, { token: bob.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.conversation.participants.find((p) => p.id === ann.id).presence, null, 'no row is a null presence, not an error');

    // The read is cached 30 s: the same viewer and member set does not ask Network again.
    const calls = h.netPresence.calls.length;
    await h.http('GET', '/api/dm/conversations', { token: ann.token });
    assert.strictEqual(h.netPresence.calls.length, calls, 'cached');
});

t('DND mutes the DM ping and the Network push, and only DND does', async () => {
    h.netPresence.rows.set(BOB, view(BOB, 'dnd'));
    require('../server/presence').clearCache();
    const sent = [];
    const orig = h.chatServer.sendDm;
    h.chatServer.sendDm = async (id, payload) => { sent.push({ id, payload }); };
    try {
        let r = await h.http('POST', `/api/dm/conversations/${conv}/messages`, { token: ann.token, body: { message: 'heads down?' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].id, bob.id);
        assert.strictEqual(sent[0].payload.silent, true, 'Bob is in DND');
        assert.ok(!h.live.effects.some((e) => e.name === 'notify/dm'), 'no Network push for the DND recipient');

        h.netPresence.rows.set(BOB, view(BOB, 'online'));
        require('../server/presence').clearCache();
        r = await h.http('POST', `/api/dm/conversations/${conv}/messages`, { token: ann.token, body: { message: 'lunch?' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(sent[1].payload.silent, undefined, 'online gets the normal ping');
        assert.ok(h.live.effects.some((e) => e.name === 'notify/dm'), 'and the Network push');
    } finally { h.chatServer.sendDm = orig; }
});

t('room member lists carry presence, built for the viewer', async () => {
    const streamer = h.addUser('streamer', { role: 'streamer' });
    const channelId = h.addChannel(streamer.id);
    const streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
    h.netPresence.rows.set(BOB, view(BOB, 'away', { live: true }));
    require('../server/presence').clearCache();
    const a = await h.ws({ ip: '198.51.100.41', token: ann.token, stream: streamId });
    const b = await h.ws({ ip: '198.51.100.42', token: bob.token, stream: streamId });
    try {
        a.sendJson({ type: 'join', streamId, token: ann.token });
        b.sendJson({ type: 'join', streamId, token: bob.token });
        await a.next((m) => m.type === 'auth' && m.user_id === ann.id);
        await b.next((m) => m.type === 'auth' && m.user_id === bob.id);
        a.sendJson({ type: 'get-users' });
        const list = await a.next((m) => m.type === 'users-list' && m.users.logged.some((u) => u.username === 'bob'));
        const listed = list.users.logged.find((u) => u.username === 'bob');
        assert.strictEqual(listed.presence.state, 'away');
        assert.strictEqual(listed.presence.live, true);
        assert.strictEqual(h.netPresence.calls.at(-1).for, ANN, 'the list was built for Ann');
    } finally { a.close(); b.close(); }
});

t('the DM peer read answers shared conversations only, with subjects only', async () => {
    const token = h.serviceToken(['chat.dm.peers.read'], { aud: 'openvibe.chat' });
    let r = await h.http('POST', '/internal/chat/dm/peers', { token, body: { subject: ANN, candidates: [BOB, CAT] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(validate('chat.dm-peers-result@1', r.body).valid, JSON.stringify(validate('chat.dm-peers-result@1', r.body).errors));
    assert.deepStrictEqual([r.body.subject, r.body.peers], [ANN, [BOB]]);
    assert.ok(!r.text.includes('messages') && !r.text.includes('Around'), 'no message, status or name');
    r = await h.http('POST', '/internal/chat/dm/peers', { token: h.serviceToken(['chat.messages.read'], { aud: 'openvibe.chat' }), body: { subject: ANN, candidates: [BOB] } });
    assert.strictEqual(r.status, 403, 'another capability is refused');
    r = await h.http('POST', '/internal/chat/dm/peers', { token, body: { subject: ANN, candidates: ['bob'] } });
    assert.strictEqual(r.status, 400);
    r = await h.http('POST', '/internal/chat/dm/peers', { token, body: { subject: ANN, candidates: [BOB], extra: 1 } });
    assert.strictEqual(r.status, 400);
});
