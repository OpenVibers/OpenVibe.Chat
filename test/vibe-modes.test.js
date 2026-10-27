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
        // Actor's public agent catalog: the names "How Vibe did this" shows.
        if (String(url).endsWith('/api/v1/agents')) return { ok: true, status: 200, json: async () => ({ agents: [{ id: 'openvibe-runtime', name: 'OpenVibe runtime' }] }) };
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
    actorTask = {
        id: 'tsk_r1', state: 'succeeded', cost: { usd: 0.0042, free_allowance_used: 0.0042 },
        result: { answer: 'Browser Use Cloud is cheapest at $0.02 an hour.', sources: ['https://browser-use.com/cloud-browsers'], agent: 'openvibe-runtime', model: 'deepseek-v4-flash', class: 'research', checked: { by: 'qwen', cross_family: true, reason: 'The sources back the answer.' } },
    };
    await workspace.poll();
    const after = await messagesOf(slug);
    const done = after[after.length - 1];
    assert.ok(done.ai_member_id && /^✅ Done: "Compare the three cheapest cloud browsers for agents"\n\nBrowser Use Cloud/.test(done.message), done.message);
    assert.ok(!/asked by/.test(done.message), 'a Vibe chat has one person in it');
    // "How Vibe did this", folded under the answer: what ran it, the check, time and cost, the sources, every step on Actor.
    const page = await fetch(`${h.base}/vibe/${slug}`, { headers: { cookie: `ov_token=${ann.token}` } }).then((x) => x.text());
    assert.ok(page.includes('<details class="vb-how"><summary>How Vibe did this</summary><ul><li>Researched by OpenVibe runtime (deepseek-v4-flash)</li>'
        + '<li>Checked by a second model (qwen): The sources back the answer.</li><li>Took under a minute · cost $0.0042 of your daily allowance</li>'
        + '<li>Sources: <a href="https://browser-use.com/cloud-browsers" rel="nofollow ugc noopener" target="_blank">browser-use.com</a></li>'
        + '<li><a href="https://openvibe.actor/tasks/tsk_r1">Every step on OpenVibe Agents</a></li></ul></details>'), 'the fold under the answer');
    const how = await vibeApi('GET', `/${slug}/how`, ann);
    assert.strictEqual(how.status, 200);
    assert.strictEqual(how.body.how[String(done.id)].actor_url, 'https://openvibe.actor/tasks/tsk_r1', 'the same, for an answer that arrives while the page is open');
    assert.strictEqual((await vibeApi('GET', `/${slug}/how`, bob)).status, 404, 'someone else\'s chat is not there');
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

t('an agent that hands its person a step on its desk: Vibe asks them in the chat, once per hand-off, with the link (Desks plan D4)', async () => {
    const start = await vibeApi('POST', '', ann, { message: 'hi' });
    const slug = start.body.room.slug;
    actorTask = { id: 'tsk_h1', state: 'queued' };
    const r = await vibeApi('POST', `/${slug}/ask`, ann, { message: 'Book the cheapest flight to Lisbon', mode: 'agent' });
    assert.strictEqual(r.status, 201, r.text);
    await new Promise((res) => setTimeout(res, 150));
    const desk = 'https://openvibe.bot/machines/dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9/screen?desk=desk-0123456789';
    actorTask = { id: 'tsk_h1', state: 'running', needs_you: { seq: 7, what: 'Sign in to the airline.', url: desk } };
    await workspace.poll();
    await workspace.poll();
    let asks = (await messagesOf(slug)).filter((m) => m.ai_member_id && /needs you/.test(m.message));
    assert.strictEqual(asks.length, 1, 'once per hand-off, however often the poller looks');
    assert.strictEqual(asks[0].message, `🙋 Your agent needs you for "Book the cheapest flight to Lisbon": Sign in to the airline.\n\nOpen its desk, take it over, do it, then let go; it goes on by itself: ${desk}`);
    // A later hand-off in the same task asks again; a link that is not https never goes out.
    actorTask = { id: 'tsk_h1', state: 'running', needs_you: { seq: 12, what: 'Pay with your card.', url: desk } };
    await workspace.poll();
    actorTask = { id: 'tsk_h1', state: 'running', needs_you: { seq: 15, what: 'Look here.', url: 'http://evil.example/x' } };
    await workspace.poll();
    asks = (await messagesOf(slug)).filter((m) => m.ai_member_id && /needs you/.test(m.message));
    assert.deepStrictEqual(asks.map((m) => /Pay with your card/.test(m.message)), [false, true]);
    actorTask = { id: 'tsk_h1', state: 'cancelled' };
    await workspace.poll();
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
