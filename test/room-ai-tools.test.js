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
    // Both search tools take the Search Fabric's freshness window (10-30): "today" and "recently" reach Search.
    const schemaOf = (name) => aiTools.definitions({ handle: 'vibe' }).find((d) => d.function.name === name).function.parameters;
    for (const name of ['search_openvibe', 'web_search']) {
        assert.deepStrictEqual(schemaOf(name).properties.freshness.enum, ['day', 'week', 'month', 'year'], `freshness on ${name}`);
        assert.match(schemaOf(name).properties.freshness.description, /today|news/, `the model is told when to use it on ${name}`);
    }
    // OpenVibe first (11-01): the search tool names the product owners, in the schema and in the description.
    const openvibe = aiTools.definitions({ handle: 'vibe' }).find((d) => d.function.name === 'search_openvibe');
    assert.deepStrictEqual(openvibe.function.parameters.properties.owner.enum, ['work', 'deals', 'food', 'rent', 'help', 'quest', 'live', 'tools']);
    assert.match(openvibe.function.parameters.properties.owner.description, /work.*jobs/);
    assert.match(openvibe.function.description, /OpenVibe first/);
    assert.match(openvibe.function.description, /only when this finds nothing useful/);
    // read_page asks OpenVibe.Tools' read tool (Tools decides what may be reached) and passes on only the page's parts.
    assert.ok(/full http\(s\) address/.test(JSON.parse(await aiTools.run('read_page', '{"url":"ftp://example.com"}')).error));
    const asked = [];
    const page = JSON.parse(await aiTools.run('read_page', '{"url":"https://example.com/a"}', {
        fetchImpl: async (url, o) => { asked.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ state: 'succeeded', result: { data: { url: 'https://example.com/a', status: 200, title: 'Example', text: 'Hello', truncated: false, links: [{ text: 'More', url: 'https://example.com/b' }] } } }) }; },
    }));
    assert.deepStrictEqual(asked[0], { url: 'https://openvibe.tools/api/v1/tools/read/run', body: { input: { url: 'https://example.com/a', max_chars: 6000 } } });
    assert.deepStrictEqual([page.title, page.text, page.links[0].url], ['Example', 'Hello', 'https://example.com/b']);
    // web_search is Vibe's (a Vibe chat, or Vibe added to a room); it asks the Search Fabric's web scope.
    assert.ok(aiTools.definitions({ handle: 'vibe' }).some((d) => d.function.name === 'web_search'), 'Vibe searches the web');
    assert.ok(!aiTools.definitions({ handle: 'pantry' }).some((d) => d.function.name === 'web_search'), 'another AI member does not');
    assert.ok(/no tool called web_search/.test(await aiTools.run('web_search', '{"query":"x"}', { member: { handle: 'pantry' } })));
    const subject = ids.newId('user');
    const fabricCalls = [];
    const fabricClient = { fabric: async (text, o) => { fabricCalls.push({ text, o }); return { results: [{ scope: 'web', kind: 'page', title: 'Mariners 5-3', snippet: 'A recap', url: 'https://example.com/score', site: 'example.com', provider: 'deepseek', published_at: '2026-10-27T00:00:00Z', retrieved_at: '2026-10-28T12:00:00Z' }], citations: [{ n: 1, url: 'https://example.com/score', title: 'Mariners 5-3', provider: 'deepseek', retrieved_at: '2026-10-28T12:00:00Z' }], route: { explain: [{ scope: 'web', step: 'deepseek', ok: true, count: 1, cost_usd: 0.00075 }], cost_usd: 0.00075 } }; } };
    const web = JSON.parse(await aiTools.run('web_search', '{"query":"who won the Mariners game","freshness":"day"}', { member: { handle: 'vibe' }, subject, idempotencyKey: 'chat-ai-1-2-t0-web_search', webSearchOpts: { fabricClient } }));
    assert.deepStrictEqual(fabricCalls.map((c) => [c.text, c.o.scopes, c.o.actingSubject, c.o.freshness]), [['who won the Mariners game', ['web'], subject, 'day']], 'the fabric web scope as the person who asked, in the day window');
    assert.strictEqual(web.freshness, 'day');
    assert.deepStrictEqual([web.results[0].provider, web.results[0].published_at, web.results[0].retrieved_at, web.results[0].url], ['deepseek', '2026-10-27T00:00:00Z', '2026-10-28T12:00:00Z', 'https://example.com/score']);
    assert.deepStrictEqual([web.citations[0].provider, web.citations[0].published_at, web.citations[0].url], ['deepseek', '2026-10-27T00:00:00Z', 'https://example.com/score']);
    assert.strictEqual(web.answer, null);
    assert.strictEqual(web.found_by, 'deepseek');
    // Nothing on the web: the result says so and gives the one retry hint (10-30).
    const noWeb = JSON.parse(await aiTools.run('web_search', '{"query":"a thing nobody wrote"}', { member: { handle: 'vibe' }, subject, webSearchOpts: { fabricClient: { fabric: async () => ({ results: [] }) } } }));
    assert.deepStrictEqual(noWeb.results, []);
    assert.match(noWeb.note, /Nothing found on the web/);
    assert.match(noWeb.note, /2–3 key nouns/);
    // A long web result is clipped for the model but kept whole for the answer's source chips (11-01).
    const long = Array.from({ length: 6 }, (_, i) => ({ scope: 'web', kind: 'page', title: `${'Long title '.repeat(20)} ${i}`, snippet: `${'A sentence of the story. '.repeat(20)} ${i}`, url: `https://example.com/story/${i}`, site: 'example.com', provider: 'deepseek', published_at: '2026-10-27T00:00:00Z' }));
    const big = await aiTools.runWithResult('web_search', '{"query":"a long result"}', { member: { handle: 'vibe' }, subject, webSearchOpts: { fabricClient: { fabric: async () => ({ results: long }) } } });
    assert.ok(big.text.length <= aiTools.RESULT_MAX, 'the model still gets a bounded result');
    assert.strictEqual(big.result.citations.length, 6, 'the whole result keeps every citation');
    const bigAcc = { steps: [], sources: [] };
    require('../server/rooms/how').cite(bigAcc, 'web_search', big.result);
    assert.strictEqual(bigAcc.citations.length, 6, 'the chips keep every citation even when the model result was clipped');
    // The fabric is down (404 here): the old Actor task still answers, as before the fabric.
    require('../server/rooms/web-search')._setTokens({ getToken: async () => 'chat-actor-token' });
    const sent = [];
    const actorFetch = async (url, o = {}) => {
        sent.push({ url, method: o.method || 'GET', subject: o.headers['X-OV-Subject'], auth: o.headers.Authorization, body: o.body ? JSON.parse(o.body) : null });
        if ((o.method || 'GET') === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'tsk_1', state: 'queued' }) };
        return { ok: true, status: 200, json: async () => ({ id: 'tsk_1', state: 'succeeded', result: { answer: 'The Mariners won 5-3.', sources: ['https://example.com/score'] } }) };
    };
    const down = { fabric: async () => { throw Object.assign(new Error('no fabric'), { status: 404 }); } };
    const oldWeb = JSON.parse(await aiTools.run('web_search', '{"query":"who won the Mariners game"}', { member: { handle: 'vibe' }, subject, idempotencyKey: 'chat-ai-1-2-t0-web_search', webSearchOpts: { fabricClient: down, fetchImpl: actorFetch, pollMs: 1 } }));
    assert.deepStrictEqual(oldWeb, { answer: 'The Mariners won 5-3.', sources: ['https://example.com/score'] });
    assert.deepStrictEqual([sent[0].url, sent[0].method, sent[0].subject, sent[0].auth], ['http://127.0.0.1:4950/api/v1/tasks', 'POST', subject, 'Bearer chat-actor-token'], 'a task for the person, with Chat\'s own token');
    assert.ok(sent[0].body.task.includes('who won the Mariners game') && sent[0].body.idempotency_key === 'chat-ai-1-2-t0-web_search');
    assert.deepStrictEqual([sent[1].url, sent[1].subject], ['http://127.0.0.1:4950/api/v1/tasks/tsk_1', subject], 'it reads back only that task, as the person');
    assert.ok(/signed in/.test(JSON.parse(await aiTools.run('web_search', '{"query":"x"}', { member: { handle: 'vibe' }, subject: null })).error), 'no person, no search');
    const failed = JSON.parse(await aiTools.run('web_search', '{"query":"x"}', { member: { handle: 'vibe' }, subject, webSearchOpts: { fabricClient: down, pollMs: 1, fetchImpl: async (u, o = {}) => ({ ok: true, status: 200, json: async () => ((o.method || 'GET') === 'POST' ? { id: 'tsk_2', state: 'queued' } : { id: 'tsk_2', state: 'failed', error: { code: 'actor.allowance.exhausted', detail: 'The free tier runs 20 tasks a day' } }) }) } }));
    assert.ok(/20 tasks a day/.test(failed.error), 'Actor\'s refusal reaches the model to say');
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
    const fake = async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ results: [{ scope: 'network', kind: 'document', owner: 'deals', type: 'offer', title: 'Air mattress for $67', snippet: 'An air mattress', url: 'https://openvibe.deals/d/x', published_at: '2026-10-27T00:00:00Z' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const found = await aiTools._runners.search_openvibe({ query: 'air mattress', limit: 99, freshness: 'week' }, { fetchImpl: fake });
    assert.ok(seen[0].startsWith(`${config.ai.searchUrl}/api/v1/query?`) && seen[0].includes('scopes=network') && seen[0].includes('limit=8') && seen[0].includes('freshness=week'), 'the Search Fabric\'s network scope, in the week window');
    assert.deepStrictEqual([found.results[0].site, found.results[0].summary, found.results[0].url, found.results[0].published_at], ['openvibe.deals', 'An air mattress', 'https://openvibe.deals/d/x', '2026-10-27T00:00:00Z']);
    assert.deepStrictEqual([found.citations[0].url, found.citations[0].published_at], ['https://openvibe.deals/d/x', '2026-10-27T00:00:00Z'], 'the result keeps its date as a citation');
    // A Search without the fabric answers 404 there: the old search answers instead.
    const seenOld = [];
    const old = async (url) => { seenOld.push(String(url)); if (String(url).includes('/api/v1/query')) return new Response('{}', { status: 404 }); return new Response(JSON.stringify({ results: [{ owner: 'deals', type: 'offer', title: 'Air mattress for $67', snippet_html: 'An <mark>air</mark> mattress', canonical_url: 'https://openvibe.deals/d/x', published_at: '2026-10-26T00:00:00Z' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const foundOld = await aiTools._runners.search_openvibe({ query: 'air mattress' }, { fetchImpl: old });
    assert.ok(seenOld[1].startsWith(`${config.ai.searchUrl}/api/v1/search?`));
    assert.deepStrictEqual([foundOld.results[0].summary, foundOld.results[0].url, foundOld.results[0].published_at], ['An air mattress', 'https://openvibe.deals/d/x', '2026-10-26T00:00:00Z']);
    assert.deepStrictEqual([foundOld.citations[0].url, foundOld.citations[0].published_at, foundOld.fallback], ['https://openvibe.deals/d/x', '2026-10-26T00:00:00Z', true]);
    // OpenVibe first: an owner the model names reaches the Fabric on the first query; one that is not a product is ignored.
    const ownerSeen = [];
    const emptyJson = async (url) => { ownerSeen.push(new URL(String(url))); return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    await aiTools._runners.search_openvibe({ query: 'video editor', owner: 'work', freshness: 'week' }, { fetchImpl: emptyJson });
    assert.deepStrictEqual([ownerSeen[0].searchParams.get('owner'), ownerSeen[0].searchParams.get('freshness')], ['work', 'week']);
    const one = async (url) => { ownerSeen.push(new URL(String(url))); return new Response(JSON.stringify({ results: [{ title: 'A tool', url: 'https://openvibe.tools/x' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    await aiTools._runners.search_openvibe({ query: 'image cropper', owner: 'news' }, { fetchImpl: one });
    assert.strictEqual(ownerSeen[1].searchParams.get('owner'), null, 'not a product owner: search all of OpenVibe');
    // Nothing matched: the note tells the model to say so and go to the web, never to list strangers (10-30).
    const none = await aiTools._runners.search_openvibe({ query: 'mechanical keyboard' }, { fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
    assert.deepStrictEqual(none.results, []);
    assert.match(none.note, /never list unrelated results/);
    assert.match(none.note, /web_search/);
    assert.match(none.note, /2–3 key nouns/, 'the one hint: a shorter query');
    assert.match(none.note, /video editor/, 'the job-title example the starter chip needs');
    // "remote video editing jobs" finds nothing: one automatic retry with the nouns, narrowed to Work, before the model spends a round.
    const job = { scope: 'network', kind: 'document', owner: 'work', type: 'job', title: 'Intern Video Editing & Support at Bettermile', snippet: 'Video editing, remote-friendly', url: 'https://openvibe.work/jobs/job_1', published_at: '2026-10-26T00:00:00Z' };
    const retrySeen = [];
    const retryFake = async (url) => {
        retrySeen.push(new URL(String(url)));
        const q = retrySeen[retrySeen.length - 1].searchParams.get('q');
        const results = q === 'video editing' ? [job] : [];
        return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const retried = await aiTools._runners.search_openvibe({ query: 'Find remote video editing jobs posted recently', freshness: 'week' }, { fetchImpl: retryFake });
    assert.strictEqual(retrySeen.length, 2, 'one retry, not a loop');
    assert.strictEqual(retrySeen[0].searchParams.get('q'), 'Find remote video editing jobs posted recently');
    assert.deepStrictEqual([retrySeen[1].searchParams.get('q'), retrySeen[1].searchParams.get('owner'), retrySeen[1].searchParams.get('freshness')], ['video editing', 'work', 'week']);
    assert.deepStrictEqual([retried.query, retried.original_query, retried.results.length], ['video editing', 'Find remote video editing jobs posted recently', 1]);
    assert.match(retried.note, /retry with "video editing" found 1/);
    // A bare query with no time words: a window the model guessed is dropped for the retry, so the Work job is found.
    const bareSeen = [];
    const bare = await aiTools._runners.search_openvibe({ query: 'remote video editing jobs', owner: 'work', freshness: 'day' }, { fetchImpl: async (url) => { bareSeen.push(new URL(String(url))); const q = bareSeen[bareSeen.length - 1].searchParams.get('q'); return new Response(JSON.stringify({ results: q === 'video editing' ? [job] : [] }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
    assert.deepStrictEqual([bareSeen[0].searchParams.get('freshness'), bareSeen[1].searchParams.get('freshness')], ['day', null], 'no time word: the retry looks outside the guessed window');
    assert.deepStrictEqual([bare.freshness_dropped, bare.results.length], ['day', 1]);
    assert.match(bare.note, /in the last day/);
    // ...and when both find nothing, the note still gives the hint.
    const bothEmpty = await aiTools._runners.search_openvibe({ query: 'remote video editing jobs', freshness: 'day' }, { fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
    assert.match(bothEmpty.note, /"remote video editing jobs" and a retry with "video editing" both found nothing/);
    assert.match(bothEmpty.note, /2–3 key nouns/);
});

t('the fabric gets Chat\'s service token and the person as X-OV-Subject, and its provider and dates survive', async () => {
    const http = require('http');
    const seen = [];
    const stub = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://stub');
        seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, subject: req.headers['x-ov-subject'] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [{ scope: 'web', kind: 'page', title: 'A real result', snippet: 'With a provider and dates', url: 'https://example.com/real', site: 'example.com', provider: 'wikipedia', published_at: '2026-10-27T00:00:00Z', retrieved_at: '2026-10-28T12:00:00Z' }], citations: [], route: { explain: [{ scope: 'web', step: 'wikipedia', ok: true, count: 1 }], cost_usd: 0 } }));
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const fabric = require('../server/rooms/search-fabric');
    const saved = config.ai.searchUrl;
    config.ai.searchUrl = `http://127.0.0.1:${stub.address().port}`;
    fabric._reset();
    try {
        const web = await require('../server/rooms/web-search').search({ subject: ids.newId('user'), query: 'real fabric' });
        assert.strictEqual(seen.length, 1, 'one fabric query, no Actor task');
        assert.ok(seen[0].path === '/api/v1/query' && seen[0].query.scopes === 'web' && seen[0].query.limit === '6');
        assert.match(String(seen[0].auth), /^Bearer /);
        assert.match(String(seen[0].subject), /^usr_/);
        assert.deepStrictEqual([web.results[0].provider, web.results[0].published_at, web.results[0].url], ['wikipedia', '2026-10-27T00:00:00Z', 'https://example.com/real']);
    } finally {
        config.ai.searchUrl = saved;
        fabric._reset();
        await new Promise((r) => stub.close(r));
    }
});

t('sources: redirects and aggregators resolve to the page, and the chips name it with the date', async () => {
    const fabric = require('../server/rooms/search-fabric');
    const how = require('../server/rooms/how');
    const results = [
        { title: 'A story', url: 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fstory%3Fid%3D1', published_at: '2026-10-27T00:00:00Z' },
        { title: 'AP story', url: 'https://link.apnews.com/view/abc', display_url: 'https://apnews.com/article/xyz', published_at: '2026-10-26T00:00:00Z' },
        { title: 'NYPL aggregator with a target', url: 'https://nypl.org/aggregator/sources/2?page=1', display_url: 'https://apnews.com/article/abc', published_at: '2026-10-25T00:00:00Z' },
        { title: 'Google story', url: 'https://news.google.com/rss/articles/abc', published_at: '2026-10-24T00:00:00Z' },
        { title: 'No target', url: 'https://link.apnews.com/view/def', published_at: '2026-10-23T00:00:00Z' },
    ].map((r) => fabric.resultOf(r));
    assert.deepStrictEqual([results[0].url, results[0].site], ['https://example.com/story?id=1', 'example.com'], 'a known redirector\'s ?url= target');
    assert.deepStrictEqual([results[1].url, results[1].site, results[1].display_url], ['https://apnews.com/article/xyz', 'apnews.com', 'https://link.apnews.com/view/abc'], 'display_url is the target');
    assert.deepStrictEqual([results[2].url, results[2].site, results[2].display_url], ['https://apnews.com/article/abc', 'apnews.com', 'https://nypl.org/aggregator/sources/2?page=1'], 'an aggregator with a target resolves');
    assert.deepStrictEqual([results[3].url, results[3].site], ['https://news.google.com/rss/articles/abc', 'news.google.com'], 'no target: the aggregator is named honestly');
    assert.deepStrictEqual([results[4].url, results[4].site], ['https://link.apnews.com/view/def', 'link.apnews.com']);
    const citations = fabric.citationsOf(results);
    assert.deepStrictEqual([citations[0].url, citations[0].site], ['https://example.com/story?id=1', 'example.com']);
    const acc = { steps: [], sources: [] };
    how.cite(acc, 'web_search', JSON.stringify({ citations }));
    assert.deepStrictEqual([acc.citations[0].url, acc.citations[0].site], ['https://example.com/story?id=1', 'example.com']);
    const info = how.ofMessage(JSON.stringify({ steps: ['Searched the web for “tech news”'], citations: acc.citations, sources: ['https://openvibe.live/docs/go-live-in-your-browser'] }));
    const chips = how.chips(info);
    assert.match(chips, /^<ul class="vb-sources" aria-label="Sources">/);
    assert.match(chips, /href="https:\/\/example\.com\/story\?id=1"/);
    assert.match(chips, /example\.com/);
    assert.match(chips, /Oct 27, 2026/);
    assert.match(chips, /href="https:\/\/apnews\.com\/article\/abc"/, 'the aggregator opens its target, not itself');
    assert.match(chips, /href="https:\/\/openvibe\.live\/docs\/go-live-in-your-browser"/);
    assert.match(chips, /openvibe\.live/, 'a page read is a source too, without a date');
    assert.match(chips, /link\.apnews\.com/, 'no target: the redirector itself is named');
    assert.match(how.html(info), /class="vb-how-sources"/);
    assert.match(how.html(info), /Oct 27, 2026/);
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
