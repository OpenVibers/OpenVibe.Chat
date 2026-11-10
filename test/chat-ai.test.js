'use strict';
/**
 * Plan T3 step 2 — the chat-AI job and its routes, moved into Chat (decision 5):
 *   - the job's selection and write path over Chat's own messages (stub AI client)
 *   - the extractive fallback when AI does not answer
 *   - each of the six routes' shape, visibility and error codes
 *   - the job's switch (off unless CHAT_AI_ENABLED)
 */
const assert = require('assert');
const { boot, suite, sqliteNow } = require('./helpers');

const t = suite('chat-ai');
let h, db, ctx, chatAi, aiClient, streamer, alice, bob, channelId, streamId;

async function msg(o = {}) {
    const subject = o.subject_id !== undefined ? o.subject_id
        : (o.user_id ? ((h.live.users.get(o.user_id) || {}).subject_id || null) : null);
    return (await db.run(
        `INSERT INTO chat_messages (stream_id, user_id, username, message, message_type, is_global, channel_user_id, timestamp, subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.stream_id === undefined ? streamId : o.stream_id, o.user_id === undefined ? null : o.user_id,
            o.username || null, o.message || 'a message', o.message_type || 'chat', o.is_global ? 1 : 0,
            o.channel_user_id === undefined ? streamer.id : o.channel_user_id, o.timestamp || sqliteNow(), subject]
    )).lastInsertRowid;
}

t('boot', async () => {
    h = await boot({ env: { CHAT_AI_ENABLED: '1' } });
    db = require('../server/db/database');
    ctx = require('../server/live-context');
    chatAi = require('../server/ai/chat-ai');
    aiClient = require('../server/ai/client');
    streamer = h.addUser('streamer', { role: 'streamer', subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1' });
    alice = h.addUser('alice', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A2' });
    bob = h.addUser('bob', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' });
    h.consent.allowed.add(streamer.subject_id);
    h.consent.allowed.add(alice.subject_id);
    h.consent.allowed.add(bob.subject_id);
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
});

t('the job selects Chat messages and writes the summary', async () => {
    const calls = [];
    aiClient._setClient({
        runs: {
            create: async (workflow, input) => {
                calls.push({ workflow, input });
                return { run: { status: 'succeeded', output: {
                    recent_overview: 'the room talked about games',
                    memory: 'memory line',
                    timeline: [{ label: 'a moment', detail: 'detail', mins_ago: 3 }],
                } } };
            },
        },
    });
    await msg({ user_id: alice.id, username: 'alice', message: 'hello world' });
    await msg({ user_id: bob.id, username: 'bob', message: 'a big donation', message_type: 'donation' });

    await chatAi._tick();

    const global = calls.find((c) => c.workflow === chatAi.WORKFLOW_GLOBAL);
    assert.ok(global, 'the global workflow was called');
    assert.strictEqual(global.input.messages.length, 2);
    assert.strictEqual(global.input.messages[0].author, 'alice');

    const row = await db.getChatAiSummary('global', 0, 'global');
    assert.ok(row, 'a global summary row was written');
    assert.strictEqual(row.overview, 'the room talked about games');
    assert.strictEqual(row.memory_json, 'memory line');
    assert.ok(JSON.parse(row.timeline_json).some((x) => x.label === 'a moment'));
    const events = await db.getChatTimelineEvents({ scope: 'global', subjectId: 0, limit: 10 });
    assert.ok(events.some((e) => e.label === 'a moment'), 'the timeline event was appended');
});

t('falls back to the extractive summary when AI does not answer', async () => {
    aiClient._setClient({ runs: { create: async () => ({ run: { status: 'failed' } }) } });
    await db.run("UPDATE chat_ai_summaries SET updated_at = ? WHERE scope = 'global'", [sqliteNow(-40 * 60 * 1000)]);
    await msg({ user_id: alice.id, username: 'alice', message: 'the extractive line' });

    await chatAi._tick();

    const row = await db.getChatAiSummary('global', 0, 'global');
    assert.ok(/chatting; the latest line was/.test(row.overview), row.overview);
    assert.ok(row.overview.includes('the extractive line'), row.overview);
    aiClient._reset();
    aiClient._setClient(null);
});

t('a failed run remembers ai.resting for the caller to show; a success clears it', async () => {
    aiClient._setClient({ runs: { create: async () => ({ run: { status: 'failed', error: { code: 'ai.resting', detail: 'AI is resting for a moment' } } }) } });
    assert.strictEqual(await aiClient.structured('chat.insight', {}), null);
    assert.strictEqual(aiClient.lastProblem(), 'ai.resting');
    aiClient._setClient({ runs: { create: async () => ({ run: { status: 'succeeded', output: { ok: 1 } } }) } });
    assert.deepStrictEqual(await aiClient.structured('chat.insight', {}), { ok: 1 });
    assert.strictEqual(aiClient.lastProblem(), null);
});

t('the job is off unless CHAT_AI_ENABLED is set', async () => {
    const cfg = require('../server/config');
    assert.strictEqual(cfg.ai.enabled, true, 'this boot enabled it');
    const before = (await db.getChatAiSummary('global', 0, 'global')).message_count;
    cfg.ai.enabled = false;
    await msg({ user_id: bob.id, username: 'bob', message: 'while the job is off' });
    await chatAi._tick();
    assert.strictEqual((await db.getChatAiSummary('global', 0, 'global')).message_count, before);
    cfg.ai.enabled = true;
});

t('the six routes answer with Live\'s shapes, publicly', async () => {
    await db.upsertChatAiSummary({
        scope: 'global', subject_id: 0, window: 'global', overview: 'everything happened', memory_json: 'mem',
        timeline_json: JSON.stringify([{ ts: '2026-01-01 00:00:00', label: 'moment', detail: 'detail' }]),
        message_count: 5, window_message_count: 4, window_label: 'past hour',
    });
    await db.upsertChatAiSummary({
        scope: 'user', subject_id: alice.id, window: 'rolling',
        overview: JSON.stringify({ today: 'today read', alltime: 'all time read', has_24h: true }),
        timeline_json: '[]', message_count: 9,
    });
    await db.upsertChatAiSummary({
        scope: 'anon', subject_id: 7, window: 'rolling',
        overview: JSON.stringify({ today: 'anon today', alltime: 'anon all', has_24h: false }), timeline_json: '[]', message_count: 2,
    });
    await db.recordRelayUser('twitch', 'SomeOne');
    const ru = await db.getRelayUser('twitch', 'someone');
    await db.upsertChatAiSummary({
        scope: 'relay', subject_id: ru.id, window: 'rolling',
        overview: JSON.stringify({ today: 'relay today', alltime: 'relay all', has_24h: true }), timeline_json: '[]', message_count: 3,
    });

    let r = await h.http('GET', '/api/chat/ai/global');     // no token: public, as Live
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.insight.overview, 'everything happened');
    assert.strictEqual(r.body.insight.window_label, 'past hour');
    assert.deepStrictEqual(r.body.insight.timeline.map((x) => x.label), ['moment']);

    r = await h.http('GET', '/api/chat/ai/timeline?limit=10');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(Array.isArray(r.body.events));
    assert.strictEqual(typeof r.body.hasMore, 'boolean');

    r = await h.http('GET', `/api/chat/ai/user/${alice.id}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.user.id, alice.id);
    assert.strictEqual(r.body.user.username, 'alice');
    assert.strictEqual(r.body.streamer, null, 'the streamer half is Live\'s (For Opus)');
    assert.strictEqual(r.body.insight.overview_24h, 'today read');
    assert.strictEqual(r.body.insight.overview_alltime, 'all time read');
    assert.strictEqual(r.body.insight.has_24h, true);
    r = await h.http('GET', '/api/chat/ai/user/not-a-number');
    assert.strictEqual(r.status, 400);

    r = await h.http('GET', '/api/chat/ai/anon/anon7');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.user.anon_id, 'anon7');
    assert.strictEqual(r.body.insight.overview_24h, 'anon today');
    r = await h.http('GET', '/api/chat/ai/anon/nope');
    assert.strictEqual(r.status, 400);

    r = await h.http('GET', '/api/chat/ai/relay/twitch/someone');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.user.platform, 'twitch');
    assert.strictEqual(r.body.insight.overview_alltime, 'relay all');
    r = await h.http('GET', '/api/chat/ai/relay/twitch/ghost');
    assert.deepStrictEqual(r.body, { insight: null, user: null });

    r = await h.http('GET', `/api/chat/ai/timeline/${alice.username}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.username, 'alice');
    assert.strictEqual(r.body.chatInsight.overview_24h, 'today read');
    assert.deepStrictEqual(r.body.sessions, []);
    r = await h.http('GET', '/api/chat/ai/timeline/nobody');
    assert.strictEqual(r.status, 404);
});

t('the summariser reads only people who allowed AI use, and stores people and topics', async () => {
    const calls = [];
    aiClient._setClient({
        runs: {
            create: async (workflow, input) => {
                calls.push({ workflow, input });
                return { run: { status: 'succeeded', output: {
                    recent_overview: 'consenting talk', memory: 'memory line',
                    timeline: [{ label: 'a moment', detail: 'detail', mins_ago: 1 }],
                } } };
            },
        },
    });
    const carol = h.addUser('carol', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4' });   // no consent
    await db.run("UPDATE chat_ai_summaries SET updated_at = ? WHERE scope = 'global'", [sqliteNow(-60 * 60 * 1000)]);
    await msg({ user_id: carol.id, username: 'carol', message: 'carol secret line' });
    await msg({ user_id: alice.id, username: 'alice', message: 'zelda talk is good' });
    await msg({ user_id: bob.id, username: 'bob', message: 'zelda again' });

    await chatAi._tick();

    const global = calls.find((c) => c.workflow === chatAi.WORKFLOW_GLOBAL);
    assert.ok(global, 'the global workflow was called');
    const authors = global.input.messages.map((m) => m.author);
    assert.ok(!authors.includes('carol'), 'carol is left out');
    assert.ok(authors.includes('alice') && authors.includes('bob'), JSON.stringify(authors));
    const row = await db.getChatAiSummary('global', 0, 'global');
    assert.strictEqual(row.overview, 'consenting talk');
    assert.strictEqual(Number(row.people), 2);
    const topics = JSON.parse(row.topics_json);
    assert.ok(topics.some((x) => x.label === 'zelda' && x.count >= 2), JSON.stringify(topics));
});

t('a consent check that fails leaves everyone out (fail closed)', async () => {
    const consent = require('../server/net/consent');
    consent._reset();
    h.consent.down = true;
    const before = (await db.getChatAiSummary('global', 0, 'global')).message_count;
    await db.run("UPDATE chat_ai_summaries SET updated_at = ? WHERE scope = 'global'", [sqliteNow(-60 * 60 * 1000)]);
    await msg({ user_id: alice.id, username: 'alice', message: 'not read while Network is down' });
    await chatAi._tick();
    assert.strictEqual((await db.getChatAiSummary('global', 0, 'global')).message_count, before);
    h.consent.down = false;
    consent._reset();
});

t('GET /api/v1/rooms/global/insight answers the room shape, publicly', async () => {
    await db.upsertChatAiSummary({
        scope: 'global', subject_id: 0, window: 'global', overview: 'arrivals see this', memory_json: 'm',
        timeline_json: JSON.stringify([{ ts: sqliteNow(), label: 'a moment', detail: 'detail' }]),
        message_count: 12, window_message_count: 4, window_label: 'past hour',
        window_start: sqliteNow(-3600e3), window_end: sqliteNow(), people: 3,
        topics_json: JSON.stringify([{ label: 'zelda', count: 2 }]),
    });
    await db.addChatTimelineEvents('global', 0, [{ ts: sqliteNow(), label: 'the moment', detail: 'what happened', kind: 'moment' }]);

    let r = await h.http('GET', '/api/v1/rooms/global/insight');   // no token: public
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'ready');
    assert.strictEqual(r.body.overview.text, 'arrivals see this');
    assert.deepStrictEqual(r.body.overview.topics, [{ label: 'zelda', count: 2 }]);
    assert.strictEqual(r.body.overview.people, 3);
    assert.strictEqual(r.body.overview.messages, 4);
    assert.ok(r.body.overview.from && r.body.overview.to && r.body.overview.updated_at);
    assert.ok(Array.isArray(r.body.timeline) && r.body.timeline.length >= 1);
    const ev = r.body.timeline.find((e) => e.title === 'the moment');
    assert.ok(ev, JSON.stringify(r.body.timeline.slice(0, 3)));
    assert.deepStrictEqual(Object.keys(ev).sort(), ['at', 'kind', 'message_id', 'text', 'title']);
    assert.strictEqual(ev.text, 'what happened');

    r = await h.http('GET', '/api/v1/rooms/nope/insight');
    assert.strictEqual(r.status, 404);

    r = await h.http('GET', '/');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.text.includes('arrivals see this'), 'the Global page shows the overview');
    assert.ok(r.text.includes('AI overview of this room'), 'behind the head button');
});

t('an old summary is said as quiet, never as today\'s news', async () => {
    await db.run("UPDATE chat_ai_summaries SET window_end = ?, updated_at = ? WHERE scope = 'global'", [sqliteNow(-48 * 3600e3), sqliteNow(-48 * 3600e3)]);
    const r = await h.http('GET', '/api/v1/rooms/global/insight');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'quiet');
    assert.strictEqual(r.body.overview.text, '');
    assert.deepStrictEqual(r.body.overview.topics, []);
});

t.run(async () => { try { chatAi.stop(); } catch { /* */ } });
