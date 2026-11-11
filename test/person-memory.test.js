'use strict';
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('person-memory');
let h, db, memory, person, channel, outsider;
const yesterday = () => new Date(Date.now() - 86400000).toISOString().replace('T', ' ').replace('Z', '');

t('boot', async () => {
    h = await boot({ env: { CHAT_PERSON_MEMORY_ENABLED: '1' } });
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
            VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, message, yesterday()]);
    }
    await memory.tick();
    const day = await memory.read(person.id, { channelId: channel.id });
    assert.strictEqual(day.length, 1);
    assert.strictEqual(day[0].message_count, 2);
    assert.strictEqual(day[0].highlights.length, 0);
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id, level: 'week' }))[0].message_count, 2);
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id, level: 'month' }))[0].message_count, 2);
    assert.strictEqual((await memory.read(person.id))[0].message_count, 2);
    await db.run("UPDATE person_chat_memory SET summary = 'Alice discussed a game.' WHERE user_id = ? AND channel_user_id = ? AND level = 'day'", [person.id, channel.id]);
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'one more', yesterday()]);
    await memory.tick();
    const incremented = (await memory.read(person.id, { channelId: channel.id }))[0];
    assert.strictEqual(incremented.message_count, 3);
    assert.strictEqual(incremented.summary, 'Alice discussed a game.', 'a capped model call does not discard earlier memory');
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

t('reply partners require their own consent and disappear after opt out', async () => {
    h.consent.allowed.add(channel.subject_id);
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [channel.id, channel.id, channel.username, channel.subject_id, 'welcome', yesterday()]);
    const target = await db.get('SELECT MAX(id) AS id FROM chat_messages WHERE user_id = ?', [channel.id]);
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp, reply_to_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'thanks', yesterday(), target.id]);
    await memory.tick();
    const visible = await memory.read(person.id, { channelId: channel.id, privateView: true });
    assert.ok(visible[0].people.includes(channel.username));
    await memory.forget(channel.id, true);
    const hidden = await memory.read(person.id, { channelId: channel.id, privateView: true });
    assert.ok(!hidden[0].people.includes(channel.username));
    const stored = await db.get("SELECT people FROM person_chat_memory WHERE user_id = ? AND channel_user_id = ? AND level = 'day'", [person.id, channel.id]);
    assert.ok(!JSON.stringify(stored.people).includes(channel.username), 'opt out also erases stored references');
});

t('the Chat workflow records measured Exchange-backed run cost', async () => {
    const config = require('../server/config');
    const client = require('../server/ai/client');
    config.ai.enabled = true;
    client._setClient({ runs: { create: async (workflow, input) => {
        assert.strictEqual(workflow, 'chat.person-memory');
        assert.ok(['day', 'week', 'month'].includes(input.level));
        return { run: { status: 'succeeded', usage: { cost_usd: 0.002 }, output: {
            summary: 'A game and a win.', topics: ['game'], highlights: [], tone: 'brief', catchphrases: [],
        } } };
    } } });
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'we won', yesterday()]);
    await memory.tick();
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id }))[0].summary, 'A game and a win.');
    const beforeFailure = await memory.spentToday();
    assert.ok(beforeFailure.usd >= 0.002);
    client._setClient({ runs: { create: async () => ({ run: { status: 'failed', usage: { cost_usd: 0.003 } } }) } });
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'another game', yesterday()]);
    await memory.tick();
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id }))[0].summary, 'A game and a win.');
    assert.ok((await memory.spentToday()).usd >= beforeFailure.usd + 0.003, 'a billed failed run counts toward the cap');
    client._reset();
    config.ai.enabled = false;
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
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'new day', yesterday()]);
    await memory.tick();
    assert.strictEqual((await memory.read(person.id, { channelId: channel.id }))[0].message_count, 1);
    h.consent.allowed.delete(person.subject_id);
    require('../server/net/consent')._reset();
    await db.run(`INSERT INTO chat_messages (user_id, channel_user_id, username, subject_id, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`, [person.id, channel.id, person.username, person.subject_id, 'withdrawn', yesterday()]);
    await memory.tick();
    assert.deepStrictEqual(await memory.read(person.id, { channelId: channel.id }), []);
});

t('close', async () => { memory.stop(); await h.close(); });
