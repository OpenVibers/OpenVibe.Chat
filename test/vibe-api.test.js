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
    const latest = await h.http('GET', '/api/vibe/chat', { token: ann.token });
    assert.strictEqual(latest.body.chat.slug, fresh.body.chat.slug, 'the latest chat first');
});

t('a chat is its person\'s alone, and an empty message is refused', async () => {
    const mine = (await h.http('GET', '/api/vibe/chat', { token: ann.token })).body.chat.slug;
    const peek = await h.http('GET', `/api/vibe/chat?slug=${mine}`, { token: bob.token });
    assert.deepStrictEqual(peek.body, { chat: null, messages: [] }, 'another person sees nothing of it');
    const into = await h.http('POST', '/api/vibe/ask', { token: bob.token, body: { message: 'hi', slug: mine } });
    assert.notStrictEqual(into.body.chat.slug, mine, 'naming someone else\'s chat starts their own instead');
    assert.strictEqual((await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: '   ' } })).status, 422);
});

t('done', async () => { aiClient._setClient(null); await h.close(); });
