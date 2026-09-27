'use strict';
/**
 * network.subject.merged in Chat (roadmap WS-B task 5, ADR-029): the folded-in account's messages (by subject and by
 * Live user id, and the channel it posted in), DM messages, DM memberships (a conversation both are in keeps the
 * survivor's row), DM blocks and platform blocks (the survivor's pair wins; blocking oneself goes) become the
 * survivor's; moderation history stays. Once per event (the inbox); another source or a bad payload is ignored.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const t = suite('subject-merge');
let h, keep, fold, other;
const merged = (from, into, { source = 'network', mergeId = `mrg_${ids.ulid()}` } = {}) => ({
    event_id: ids.newId('event'), event_type: 'network.subject.merged', version: 1, source,
    actor: { type: 'user', id: into }, timestamp: new Date().toISOString(), visibility: 'internal',
    subject: { type: 'user', id: into }, payload: { merge_id: mergeId, from, into, merged_at: new Date().toISOString(), initiated_by: 'person' },
});

t('boot', async () => {
    h = await boot();
    keep = h.addUser('keep', { subject: ids.newId('user') });
    fold = h.addUser('fold', { subject: ids.newId('user') });
    other = h.addUser('otto', { subject: ids.newId('user') });
    await h.ctx.sync();
    assert.ok(require('../server/events/consumer').TOPICS.includes('network.subject.merged'), 'Chat subscribes to merges');
});

t('the folded-in account becomes the survivor in Chat', async () => {
    const d = require('../server/db/database').getDb();
    // Messages: in otto's channel and in fold's own channel.
    d.prepare("INSERT INTO chat_messages (user_id, username, message, channel_user_id, subject_id) VALUES (?, 'fold', 'hi otto', ?, ?), (?, 'otto', 'hi fold', ?, ?)")
        .run(fold.id, other.id, fold.subject_id, other.id, fold.id, other.subject_id);
    // DMs: fold↔otto (only fold), and a group where both keep and fold are.
    const dmFO = (await h.http('POST', '/api/dm/conversations', { token: fold.token, body: { user_ids: [other.id] } })).body.conversation.id;
    const group = (await h.http('POST', '/api/dm/conversations', { token: other.token, body: { user_ids: [keep.id, fold.id], name: 'Trio' } })).body.conversation.id;
    assert.strictEqual((await h.http('POST', `/api/dm/conversations/${dmFO}/messages`, { token: fold.token, body: { message: 'yo' } })).status < 300, true);
    d.prepare('INSERT INTO dm_blocks (blocker_id, blocked_id, blocker_subject_id) VALUES (?, ?, ?), (?, ?, ?)').run(fold.id, other.id, fold.subject_id, fold.id, keep.id, fold.subject_id);
    require('../server/chat/network-blocks').ensureSchema && require('../server/chat/network-blocks').ensureSchema();
    d.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)').run(fold.subject_id, other.subject_id, fold.subject_id, keep.subject_id);
    d.prepare("INSERT INTO moderation_actions (action_type, actor_subject_id) VALUES ('timeout', ?)").run(fold.subject_id);

    assert.strictEqual(h.eventsConsumer.apply(merged(fold.subject_id, keep.subject_id, { source: 'live' })).outcome, 'ignored:source');
    assert.strictEqual(h.eventsConsumer.apply({ ...merged(fold.subject_id, keep.subject_id), payload: { merge_id: 'nope' } }).outcome, 'ignored:payload');
    const ev = merged(fold.subject_id, keep.subject_id);
    assert.strictEqual(h.eventsConsumer.apply(ev).outcome, 'merged');

    const q = (sql, ...a) => d.prepare(sql).all(...a);
    assert.deepStrictEqual(q('SELECT user_id AS u, channel_user_id AS c, subject_id AS s FROM chat_messages ORDER BY id').map((m) => [m.u, m.c, m.s]),
        [[keep.id, other.id, keep.subject_id], [other.id, keep.id, other.subject_id]], 'authorship and the channel follow');
    assert.ok(q('SELECT sender_id, sender_subject_id FROM dm_messages').every((m) => m.sender_id === keep.id && m.sender_subject_id === keep.subject_id));
    assert.deepStrictEqual(q('SELECT user_id FROM dm_participants WHERE conversation_id = ? ORDER BY user_id', dmFO).map((p) => p.user_id), [keep.id, other.id].sort((x, y) => x - y));
    assert.deepStrictEqual(q('SELECT user_id FROM dm_participants WHERE conversation_id = ? ORDER BY user_id', group).map((p) => p.user_id), [keep.id, other.id].sort((x, y) => x - y), 'in the group once');
    assert.deepStrictEqual(q('SELECT blocker_id AS a, blocked_id AS b FROM dm_blocks').map((x) => [x.a, x.b]), [[keep.id, other.id]], 'moved; blocking oneself gone');
    assert.deepStrictEqual(q('SELECT blocker_subject AS a, blocked_subject AS b FROM network_blocks').map((x) => [x.a, x.b]), [[keep.subject_id, other.subject_id]]);
    assert.deepStrictEqual(q('SELECT actor_subject_id AS a FROM moderation_actions').map((x) => x.a), [fold.subject_id], 'moderation history stays as recorded');
    // The inbox makes a redelivery a no-op.
    assert.strictEqual(h.eventsConsumer.apply(ev).duplicate, true);
});

t.run(async () => { if (h && h.close) await h.close(); });
