'use strict';
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('Actor agents in Chat channels');
const AGENT = 'agt_01M4W5JBFEG3QG9ER8W1A2K0RX';
const TASK = 'tsk_01M4XENCR31NXDJQYDCCW2J9R9';
let h, owner, member, channel, actorCalls, actorResult;
let realFetch;
const serverApi = (method, path, user, body) => h.http(method, `/api/chat/servers${path}`, { token: user && user.token, body });
const roomApi = (method, path, user, body) => h.http(method, `/api/chat/rooms${path}`, { token: user && user.token, body });

t('setup and owner switch', async () => {
    h = await boot({ env: { CHAT_ACTOR_MEMBERS: '1', CHAT_WEB_URL: 'https://openvibe.chat' } });
    owner = h.addUser('owner', { subject: ids.newId('user') });
    member = h.addUser('member', { subject: ids.newId('user') });
    for (const user of [owner, member]) await h.ctx.upsertUser(h.live.users.get(user.id));
    actorCalls = [];
    actorResult = { id: TASK, state: 'queued' };
    const ownerSubject = h.live.users.get(owner.id).subject_id;
    require('../server/rooms/vibe-agents')._setTokens({ getToken: async () => 'manage' });
    require('../server/rooms/vibe-agents')._setRunTokens({ getToken: async () => 'run' });
    require('../server/rooms/workspace')._setTokens({ getToken: async () => 'read' });
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        if (!String(url).startsWith('http://127.0.0.1:4950/')) return realFetch(url, opts);
        const path = new URL(url).pathname;
        actorCalls.push({ path, method: opts.method || 'GET', subject: opts.headers && opts.headers['X-OV-Subject'], body: opts.body ? JSON.parse(opts.body) : null });
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (path === `/api/v1/me/agents/${AGENT}` && opts.method !== 'POST') return opts.headers['X-OV-Subject'] === ownerSubject
            ? json({ id: AGENT, name: 'Researcher', status: 'active' }) : json({ code: 'actor.agent.not_found' }, 404);
        if (path === '/api/v1/me/agents') return json({ agents: [{ id: AGENT, name: 'Researcher', status: 'active', schedule: 'off' }] });
        if (path === `/api/v1/me/agents/${AGENT}/run`) return json({ id: TASK, state: 'queued' }, 201);
        if (path === `/api/v1/tasks/${TASK}`) return json(actorResult);
        return json({ code: 'not_found' }, 404);
    };
    const made = await serverApi('POST', '/', owner, { name: 'Build Club' });
    assert.strictEqual(made.status, 201, made.text);
    channel = (await serverApi('GET', '/build-club', owner)).body.channels[0].room;
    assert.strictEqual((await serverApi('POST', '/build-club/join', member)).status, 200);
    const config = require('../server/config');
    const settings = require('../server/settings');
    const previous = settings.current();
    config.actor.members = false;
    settings.activate({ value: (key, _env, fallback) => key === 'actor_members_enabled' ? false : fallback });
    try {
        assert.strictEqual((await roomApi('POST', `/${channel}/ai-members`, owner, { actor_agent_id: AGENT })).status, 403);
    } finally { config.actor.members = true; settings.activate(previous); }
});

t('owner attaches their agent and members can see and ask it', async () => {
    // The server channel page is exercised through HTTP below.
    assert.ok(require('../server/web/server-pages').mountServerPages);
    const attached = await roomApi('POST', `/${channel}/ai-members`, owner, { actor_agent_id: AGENT });
    assert.strictEqual(attached.status, 201, attached.text);
    assert.deepStrictEqual([attached.body.name, attached.body.model, attached.body.link.service], ['Researcher', 'OpenVibe Actor', 'actor']);
    const page = await realFetch(`${h.base}/s/build-club/general`, { headers: { cookie: `ov_token=${member.token}` } });
    const html = await page.text();
    assert.strictEqual(page.status, 200);
    assert.match(html, /Agents <span class="oc-muted">1<\/span>/);
    assert.match(html, /@researcher/);
    const settingsPage = await realFetch(`${h.base}/r/${channel}/settings`, { headers: { cookie: `ov_token=${owner.token}` } });
    assert.strictEqual(settingsPage.status, 200);
    assert.match(await settingsPage.text(), /Add one of your Actor agents/);
    const posted = await roomApi('POST', `/${channel}/messages`, member, { message: '@researcher summarize our plan' });
    assert.strictEqual(posted.status, 201, posted.text);
    const db = require('../server/db/database');
    let task = null;
    for (let i = 0; i < 50; i++) {
        task = await db.get('SELECT * FROM room_tasks WHERE source_message = ?', [posted.body.message.id]);
        if (task && task.actor_task) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(task && task.actor_task === TASK, 'the mention started a durable Actor task');
    const run = actorCalls.find((call) => call.path.endsWith(`/${AGENT}/run`));
    assert.strictEqual(run.subject, h.live.users.get(owner.id).subject_id, 'the attached agent runs on its owner account');
    assert.match(run.body.input, /summarize our plan/);
    actorResult = { id: TASK, state: 'succeeded', result: { answer: 'The plan is to build and test one feature.' }, cost: { usd: 0.003 } };
    await require('../server/rooms/workspace').poll();
    const messages = (await roomApi('GET', `/${channel}/messages`, member)).body.messages;
    assert.strictEqual(messages[0].display_name, 'Researcher');
    assert.match(messages[0].message, /The plan is to build and test one feature/);
    await require('../server/rooms/workspace').poll();
    assert.strictEqual((await roomApi('GET', `/${channel}/messages`, member)).body.messages.length, messages.length, 'one result after repeated polling');
});

t.run(async () => { if (realFetch) globalThis.fetch = realFetch; if (h) await h.close(); });
