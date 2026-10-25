'use strict';
/**
 * The Vibe composer's modes (server/rooms/vibe.js work/startWork, vibe-routes.js, web/vibe-pages.js; plan track K):
 * Research, Agent and Code post the message without Vibe's instant answer and make it a task of the chat on the
 * person's own OpenVibe.Actor allowance (research at once; Agent and Code on their own computer), Vibe says it is on it
 * with the task's link, and the result comes back into the chat (without "asked by": the chat is theirs alone). Chat
 * mode answers as before; an unknown mode, someone else's chat or no sign-in is refused; the composer shows the modes.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe modes');
const SITE = 'https://openvibe.chat';
let h, ann, bob, workspace;
const turns = [];
const actorCalls = [];
let actorTask = { id: 'tsk_r1', state: 'queued' };
const vibeApi = (method, path, u, body) => h.http(method, `/api/chat/vibe${path}`, { token: u && u.token, body });
const messagesOf = async (slug) => ((await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token })).body.messages || []);
const realFetch = globalThis.fetch;

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    workspace = require('../server/rooms/workspace');
    workspace._setTokens({ getToken: async () => 'chat-actor-token' });
    require('../server/ai/client')._setClient({
        runs: { create: async (workflow) => { turns.push(workflow); return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'Chat answer' } }] } } }; } },
    });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    globalThis.fetch = async (url, o = {}) => {
        if (!String(url).startsWith('http://127.0.0.1:4950')) return realFetch(url, o);
        actorCalls.push({ url: String(url), method: o.method || 'GET', subject: o.headers['X-OV-Subject'], body: o.body ? JSON.parse(o.body) : null });
        return { ok: true, status: (o.method || 'GET') === 'POST' ? 201 : 200, json: async () => actorTask };
    };
});

t('Research in a new chat: a task on Actor as the person, Vibe says it is on it, no instant answer', async () => {
    const r = await vibeApi('POST', '', ann, { message: 'Compare the three cheapest cloud browsers for agents', mode: 'research' });
    assert.strictEqual(r.status, 201, r.text);
    const slug = r.body.room.slug;
    assert.strictEqual(r.body.task.kind, 'research');
    const create = actorCalls.find((c) => c.method === 'POST');
    assert.strictEqual(create.subject, h.live.users.get(ann.id).subject_id, 'on the person\'s own allowance');
    assert.match(create.body.task, /^Research this and write a short report for a team, with the links of your sources: Compare the three cheapest/);
    await new Promise((res) => setTimeout(res, 150));
    const msgs = await messagesOf(slug);
    assert.deepStrictEqual(msgs.map((m) => (m.ai_member_id ? 'vibe' : 'ann')), ['ann', 'vibe']);
    assert.match(msgs[1].message, new RegExp(`^On it: I am researching this[\\s\\S]*${SITE}/r/${slug}/tasks/${r.body.task.id}$`));
    assert.strictEqual(turns.length, 0, 'no instant answer');
    // Actor finishes: the answer comes back into the chat, without "asked by".
    actorTask = { id: 'tsk_r1', state: 'succeeded', result: { answer: 'Browser Use Cloud is cheapest at $0.02 an hour.', sources: ['https://browser-use.com/cloud-browsers'] } };
    await workspace.poll();
    const after = await messagesOf(slug);
    const done = after[after.length - 1];
    assert.ok(done.ai_member_id && /^✅ Done: "Compare the three cheapest cloud browsers for agents"\n\nBrowser Use Cloud/.test(done.message), done.message);
    assert.ok(!/asked by/.test(done.message), 'a Vibe chat has one person in it');
});

t('Code in an existing chat: Codes on their own computer; Agent too; Chat mode answers as before', async () => {
    const start = await vibeApi('POST', '', ann, { message: 'hello' });
    const slug = start.body.room.slug;
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(turns.length, 1, 'Chat mode: Vibe answers at once');
    actorTask = { id: 'tsk_c1', state: 'queued' };
    actorCalls.length = 0;
    let r = await vibeApi('POST', `/${slug}/ask`, ann, { message: 'Add a dark favicon to OpenVibe.Tools', mode: 'code' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.task.kind, r.body.task.status, r.body.task.runner], ['code', 'running', 'actor']);
    assert.match(actorCalls.find((c) => c.method === 'POST').body.task, /^Make this code change with OpenVibe\.Codes on my own computer/);
    actorTask = { id: 'tsk_a1', state: 'queued' };
    r = await vibeApi('POST', `/${slug}/ask`, ann, { message: 'Tidy my Downloads folder', mode: 'agent' });
    assert.deepStrictEqual([r.body.task.kind, r.body.task.status], ['computer', 'running']);
    await new Promise((res) => setTimeout(res, 150));
    const vibeLines = (await messagesOf(slug)).filter((m) => m.ai_member_id).map((m) => m.message);
    assert.ok(vibeLines.some((l) => /^On it: I sent this to OpenVibe\.Codes on your own computer/.test(l)));
    assert.ok(vibeLines.some((l) => /^On it: I am doing this on your own computer, through OpenVibe\.Node/.test(l)));
    assert.strictEqual(turns.length, 1, 'no instant answers to the tasks');
});

t('refusals: an unknown mode, someone else\'s chat, no sign-in', async () => {
    const start = await vibeApi('POST', '', ann, { message: 'mine' });
    const slug = start.body.room.slug;
    assert.strictEqual((await vibeApi('POST', `/${slug}/ask`, ann, { message: 'x', mode: 'shell' })).status, 422);
    assert.strictEqual((await vibeApi('POST', '', ann, { message: 'x', mode: 'shell' })).status, 422);
    assert.strictEqual((await vibeApi('POST', `/${slug}/ask`, bob, { message: 'mine now', mode: 'research' })).status, 404);
    assert.strictEqual((await vibeApi('POST', `/${slug}/ask`, null, { message: 'x', mode: 'research' })).status, 401);
});

t('the composer shows the four modes, Chat chosen, each saying what it does', async () => {
    const page = await h.http('GET', '/vibe', { headers: { cookie: `ov_token=${ann.token}` } });
    assert.match(page.text, /<fieldset class="vb-modes" aria-label="What Vibe does with it">/);
    assert.match(page.text, /value="chat" data-placeholder="Message Vibe" checked><span>Chat<\/span>/);
    ['research', 'agent', 'code'].forEach((m) => assert.match(page.text, new RegExp(`value="${m}"`)));
});

t.run(async () => { globalThis.fetch = realFetch; if (h && h.close) await h.close(); });
