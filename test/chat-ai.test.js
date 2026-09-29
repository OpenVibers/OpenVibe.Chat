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

function msg(o = {}) {
    return db.run(
        `INSERT INTO chat_messages (stream_id, user_id, username, message, message_type, is_global, channel_user_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.stream_id === undefined ? streamId : o.stream_id, o.user_id === undefined ? null : o.user_id,
            o.username || null, o.message || 'a message', o.message_type || 'chat', o.is_global ? 1 : 0,
            o.channel_user_id === undefined ? streamer.id : o.channel_user_id, o.timestamp || sqliteNow()]
    ).lastInsertRowid;
}

t('boot', async () => {
    h = await boot({ env: { CHAT_AI_ENABLED: '1' } });
    db = require('../server/db/database');
    ctx = require('../server/live-context');
    chatAi = require('../server/ai/chat-ai');
    aiClient = require('../server/ai/client');
    streamer = h.addUser('streamer', { role: 'streamer' });
    alice = h.addUser('alice');
    bob = h.addUser('bob');
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
    msg({ user_id: alice.id, username: 'alice', message: 'hello world' });
    msg({ user_id: bob.id, username: 'bob', message: 'a big donation', message_type: 'donation' });

    await chatAi._tick();

    const global = calls.find((c) => c.workflow === chatAi.WORKFLOW_GLOBAL);
    assert.ok(global, 'the global workflow was called');
    assert.strictEqual(global.input.messages.length, 2);
    assert.strictEqual(global.input.messages[0].author, 'alice');

    const row = db.getChatAiSummary('global', 0, 'global');
    assert.ok(row, 'a global summary row was written');
    assert.strictEqual(row.overview, 'the room talked about games');
    assert.strictEqual(row.memory_json, 'memory line');
    assert.ok(JSON.parse(row.timeline_json).some((x) => x.label === 'a moment'));
    const events = db.getChatTimelineEvents({ scope: 'global', subjectId: 0, limit: 10 });
    assert.ok(events.some((e) => e.label === 'a moment'), 'the timeline event was appended');
});

t('falls back to the extractive summary when AI does not answer', async () => {
    aiClient._setClient({ runs: { create: async () => ({ run: { status: 'failed' } }) } });
    db.run("UPDATE chat_ai_summaries SET updated_at = ? WHERE scope = 'global'", [sqliteNow(-40 * 60 * 1000)]);
    msg({ user_id: alice.id, username: 'alice', message: 'the extractive line' });

    await chatAi._tick();

    const row = db.getChatAiSummary('global', 0, 'global');
    assert.ok(/messages from \d+ chatter/.test(row.overview), row.overview);
    assert.ok(row.overview.includes('the extractive line'), row.overview);
    aiClient._reset();
    aiClient._setClient(null);
});

t('the job is off unless CHAT_AI_ENABLED is set', async () => {
    const cfg = require('../server/config');
    assert.strictEqual(cfg.ai.enabled, true, 'this boot enabled it');
    const before = db.getChatAiSummary('global', 0, 'global').message_count;
    cfg.ai.enabled = false;
    msg({ user_id: bob.id, username: 'bob', message: 'while the job is off' });
    await chatAi._tick();
    assert.strictEqual(db.getChatAiSummary('global', 0, 'global').message_count, before);
    cfg.ai.enabled = true;
});

t('the six routes answer with Live\'s shapes, publicly', async () => {
    db.upsertChatAiSummary({
        scope: 'global', subject_id: 0, window: 'global', overview: 'everything happened', memory_json: 'mem',
        timeline_json: JSON.stringify([{ ts: '2026-01-01 00:00:00', label: 'moment', detail: 'detail' }]),
        message_count: 5, window_message_count: 4, window_label: 'past hour',
    });
    db.upsertChatAiSummary({
        scope: 'user', subject_id: alice.id, window: 'rolling',
        overview: JSON.stringify({ today: 'today read', alltime: 'all time read', has_24h: true }),
        timeline_json: '[]', message_count: 9,
    });
    db.upsertChatAiSummary({
        scope: 'anon', subject_id: 7, window: 'rolling',
        overview: JSON.stringify({ today: 'anon today', alltime: 'anon all', has_24h: false }), timeline_json: '[]', message_count: 2,
    });
    db.recordRelayUser('twitch', 'SomeOne');
    const ru = db.getRelayUser('twitch', 'someone');
    db.upsertChatAiSummary({
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

t.run(async () => { try { chatAi.stop(); } catch { /* */ } });
