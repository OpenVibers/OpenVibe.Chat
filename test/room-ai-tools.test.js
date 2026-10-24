'use strict';
/**
 * Tools for a room's AI members (server/rooms/ai-tools.js, the turn loop in server/rooms/ai-members.js): the member's
 * answer is OpenVibe.AI's chat.member.turn with the tool list; Chat runs the calls the model makes (search OpenVibe,
 * time, dice, a pick, a linked household's pantry) and sends the results back; after three rounds it must answer in
 * text; a failing turn falls back to chat.member.reply; tools are bounded and refuse what is not theirs.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, aiTools, config;

const t = suite('room AI members: tools');
let h, ann;
const api = (method, path, u, body) => h.http(method, `/api/chat${path}`, { token: u && u.token, body });
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const calls = [];
let script = [];                 // what the fake AI answers, turn by turn: (input) => output
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const callTools = (...tc) => ({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: tc }, finish_reason: 'tool_calls' }] });

t('boot', async () => {
    h = await boot();
    aiClient = require('../server/ai/client');
    aiTools = require('../server/rooms/ai-tools');
    config = require('../server/config');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    aiClient._setClient({
        runs: {
            create: async (workflow, input, o) => {
                calls.push({ workflow, input: JSON.parse(JSON.stringify(input)), o });
                if (workflow === 'chat.member.reply') return { run: { status: 'succeeded', output: { text: 'The plain reply.' } } };
                const next = script.shift();
                if (!next) return { run: { status: 'failed', error: { code: 'provider.error' } } };
                return { run: { status: 'succeeded', output: next(input) } };
            },
        },
    });
    assert.strictEqual((await api('POST', '/rooms', ann, { name: 'Game Night', visibility: 'private' })).status, 201);
    assert.strictEqual((await api('POST', '/rooms/game-night/ai-members', ann, { name: 'Dealer' })).status, 201);
});

t('the tool list and the runners: bounded, fair, refusing what is not theirs', async () => {
    const names = aiTools.definitions({}).map((d) => d.function.name);
    assert.deepStrictEqual(names, ['search_openvibe', 'read_page', 'current_time', 'roll_dice', 'pick_one'], 'no pantry for an unlinked member');
    // read_page asks OpenVibe.Tools' read tool (Tools decides what may be reached) and passes on only the page's parts.
    assert.ok(/full http\(s\) address/.test(JSON.parse(await aiTools.run('read_page', '{"url":"ftp://example.com"}')).error));
    const asked = [];
    const page = JSON.parse(await aiTools.run('read_page', '{"url":"https://example.com/a"}', {
        fetchImpl: async (url, o) => { asked.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ state: 'succeeded', result: { data: { url: 'https://example.com/a', status: 200, title: 'Example', text: 'Hello', truncated: false, links: [{ text: 'More', url: 'https://example.com/b' }] } } }) }; },
    }));
    assert.deepStrictEqual(asked[0], { url: 'https://openvibe.tools/api/v1/tools/read/run', body: { input: { url: 'https://example.com/a', max_chars: 6000 } } });
    assert.deepStrictEqual([page.title, page.text, page.links[0].url], ['Example', 'Hello', 'https://example.com/b']);
    assert.ok(aiTools.definitions({ link_service: 'food', link_resource: 'plan1' }).some((d) => d.function.name === 'household_pantry'));
    const dice = JSON.parse(await aiTools.run('roll_dice', '{"count":50,"sides":6}'));
    assert.strictEqual(dice.rolls.length, 10, 'at most ten dice');
    assert.ok(dice.rolls.every((r) => r >= 1 && r <= 6));
    const pick = JSON.parse(await aiTools.run('pick_one', JSON.stringify({ options: ['tacos', 'pizza'] })));
    assert.ok(['tacos', 'pizza'].includes(pick.picked));
    assert.match(JSON.parse(await aiTools.run('current_time', '{"timezone":"Not/AZone"}')).timezone, /^UTC$/, 'a bad zone is UTC');
    assert.match(await aiTools.run('household_pantry', '{}', { member: {} }), /no tool called/);
    assert.match(await aiTools.run('rm_rf', '{}'), /no tool called/);
    assert.match(await aiTools.run('roll_dice', '{not json'), /not valid JSON/);
    const seen = [];
    const fake = async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ results: [{ owner: 'deals', type: 'offer', title: 'Air mattress for $67', snippet_html: 'An <mark>air</mark> mattress', canonical_url: 'https://openvibe.deals/d/x' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const found = await aiTools._runners.search_openvibe({ query: 'air mattress', limit: 99 }, { fetchImpl: fake });
    assert.ok(seen[0].startsWith(`${config.ai.searchUrl}/api/v1/search?`) && seen[0].includes('limit=8'));
    assert.deepStrictEqual([found.results[0].site, found.results[0].summary, found.results[0].url], ['deals', 'An air mattress', 'https://openvibe.deals/d/x']);
});

t('@dealer rolls through a tool: the call runs here, its result goes back, the text answer is posted', async () => {
    const before = calls.length;
    script = [
        (input) => { assert.ok(input.tools.some((x) => x.function.name === 'roll_dice')); return callTools(toolCall('c1', 'roll_dice', { count: 2, sides: 6 })); },
        (input) => {
            const toolMsg = input.messages.find((m) => m.role === 'tool');
            const r = JSON.parse(toolMsg.content);
            assert.strictEqual(toolMsg.tool_call_id, 'c1');
            return say(`You rolled ${r.rolls.join(' and ')}: ${r.total}.`);
        },
    ];
    await api('POST', '/rooms/game-night/messages', ann, { message: '@dealer roll two dice' });
    await settle();
    const turns = calls.slice(before);
    assert.deepStrictEqual(turns.map((c) => c.workflow), ['chat.member.turn', 'chat.member.turn']);
    assert.match(turns[0].input.messages[0].content, /You are Dealer/);
    assert.match(turns[0].input.messages[1].content, /Ann just wrote to you: @dealer roll two dice/);
    assert.deepStrictEqual([turns[0].o.idempotencyKey.endsWith('-t0'), turns[1].o.idempotencyKey.endsWith('-t1')], [true, true]);
    const last = (await api('GET', '/rooms/game-night/messages', ann)).body.messages.pop();
    assert.match(last.message, /^You rolled \d and \d: \d+\.$/);
    assert.strictEqual(last.display_name, 'Dealer');
});

t('after three rounds of tools the fourth turn must answer in text; a failing turn falls back to chat.member.reply', async () => {
    let before = calls.length;
    script = [0, 1, 2].map((i) => () => callTools(toolCall(`r${i}`, 'current_time', {}))).concat([(input) => { assert.strictEqual(input.tool_choice, 'none'); return say('It is late.'); }]);
    await api('POST', '/rooms/game-night/messages', ann, { message: '@dealer what time is it, really?' });
    await settle();
    assert.strictEqual(calls.length - before, 4);
    assert.strictEqual((await api('GET', '/rooms/game-night/messages', ann)).body.messages.pop().message, 'It is late.');

    before = calls.length;
    script = []; // the turn fails (a provider without tools)
    await api('POST', '/rooms/game-night/messages', ann, { message: '@dealer hello' });
    await settle();
    assert.deepStrictEqual(calls.slice(before).map((c) => c.workflow), ['chat.member.turn', 'chat.member.reply']);
    assert.strictEqual((await api('GET', '/rooms/game-night/messages', ann)).body.messages.pop().message, 'The plain reply.');
});

t('CHAT_AI_MEMBER_TOOLS=0: straight to chat.member.reply', async () => {
    config.ai.memberTools = false;
    try {
        const before = calls.length;
        await api('POST', '/rooms/game-night/messages', ann, { message: '@dealer and now?' });
        await settle();
        assert.deepStrictEqual(calls.slice(before).map((c) => c.workflow), ['chat.member.reply']);
    } finally { config.ai.memberTools = true; }
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
