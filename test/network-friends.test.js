'use strict';
/**
 * The person's Network friends in Chat (plan §AB.51): the mutual friends they made on OpenVibe.Network
 * are in the DM contacts (GET /api/dm/contacts) and in the side column, first, and a DM start by
 * username finds a friend Chat has never talked to. The friends are read with Chat's service token
 * through network.friends.read and kept for a minute.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('network friends');
let h, alice, bob, dave, erin;

const dmApi = (method, path, u, body) => h.http(method, `/api/dm${path}`, { token: u && u.token, body });

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    dave = h.addUser('dave', { subject: ids.newId('user') });
    for (const u of [alice, bob, dave]) await h.ctx.upsertUser(h.live.users.get(u.id));
    // erin is a Network friend Chat has never seen: Network knows the subject and the name.
    erin = { subject: ids.newId('user') };
    h.netFriends.names.set(erin.subject, { username: 'erin', display_name: 'Erin', avatar_url: 'https://openvibe.media/fixture/erin.png' });
    h.netFriends.names.set(bob.subject_id, { username: 'bob', display_name: 'Bob' });
    h.netFriends.circle.set(alice.subject_id, [bob.subject_id, erin.subject]);
});

t('the contacts list carries the Network friends, first', async () => {
    const r = await dmApi('GET', '/contacts', alice);
    assert.strictEqual(r.status, 200);
    const subjects = r.body.friends.map((f) => f.subject_id);
    assert.ok(subjects.includes(bob.subject_id), 'bob, a friend Chat knows');
    assert.ok(subjects.includes(erin.subject), 'erin, a friend Chat has never talked to');
    assert.strictEqual(subjects.indexOf(bob.subject_id) < subjects.indexOf(erin.subject), true, 'in the Network order');
    const erinRow = r.body.friends.find((f) => f.subject_id === erin.subject);
    assert.strictEqual(erinRow.username, 'erin', 'named by Network');
    assert.strictEqual(erinRow.display_name, 'Erin');
    assert.strictEqual(erinRow.id, null, 'no Chat row yet');
    assert.strictEqual(erinRow.status, 'friend');
});

t('Chat\'s own contacts stay as they are, after the Network friends', async () => {
    // Chat's own friend: a row in dm_contacts (the people you have talked to).
    await h.db.run("INSERT INTO dm_contacts (user_id, contact_id, status) VALUES (?, ?, 'friend')", [alice.id, dave.id]);
    const r = await dmApi('GET', '/contacts', alice);
    const names = r.body.friends.map((f) => f.username);
    assert.ok(names.includes('dave'), 'dave is a friend of Chat');
    assert.ok(names.indexOf('erin') < names.indexOf('dave'), 'the Network friends come first');
    assert.deepStrictEqual(r.body.requests, []);
    assert.deepStrictEqual(r.body.asked, []);
    // The same list, once more: the answer is kept, so Network is not asked again.
    const asked = h.netFriends.calls.length;
    await dmApi('GET', '/contacts', alice);
    assert.strictEqual(h.netFriends.calls.length, asked, 'the answer is kept for a minute');
});

t('a DM start by username finds the friend Chat has never talked to', async () => {
    // erin has no Chat row, so the DM cannot be opened for her yet: the name is known, the account is not.
    const no = await dmApi('POST', '/conversations', alice, { usernames: ['erin'] });
    assert.strictEqual(no.status, 400, 'no Chat account for erin yet');
    // bob is a friend and has a Chat row: the DM opens.
    const yes = await dmApi('POST', '/conversations', alice, { usernames: ['bob'] });
    assert.strictEqual(yes.status, 200, yes.text);
    assert.ok(yes.body.conversation && yes.body.conversation.id, 'a conversation');
});

t('a friend who renamed their account is still found by their name', async () => {
    // The Network owns the name: Chat's own projection still says the old one.
    await h.db.run('UPDATE ctx_users SET username = ? WHERE id = ?', ['bob_old', bob.id]);
    require('../server/chat/network-friends').reset();
    const list = await dmApi('GET', '/contacts', alice);
    const row = list.body.friends.find((f) => f.subject_id === bob.subject_id);
    assert.strictEqual(row.username, 'bob', 'the Network name is the one shown');
    const dm = await dmApi('POST', '/conversations', alice, { usernames: ['bob'] });
    assert.strictEqual(dm.status, 200, dm.text);
});

t('a Network that cannot be reached leaves the person with their own contacts', async () => {
    h.netFriends.down = true;
    require('../server/chat/network-friends').reset();
    const r = await dmApi('GET', '/contacts', alice);
    assert.strictEqual(r.status, 200);
    const names = r.body.friends.map((f) => f.username);
    assert.ok(names.includes('dave'), 'Chat\'s own contacts stand alone');
    assert.ok(!names.includes('erin'), 'no Network friends without Network');
    h.netFriends.down = false;
    require('../server/chat/network-friends').reset();
});

t.run(async () => { if (h && h.close) await h.close(); });
