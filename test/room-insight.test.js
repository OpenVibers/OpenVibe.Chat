'use strict';
/**
 * A room's AI insight reader (plan 2026-11-10, part 1): the one shape GET /api/v1/rooms/:id/insight
 * answers, quiet said as quiet, and the route module mounted for Global. The job's consent filtering
 * and the public route are exercised end to end in chat-ai.test.js.
 */
const assert = require('assert');
const { suite, sqliteNow } = require('./helpers');
const roomInsight = require('../server/chat/room-insight');
const routes = require('../server/chat/room-insight-routes');

const t = suite('room-insight');

t('a fresh summary is ready and keeps its topics, people and timeline', async () => {
    const now = sqliteNow();
    const from = sqliteNow(-3600e3);
    const shaped = roomInsight._shape({
        overview: 'arrivals see this', window_start: from, window_end: now, updated_at: now,
        people: 3, window_message_count: 4, topics_json: JSON.stringify([{ label: 'zelda', count: 2 }, { label: '', count: 9 }]),
    }, [{ ts: now, label: 'a moment', detail: 'what happened', kind: 'event', message_id: 9 }]);
    assert.strictEqual(shaped.state, 'ready');
    assert.strictEqual(shaped.overview.text, 'arrivals see this');
    assert.deepStrictEqual(shaped.overview.topics, [{ label: 'zelda', count: 2 }]);
    assert.strictEqual(shaped.overview.people, 3);
    assert.strictEqual(shaped.overview.messages, 4);
    assert.deepStrictEqual(shaped.timeline, [{ at: now, kind: 'event', title: 'a moment', text: 'what happened', message_id: 9 }]);
    assert.strictEqual(shaped.overview.from, from);
});

t('an old summary is quiet: no text, no topics, the timeline stays', async () => {
    const old = sqliteNow(-48 * 3600e3);
    const shaped = roomInsight._shape({
        overview: 'two days ago everything happened', window_start: old, window_end: old, updated_at: old,
        people: 7, window_message_count: 30, topics_json: JSON.stringify([{ label: 'zelda', count: 4 }]),
    }, [{ ts: old, label: 'a moment', detail: 'old news' }]);
    assert.strictEqual(shaped.state, 'quiet');
    assert.strictEqual(shaped.overview.text, '');
    assert.deepStrictEqual(shaped.overview.topics, []);
    assert.strictEqual(shaped.overview.people, 0);
    assert.strictEqual(shaped.overview.messages, 0);
    assert.strictEqual(shaped.timeline.length, 1);
    assert.strictEqual(shaped.timeline[0].kind, 'moment');
});

t('a room with insight off says off, with no text and no timeline', async () => {
    const now = sqliteNow();
    const shaped = roomInsight._shape({
        overview: 'was once here', window_end: now, updated_at: now, people: 2, window_message_count: 3,
    }, [{ ts: now, label: 'a moment', detail: 'old' }], false);
    assert.strictEqual(shaped.state, 'off');
    assert.strictEqual(shaped.overview.text, '');
    assert.deepStrictEqual(shaped.overview.topics, []);
    assert.deepStrictEqual(shaped.timeline, []);
});

t('no row at all is quiet, and the route module is a router', async () => {
    const shaped = roomInsight._shape(null, []);
    assert.strictEqual(shaped.state, 'quiet');
    assert.strictEqual(shaped.overview.text, '');
    assert.strictEqual(shaped.overview.updated_at, null);
    assert.deepStrictEqual(shaped.timeline, []);
    assert.strictEqual(typeof routes, 'function');
});

t.run();
