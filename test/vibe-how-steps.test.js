'use strict';
/**
 * "How Vibe did this" under a chat answer (server/rooms/how.js step/ofMessage, ai-members.js, migrations/0032): the
 * tools Vibe called to answer in a person's own chat are kept with its message in plain words (searched what, read
 * which page, a note saved) with the pages as sources; the chat page folds them under the answer, the socket's message
 * carries them, and /how lists them; an answer with no tool call, and an AI member in a group room, keep none.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe how steps');
let h, ann, aiClient;
let script = [];
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const callTools = (...tc) => ({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: tc }, finish_reason: 'tool_calls' }] });
const vibeApi = (method, path, body) => h.http(method, `/api/chat/vibe${path}`, { token: ann.token, body });
async function lastAi(slug) {
    for (let i = 0; i < 80; i++) {
        const msgs = (await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token })).body.messages || [];
        const ai = msgs.filter((m) => m.ai_member_id);
        if (ai.length) return ai[ai.length - 1];
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no answer');
}

t('boot', async () => {
    // Search and Tools answer here, not on the real network: the steps are what this file checks, and a slow outside
    // answer would only make the wait for Vibe's message run out.
    const stub = require('http').createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url.startsWith('/api/v1/') ? { results: [] } : { title: 'Keyboards', text: 'Keychron K2 $59', links: [] }));
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    stub.unref();
    const local = `http://127.0.0.1:${stub.address().port}`;
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat', CHAT_SEARCH_URL: local, CHAT_TOOLS_URL: local } });
    aiClient = require('../server/ai/client');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    aiClient._setClient({ runs: { create: async (workflow) => ({ run: { status: 'succeeded', output: workflow === 'chat.member.turn' ? (script.shift() || (() => say('Sure.')))() : { text: 'plain' } } }) } });
});

t('the tools Vibe used are kept with its answer, in plain words, with the pages it read', async () => {
    script = [() => callTools(toolCall('c1', 'search_openvibe', { query: 'mechanical keyboard deals' }), toolCall('c2', 'read_page', { url: 'https://www.example.com/kb' })), () => say('The **Keychron K2** is $59 today.')];
    const r = await vibeApi('POST', '', { message: 'Find me a mechanical keyboard deal' });
    assert.strictEqual(r.status, 201, r.text);
    const m = await lastAi(r.body.room.slug);
    assert.deepStrictEqual(JSON.parse(m.how), { steps: ['Searched OpenVibe for “mechanical keyboard deals”', 'Read example.com'], sources: ['https://www.example.com/kb'] });
    const page = await fetch(`${h.base}/vibe/${r.body.room.slug}`, { headers: { cookie: `ov_token=${ann.token}` } }).then((x) => x.text());
    assert.ok(page.includes('<details class="vb-how"><summary>How Vibe did this</summary><ul><li>Searched OpenVibe for “mechanical keyboard deals”</li><li>Read example.com</li><li>Sources: <a href="https://www.example.com/kb" rel="nofollow ugc noopener" target="_blank">example.com</a></li></ul></details>'), 'folded under the answer');
    const how = await vibeApi('GET', `/${r.body.room.slug}/how`);
    assert.deepStrictEqual(how.body.how[String(m.id)].lines, ['Searched OpenVibe for “mechanical keyboard deals”', 'Read example.com']);
});

t('no tool call, no steps; a note kept by the safety net is a step', async () => {
    script = [() => say('Hello!')];
    const r = await vibeApi('POST', '', { message: 'hi there' });
    assert.strictEqual((await lastAi(r.body.room.slug)).how, null);
    script = [() => say('Noted.')];
    const r2 = await vibeApi('POST', '', { message: 'Please remember that I live in Porto.' });
    assert.deepStrictEqual(JSON.parse((await lastAi(r2.body.room.slug)).how).steps, ['Saved a note to your memory']);
});

t('an AI member in a group room keeps no steps', async () => {
    assert.strictEqual((await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Steps Crew', visibility: 'private' } })).status, 201);
    assert.strictEqual((await h.http('POST', '/api/chat/rooms/steps-crew/ai-members', { token: ann.token, body: { name: 'Helper' } })).status, 201);
    script = [() => callTools(toolCall('c3', 'current_time', {})), () => say('It is noon.')];
    await h.http('POST', '/api/chat/rooms/steps-crew/messages', { token: ann.token, body: { message: '@helper what time is it?' } });
    assert.strictEqual((await lastAi('steps-crew')).how, null);
});

t('steps read plainly, at most twelve, the same one twice in a row once', async () => {
    const how = require('../server/rooms/how');
    const acc = { steps: [], sources: [] };
    how.step(acc, 'web_search', '{"query":"who won the match"}');
    how.step(acc, 'web_search', '{"query":"who won the match"}');
    how.step(acc, 'set_up_agent', { name: 'Remote jobs' });
    how.step(acc, 'no_such_tool', '{}');
    how.step(acc, 'read_page', 'not json');
    assert.deepStrictEqual(acc.steps, ['Searched the web for “who won the match”', 'Set up an agent: “Remote jobs”', 'Read a page']);
    for (let i = 0; i < 30; i++) how.step(acc, 'search_openvibe', JSON.stringify({ query: `q${i}` }));
    assert.strictEqual(acc.steps.length, 12);
    assert.strictEqual(how.ofMessage('{"steps":[]}'), null);
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
