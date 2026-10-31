'use strict';
/**
 * The overlay alert feed on Chat's typed ingress (server/chat/internal-ingress.js,
 * server/chat/overlay-alerts.js): the frame a streamer's OBS overlay reads for every moment worth
 * showing — a follow, a tip, a subscription, a raid, a goal reached.
 *
 * What is checked here:
 *   - every kind's shape, delivered to the channel's own room;
 *   - the join contract of the overlay page (/obs/alerts/<username>): a socket that joins with
 *     `channel: '<username>'` and no stream id (the channel is offline) still receives the alerts;
 *   - the tipper's words stay plain text (a <script> in a tip arrives as text, not as markup) and
 *     pass the moderation a chat line passes (blocked words, the channel's own filters);
 *   - nothing private is in the payload (the frame is closed, and the room is the channel's own).
 *
 *   node --import ./test/helpers/pg-preload.mjs test/overlay-alert-ingress.test.js
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('overlay-alert-ingress');
let h, streamer, viewer, streamId, offlineStreamId, channelId, room, overlayRoom, overlayAuth;
const CAPS = { events: 'chat.event.publish' };
const post = (body) => h.http('POST', '/internal/chat/events', { body, token: h.serviceToken([CAPS.events]) });
const FRAME_KEYS = ['type', 'kind', 'id', 'at', 'who', 'amount', 'text'];
const frame = (over = {}) => ({ type: 'overlay-alert', kind: 'tip', id: 'tip:0123456789abcdef', at: new Date().toISOString(), who: { name: 'Ann', avatar: null }, amount: { value: 500, unit: 'vibes' }, text: null, ...over });

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('overlay-streamer', { role: 'streamer' });
    viewer = h.addUser('overlay-viewer');
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    offlineStreamId = h.addStream(streamer.id, channelId, { title: 'Earlier', is_live: 0 });
    await h.ctx.sync();
    // A viewer in the channel room (the chat overlay's join).
    room = await h.ws({ token: viewer.token });
    room.sendJson({ type: 'join', streamId, token: viewer.token });
    await room.next((m) => m.type === 'auth');
    // The overlay page's join: the channel by name, no stream id (the streamer is offline).
    overlayRoom = await h.ws();
    overlayRoom.sendJson({ type: 'join', streamId: null, channel: 'overlay-streamer' });
    overlayAuth = await overlayRoom.next((m) => m.type === 'auth');
});

t('the join by channel name is an anonymous viewer in that channel room', async () => {
    assert.strictEqual(overlayAuth.authenticated, false, 'naming a channel grants nothing');
    assert.strictEqual(overlayAuth.user_id, null);
});

t('every kind arrives in the channel room with the same shape', async () => {
    for (const kind of ['follow', 'tip', 'sub', 'raid', 'goal']) {
        const f = frame({ kind, id: `${kind}:0123456789abcdef`, amount: kind === 'tip' ? { value: 500, unit: 'vibes' } : (kind === 'raid' ? { value: 12, unit: 'viewers' } : null) });
        const r = await post({ key: `overlay:${kind}:1`, target: { kind: 'channel', id: streamer.id }, frame: f });
        assert.strictEqual(r.status, 200, r.text);
        const got = await room.next((m) => m.type === 'overlay-alert' && m.kind === kind);
        assert.deepStrictEqual(Object.keys(got).filter((k) => k !== '__taken').sort(), [...FRAME_KEYS].sort(), 'the frame has exactly these seven fields');
        assert.strictEqual(got.type, 'overlay-alert');
        assert.strictEqual(got.kind, kind);
        assert.strictEqual(got.id, f.id);
        assert.ok(!Number.isNaN(Date.parse(got.at)));
    }
});

t('the overlay page’s socket gets the alerts while the channel is offline', async () => {
    const f = frame({ kind: 'tip', id: 'tip:offline00000000', text: 'gg' });
    const r = await post({ key: 'overlay:offline:1', target: { kind: 'channel', id: streamer.id }, frame: f });
    assert.strictEqual(r.status, 200, r.text);
    const got = await overlayRoom.next((m) => m.type === 'overlay-alert' && m.id === f.id);
    assert.strictEqual(got.kind, 'tip');
    assert.strictEqual(got.text, 'gg');
    // The same moment twice is one message (the ingress key).
    const again = await post({ key: 'overlay:offline:1', target: { kind: 'channel', id: streamer.id }, frame: f });
    assert.strictEqual(again.status, 200);
    await h.sleep(300);
    assert.strictEqual(overlayRoom.all.filter((m) => m.type === 'overlay-alert' && m.id === f.id).length, 1, 'the alert is delivered once');
});

t('the tipper’s words are plain text', async () => {
    const text = '<script>alert(1)</script>';
    const f = frame({ kind: 'tip', id: 'tip:script000000000', text });
    const r = await post({ key: 'overlay:script:1', target: { kind: 'channel', id: streamer.id }, frame: f });
    assert.strictEqual(r.status, 200, r.text);
    const got = await room.next((m) => m.type === 'overlay-alert' && m.id === f.id);
    assert.strictEqual(got.text, text, 'a script in a tip arrives as text, not as markup');
    assert.strictEqual(typeof got.text, 'string');
});

t('the text passes the moderation a chat line passes', async () => {
    // The blocked-word filter censors, as it does for a chat line.
    const blocked = frame({ kind: 'tip', id: 'tip:blocked00000000', text: 'my exact location is here' });
    await post({ key: 'overlay:blocked:1', target: { kind: 'channel', id: streamer.id }, frame: blocked });
    const got = await room.next((m) => m.type === 'overlay-alert' && m.id === blocked.id);
    assert.ok(!got.text.includes('exact location'), 'the blocked words are censored');
    assert.ok(got.text.includes('*'), 'and shown as asterisks');

    // The channel's own filters: a hit means the words are not shown at all.
    await h.setChannelSettings(channelId, { slur_filter_enabled: 1, slur_filter_terms: 'pineapple' });
    const filtered = frame({ kind: 'tip', id: 'tip:filtered0000000', text: 'a pineapple for you' });
    await post({ key: 'overlay:filtered:1', target: { kind: 'channel', id: streamer.id }, frame: filtered });
    const gone = await room.next((m) => m.type === 'overlay-alert' && m.id === filtered.id);
    assert.strictEqual(gone.text, null, 'the channel’s filter keeps the words off the overlay');
    // The moment itself is still shown.
    assert.strictEqual(gone.kind, 'tip');
    assert.deepStrictEqual(gone.amount, { value: 500, unit: 'vibes' });
    await h.setChannelSettings(channelId, null);
});

t('the frame is closed and the room is the channel’s own', async () => {
    const bad = [
        ['an account field', frame({ id: 'tip:private000000000', user_id: viewer.id })],
        ['an email', frame({ id: 'tip:private000000001', email: 'a@b.test' })],
        ['another kind', frame({ id: 'tip:private000000002', kind: 'cheer' })],
        ['a bad id', frame({ id: 'tip with spaces' })],
        ['a bad time', frame({ id: 'tip:private000000003', at: 'yesterday' })],
        ['a person without a name', frame({ id: 'tip:private000000004', who: { avatar: null } })],
        ['a script as an avatar', frame({ id: 'tip:private000000005', who: { name: 'Ann', avatar: 'javascript:alert(1)' } })],
        ['a negative amount', frame({ id: 'tip:private000000006', amount: { value: -5, unit: 'vibes' } })],
        ['an unknown unit', frame({ id: 'tip:private000000007', amount: { value: 5, unit: 'bucks' } })],
        ['too much text', frame({ id: 'tip:private000000008', text: 'x'.repeat(201) })],
    ];
    for (const [why, f] of bad) {
        const r = await post({ key: `overlay:bad:${why}`, target: { kind: 'channel', id: streamer.id }, frame: f });
        assert.strictEqual(r.status, 400, `${why} is refused`);
    }
    // The room is a channel, never a global room or another channel's.
    for (const target of [{ kind: 'global' }, { kind: 'all' }, { kind: 'stream', id: streamId }]) {
        const r = await post({ key: `overlay:target:${target.kind}`, target, frame: frame({ id: 'tip:target000000000' }) });
        assert.strictEqual(r.status, 400, `a ${target.kind} target is refused`);
    }
    // Nothing is persisted: the overlay feed is not chat history.
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM chat_messages')).n, 0);
});

t('a channel with no such name is simply not joined', async () => {
    const other = await h.ws();
    other.sendJson({ type: 'join', streamId: null, channel: 'nobody-here' });
    const auth = await other.next((m) => m.type === 'auth');
    assert.strictEqual(auth.authenticated, false);
    const r = await post({ key: 'overlay:nobody:1', target: { kind: 'channel', id: streamer.id }, frame: frame({ id: 'tip:nobody000000000' }) });
    assert.strictEqual(r.status, 200);
    await h.sleep(200);
    assert.ok(!other.all.some((m) => m.type === 'overlay-alert'), 'a socket in no room gets nothing');
});

t.run(async () => {
    if (room) room.close();
    if (overlayRoom) overlayRoom.close();
    if (h) await h.close();
});
