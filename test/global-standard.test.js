'use strict';
/**
 * server/chat/global-standard.js: what OpenVibe's global room shows of every room's lines. A slur spelled across one
 * sender's short lines hides the run (rows) or retracts it (live); a wall (symbols, or one piece repeated) from any room
 * and a mirrored line without a letter, digit or emoji are not shown; everything ordinary is.
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
assert.ok(isWall('[8]'.repeat(520)) && isWall('[8]'.repeat(167)), 'one short piece repeated, digits and all (10-24 16:27)');
assert.ok(isWall('word '.repeat(60)) && isWall('😂'.repeat(150)), 'a word or an emoji repeated a hundred times is a wall too');
const long = 'Just got back from the stream, the part where the bridge collapsed and everyone in chat lost it was the best thing '
    + 'I have seen all week. Anyone know if there will be a replay tonight, or a clip of the ending? 😂 12/10 would watch again.';
assert.ok(!isWall(long) && !isWall('ok') && !isWall('😂'.repeat(20)), 'a long ordinary message, a short line and a few emoji are not');
assert.strictEqual(lineOk('#'.repeat(500), { mirrored: false }), false, 'a wall typed in the global room itself is not shown');
assert.strictEqual(lineOk(long, { mirrored: false }), true);

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

// Every inflection of the n-word family is a core slur, in any room and in the global feed (2026-10-25: an '-erin'
// form passed both). Spelled out at run time from its parts; real words that share the first letters are not.
{
    const { containsCoreSlur } = require('../server/chat/moderation-utils');
    const stem = ['n', 'i', 'g', 'g'].join('');
    for (const tail of ['er', 'ers', 'a', 'as', 'az', 'ah', 'uh', 'ering', 'erin', 'erings', 'ered', 'erish']) {
        assert.strictEqual(containsCoreSlur(`who is ${stem}${tail} your eggs`), true, `${stem.slice(0, 1)}…${tail}`);
        assert.strictEqual(containsCoreSlur(`who is ${stem}${tail}\u2019 your eggs`), true, `${stem.slice(0, 1)}…${tail} with a curly apostrophe`);
        assert.strictEqual(lineOk(`who is ${stem}${tail} your eggs`, { mirrored: true }), false);
    }
    for (const word of ['niggle', 'niggling', 'niggles', 'niggard', 'niggardly', 'snigger', 'sniggering'])
        assert.strictEqual(containsCoreSlur(`a small ${word} about the stream`), false, word);
}

// 11-20 (the owner's phone): a finished recording was said twice in Global: the channel's line (mirrored) and Live's own
// Global line. The channel's recording line stays in its channel; any mirrored service line Global already says is once.
{
    const vod = { kind: 'vod_link', url: 'https://openvibe.live/vod/6633', vod_id: 6633 };
    const text = '📼 iZoR_One saved a broadcast: “iZoR_One’s Stream” (1h 53m) at https://openvibe.live/vod/6633';
    const channel = row(text, { message_type: 'system', user_id: null, username: 'OpenVibe.Live', stream_id: 3062, channel_user_id: 9, metadata: JSON.stringify(vod) });
    const global = row(text, { message_type: 'system', user_id: null, username: 'OpenVibe.Live', stream_id: null, channel_user_id: null, is_global: 1, metadata: vod });
    const chat = row('see you all tomorrow', { stream_id: 3062 });
    const out = filterFeed([channel, global, chat]);
    assert.deepStrictEqual(out.map((r) => r.id), [global.id, chat.id], 'the recording once, from Global; the chat line stays');
    // An 18+ channel's recording Live kept out of Global does not come in through the mirror either.
    assert.deepStrictEqual(filterFeed([channel]).length, 0);
    // Another service line Global already says, mirrored from a channel: shown once.
    const live = row('🔴 Maticus is live', { message_type: 'system', user_id: null, stream_id: 3070 });
    const liveGlobal = row('🔴  Maticus is live ', { message_type: 'system', user_id: null, stream_id: null, channel_user_id: null, is_global: 1 });
    assert.deepStrictEqual(filterFeed([live, liveGlobal]).map((r) => r.id), [liveGlobal.id]);
    // A mirrored service line with no Global twin still shows.
    assert.deepStrictEqual(filterFeed([live]).map((r) => r.id), [live.id]);
}

console.log('global-standard: all checks passed');
