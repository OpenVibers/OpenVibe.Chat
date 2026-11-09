'use strict';
/**
 * Vibe from any OpenVibe site (plan L48, V2; server/rooms/vibe-api.js): the Dock asks Vibe and reads its answer with
 * the person's own token. Nothing before the first chat; a question starts one and Vibe answers it in the background;
 * the next question within six hours carries the same chat on; fresh starts a new one; a chat is its person's alone;
 * a visitor gets nothing.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe api');
let h, ann, bob, aiClient;
const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function answerAfter(token, slug, id) {
    for (let i = 0; i < 60; i++) {
        const r = await h.http('GET', `/api/vibe/chat?slug=${encodeURIComponent(slug)}&after=${id}`, { token });
        const v = (r.body.messages || []).find((m) => m.from === 'vibe');
        if (v) return v;
        await wait(100);
    }
    return null;
}

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiClient = require('../server/ai/client');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({ runs: { create: async (workflow) => ({ run: { status: 'succeeded', output: workflow === 'chat.member.turn' ? say('Hello from Vibe.') : { text: 'Hello from Vibe.' } } }) } });
});

t('nothing before the first chat; a visitor gets nothing at all', async () => {
    const r = await h.http('GET', '/api/vibe/chat', { token: ann.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { chat: null, messages: [] });
    assert.strictEqual((await h.http('GET', '/api/vibe/chat')).status, 401);
    assert.strictEqual((await h.http('POST', '/api/vibe/ask', { body: { message: 'hi' } })).status, 401);
});

t('a question starts a chat and Vibe answers it in the background; the next one carries the same chat on', async () => {
    const first = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'What can you do?', timezone: 'Europe/Paris' } });
    assert.strictEqual(first.status, 201, first.text);
    const { chat, message } = first.body;
    assert.ok(chat.slug && /^https:\/\/openvibe\.chat\/vibe\//.test(chat.url));
    assert.deepStrictEqual([message.from, message.text], ['you', 'What can you do?']);
    const answer = await answerAfter(ann.token, chat.slug, message.id);
    assert.ok(answer && /Hello from Vibe/.test(answer.text), 'Vibe answered');
    const again = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'And reminders?' } });
    assert.strictEqual(again.body.chat.slug, chat.slug, 'within six hours: the same chat');
    const fresh = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Something new', fresh: true } });
    assert.notStrictEqual(fresh.body.chat.slug, chat.slug, 'fresh: a new chat');
    // The older chat's answer to "And reminders?" lands after the fresh chat was started: the fresh one stays current.
    await answerAfter(ann.token, chat.slug, again.body.message.id);
    const latest = await h.http('GET', '/api/vibe/chat', { token: ann.token });
    assert.strictEqual(latest.body.chat.slug, fresh.body.chat.slug, 'the chat they last wrote in, not the one an answer last arrived in');
});

t('a chat is its person\'s alone, and an empty message is refused', async () => {
    const mine = (await h.http('GET', '/api/vibe/chat', { token: ann.token })).body.chat.slug;
    const peek = await h.http('GET', `/api/vibe/chat?slug=${mine}`, { token: bob.token });
    assert.deepStrictEqual(peek.body, { chat: null, messages: [] }, 'another person sees nothing of it');
    const into = await h.http('POST', '/api/vibe/ask', { token: bob.token, body: { message: 'hi', slug: mine } });
    assert.notStrictEqual(into.body.chat.slug, mine, 'naming someone else\'s chat starts their own instead');
    assert.strictEqual((await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: '   ' } })).status, 422);
});

t('the Dock lists only your conversations with a preview and the site where each began', async () => {
    const started = await h.http('POST', '/api/vibe/ask', { token: ann.token, headers: { origin: 'https://openvibe.today' }, body: { message: 'What is on today?', fresh: true } });
    assert.strictEqual(started.status, 201, started.text);
    const r = await h.http('GET', '/api/vibe/conversations', { token: ann.token });
    assert.strictEqual(r.status, 200, r.text);
    const row = r.body.conversations.find((c) => c.slug === started.body.chat.slug);
    assert.deepStrictEqual([row.last_line, row.site], ['What is on today?', 'openvibe.today']);
    assert.ok(r.body.count >= 1);
    const short = await h.http('GET', '/api/vibe/conversations?limit=1', { token: ann.token });
    assert.strictEqual(short.body.conversations.length, 1);
    assert.ok(short.body.count > 1, 'the Chats row counts the full history, beyond this page');
    assert.ok(!(await h.http('GET', '/api/vibe/conversations', { token: bob.token })).body.conversations.some((c) => c.slug === row.slug));
});

t('two and three explicit models run in parallel, keep receipts, and isolate a failure', async () => {
    require('../server/net/actor-limits').limits.reset();
    const seen = [];
    aiClient._setComplete(async ({ model, subject }) => {
        seen.push({ model, subject, at: Date.now() });
        await wait(40);
        if (model.includes('broken')) throw new Error('provider unavailable');
        return { text: `From ${model}`, provider: 'test', cost_usd: 0.001, ms: 40, run_id: `run_${model}` };
    });
    const models = ['maker/one', 'maker/two'];
    const first = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Compare this', models, fresh: true } });
    assert.strictEqual(first.status, 201, first.text);
    const slug = first.body.chat.slug;
    let group;
    for (let i = 0; i < 40; i++) {
        const chat = await h.http('GET', `/api/vibe/chat?slug=${slug}`, { token: ann.token });
        group = chat.body.messages.find((m) => m.id === first.body.message.id);
        if (group && group.answers && group.answers.every((a) => a.status !== 'writing')) break;
        await wait(50);
    }
    assert.deepStrictEqual(group.answers.map((a) => a.status), ['finished', 'finished']);
    assert.ok(group.answers.every((a) => a.provider === 'test' && a.cost_usd === 0.001 && a.ms === 40 && a.run_id));
    assert.ok(Math.abs(seen[0].at - seen[1].at) < 30, 'the calls start together');
    assert.ok(seen.every((x) => x.subject === ann.subject_id));
    const compare = require('../server/rooms/vibe-compare');
    const benchCalls = [];
    compare._setBench({ createRound: async (body) => {
        benchCalls.push({ kind: 'round', body });
        return { round: { id: 'brd_TEST' }, entries: [{ id: 'bte_LEFT' }, { id: 'bte_RIGHT' }] };
    }, vote: async (body) => { benchCalls.push({ kind: 'vote', body }); return { judgement: { id: 'bju_TEST' } }; } });
    const preferred = await h.http('POST', '/api/vibe/prefer', { token: ann.token, body: { message_id: first.body.message.id, model: 'maker/two' } });
    assert.strictEqual(preferred.status, 200, preferred.text);
    assert.deepStrictEqual(benchCalls.map((c) => c.kind), ['round', 'vote']);
    assert.strictEqual(benchCalls[0].body.source, 'chat');
    assert.strictEqual(benchCalls[1].body.subject, ann.subject_id);
    assert.strictEqual((await h.http('POST', '/api/vibe/prefer', { token: ann.token, body: { message_id: first.body.message.id, model: 'maker/two' } })).status, 409);
    compare._setBench(null);
    const picked = await h.http('POST', '/api/vibe/pick', { token: ann.token, body: { message_id: first.body.message.id, model: 'maker/two' } });
    assert.strictEqual(picked.status, 200, picked.text);
    const next = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Three now', slug, models: ['maker/one', 'maker/two', 'maker/broken'] } });
    assert.strictEqual(next.status, 201, next.text);
    let answers;
    for (let i = 0; i < 40; i++) {
        const chat = await h.http('GET', `/api/vibe/chat?slug=${slug}`, { token: ann.token });
        answers = chat.body.messages.find((m) => m.id === next.body.message.id).answers;
        if (answers.every((a) => a.status !== 'writing')) break;
        await wait(50);
    }
    assert.strictEqual(answers.filter((a) => a.status === 'finished').length, 2);
    assert.strictEqual(answers.filter((a) => a.status === 'failed').length, 1);
    assert.strictEqual((await h.http('POST', '/api/vibe/pick', { token: bob.token, body: { message_id: first.body.message.id, model: 'maker/one' } })).status, 404);
    assert.strictEqual((await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'too many', fresh: true, models: ['a/one', 'b/two', 'c/three', 'd/four'] } })).status, 422);
});

t('Exchange import is scoped to the person and repeating it makes no second chat', async () => {
    require('../server/net/actor-limits').limits.reset();
    const importer = require('../server/rooms/vibe-import');
    const dates = ['2026-10-01T10:00:00.000Z', '2026-10-01T10:01:00.000Z'];
    importer._setExport(async (subject) => ({ chats: [{ id: subject === ann.subject_id ? 'exc_ANN1' : 'exc_BOB1',
        title: subject === ann.subject_id ? 'Alice old chat' : 'Bob old chat', models: ['maker/one'], created_at: dates[0], updated_at: dates[1],
        messages: [{ role: 'user', content: 'Old question', created_at: dates[0] },
            { role: 'assistant', model: 'maker/one', content: 'Old answer', created_at: dates[1] }] }] }));
    const status = await h.http('GET', '/api/vibe/import', { token: ann.token });
    assert.deepStrictEqual(status.body, { count: 1, show: true });
    const first = await h.http('POST', '/api/vibe/import', { token: ann.token, body: {} });
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.body.imported, 1);
    const again = await h.http('POST', '/api/vibe/import', { token: ann.token, body: {} });
    assert.strictEqual(again.body.imported, 0);
    const bobImport = await h.http('POST', '/api/vibe/import', { token: bob.token, body: {} });
    assert.strictEqual(bobImport.body.imported, 1);
    const aliceRoom = await h.db.get("SELECT id, name, created_at FROM rooms WHERE owner_id = ? AND name = 'Alice old chat'", [ann.id]);
    assert.ok(aliceRoom && String(aliceRoom.created_at).startsWith('2026-10-01'));
    const messages = await h.db.all('SELECT message FROM room_messages WHERE room_id = ? ORDER BY id', [aliceRoom.id]);
    assert.deepStrictEqual(messages.map((m) => m.message), ['Old question', 'Old answer']);
    assert.strictEqual(await h.db.get("SELECT id FROM rooms WHERE owner_id = ? AND name = 'Bob old chat'", [ann.id]), undefined);
    importer._setExport(null);
});

t('done', async () => { aiClient._setComplete(null); aiClient._setClient(null); await h.close(); });

t.run();
