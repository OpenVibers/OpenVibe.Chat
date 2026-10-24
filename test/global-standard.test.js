'use strict';
/**
 * server/chat/global-standard.js: what OpenVibe's global room shows of every room's lines. A slur spelled across one
 * sender's short lines hides the run (rows) or retracts it (live); a mirrored wall or a line without a letter, digit
 * or emoji is not shown; everything ordinary is.
 */
const assert = require('assert');
const { lineOk, filterFeed, createRunGuard, isWall } = require('../server/chat/global-standard');

const letters = ['k', 'y', 'k', 'e'];   // a built-in pattern, spelled out at run time
const slur = letters.join('');
let id = 0;
const row = (message, extra = {}) => ({ id: ++id, message, message_type: 'chat', user_id: 7, channel_user_id: 3, is_global: 0, timestamp: `2026-10-24 13:58:${String(id % 60).padStart(2, '0')}`, ...extra });

// One line.
assert.strictEqual(lineOk(`you ${slur}`), false);
assert.strictEqual(lineOk('hello there'), true);
assert.strictEqual(lineOk('.', { mirrored: true }), false, 'a mirrored line of punctuation');
assert.strictEqual(lineOk('.', { mirrored: false }), true, 'the global room keeps its own short lines');
assert.strictEqual(lineOk('😂', { mirrored: true }), true, 'an emoji is a line');
assert.strictEqual(lineOk('gg', { mirrored: true }), true);
assert.ok(isWall('░▒▓'.repeat(60)) && isWall('#'.repeat(600)), 'block characters and symbols');
assert.ok(!isWall('word '.repeat(60)) && !isWall('😂'.repeat(150)) && !isWall('ok'), 'long words or emoji are not a wall');

// Rows: the run goes whole, an interleaved sender does not break it, another sender's letters are their own.
const run = letters.map((l) => row(l));
const others = [row('k', { user_id: 9 }), row('nice stream', { user_id: 9 })];
const feed = [run[0], others[0], run[1], others[1], run[2], run[3], row('░▒▓'.repeat(60)), row('normal line')];
const kept = filterFeed(feed).map((r) => r.message);
assert.deepStrictEqual(kept, ['k', 'nice stream', 'normal line'], 'the run and the wall are left out, the rest kept in order');
assert.deepStrictEqual(filterFeed([...feed].reverse()).map((r) => r.message), ['normal line', 'nice stream', 'k'], 'newest first works the same');
// A run more than a minute apart is two runs.
const slow = letters.map((l, i) => row(l, { user_id: 11, timestamp: `2026-10-24 14:0${i * 2}:00` }));
assert.strictEqual(filterFeed(slow).length, 4, 'letters minutes apart are not a run');
assert.deepStrictEqual(filterFeed([row('/me waves', { message_type: 'system' })]).length, 1, 'non-chat rows pass through');

// Live: the line that completes the run is refused and retracts the earlier ones.
let t = 0;
const guard = createRunGuard({ now: () => t });
const said = letters.map((l, i) => { t += 1000; return guard.check({ id: 100 + i, message: l, user_id: 5, mirrored: true }); });
assert.deepStrictEqual(said.slice(0, 3).map((x) => x.ok), [true, true, true]);
assert.deepStrictEqual(said[3], { ok: false, retract: [100, 101, 102] });
t += 1000;
assert.deepStrictEqual(guard.check({ id: 200, message: 'k', user_id: 5, mirrored: true }), { ok: true, retract: [] }, 'a fresh run after it');
t += 120000;
assert.deepStrictEqual(guard.check({ id: 201, message: 'y', user_id: 5, mirrored: true }).retract, [], 'two minutes later the run is gone');
assert.strictEqual(guard.check({ id: 202, message: 'a whole sentence', user_id: 5, mirrored: true }).ok, true);
assert.strictEqual(guard.check({ id: 203, message: '#'.repeat(300), user_id: 5, mirrored: true }).ok, false, 'a mirrored wall');

console.log('global-standard: all checks passed');
