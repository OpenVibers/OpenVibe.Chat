'use strict';
const assert = require('assert');
const { suite } = require('./helpers');
const providers = require('../public/web/party-providers');
const follow = require('../public/web/party-provider-sync').follow;
const clock = require('../server/rooms/sync-clock');
const t = suite('party providers');

t('accepts only supported official YouTube and Twitch watch links', () => {
    for (const [url, kind, id, live] of [
        ['https://youtube.com/watch?v=abcdefghijk', 'youtube', 'abcdefghijk', false],
        ['https://www.youtube.com/shorts/abcdefghijk', 'youtube', 'abcdefghijk', false],
        ['https://youtu.be/abcdefghijk', 'youtube', 'abcdefghijk', false],
        ['https://twitch.tv/videos/12345', 'twitch', '12345', false],
        ['https://www.twitch.tv/some_channel', 'twitch', 'some_channel', true],
    ]) {
        const parsed = providers.parse(url);
        assert.deepStrictEqual([parsed.kind, parsed.id, parsed.live], [kind, id, live]);
        assert.strictEqual(clock._mediaOf(url), url);
    }
    for (const url of [
        'http://youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.example/watch?v=abcdefghijk',
        'https://youtube.com/watch?v=bad', 'https://youtube.com.evil/watch?v=abcdefghijk',
        'https://twitch.tv.evil/some_channel', 'https://twitch.tv/videos/nope',
        'https://user@youtube.com/watch?v=abcdefghijk',
        'https://vimeo.com/12345', 'https://tracker.example/film.webm',
    ]) {
        assert.strictEqual(providers.parse(url), null, url);
        assert.throws(() => clock._mediaOf(url), /media/);
    }
});

t('corrects VOD drift and follows live Twitch without seeking', () => {
    const actions = [];
    const vod = { time: () => 14, supportsRate: true, seek: (s) => actions.push(['seek', s]), rate: (r) => actions.push(['rate', r]), play: () => actions.push(['play']), pause: () => actions.push(['pause']) };
    const state = { position_ms: 10000, at_ms: 100000, rate: 1, paused: false };
    follow(vod, state, 102000);
    assert.deepStrictEqual(actions, [['seek', 12], ['play']]);
    actions.length = 0;
    vod.time = () => 11.2;
    follow(vod, state, 102000);
    assert.ok(actions.some((x) => x[0] === 'rate' && x[1] !== 1), 'small drift gets a rate nudge');
    actions.length = 0;
    follow({ live: true, time: () => 999, seek: () => actions.push(['seek']), play: () => actions.push(['play']), pause: () => actions.push(['pause']) }, state, 102000);
    assert.deepStrictEqual(actions, [['play']]);
});

t.run();
