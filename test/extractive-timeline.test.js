'use strict';
// The fallback timeline (server/ai/extractive.js): each event once with its count, and the latest messages beside
// the events, newest last (the owner, 11-13: "played !africa" three times, and nothing from today).
const assert = require('assert');
const { _timeline } = require('../server/ai/extractive');

const now = Date.parse('2026-11-13T20:00:00Z');
const at = (min) => new Date(now - min * 60000).toISOString();
const rows = [
    { id: 1, message: 'played !africa', message_type: 'sound', username: 'a', timestamp: at(300) },
    { id: 2, message: 'played !africa', message_type: 'sound', username: 'b', timestamp: at(200) },
    { id: 3, message: 'played !africa', message_type: 'sound', username: 'c', timestamp: at(100) },
    { id: 4, message: 'good morning everyone', message_type: 'chat', username: 'd', timestamp: at(30) },
    { id: 5, message: 'who is live today?', message_type: 'chat', username: 'e', timestamp: at(10) },
    { id: 6, message: 'spoken words', message_type: 'tts', username: 'f', timestamp: at(5) },
];
const t = _timeline(rows, now);
const labels = t.map((x) => x.label);
assert.deepStrictEqual(labels, ['played !africa ×3', 'good morning everyone', 'who is live today?'], 'one line per event, with today\'s messages');
assert.strictEqual(t[0].message_id, 3, 'the event line points at its latest play');
assert.strictEqual(t[0].kind, 'event');
assert.strictEqual(t[2].kind, 'message');
assert.ok(!labels.includes('spoken words'), 'TTS lines are not moments');

// Only messages: the latest few, in order.
const chat = Array.from({ length: 12 }, (_, i) => ({ id: 10 + i, message: `line ${i}`, message_type: 'chat', username: 'x', timestamp: at(60 - i) }));
const c = _timeline(chat, now);
assert.ok(c.length <= 10 && c.length >= 3, 'a few messages');
assert.strictEqual(c[c.length - 1].label, 'line 11', 'newest last');

console.log('extractive-timeline: events once with a count, today\'s messages beside them ok');
