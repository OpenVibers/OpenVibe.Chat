'use strict';
/**
 * Platform blocks in Chat (WS-E task 5, Contracts 0.49.0 network.block.changed): the projection keeps the
 * newest revision per (blocker, blocked) and ignores older, replayed, foreign or malformed events; while a
 * block is active, neither person can start a conversation with the other, message them in a 1:1 or add
 * them to a group, and the user search hides them (both directions), exactly as dm_blocks already does;
 * an unblock lifts it. The one-off scripts/migrate-dm-blocks-to-network.js maps dm_blocks to subject pairs
 * (dry run by default) for Network's scripts/import-blocks.js.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ids, validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('network-blocks');
let h, alice, bob, carol, dave, nosubject, convAB, group;
const event = (blocker, blocked, active, revision, { source = 'network' } = {}) => ({
    event_id: ids.newId('event'), event_type: 'network.block.changed', version: 1, source,
    actor: { type: 'user', id: blocker }, timestamp: new Date().toISOString(), visibility: 'internal',
    subject: { type: 'user', id: blocker }, payload: { blocker, blocked, active, revision, at: new Date().toISOString() },
});

t('boot', async () => {
    h = await boot();
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    dave = h.addUser('dave', { subject: ids.newId('user') });
    nosubject = h.addUser('legacyonly');
    await h.ctx.sync();
    assert.ok(require('../server/events/consumer').TOPICS.includes('network.block.changed'), 'Chat subscribes to it');
    // Before any block: a 1:1 and a group.
    convAB = (await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id] } })).body.conversation.id;
    group = (await h.http('POST', '/api/dm/conversations', { token: carol.token, body: { user_ids: [bob.id, dave.id], name: 'Crew' } })).body.conversation.id;
    assert.ok(convAB && group);
    assert.ok(validate('network.block.changed@1', event(bob.subject_id, alice.subject_id, true, 1).payload).valid);
});

t('the projection keeps the newest revision per pair', async () => {
    const nb = require('../server/chat/network-blocks');
    const e1 = event(bob.subject_id, alice.subject_id, true, 1);
    assert.strictEqual(h.eventsConsumer.apply(e1).outcome, 'blocked');
    assert.strictEqual(h.eventsConsumer.apply(e1).duplicate, true, 'a redelivery is a no-op');
    assert.ok(nb.hasBlocked(bob.subject_id, alice.subject_id));
    assert.ok(!nb.hasBlocked(alice.subject_id, bob.subject_id), 'one direction');
    assert.ok(nb.eitherBlockedUsers(alice.id, bob.id) && nb.eitherBlockedUsers(bob.id, alice.id));
    // Out of order: revision 3 (unblock) then the late revision 2 (block) changes nothing.
    assert.strictEqual(h.eventsConsumer.apply(event(dave.subject_id, carol.subject_id, false, 3)).outcome, 'unblocked');
    assert.strictEqual(h.eventsConsumer.apply(event(dave.subject_id, carol.subject_id, true, 2)).outcome, 'unchanged', 'an older revision never wins');
    assert.ok(!nb.hasBlocked(dave.subject_id, carol.subject_id));
    // Only Network's, only valid payloads.
    assert.strictEqual(h.eventsConsumer.apply(event(dave.subject_id, carol.subject_id, true, 9, { source: 'live' })).outcome, 'ignored:source');
    const bad = event(dave.subject_id, carol.subject_id, true, 9); bad.payload.blocked = 'carol';
    assert.strictEqual(h.eventsConsumer.apply(bad).outcome, 'ignored:payload');
    const zero = event(dave.subject_id, carol.subject_id, true, 0);
    assert.strictEqual(h.eventsConsumer.apply(zero).outcome, 'ignored:payload', 'revision starts at 1');
    assert.ok(!nb.hasBlocked(dave.subject_id, carol.subject_id));
});

t('DMs: bob blocked alice on the network — refused both ways, same shapes as dm_blocks', async () => {
    // A new conversation, either way.
    let r = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id, carol.id] } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Cannot start a conversation with this user' }], 'the blocked person cannot start one');
    r = await h.http('POST', '/api/dm/conversations', { token: bob.token, body: { user_ids: [alice.id] } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Cannot start a conversation with this user' }], 'nor the blocker');
    // Messages in their existing 1:1, either way.
    r = await h.http('POST', `/api/dm/conversations/${convAB}/messages`, { token: alice.token, body: { message: 'hello?' } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Cannot send messages in this conversation' }]);
    r = await h.http('POST', `/api/dm/conversations/${convAB}/messages`, { token: bob.token, body: { message: 'go away' } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Cannot send messages in this conversation' }]);
    // Being added to a group bob is in.
    r = await h.http('POST', `/api/dm/conversations/${group}/participants`, { token: carol.token, body: { user_id: alice.id } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Cannot add this user' }]);
    // The user search hides them from each other, not from others.
    assert.deepStrictEqual((await h.http('GET', '/api/dm/users/search?q=bo', { token: alice.token })).body.users, []);
    assert.deepStrictEqual((await h.http('GET', '/api/dm/users/search?q=ali', { token: bob.token })).body.users, []);
    assert.deepStrictEqual((await h.http('GET', '/api/dm/users/search?q=ali', { token: carol.token })).body.users.map((u) => u.username), ['alice']);
    // Others are untouched; the participant check still comes first.
    r = await h.http('POST', `/api/dm/conversations/${group}/messages`, { token: carol.token, body: { message: 'hi crew' } });
    assert.strictEqual(r.status, 200);
    r = await h.http('POST', `/api/dm/conversations/${group}/messages`, { token: alice.token, body: { message: 'let me in' } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Not a participant' }]);
    // Chat's own "is blocked" answer stays about dm_blocks (its block button), not the network block.
    assert.strictEqual((await h.http('GET', `/api/dm/blocks/check/${alice.id}`, { token: bob.token })).body.blocked, false);
});

t('an unblock lifts it', async () => {
    assert.strictEqual(h.eventsConsumer.apply(event(bob.subject_id, alice.subject_id, false, 2)).outcome, 'unblocked');
    let r = await h.http('POST', `/api/dm/conversations/${convAB}/messages`, { token: alice.token, body: { message: 'hi again' } });
    assert.strictEqual(r.status, 200, r.text);
    r = await h.http('POST', `/api/dm/conversations/${group}/participants`, { token: carol.token, body: { user_id: alice.id } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual((await h.http('GET', '/api/dm/users/search?q=bo', { token: alice.token })).body.users.map((u) => u.username), ['bob']);
});

t('migration: dm_blocks → subject pairs for Network (dry run by default)', async () => {
    const migrate = require('../scripts/migrate-dm-blocks-to-network');
    assert.deepStrictEqual((await h.http('POST', `/api/dm/blocks/${bob.id}`, { token: carol.token })).body, { ok: true });
    await h.http('POST', `/api/dm/blocks/${carol.id}`, { token: dave.token });
    await h.http('POST', `/api/dm/blocks/${nosubject.id}`, { token: dave.token });   // no Network subject: skipped
    const out = path.join(h.tmp, 'pairs.json');
    const lines = [];
    let code = await migrate.main([], (m) => lines.push(m));
    assert.strictEqual(code, 0);
    assert.match(lines.join('\n'), /dm_blocks 3; pairs for Network 2; skipped: blocked-without-subject 1/);
    assert.match(lines.join('\n'), new RegExp(`Live ids without a Network subject: ${nosubject.id}`));
    assert.match(lines.join('\n'), /dry run: nothing written/);
    assert.ok(!fs.existsSync(out));
    assert.strictEqual(await migrate.main(['--apply'], () => {}), 2, '--apply needs --out');
    code = await migrate.main(['--apply', '--out', out], () => {});
    assert.strictEqual(code, 0);
    const file = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual(file.pairs, [
        { blocker_subject: carol.subject_id, blocked_subject: bob.subject_id },
        { blocker_subject: dave.subject_id, blocked_subject: carol.subject_id },
    ]);
    assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
    assert.strictEqual(await migrate.main(['--apply', '--out', out], () => {}), 2, 'never overwrites a file');
    // Chat's own blocks keep working as before.
    const r = await h.http('POST', '/api/dm/conversations', { token: bob.token, body: { user_ids: [carol.id] } });
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'Cannot start a conversation with this user' }]);
});

t.run(async () => { if (h && h.close) await h.close(); });
