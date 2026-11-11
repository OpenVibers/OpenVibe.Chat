'use strict';
const assert = require('assert');
const { boot, suite, sqliteNow } = require('./helpers');

const t = suite('person-memory');
let h, db, memory, person, channel, outsider;

t('boot', async () => {
    h = await boot({ env: { CHAT_PERSON_MEMORY_ENABLED: '1', CHAT_PERSON_MEMORY_MODEL: '' } });
    db = require('../server/db/database');
    memory = require('../server/ai/person-memory');
    person = h.addUser('memoryperson', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B1' });
    channel = h.addUser('memorychannel', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2' });
    outsider = h.addUser('memoryoutsider', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B3' });
    h.consent.allowed.add(person.subject_id);
    await h.ctx.sync();
});

t('new messages form one day, then week and month from the day', async () => {
    for (const message of ['hello there', 'we are playing a game']) {
        await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, message, sqliteNow()]);
    }
    await memory.tick();
    const day = await memory.read(person.id, { channelId: channel.id });
    assert.strictEqual(day.length, 1);
    assert.strictEqual(day[0].message_count, 2);
    assert.strictEqual(day[0].highlights.length, 0);
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id, level: 'week' }))[0].message_count, 2);
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id, level: 'month' }))[0].message_count, 2);
    assert.strictEqual((await memory.read(person.id))[0].message_count, 2);
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'one more', sqliteNow()]);
    await memory.tick();
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id }))[0].message_count, 3);
});

t('read exposes private fields only to the person or channel owner', async () => {
    const publicRead = await h.http('GET', `/api/v1/people/${person.username}/memory?channel=${channel.username}`);
    assert.strictEqual(publicRead.status, 200, publicRead.text);
    assert.strictEqual(publicRead.body.entries[0].tone, undefined);
    const ownRead = await h.http('GET', `/api/v1/people/${person.username}/memory?channel=${channel.username}`, { token: person.token });
    assert.strictEqual(ownRead.status, 200, ownRead.text);
    assert.ok(Object.hasOwn(ownRead.body.entries[0], 'tone'));
    const noChannel = await h.http('GET', `/api/v1/people/${person.username}/memory`, { token: outsider.token });
    assert.strictEqual(noChannel.status, 400);
});

t('the person can erase and opt out; the worker does not rebuild it', async () => {
    const erased = await h.http('DELETE', `/api/v1/people/${person.username}/memory`, { token: person.token });
    assert.strictEqual(erased.status, 200, erased.text);
    assert.strictEqual(erased.body.opted_out, true);
    await memory.tick();
    assert.deepStrictEqual(await memory.read(person.id, { channelId: channel.id }), []);
    const outsiderDelete = await h.http('DELETE', `/api/v1/people/${person.username}/memory`, { token: outsider.token });
    assert.strictEqual(outsiderDelete.status, 403);
    const resume = await h.http('PUT', `/api/v1/people/${person.username}/memory/preferences`, { token: person.token, body: { opted_out: false } });
    assert.strictEqual(resume.status, 200, resume.text);
    await memory.tick();
    assert.deepStrictEqual(await memory.read(person.id, { channelId: channel.id }), [], 'old messages remain forgotten');
});

t('withdrawn consent erases a newly built memory', async () => {
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'new day', sqliteNow()]);
    await memory.tick();
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id }))[0].message_count, 1);
    h.consent.allowed.delete(person.subject_id);
    require('../server/net/consent')._reset();
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'withdrawn', sqliteNow()]);
    await memory.tick();
    assert.deepStrictEqual(await memory.read(person.id, { channelId: channel.id }), []);
});

t('close', async () => { memory.stop(); await h.close(); });
