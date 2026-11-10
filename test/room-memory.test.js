'use strict';
/**
 * Part 3 of the room insight (plan 2026-11-10): what a room remembers between summaries. The summariser
 * writes short entries from its memory line with the messages they came from; members read them; a
 * moderator corrects or removes any; a person removes every entry learned from their own messages; the
 * same rows go with the account export and deletion.
 */
const assert = require('assert');
const { boot, suite, sqliteNow } = require('./helpers');

const t = suite('room-memory');
const arr = (v) => (Array.isArray(v) ? v : JSON.parse(v || '[]'));
let h, db, rooms, chatAi, aiClient, memory, owner, alice, bob, pub, priv;

async function msg(roomId, user, text) {
    return (await db.run(
        `INSERT INTO room_messages (room_id, user_id, subject_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [roomId, user.id, user.subject_id || null, text, sqliteNow()]
    )).lastInsertRowid;
}

t('boot', async () => {
    h = await boot({ env: { CHAT_AI_ENABLED: '1' } });
    db = require('../server/db/database');
    rooms = require('../server/rooms/rooms');
    chatAi = require('../server/ai/chat-ai');
    aiClient = require('../server/ai/client');
    memory = require('../server/rooms/memory');
    owner = h.addUser('memowner', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2C1' });
    alice = h.addUser('memalice', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2C2' });
    bob = h.addUser('membob', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2C3' });
    h.consent.allowed.add(alice.subject_id);
    h.consent.allowed.add(bob.subject_id);
    await h.ctx.sync();
    pub = await rooms.create(owner, { name: 'Memory Room', slug: 'memory-room', visibility: 'public' });
    priv = await rooms.create(owner, { name: 'Quiet Memory', slug: 'quiet-memory', visibility: 'private' });
    await rooms.join(pub, alice);
    await rooms.join(pub, bob);
    aiClient._setClient({ runs: { create: async () => ({ run: { status: 'succeeded', output: {
        recent_overview: 'the room is making plans',
        memory: 'The stream is on Fridays. Lee is vegetarian.',
        timeline: [],
    } } }) } });
});

t('the summariser keeps the memory line, with its source messages and a confidence', async () => {
    const id = await msg(pub.id, alice, 'remember the stream is on Fridays');
    await chatAi._refreshRoom({ id: pub.id, slug: pub.slug, max_id: id });
    const rows = await db.all('SELECT * FROM room_memory WHERE room_id = ? AND removed_at IS NULL ORDER BY id', [pub.id]);
    assert.strictEqual(rows.length, 2, JSON.stringify(rows.map((r) => r.text)));
    assert.ok(rows.some((r) => r.text === 'The stream is on Fridays.'));
    assert.ok(rows.every((r) => Number(r.confidence) > 0));
    assert.ok(rows.every((r) => arr(r.source_message_ids).includes(Number(id))));
    assert.ok(rows.every((r) => arr(r.source_subjects).includes(alice.subject_id)));
});

t('members read the entries with their sources; signed out is 401 and a private room is 404', async () => {
    let r = await h.http('GET', '/api/v1/rooms/memory-room/memory', { token: alice.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.entries.length >= 2);
    const e = r.body.entries.find((x) => x.text === 'The stream is on Fridays.');
    assert.ok(e, JSON.stringify(r.body.entries));
    assert.ok(e.sources.some((s) => s.text.includes('remember the stream')));

    r = await h.http('GET', '/api/v1/rooms/memory-room/memory');
    assert.strictEqual(r.status, 401);

    r = await h.http('GET', '/api/v1/rooms/quiet-memory/memory', { token: alice.token });
    assert.strictEqual(r.status, 404, 'not a member of the private room');
});

t('a moderator corrects and removes an entry; a person removes only what came from them', async () => {
    const all = await h.http('GET', '/api/v1/rooms/memory-room/memory', { token: owner.token });
    const friday = all.body.entries.find((x) => x.text === 'The stream is on Fridays.');
    const veg = all.body.entries.find((x) => x.text === 'Lee is vegetarian.');

    let r = await h.http('PATCH', `/api/v1/rooms/memory-room/memory/${friday.id}`, { token: owner.token, body: { text: 'The stream is on Friday nights.', kind: 'fact', confidence: 90 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.entry.text, 'The stream is on Friday nights.');

    // Bob may not remove an entry learned from Alice's messages.
    r = await h.http('DELETE', `/api/v1/rooms/memory-room/memory/${veg.id}`, { token: bob.token });
    assert.strictEqual(r.status, 403, r.text);

    // Alice can: it came from her line.
    r = await h.http('DELETE', `/api/v1/rooms/memory-room/memory/${veg.id}`, { token: alice.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.removed, true);

    // Her one call forgets everything else sourced from her.
    r = await h.http('DELETE', '/api/v1/rooms/memory-room/memory?mine=1', { token: alice.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.removed >= 1);
    const left = await h.http('GET', '/api/v1/rooms/memory-room/memory', { token: alice.token });
    assert.deepStrictEqual(left.body.entries, []);
});

t('a moderator adds an entry by hand, and the room prompt carries the notes', async () => {
    let r = await h.http('POST', '/api/v1/rooms/memory-room/memory', { token: owner.token, body: { text: 'The weekly stream moved to Saturday', kind: 'fact', confidence: 95 } });
    assert.strictEqual(r.status, 201, r.text);
    const added = r.body.entry;
    assert.strictEqual(added.text, 'The weekly stream moved to Saturday');
    const prompt = await memory.forPrompt(pub);
    assert.ok(prompt.includes('The weekly stream moved to Saturday'), prompt);

    r = await h.http('POST', '/api/v1/rooms/memory-room/memory', { token: alice.token, body: { text: 'not allowed' } });
    assert.strictEqual(r.status, 403);
    r = await h.http('DELETE', `/api/v1/rooms/memory-room/memory/${added.id}`, { token: owner.token });
    assert.strictEqual(r.body.removed, true);
});

t('the account export carries the memory and deletion removes it', async () => {
    const account = require('../server/chat/account-data');
    const d = db.getDb();
    await db.run(`INSERT INTO room_memory (room_id, kind, text, source_message_ids, source_subjects, confidence, learned_by)
        VALUES (?, 'fact', 'Lee is vegetarian.', '[]'::jsonb, ?::jsonb, 60, 'ai')`, [pub.id, JSON.stringify([alice.subject_id])]);
    const part = await account.exportPart(d, alice.subject_id);
    const file = part.files.find((f) => f.name === 'room_memory.json');
    assert.ok(file, part.files.map((f) => f.name).join(','));
    assert.ok(file.content.some((r) => r.text === 'Lee is vegetarian.'), JSON.stringify(file.content));
    await account.erase(d, [alice.subject_id]);
    const left = await db.all("SELECT * FROM room_memory WHERE room_id = ? AND source_subjects @> ?::jsonb", [pub.id, JSON.stringify([alice.subject_id])]);
    assert.deepStrictEqual(left, []);
});

t.run(async () => { try { chatAi.stop(); } catch { /* */ } });
