'use strict';
/**
 * Live's internal read API over Chat's tables (server/chat/internal-reads.js, plan T3 J4b N1–N5):
 * one capability per route, each answer valid against its openvibe-contracts schema, and
 * first_chat on the message ingress's answer.
 */

const assert = require('assert');
const { validate, catalog } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('chat-internal-reads');
let h, streamer, viewer, other, host, channelId, streamId, otherStreamId, hostStreamId;
const T = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (ms) => new Date(T + ms).toISOString().slice(0, 19).replace('T', ' ');
const ids = {};

// The read contracts arrive with openvibe-contracts 0.95.0. Until the pin reaches it, an older
// package cannot validate them: the run says so instead of failing (the shapes are asserted anyway).
const unknownContracts = new Set();
const sendResultHasFirstChat = (() => {
    const [major, minor] = catalog.find((c) => c.id === 'chat.send-result').version.split('.').map(Number);
    return major > 1 || minor >= 2;
})();
function check(ref, body) {
    let r;
    try { r = validate(ref, body); } catch (err) {
        if (!/unknown contract|is v\d/.test(err.message)) throw err;
        unknownContracts.add(ref);
        return body;
    }
    assert.ok(r.valid, `${ref} invalid: ${JSON.stringify(r.errors)} (${JSON.stringify(body)})`);
    return body;
}
const token = (cap) => h.serviceToken([cap]);
async function read(path, cap, ref, status = 200) {
    const r = await h.http('GET', `/internal/chat${path}`, { token: token(cap) });
    assert.strictEqual(r.status, status, `${path}: ${r.text}`);
    return status === 200 ? check(ref, r.body) : r.body;
}
async function stats(body, status = 200) {
    const r = await h.http('POST', '/internal/chat/stats', { body, token: token('chat.stats.read') });
    assert.strictEqual(r.status, status, `${JSON.stringify(body)}: ${r.text}`);
    return check('chat.stats-result@1', r.body);
}
async function line(name, { ms, user = null, anon = null, username, type = 'chat', platform = null, deleted = 0, stream = streamId, channel = streamer.id }) {
    const r = await h.db.run(
        `INSERT INTO chat_messages (stream_id, channel_user_id, user_id, anon_id, username, message, message_type, source_platform, is_deleted, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stream, channel, user, anon, username, `line ${name}`, type, platform, deleted, at(ms)]);
    ids[name] = Number(r.lastInsertRowid);
}

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('reads-streamer', { role: 'streamer' });
    viewer = h.addUser('reads-viewer', { display_name: 'Reads Viewer' });
    other = h.addUser('reads-other');
    host = h.addUser('reads-host', { role: 'streamer' });
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    otherStreamId = h.addStream(other.id, h.addChannel(other.id));
    hostStreamId = h.addStream(host.id, h.addChannel(host.id));
    await h.ctx.sync();
    await h.ctx.ensureUsers([streamer.id, viewer.id, other.id, host.id]);

    await line('v1', { ms: 0, user: viewer.id, username: viewer.username });
    await line('gone', { ms: 10e3, user: viewer.id, username: viewer.username, deleted: 1 });
    await line('v2', { ms: 30e3, user: viewer.id, username: viewer.username });
    await line('o1', { ms: 65e3, user: other.id, username: other.username });
    await line('v3', { ms: 70e3, user: viewer.id, username: viewer.username });
    await line('a1', { ms: 130e3, anon: 'anon77', username: 'anon77' });
    await line('r1', { ms: 135e3, username: 'twitch:fan', platform: 'twitch' });
    await line('sb', { ms: 140e3, user: viewer.id, username: viewer.username, type: 'soundboard' });
    await line('sys', { ms: 150e3, username: 'System', type: 'system' });
    await line('elsewhere', { ms: 5e3, user: other.id, username: other.username, stream: otherStreamId, channel: other.id });
});

t('each route needs its own capability, a service token for Chat and loopback', async () => {
    const routes = [
        ['POST', '/stats', 'chat.stats.read', { kind: 'site' }],
        ['GET', `/messages?stream_id=${streamId}`, 'chat.messages.read'],
        ['GET', `/timeline?stream_id=${streamId}&since=${T}&until=${T + 600e3}&bucket_ms=60000`, 'chat.analysis.read'],
        ['GET', `/first-chat?channel_id=${streamer.id}&identity=user:${viewer.id}`, 'chat.analysis.read'],
        ['GET', `/moderation/pending-ip?channel_id=${channelId}`, 'chat.moderation.queue.read'],
        ['GET', `/moderation/relay-users?channel_id=${channelId}`, 'chat.moderation.queue.read'],
        ['GET', '/moderation/relay-users/1', 'chat.moderation.queue.read'],
        ['GET', '/moderation/tts-override?identity_key=x', 'chat.moderation.queue.read'],
        ['GET', `/sounds?channel_owner_id=${streamer.id}`, 'chat.sounds.read'],
        ['GET', `/sounds/count?channel_owner_id=${streamer.id}`, 'chat.sounds.read'],
        ['GET', '/sounds?pending_asset=1', 'chat.sounds.read'],
        ['GET', `/sounds/by-command?channel_id=${streamer.id}&command=honk`, 'chat.sounds.read', undefined, 404],
        ['POST', '/sounds/asset', 'chat.sounds.write', { id: 999999, media_url: 'https://media.test/x', media_asset_id: 1 }, 404],
    ];
    for (const [method, path, cap, body, ok = 200] of routes) {
        const url = `/internal/chat${path}`;
        const wrong = cap === 'chat.messages.read' ? 'chat.stats.read' : 'chat.messages.read';
        assert.strictEqual((await h.http(method, url, { body })).status, 401, `${path} without a token`);
        assert.strictEqual((await h.http(method, url, { body, token: token(wrong) })).status, 403, `${path} with ${wrong}`);
        assert.strictEqual((await h.http(method, url, { body, token: token('chat.moderation.read') })).status, 403, `${path} with chat.moderation.read`);
        assert.strictEqual((await h.http(method, url, { body, token: h.serviceToken([cap], { aud: 'openvibe.live' }) })).status, 401, `${path} for another audience`);
        assert.strictEqual((await h.http(method, url, { body, token: token(cap), headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, `${path} from outside`);
        assert.strictEqual((await h.http(method, url, { body, token: token(cap) })).status, ok, `${path} with ${cap}`);
    }
    // Reading sounds does not allow writing their asset.
    assert.strictEqual((await h.http('POST', '/internal/chat/sounds/asset', { body: {}, token: token('chat.sounds.read') })).status, 403);
});

t('N1 stats: site, user, stream and channel-top over non-deleted lines in the window', async () => {
    const win = { since: T, until: T + 600e3 };
    assert.deepStrictEqual(await stats({ kind: 'site', ...win }), { ok: true, messages: 9, chatters: 4 });
    assert.ok((await stats({ kind: 'site' })).messages >= 9);
    assert.deepStrictEqual(await stats({ kind: 'user', user_id: viewer.id, ...win }), { ok: true, messages: 4, chatters: 1 });
    assert.deepStrictEqual(await stats({ kind: 'stream', stream_id: streamId, ...win }), { ok: true, messages: 8, chatters: 4, sounds: 1 });
    assert.deepStrictEqual(await stats({ kind: 'stream', stream_id: streamId, since: T + 60e3, until: T + 120e3 }), { ok: true, messages: 2, chatters: 2, sounds: 0 });

    const top = (await stats({ kind: 'channel-top', stream_id: streamId, ...win })).top_chatters;
    assert.deepStrictEqual(top[0], { user_id: viewer.id, username: viewer.username, display_name: 'Reads Viewer', avatar_url: null, profile_color: '#8b5cf6', count: 4 });
    assert.deepStrictEqual(top.slice(1).map((c) => [c.user_id, c.username, c.count]).sort(),
        [[null, 'anon77', 1], [null, 'twitch:fan', 1], [other.id, other.username, 1]].sort());
    assert.deepStrictEqual((await stats({ kind: 'channel-top', channel_user_id: streamer.id, limit: 2, ...win })).top_chatters.map((c) => c.count), [4, 1]);
    const all = (await stats({ kind: 'channel-top', ...win })).top_chatters;
    assert.deepStrictEqual(all.slice(0, 2).map((c) => [c.user_id, c.count]), [[viewer.id, 4], [other.id, 2]]);

    for (const body of [{}, { kind: 'everything' }, { kind: 'user' }, { kind: 'stream' }, { kind: 'site', extra: 1 },
        { kind: 'site', since: -1 }, { kind: 'site', since: '1' }, { kind: 'stream', stream_id: 1.5 }, { kind: 'channel-top', limit: 51 },
        { kind: 'channel-top', user_id: viewer.id }]) await stats(body, 400);
});

t('N1b stats site-daily: one row per UTC day over every channel, zeros filled', async () => {
    const series = async (body, status = 200) => {
        const r = await h.http('POST', '/internal/chat/stats', { body, token: token('chat.stats.read') });
        assert.strictEqual(r.status, status, `${JSON.stringify(body)}: ${r.text}`);
        return r.body;
    };
    assert.deepStrictEqual(await series({ kind: 'site-daily', since: T, until: T + 600e3 }),
        { ok: true, days: [{ day: '2026-01-01', messages: 9, chatters: 4 }] });
    // [2025-12-31, 2026-01-02): two UTC days; the empty first day is a zero row, not skipped.
    assert.deepStrictEqual(await series({ kind: 'site-daily', since: Date.UTC(2025, 11, 31), until: Date.UTC(2026, 0, 2) }), {
        ok: true, days: [{ day: '2025-12-31', messages: 0, chatters: 0 }, { day: '2026-01-01', messages: 9, chatters: 4 }],
    });
    assert.strictEqual((await series({ kind: 'site-daily', since: T, until: T + 399 * 86400000 })).days.length, 400);
    for (const body of [{ kind: 'site-daily' }, { kind: 'site-daily', since: T }, { kind: 'site-daily', until: T },
        { kind: 'site-daily', since: T, until: T }, { kind: 'site-daily', since: T + 1, until: T },
        { kind: 'site-daily', since: T, until: T + 400 * 86400000 }, { kind: 'site-daily', since: T, until: T + 600e3, user_id: viewer.id },
        { kind: 'site-daily', since: T, until: T + 600e3, limit: 5 }, { kind: 'site-daily', since: T, until: T + 600e3, extra: 1 }])
        await series(body, 400);
});

t('N2 messages: one filter, a cursor on id, tail → max_id', async () => {
    const live = ['v1', 'v2', 'o1', 'v3', 'a1', 'r1', 'sb', 'sys'].map((k) => ids[k]);
    const page = (q, status) => read(`/messages?${q}`, 'chat.messages.read', 'chat.messages-page@1', status);
    const newest = await page(`stream_id=${streamId}`);
    assert.deepStrictEqual(newest.messages.map((m) => m.id), [...live].reverse());
    assert.strictEqual(newest.max_id, ids.sys);
    assert.deepStrictEqual(newest.messages.find((m) => m.id === ids.r1), {
        id: ids.r1, user_id: null, anon_id: null, username: 'twitch:fan', message: 'line r1', message_type: 'chat', is_global: 0,
        stream_id: streamId, channel_user_id: streamer.id, source_platform: 'twitch', reply_to_id: null, timestamp: at(135e3),
    });
    assert.deepStrictEqual((await page(`stream_id=${streamId}&after_id=${ids.v1}&limit=2`)).messages.map((m) => m.id), [ids.v2, ids.o1]);
    assert.deepStrictEqual((await page(`channel_user_id=${streamer.id}&before_id=${ids.o1}`)).messages.map((m) => m.id), [ids.v2, ids.v1]);
    assert.deepStrictEqual((await page(`user_id=${viewer.id}&after_id=${ids.v1}&before_id=${ids.sb}`)).messages.map((m) => m.id), [ids.v2, ids.v3]);
    assert.deepStrictEqual(await page(`channel_user_id=${streamer.id}&tail=1`), { ok: true, messages: [], max_id: ids.sys });
    assert.deepStrictEqual((await page(`stream_id=${streamId}&types=chat`)).messages.map((m) => m.id), live.slice(0, 6).reverse());
    assert.deepStrictEqual((await page('anon_id=anon77')).messages.map((m) => m.id), [ids.a1]);
    assert.deepStrictEqual((await page('username=twitch%3Afan')).messages.map((m) => m.id), [ids.r1]);
    assert.deepStrictEqual((await page(`id=${ids.o1}`)).messages.map((m) => m.message), ['line o1']);
    assert.deepStrictEqual(await page(`id=${ids.gone}`), { ok: true, messages: [], max_id: null });
    assert.strictEqual((await page(`stream_id=${streamId}&limit=100000`)).messages.length, live.length);
    for (const q of ['', `stream_id=${streamId}&user_id=${viewer.id}`, 'stream_id=abc', 'stream_id=0', `stream_id=${streamId}&limit=-1`,
        `stream_id=${streamId}&tail=yes`, `stream_id=${streamId}&types=chat,nope`, `stream_id=${streamId}&order=asc`, `stream_id=${streamId}&stream_id=1`])
        check('chat.messages-page@1', await page(q, 400));
});

t('N3 timeline: buckets from since, oldest first, empty ones left out', async () => {
    const tl = (q, status) => read(`/timeline?${q}`, 'chat.analysis.read', 'chat.timeline-result@1', status);
    assert.deepStrictEqual(await tl(`stream_id=${streamId}&since=${T}&until=${T + 600e3}&bucket_ms=60000`), {
        ok: true, buckets: [{ t: T, count: 2 }, { t: T + 60e3, count: 2 }, { t: T + 120e3, count: 4 }], max_id: ids.sys,
    });
    assert.deepStrictEqual(await tl(`channel_user_id=${streamer.id}&since=${T + 30e3}&until=${T + 90e3}&bucket_ms=30000`), {
        ok: true, buckets: [{ t: T + 30e3, count: 1 }, { t: T + 60e3, count: 2 }], max_id: ids.v3,
    });
    assert.deepStrictEqual(await tl(`stream_id=${streamId}&since=${T + 900e3}&until=${T + 960e3}&bucket_ms=60000`), { ok: true, buckets: [], max_id: null });
    for (const q of [`since=${T}&bucket_ms=60000`, `stream_id=${streamId}&channel_user_id=${streamer.id}&since=${T}&bucket_ms=60000`,
        `stream_id=${streamId}&bucket_ms=60000`, `stream_id=${streamId}&since=${T}`, `stream_id=${streamId}&since=${T}&until=${T + 600e3}&bucket_ms=500`,
        `stream_id=${streamId}&since=${T}&until=${T}&bucket_ms=60000`, `stream_id=${streamId}&since=0&until=${T}&bucket_ms=1000`])
        check('chat.timeline-result@1', await tl(q, 400));
});

t('N1c first chat: whether this identity has ever chatted in the channel', async () => {
    await h.db.run(`INSERT INTO stream_first_chats (chatter_key, channel_user_id) VALUES ('user:123', ?), ('anon:anonX', ?), ('ext:[Twitch] foo', ?)`,
        [streamer.id, streamer.id, streamer.id]);
    const fc = async (q, status = 200) => {
        const r = await h.http('GET', `/internal/chat/first-chat?${q}`, { token: token('chat.analysis.read') });
        assert.strictEqual(r.status, status, `${q}: ${r.text}`);
        return r.body;
    };
    assert.deepStrictEqual(await fc(`channel_id=${streamer.id}&identity=user:123`), { ok: true, first: false });
    assert.deepStrictEqual(await fc(`channel_id=${streamer.id}&identity=anon:anonX`), { ok: true, first: false });
    assert.deepStrictEqual(await fc(`channel_id=${streamer.id}&identity=${encodeURIComponent('ext:[Twitch] foo')}`), { ok: true, first: false });
    assert.deepStrictEqual(await fc(`channel_id=${streamer.id}&identity=user:999`), { ok: true, first: true });
    assert.deepStrictEqual(await fc(`channel_id=${other.id}&identity=user:123`), { ok: true, first: true }, 'a channel is its owner');
    for (const q of ['', `channel_id=${streamer.id}`, 'identity=user:1', `channel_id=abc&identity=user:1`, `channel_id=0&identity=user:1`,
        `channel_id=${streamer.id}&identity=123`, `channel_id=${streamer.id}&identity=user:`, `channel_id=${streamer.id}&identity=user:${'a'.repeat(200)}`,
        `channel_id=${streamer.id}&identity=user:1&extra=1`]) await fc(q, 400);
});

t('N4 moderation queues: pending IP messages, hidden relay users, TTS overrides', async () => {
    const run = (sql, p) => h.db.run(sql, p);
    const pend = async (channel, status, ms) => Number((await run(
        `INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, anon_id, username, message, status, created_at) VALUES (?, ?, '203.0.113.9', 'anon5', 'anon5', 'held', ?, ?)`,
        [channel, streamId, status, at(ms)])).lastInsertRowid);
    const later = await pend(channelId, 'pending', 20e3);
    const first = await pend(channelId, 'pending', 10e3);
    await pend(channelId, 'approved', 5e3);
    await pend(channelId + 100, 'pending', 1e3);
    const q = (path, status) => read(`/moderation/${path}`, 'chat.moderation.queue.read', 'chat.moderation-queue-result@1', status);
    const pending = (await q(`pending-ip?channel_id=${channelId}`)).pending_ip;
    assert.deepStrictEqual(pending.map((r) => r.id), [first, later]);
    assert.strictEqual(pending[0].ip_address, '203.0.113.9');
    assert.strictEqual((await q(`pending-ip?channel_id=${channelId}&limit=1`)).pending_ip.length, 1);

    const hide = async (channel, ms) => Number((await run(
        `INSERT INTO hidden_relay_users (channel_id, platform, external_username, action, reason, created_by, created_at) VALUES (?, 'twitch', 'spammer', 'hide', 'spam', ?, ?)`,
        [channel, streamer.id, at(ms)])).lastInsertRowid);
    const older = await hide(channelId, 1e3);
    const everywhere = await hide(null, 2e3);
    await hide(channelId + 100, 3e3);
    const relay = (await q(`relay-users?channel_id=${channelId}`)).relay_users;
    assert.deepStrictEqual(relay.map((r) => [r.id, r.channel_id]), [[everywhere, null], [older, channelId]]);
    assert.strictEqual(relay[0].created_by_username, streamer.username);
    assert.deepStrictEqual((await q(`relay-users/${older}`)).relay_user, { ...relay[1] });
    assert.deepStrictEqual(await q('relay-users/999999'), { ok: true, relay_user: null });

    await run(`INSERT INTO tts_voice_overrides (identity_key, voice, pitch, speed, gap, set_by) VALUES ('user:42', 'brian', 2, -1, 3, ?)`, [streamer.id]);
    const override = (await q('tts-override?identity_key=%20USER:42%20')).tts_override;
    assert.deepStrictEqual({ ...override, updated_at: null }, { identity_key: 'user:42', voice: 'brian', pitch: 2, speed: -1, gap: 3, set_by: streamer.id, updated_at: null });
    assert.deepStrictEqual(await q('tts-override?identity_key=user:43'), { ok: true, tts_override: null });

    for (const path of ['pending-ip', 'pending-ip?channel_id=x', 'relay-users', 'relay-users/abc', 'relay-users/0', 'tts-override', 'tts-override?identity_key=%20', `pending-ip?channel_id=${channelId}&status=denied`])
        check('chat.moderation-queue-result@1', await q(path, 400));
});

t('N5 sounds: count, pending assets, and an idempotent asset write-back', async () => {
    const sound = async (owner, command, asset = null) => Number((await h.db.run(
        `INSERT INTO channel_sounds (channel_owner_id, command, url, duration_seconds, created_by, created_by_name, media_url, media_asset_id) VALUES (?, ?, ?, 1.5, ?, 'uploader', ?, ?)`,
        [owner, command, `/sounds/${command}.mp3`, owner, asset && `https://media.test/a/${asset}`, asset])).lastInsertRowid);
    const honk = await sound(streamer.id, 'honk');
    await sound(streamer.id, 'beep', 7);
    const boom = await sound(other.id, 'boom');
    const s = (path, status) => read(`/sounds${path}`, 'chat.sounds.read', 'chat.sounds-result@1', status);
    assert.deepStrictEqual(await s(`?channel_owner_id=${streamer.id}`), { ok: true, count: 2 });
    assert.deepStrictEqual(await s(`/count?channel_owner_id=${other.id}`), { ok: true, count: 1 });
    assert.deepStrictEqual(await s(`?channel_owner_id=${host.id}`), { ok: true, count: 0 });
    const pending = (await s('?pending_asset=1')).sounds;
    assert.deepStrictEqual(pending.map((r) => r.id), [honk, boom]);
    assert.deepStrictEqual(pending[0], {
        id: honk, channel_owner_id: streamer.id, command: 'honk', url: '/sounds/honk.mp3', mime: 'audio/mpeg', duration_seconds: 1.5,
        created_by: streamer.id, created_by_name: 'uploader', media_url: null, media_asset_id: null,
    });
    assert.deepStrictEqual((await s(`?pending_asset=1&channel_owner_id=${other.id}`)).sounds.map((r) => r.id), [boom]);
    assert.deepStrictEqual((await s(`?pending_asset=1&after_id=${honk}&limit=1`)).sounds.map((r) => r.id), [boom]);

    const write = (body) => h.http('POST', '/internal/chat/sounds/asset', { body, token: token('chat.sounds.write') });
    const body = check('chat.sound-asset-request@1', { id: honk, media_url: 'https://media.test/a/11', media_asset_id: 11 });
    for (let i = 0; i < 2; i++) {
        const r = await write(body);
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(check('chat.ingress-ack@1', r.body), { ok: true });
    }
    assert.deepStrictEqual((await s('?pending_asset=1')).sounds.map((r) => r.id), [boom]);
    const row = await h.db.get('SELECT media_url, media_asset_id FROM channel_sounds WHERE id = ?', [honk]);
    assert.deepStrictEqual([row.media_url, Number(row.media_asset_id)], ['https://media.test/a/11', 11]);
    assert.strictEqual((await write({ ...body, id: 999999 })).status, 404);
    for (const bad of [{}, { ...body, id: 0 }, { ...body, media_url: '' }, { ...body, media_asset_id: '11' }, { ...body, extra: 1 }, { ...body, media_url: 'x'.repeat(2049) }]) {
        const r = await write(bad);
        assert.strictEqual(r.status, 400, JSON.stringify(bad));
        check('chat.ingress-ack@1', r.body);
    }
    for (const path of ['', '?channel_owner_id=abc', '?pending_asset=2', `?channel_owner_id=${streamer.id}&limit=5`]) await s(path, 400);
});

t('N5b sounds by command: the approved sound Live plays, or 404', async () => {
    const sound = async (owner, command, approved = 1, asset = null) => Number((await h.db.run(
        `INSERT INTO channel_sounds (channel_owner_id, command, url, duration_seconds, created_by, created_by_name, is_approved, media_url, media_asset_id) VALUES (?, ?, ?, 2, ?, 'uploader', ?, ?, ?)`,
        [owner, command, `/sounds/${command}.mp3`, owner, approved, asset && `https://media.test/a/${asset}`, asset])).lastInsertRowid);
    const a = await sound(host.id, 'honk', 1, 3);
    const b = await sound(host.id, 'honk');
    await sound(host.id, 'quiet', 0);
    const get = async (q, status = 200) => {
        const r = await h.http('GET', `/internal/chat/sounds/by-command?${q}`, { token: token('chat.sounds.read') });
        assert.strictEqual(r.status, status, `${q}: ${r.text}`);
        return r.body;
    };
    const found = (await get(`channel_id=${host.id}&command=HONK`)).sound;
    assert.ok([a, b].includes(found.id), 'one of the channel\'s approved honks');
    assert.deepStrictEqual(found, {
        id: found.id, channel_owner_id: host.id, command: 'honk', url: '/sounds/honk.mp3', mime: 'audio/mpeg',
        duration_seconds: 2, created_by: host.id, created_by_name: 'uploader',
        media_url: found.id === a ? 'https://media.test/a/3' : null, media_asset_id: found.id === a ? 3 : null,
    });
    assert.ok([a, b].includes((await get(`channel_id=${host.id}&command=%20!HONK%20`)).sound.id), 'trimmed, lowercased, ! stripped');
    assert.deepStrictEqual(await get(`channel_id=${other.id}&command=honk`, 404), { ok: false, error: 'Sound not found' }, 'another owner\'s command');
    assert.deepStrictEqual(await get(`channel_id=${host.id}&command=quiet`, 404), { ok: false, error: 'Sound not found' }, 'unapproved');
    for (const q of ['', `channel_id=${host.id}`, 'command=honk', `channel_id=abc&command=honk`, `channel_id=0&command=honk`,
        `channel_id=${host.id}&command=%20`, `channel_id=${host.id}&command=${'x'.repeat(121)}`, `channel_id=${host.id}&command=honk&extra=1`])
        await get(q, 400);
});

t('the message ingress answers first_chat: true once per chatter and channel', async () => {
    const send = async (key, extra) => {
        const r = await h.http('POST', '/internal/chat/messages', { body: { key, stream_id: hostStreamId, message: 'hello host', ...extra }, token: token('chat.message.send') });
        assert.strictEqual(r.status, 200, r.text);
        // first_chat is in chat.send-result from 1.2.0 (openvibe-contracts 0.95.0).
        const { first_chat, ...older } = r.body;
        check('chat.send-result@1', sendResultHasFirstChat ? r.body : older);
        return r.body;
    };
    const viewerLine = { user_id: viewer.id, username: viewer.username };
    assert.strictEqual((await send('reads:first:1', viewerLine)).first_chat, true);
    assert.strictEqual((await send('reads:first:2', viewerLine)).first_chat, false);
    assert.strictEqual((await send('reads:first:1', viewerLine)).first_chat, true, 'a retry answers what was saved');
    assert.strictEqual((await send('reads:first:3', { anon_id: 'anon88', username: 'anon88' })).first_chat, true);
    assert.strictEqual((await send('reads:first:4', { ...viewerLine, message_type: 'system' })).first_chat, false, 'only chat lines use up a welcome');
    const r = await h.http('POST', '/internal/chat/messages', { body: { key: 'reads:first:dm', user_id: viewer.id, username: viewer.username, message: 'dm', dm: { to_user_id: other.id } }, token: token('chat.message.send') });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!('first_chat' in check('chat.send-result@1', r.body)));
});

t.run(async () => {
    if (unknownContracts.size) {
        console.log(`chat-internal-reads: schemas not validated (openvibe-contracts ${require('openvibe-contracts/package.json').version} lacks ${[...unknownContracts].join(', ')}; pin v0.95.0)`);
    }
    if (h) await h.close();
});
