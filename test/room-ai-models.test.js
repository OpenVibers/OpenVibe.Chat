'use strict';
/**
 * A model of their own for AI members (migrations/0014_ai_member_models.sql, server/ai/credentials.js): a person keeps
 * their provider key in OpenVibe.AI through Chat (/api/chat/me/ai-key and the /settings form; the key is never shown
 * again), a room's manager sets a member to think with it (engine 'own'), its answers are runs that name the
 * credential, outside the room's daily cap, and the room shows which model each member uses. Removing the key, or the
 * account, sends those members back to OpenVibe's model. A server's channels get AI members from its admins.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, aiMembers, config;

const t = suite('room AI members: their own models');
const SITE = 'https://openvibe.chat';
let h, ann, bob;
const web = async (method, path, u, fields) => {
    const headers = { cookie: `ov_token=${u.token}`, ...(fields ? { 'content-type': 'application/x-www-form-urlencoded', origin: SITE } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: fields ? new URLSearchParams(fields).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
const api = (method, path, u, body) => h.http(method, `/api/chat${path}`, { token: u && u.token, body });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// OpenVibe.AI, as Chat's HTTP client sees it: the credential store and credentialed runs.
const store = new Map();          // subject → stored credential (as AI answers it)
const runs = [];                  // credentialed runs
const shared = [];                // runs with OpenVibe's model
const problem = (status, code) => Object.assign(new Error(code), { status, code });
const fakeHttp = {
    async json({ method, path, json }) {
        const cred = /^\/api\/v1\/credentials\/(.+)$/.exec(path);
        if (cred) {
            const subject = decodeURIComponent(cred[1]);
            if (method === 'GET') { if (!store.has(subject)) throw problem(404, 'credential.not_found'); return store.get(subject); }
            if (method === 'DELETE') { if (!store.delete(subject)) throw problem(404, 'credential.not_found'); return null; }
            const prev = store.get(subject);
            if (json.provider === 'node') {   // a model on the person's own computer: no key (contracts 0.220.0)
                const row = { owner: 'chat', subject, provider: 'node', machine: json.machine, base_url: null, models: json.models, budget_usd_per_day: null, spent_usd_today: 0 };
                store.set(subject, row);
                return row;
            }
            if (!json.api_key && (!prev || prev.provider !== json.provider || (prev.base_url || null) !== (json.base_url || null))) throw problem(400, 'credential.key_required');
            const row = { owner: 'chat', subject, provider: json.provider, base_url: json.base_url || null, key_hint: json.api_key ? json.api_key.slice(-4) : prev.key_hint, models: json.models, budget_usd_per_day: json.budget_usd_per_day, spent_usd_today: 0.25 };
            store.set(subject, row);
            return row;
        }
        if (method === 'POST' && path === '/api/v1/runs') {
            runs.push(json);
            return { run: { status: 'succeeded', output: { text: `From ${store.get(json.credential.subject).models.chat}: hello ${json.input.asked_by}` } } };
        }
        throw problem(404, 'not_found');
    },
};

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    aiClient = require('../server/ai/client');
    aiMembers = require('../server/rooms/ai-members');
    config = require('../server/config');
    config.ai.memberTools = false; // tools are test/room-ai-tools.test.js'; here one run is one reply
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({ runs: { create: async (workflow, input) => { shared.push({ workflow, input }); return { run: { status: 'succeeded', output: { text: 'OpenVibe here' } } }; } } });
    aiClient._setHttp(fakeHttp);
    assert.strictEqual((await api('POST', '/rooms', ann, { name: 'Model Night', visibility: 'private' })).status, 201);
    assert.strictEqual((await api('POST', '/rooms/model-night/members', ann, { username: 'bob' })).status, 200);
});

t('your AI key: stored in OpenVibe.AI, never shown back; checked first', async () => {
    assert.deepStrictEqual((await api('GET', '/me/ai-key', ann)).body, { key: null });
    assert.strictEqual((await api('PUT', '/me/ai-key', ann, { provider: 'gemini', model: 'x', api_key: 'sk-test-1234' })).status, 422, 'a provider AI knows');
    assert.strictEqual((await api('PUT', '/me/ai-key', ann, { provider: 'openai', model: 'two words', api_key: 'sk-test-1234' })).status, 422, 'a model name');
    assert.strictEqual((await api('PUT', '/me/ai-key', ann, { provider: 'anthropic', base_url: 'https://x.example', model: 'm', api_key: 'sk-test-1234' })).status, 422, 'an endpoint is for OpenAI-compatible providers');
    assert.strictEqual((await api('PUT', '/me/ai-key', ann, { provider: 'openai', base_url: 'http://insecure.example', model: 'm', api_key: 'sk-test-1234' })).status, 422, 'https only');
    const first = await api('PUT', '/me/ai-key', ann, { provider: 'openai', model: 'gpt-4o-mini' });
    assert.deepStrictEqual([first.status, first.body.code], [400, 'credentials.key'], 'the key is needed the first time');
    const put = await api('PUT', '/me/ai-key', ann, { provider: 'openai', base_url: 'https://openrouter.ai/api/v1/', model: 'gpt-4o-mini', api_key: 'sk-test-abcd', budget_usd_per_day: 2 });
    assert.strictEqual(put.status, 200, put.text);
    assert.deepStrictEqual([put.body.key.provider, put.body.key.base_url, put.body.key.model, put.body.key.key_hint, put.body.key.budget_usd_per_day], ['openai', 'https://openrouter.ai/api/v1', 'gpt-4o-mini', 'abcd', 2]);
    assert.ok(!JSON.stringify(put.body).includes('sk-test-abcd'), 'the key itself never comes back');
    assert.strictEqual(store.get(h.live.users.get(ann.id).subject_id).owner, 'chat');
    const keep = await api('PUT', '/me/ai-key', ann, { provider: 'openai', base_url: 'https://openrouter.ai/api/v1', model: 'gpt-4.1-mini' });
    assert.strictEqual(keep.status, 200, 'changing only the model keeps the key');
});

t('a member thinks with its manager\'s own key; the room sees which model', async () => {
    assert.strictEqual((await api('POST', '/rooms/model-night/ai-members', bob, { name: 'Sage', engine: 'own' })).status, 403, 'managers only');
    assert.strictEqual((await api('POST', '/rooms/model-night/ai-members', ann, { name: 'Sage', engine: 'gpt' })).status, 422);
    const own = await api('POST', '/rooms/model-night/ai-members', ann, { name: 'Sage', persona: 'Thoughtful', engine: 'own' });
    assert.strictEqual(own.status, 201, own.text);
    assert.deepStrictEqual([own.body.engine, own.body.model], ['own', 'openai (openrouter.ai) · gpt-4.1-mini, Ann\'s key']);
    const plain = await api('POST', '/rooms/model-night/ai-members', ann, { name: 'Pip' });
    assert.deepStrictEqual([plain.body.engine, plain.body.model], ['openvibe', 'OpenVibe']);
    const seen = (await api('GET', '/rooms/model-night/ai-members', bob)).body.ai_members;
    assert.deepStrictEqual(seen.map((m) => m.model), ['openai (openrouter.ai) · gpt-4.1-mini, Ann\'s key', 'OpenVibe'], 'members see each model, not the set-up');
    const page = await web('GET', '/r/model-night', bob);
    assert.ok(page.text.includes('<strong>Sage</strong> <span class="oc-muted oc-ai-model">(openai (openrouter.ai) · gpt-4.1-mini, Ann&#39;s key)</span>') || page.text.includes('(openai (openrouter.ai) · gpt-4.1-mini, Ann&#x27;s key)'), 'the room page names the model');
});

t('@sage answers through the key (a credentialed run); outside the room\'s daily cap; @pip with OpenVibe\'s', async () => {
    const keep = config.ai.memberRepliesPerDay;
    config.ai.memberRepliesPerDay = 0;
    try {
        await api('POST', '/rooms/model-night/messages', bob, { message: '@sage hi' });
        await settle();
        const run = runs[runs.length - 1];
        assert.ok(run, 'a run went out');
        assert.deepStrictEqual([run.workflow, run.credential], ['chat.member.reply', { subject: h.live.users.get(ann.id).subject_id }]);
        assert.strictEqual(run.attribution.type, 'room');
        let last = (await api('GET', '/rooms/model-night/messages', bob)).body.messages.pop();
        assert.deepStrictEqual([last.display_name, last.message], ['Sage', 'From gpt-4.1-mini: hello Bob']);
        await api('POST', '/rooms/model-night/messages', bob, { message: '@pip hi' });
        await settle();
        last = (await api('GET', '/rooms/model-night/messages', bob)).body.messages.pop();
        assert.match(last.message, /my limit/, 'OpenVibe\'s model keeps the room\'s cap');
        assert.strictEqual(shared.length, 0);
    } finally { config.ai.memberRepliesPerDay = keep; }
    await api('POST', '/rooms/model-night/messages', bob, { message: '@pip and now?' });
    await settle();
    assert.strictEqual(shared.length, 1, 'with room under the cap, Pip answers with OpenVibe\'s model');
    assert.ok(!('credential' in (runs[runs.length - 1] || {})) || runs.length === 1, 'and not through the key');
});

t('the settings pages: your key (hint, budget), the room\'s "thinks with" choice', async () => {
    const settings = await web('GET', '/settings', ann);
    const sect = settings.text.slice(settings.text.indexOf('id="oc-ai-key"'), settings.text.indexOf('id="oc-ai-key"') + 1500);
    assert.ok(sect.includes('key ending abcd') && sect.includes('$0.25 of $2.00 used today'), sect);
    assert.ok(!settings.text.includes('sk-test-abcd'));
    const bobs = await web('GET', '/settings', bob);
    assert.ok(bobs.text.includes('No key yet.'));
    const saved = await web('POST', '/settings/ai-key', bob, { provider: 'anthropic', model: 'claude-haiku-4-5', api_key: 'sk-ant-test-wxyz', budget_usd_per_day: '0' });
    assert.deepStrictEqual([saved.status, saved.location], [303, '/settings?saved=1#oc-ai-key']);
    assert.strictEqual(store.get(h.live.users.get(bob.id).subject_id).budget_usd_per_day, 0, '0 = no cap');
    const room = await web('GET', '/r/model-night/settings', ann);
    assert.ok(room.text.includes('Thinks with <select name="engine">') && room.text.includes('Your own key: openai (openrouter.ai) · gpt-4.1-mini'));
    const sage = (await api('GET', '/rooms/model-night/ai-members', ann)).body.ai_members.find((m) => m.handle === 'sage');
    const back = await web('POST', `/r/model-night/ai-members/${sage.id}`, ann, { name: 'Sage', persona: 'Thoughtful', memory: '', enabled: '1', engine: 'openvibe' });
    assert.strictEqual(back.status, 303);
    assert.strictEqual((await api('GET', '/rooms/model-night/ai-members', ann)).body.ai_members.find((m) => m.handle === 'sage').engine, 'openvibe', 'switched back from the form');
    await web('POST', `/r/model-night/ai-members/${sage.id}`, ann, { name: 'Sage', persona: 'Thoughtful', memory: '', enabled: '1', engine: 'own' });
    assert.strictEqual((await api('GET', '/rooms/model-night/ai-members', ann)).body.ai_members.find((m) => m.handle === 'sage').engine, 'own');
});

t('a new model relabels its members; removing the key sends them back to OpenVibe\'s model', async () => {
    await api('PUT', '/me/ai-key', ann, { provider: 'openai', base_url: 'https://openrouter.ai/api/v1', model: 'gpt-5-mini' });
    let sage = (await api('GET', '/rooms/model-night/ai-members', ann)).body.ai_members.find((m) => m.handle === 'sage');
    assert.strictEqual(sage.model, 'openai (openrouter.ai) · gpt-5-mini, Ann\'s key');
    const del = await api('DELETE', '/me/ai-key', ann);
    assert.deepStrictEqual([del.status, del.body.members_switched], [200, 1]);
    sage = (await api('GET', '/rooms/model-night/ai-members', ann)).body.ai_members.find((m) => m.handle === 'sage');
    assert.deepStrictEqual([sage.engine, sage.model], ['openvibe', 'OpenVibe']);
    assert.strictEqual((await api('POST', '/rooms/model-night/ai-members', ann, { name: 'Echo', engine: 'own' })).body.code, 'rooms.ai_no_key', 'no key, no own engine');
});

t('a model on your own computer: the machine and no key; the settings form comes prefilled from openvibe.bot', async () => {
    const MACHINE = 'dev_01M5YGM39VC2RRGDQPRD6D4SHD';
    const cy = h.addUser('cy', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(cy.id));
    assert.strictEqual((await api('PUT', '/me/ai-key', cy, { provider: 'node', model: 'llama3.1:8b' })).status, 422, 'it names the computer');
    assert.strictEqual((await api('PUT', '/me/ai-key', cy, { provider: 'node', machine: 'dev_nope', model: 'llama3.1:8b' })).status, 422);
    const put = await api('PUT', '/me/ai-key', cy, { provider: 'node', machine: MACHINE, model: 'llama3.1:8b' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.deepStrictEqual([put.body.key.provider, put.body.key.machine, put.body.key.model], ['node', MACHINE, 'llama3.1:8b']);
    assert.strictEqual(require('../server/ai/credentials').label(put.body.key), 'your own computer · llama3.1:8b');
    // From openvibe.bot/machines ("Use these models in OpenVibe.Chat"): the form is filled in, nothing is saved yet.
    const page = await web('GET', `/settings?own=node&machine=${MACHINE}&model=qwen2.5:7b`, cy);
    const sect = page.text.slice(page.text.indexOf('id="oc-ai-key"'));
    assert.ok(sect.includes('<option value="node" selected>A model on my own computer</option>'), 'own computer chosen');
    assert.ok(sect.includes(`name="machine" maxlength="40"`) && sect.includes(`value="${MACHINE}"`));
    assert.ok(sect.includes('value="qwen2.5:7b"'), 'the model from the link');
    assert.ok(sect.includes('Save to let your AI members think with qwen2.5:7b on your own computer.'));
    assert.ok(sect.includes('your own computer · llama3.1:8b') && sect.includes('nothing spent'), 'what is saved now');
    const bad = await web('GET', '/settings?own=node&machine=../x&model=<b>', cy);
    assert.ok(!bad.text.includes('Save to let your AI members'), 'a bad link fills nothing');
    assert.strictEqual((await api('DELETE', '/me/ai-key', cy)).status, 200);
});

t('a server\'s admins give a text channel AI members; others are sent to the server', async () => {
    assert.strictEqual((await api('POST', '/servers', ann, { name: 'Model Guild' })).status, 201);
    assert.strictEqual((await api('POST', '/servers/model-guild/join', bob)).status, 200);
    const general = (await api('GET', '/servers/model-guild', ann)).body.channels[0].room;
    const settings = await web('GET', '/s/model-guild/settings', ann);
    assert.ok(settings.text.includes(`<a href="/r/${general}/settings#oc-ai">AI members in #general</a>`), 'linked from the channel');
    const page = await web('GET', `/r/${general}/settings`, ann);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('AI members in #general') && page.text.includes('Add an AI member') && !page.text.includes('Who can read'), 'only the AI members part');
    const add = await web('POST', `/r/${general}/ai-members`, ann, { name: 'Oracle', persona: '', memory: '', engine: 'openvibe' });
    assert.deepStrictEqual([add.status, add.location], [303, `/r/${general}/settings?saved=1`]);
    assert.deepStrictEqual([(await web('GET', `/r/${general}/settings`, bob)).status, (await web('GET', `/r/${general}/settings`, bob)).location], [302, '/s/model-guild/settings']);
    const channel = await web('GET', '/s/model-guild/general', bob);
    assert.ok(channel.text.includes('<strong>Oracle</strong> <span class="oc-muted oc-ai-model">(OpenVibe)</span>'), 'the channel names its AI members and their model');
});

t('an erased account\'s members go back to OpenVibe\'s model', async () => {
    assert.strictEqual((await api('POST', '/rooms', bob, { name: 'Bob Den', visibility: 'private' })).status, 201);
    assert.strictEqual((await api('POST', '/rooms/bob-den/members', bob, { username: 'ann' })).status, 200, 'someone else is in it, so it outlives Bob');
    const m = await api('POST', '/rooms/bob-den/ai-members', bob, { name: 'Haiku', engine: 'own' });
    assert.deepStrictEqual([m.body.engine, m.body.model], ['own', 'anthropic · claude-haiku-4-5, Bob\'s key'], m.text);
    const sid = h.live.users.get(bob.id).subject_id;
    const del = { event_id: ids.newId('event'), event_type: 'network.account.deleted', version: 1, source: 'network', actor: { type: 'user', id: sid },
        timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: sid },
        payload: { deletion_id: `del_${ids.ulid()}`, subject: sid, aliases: [], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() } };
    assert.strictEqual(await require('../server/chat/account-data').apply(del, { send: async () => ({ ok: true, status: 200 }) }), 'erased');
    const row = await require('../server/db/database').get('SELECT engine, engine_subject, engine_label FROM room_ai_members WHERE handle = ?', ['haiku']);
    assert.ok(row, 'the member stays (rooms outlive their owner)');
    assert.deepStrictEqual([row.engine, row.engine_subject, row.engine_label], ['openvibe', null, null]);
});

t.run(async () => { if (aiClient) { aiClient._setClient(null); aiClient._setHttp(null); } if (h && h.close) await h.close(); });
