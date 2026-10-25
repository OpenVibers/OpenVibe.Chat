'use strict';
/**
 * Recurring work from a Vibe chat (server/rooms/vibe-agents.js, the set_up_agent and my_agents tools in
 * server/rooms/ai-tools.js): only Vibe in its person's own chat has them; set_up_agent makes a daily or weekly OpenVibe
 * Agent on Actor as that person (Chat's own actor.agent.manage token, X-OV-Subject), checked before it is sent; Actor's
 * refusal reaches the model to say; my_agents lists the person's agents with when they run and their pages; in a chat,
 * a call the model makes lands on Actor and its answer goes back to the model.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, aiTools, agents;

const t = suite('vibe agents');
let h, ann;
const sent = [];
let actorAnswer = null;   // (call) => { status, body }
const actorFetch = async (url, o = {}) => {
    const call = { url: String(url), method: o.method || 'GET', subject: o.headers['X-OV-Subject'], auth: o.headers.Authorization, body: o.body ? JSON.parse(o.body) : null };
    sent.push(call);
    const { status, body } = actorAnswer(call);
    return { ok: status < 300, status, json: async () => body };
};
const AGENT = { id: 'agt_01JABCDEFGHJKMNPQRSTVWXYZ0', name: 'Remote jobs', status: 'active', schedule: 'daily', schedule_at: '07:30', schedule_dow: null, next_run_at: '2026-10-26T07:30:00.000Z', instructions: 'secret-ish' };
const vibeMember = { handle: 'vibe' };
const ownChat = { id: 1, assistant: 1 };
const run = async (name, args, ctx = {}) => JSON.parse(await aiTools.run(name, JSON.stringify(args), { member: vibeMember, room: ownChat, user: h.live.users.get(ann.id), fetchImpl: actorFetch, ...ctx }));

const turns = [];
let script = [];
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const callTools = (...tc) => ({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: tc }, finish_reason: 'tool_calls' }] });
const realFetch = globalThis.fetch;

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiClient = require('../server/ai/client');
    aiTools = require('../server/rooms/ai-tools');
    agents = require('../server/rooms/vibe-agents');
    agents._setTokens({ getToken: async () => 'chat-agents-token' });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    aiClient._setClient({
        runs: {
            create: async (workflow, input) => {
                const output = workflow === 'chat.member.turn' ? (script.shift() || (() => say('Sure.')))(input) : { text: 'plain' };
                turns.push({ workflow, input: JSON.parse(JSON.stringify(input)) });
                return { run: { status: 'succeeded', output } };
            },
        },
    });
});

t('only Vibe in its person\'s own chat has the tools', async () => {
    const names = (m, r) => aiTools.definitions(m, r).map((d) => d.function.name);
    assert.ok(names(vibeMember, ownChat).includes('set_up_agent') && names(vibeMember, ownChat).includes('my_agents'));
    assert.ok(!names(vibeMember, { id: 2, assistant: 0 }).includes('set_up_agent'), 'Vibe added to a room: never');
    assert.ok(!names({ handle: 'dealer' }, ownChat).includes('set_up_agent'), 'another AI member: never');
    assert.match((await run('set_up_agent', { name: 'x' }, { room: { id: 2, assistant: 0 } })).error, /no tool called set_up_agent/);
});

t('set_up_agent: a daily agent on Actor as the person, with its page; checked first; Actor\'s refusal comes back', async () => {
    actorAnswer = () => ({ status: 201, body: AGENT });
    const out = await run('set_up_agent', { name: '  Remote   jobs ', instructions: 'Find remote video editing jobs posted in the last day.', schedule: 'daily', time_utc: '07:30' });
    assert.deepStrictEqual(out.agent, { id: AGENT.id, name: 'Remote jobs', status: 'active', when: 'every day at 07:30 UTC', next_run_at: AGENT.next_run_at, page: `https://openvibe.actor/me/agents/${AGENT.id}` });
    assert.ok(!JSON.stringify(out).includes('secret-ish'), 'the instructions are not repeated back');
    const c = sent.pop();
    assert.deepStrictEqual([c.url, c.method, c.subject, c.auth], ['http://127.0.0.1:4950/api/v1/me/agents', 'POST', h.live.users.get(ann.id).subject_id, 'Bearer chat-agents-token'], 'as the person, with Chat\'s own token');
    assert.deepStrictEqual(c.body, { name: 'Remote jobs', instructions: 'Find remote video editing jobs posted in the last day.', schedule: 'daily', schedule_at: '07:30' });

    actorAnswer = () => ({ status: 201, body: { ...AGENT, schedule: 'weekly', schedule_dow: 1 } });
    assert.strictEqual((await run('set_up_agent', { name: 'Weekly', instructions: 'x', schedule: 'weekly', time_utc: '09:00', weekday: 1 })).agent.when, 'every Monday at 07:30 UTC');
    assert.strictEqual(sent.pop().body.schedule_dow, 1);

    const before = sent.length;
    assert.match((await run('set_up_agent', { name: 'W', instructions: 'x', schedule: 'weekly', time_utc: '09:00' })).error, /weekday/);
    assert.match((await run('set_up_agent', { name: 'H', instructions: 'x', schedule: 'hourly', time_utc: '09:00' })).error, /daily or weekly/);
    assert.match((await run('set_up_agent', { name: 'T', instructions: 'x', schedule: 'daily', time_utc: '7am' })).error, /HH:MM/);
    assert.match((await run('set_up_agent', { name: '', instructions: 'x', schedule: 'daily', time_utc: '07:00' })).error, /name/);
    assert.strictEqual(sent.length, before, 'nothing sent that was refused here');

    actorAnswer = () => ({ status: 429, body: { title: 'Too many', detail: 'Agent limit reached.' } });
    assert.deepStrictEqual(await run('set_up_agent', { name: 'One more', instructions: 'x', schedule: 'daily', time_utc: '07:00' }), { error: 'Agent limit reached.' });
    assert.match((await run('set_up_agent', { name: 'A', instructions: 'x', schedule: 'daily', time_utc: '07:00' }, { user: { id: 9, subject_id: null } })).error, /signed in/);
});

t('my_agents: each one\'s name, when, status and page', async () => {
    actorAnswer = () => ({ status: 200, body: { agents: [AGENT, { ...AGENT, id: 'agt_01JABCDEFGHJKMNPQRSTVWXYZ1', name: 'Paused one', status: 'paused', schedule: 'off', schedule_at: null, next_run_at: null }] } });
    const out = await run('my_agents', {});
    assert.deepStrictEqual(out.agents.map((a) => [a.name, a.when, a.status]), [['Remote jobs', 'every day at 07:30 UTC', 'active'], ['Paused one', 'only when they press Run now', 'paused']]);
    assert.strictEqual(out.manage, 'https://openvibe.actor/me/agents');
    assert.deepStrictEqual([sent[sent.length - 1].method, sent[sent.length - 1].url], ['GET', 'http://127.0.0.1:4950/api/v1/me/agents']);
});

t('in a chat: Vibe\'s call lands on Actor and the answer goes back to the model', async () => {
    actorAnswer = () => ({ status: 201, body: AGENT });
    globalThis.fetch = async (url, o) => (String(url).startsWith('http://127.0.0.1:4950') ? actorFetch(url, o) : realFetch(url, o));
    try {
        script = [() => callTools(toolCall('c1', 'set_up_agent', { name: 'Remote jobs', instructions: 'Find remote video editing jobs.', schedule: 'daily', time_utc: '07:30' })), () => say('Done: it runs every morning.')];
        const r = await h.http('POST', '/api/chat/vibe', { token: ann.token, body: { message: 'Yes, set it up for 7:30 UTC every day' } });
        assert.strictEqual(r.status, 201, r.text);
        for (let i = 0; i < 80 && turns.filter((x) => x.workflow === 'chat.member.turn').length < 2; i++) await new Promise((res) => setTimeout(res, 25));
        const second = turns.filter((x) => x.workflow === 'chat.member.turn')[1];
        assert.ok(second, 'a second turn with the tool\'s answer');
        assert.match(second.input.messages[0].content, /set_up_agent makes it one of their OpenVibe Agents/);
        assert.match(second.input.messages.find((m) => m.role === 'tool').content, /"page":"https:\/\/openvibe\.actor\/me\/agents\/agt_/);
        assert.strictEqual(sent[sent.length - 1].subject, h.live.users.get(ann.id).subject_id);
    } finally { globalThis.fetch = realFetch; }
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
