'use strict';
/**
 * The bridge Live's remaining modules use (POST /internal/live/calls, GET /internal/live/presence):
 * service-token guard, forwarded chat writes with placeholder ids mapped for later ops of the same
 * Live boot, idempotent retries, only allow-listed writes, pushes to browsers (broadcasts, DMs with
 * the participant check, disconnects, user updates with the stored-name rewrite, deploy notices),
 * and the presence snapshot Live's synchronous reads use.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('bridge');
let h, streamer, viewer, channelId, streamId, viewerWs, globalWs, BRIDGE;
const REF = -(2 ** 40) - 1;

const calls = (ops, { token = BRIDGE, boot: b = 'live-boot-1', headers } = {}) =>
    h.http('POST', '/internal/live/calls', { token, headers, body: { boot: b, ops: ops.map((o, i) => ({ seq: i + 1, ...o })) } });

t('boot', async () => {
    h = await boot();
    BRIDGE = h.serviceToken(['chat.live_bridge.write']);
    streamer = h.addUser('streamer', { role: 'streamer' });
    viewer = h.addUser('viewer');
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
    viewerWs = await h.ws({ ip: '198.51.100.50', token: viewer.token, stream: streamId });
    viewerWs.sendJson({ type: 'join', streamId, token: viewer.token });
    await viewerWs.next((m) => m.type === 'auth');
    globalWs = await h.ws({ ip: '198.51.100.51' });
    globalWs.sendJson({ type: 'join' });
    await globalWs.next((m) => m.type === 'auth');
});

t('only Live’s service token, only from loopback', async () => {
    assert.strictEqual((await h.http('POST', '/internal/live/calls', { body: { ops: [] } })).status, 401);
    assert.strictEqual((await calls([], { token: h.serviceToken(['chat.presence.read']) })).status, 403);
    assert.strictEqual((await calls([], { token: h.serviceToken(['chat.live_bridge.write'], { aud: 'openvibe.live' }) })).status, 401);
    assert.strictEqual((await calls([], { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
    assert.strictEqual((await h.http('GET', '/internal/live/presence', { token: BRIDGE })).status, 403);
});

let realId;
t('a forwarded insert gets its real id, and later ops of the boot are rewritten', async () => {
    const r = await calls([
        { op: 'db', ref: REF, key: 'live:1', args: ['saveChatMessage', { stream_id: streamId, user_id: null, username: 'ChatBot', message: 'beep boop', message_type: 'chat', source_platform: 'ai', metadata: { bot: 1 } }] },
        { op: 'broadcastToStream', args: [streamId, { type: 'chat', id: REF, username: 'ChatBot', message: 'beep boop', is_ai: true }] },
        { op: 'forwardToGlobal', args: [streamId, { type: 'chat', id: REF, username: 'ChatBot', message: 'beep boop' }] },
    ]);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body.results));
    realId = r.body.results[0].result.lastInsertRowid;
    assert.ok(realId > 0);
    const got = await viewerWs.next((m) => m.type === 'chat' && m.message === 'beep boop');
    assert.strictEqual(got.id, realId, 'placeholder replaced by the real id');
    const cross = await globalWs.next((m) => m.type === 'chat' && m.message === 'beep boop');
    assert.strictEqual(cross.id, realId);
    assert.strictEqual(cross.stream_channel, 'streamer');
    const row = h.db.getChatMessageById(realId);
    assert.strictEqual(row.channel_user_id, streamer.id, 'channel derived from the stream');
    assert.strictEqual(row.source_platform, 'ai');
});

t('a retried write (same key) is applied once and answers the first result', async () => {
    const before = h.db.get('SELECT COUNT(*) AS n FROM chat_messages').n;
    const r = await calls([{ op: 'db', ref: REF, key: 'live:1', args: ['saveChatMessage', { stream_id: streamId, username: 'ChatBot', message: 'beep boop', message_type: 'chat' }] }]);
    assert.strictEqual(r.body.results[0].result.lastInsertRowid, realId);
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM chat_messages').n, before);
});

t('placeholders are per Live boot', async () => {
    const r = await calls([{ op: 'broadcastToStream', args: [streamId, { type: 'system', message: 'other boot', id: REF }] }], { boot: 'live-boot-2' });
    assert.ok(r.body.results[0].ok);
    const got = await viewerWs.next((m) => m.type === 'system' && m.message === 'other boot');
    assert.strictEqual(got.id, REF, 'unknown placeholder left alone');
});

t('only allow-listed writes; unknown ops refused', async () => {
    const r = await calls([
        { op: 'db', args: ['run', 'DELETE FROM chat_messages'] },
        { op: 'eval', args: ['1'] },
        { op: 'db', args: ['deleteChatMessage', realId, streamer.id] },
    ]);
    assert.deepStrictEqual(r.body.results.map((x) => x.ok), [false, false, true]);
    assert.ok(h.db.get('SELECT COUNT(*) AS n FROM chat_messages').n > 0);
    assert.strictEqual(h.db.getChatMessageById(realId).is_deleted, 1);
    // Moderation from Live's /api/mod lands in Chat's log, with an internal event.
    const m = await calls([{ op: 'db', ref: REF - 1, key: 'live:2', args: ['logModerationAction', { scope_type: 'site', actor_user_id: streamer.id, action_type: 'message_delete', details: { id: realId } }] }]);
    assert.ok(m.body.results[0].ok);
    const ev = h.db.all("SELECT event FROM events_outbox WHERE event_type = 'chat.moderation.action'").map((x) => JSON.parse(x.event)).pop();
    assert.strictEqual(ev.payload.action_type, 'message_delete');
    assert.strictEqual(ev.visibility, 'internal');
});

t('DMs through the bridge keep the participant check', async () => {
    // viewer is not in conversation 999 (it does not exist): nothing is delivered.
    await calls([{ op: 'sendDm', args: [viewer.id, { type: 'call-invite', conversation_id: 999 }] }]);
    assert.ok(await viewerWs.none((m) => m.type === 'call-invite'));
    // Without a conversation id (call ringing) it is delivered, as in Live.
    await calls([{ op: 'sendDm', args: [viewer.id, { type: 'call-ring', from: 'streamer' }] }]);
    await viewerWs.next((m) => m.type === 'call-ring');
});

t('a user update from Live refreshes sockets and rewrites stored names', async () => {
    h.db.saveChatMessage({ stream_id: streamId, user_id: viewer.id, username: 'Viewer', message: 'old name line', message_type: 'chat' });
    await calls([{ op: 'sendUserUpdate', args: [viewer.id, { id: viewer.id, username: 'viewer', display_name: 'Viewer Renamed', role: 'user', avatar_url: null, profile_color: '#123456' }] }]);
    const u = await viewerWs.next((m) => m.type === 'user-updated');
    assert.strictEqual(u.user.display_name, 'Viewer Renamed');
    assert.strictEqual(h.db.get('SELECT username FROM chat_messages WHERE message = ?', ['old name line']).username, 'Viewer Renamed');
    await h.sleep(1100);
    viewerWs.sendJson({ type: 'chat', message: 'with the new name' });
    const own = await globalWs.next((m) => m.type === 'chat' && m.message === 'with the new name');
    assert.strictEqual(own.username, 'Viewer Renamed');
});

t('broadcastAllRaw (Live code that looped over chatServer.clients) reaches everyone', async () => {
    await calls([{ op: 'broadcastAllRaw', args: [JSON.stringify({ type: 'delete-messages', ids: [1, 2] })] }]);
    await viewerWs.next((m) => m.type === 'delete-messages');
    await globalWs.next((m) => m.type === 'delete-messages');
});

t('deploy notices: stored as one rolling global row, shown to everyone, folded on the next deploy', async () => {
    const commit = (n) => ({ hash: String(n).repeat(40).slice(0, 40), short: String(n).repeat(7), date: '2026-09-22T10:00:00Z', subject: `change ${n}` });
    let r = await calls([{ op: 'deployNotice', args: [[commit(1)]] }]);
    const id1 = r.body.results[0].result.id;
    const row = h.db.getChatMessageById(id1);
    assert.strictEqual(row.message_type, 'system');
    assert.strictEqual(JSON.parse(row.metadata).kind, 'deploy');
    r = await calls([{ op: 'deployNotice', args: [[commit(2)]] }]);
    assert.strictEqual(r.body.results[0].result.id, id1, 'folded into the same row');
    assert.strictEqual(JSON.parse(h.db.getChatMessageById(id1).metadata).deploys, 2);
    // A late joiner gets it once.
    const late = await h.ws({ ip: '198.51.100.52' });
    late.sendJson({ type: 'join' });
    const upd = await late.next((m) => m.type === 'update', 4000);
    assert.strictEqual(upd.id, id1);
    late.close();
});

t('Live’s own writes to data Chat caches invalidate it at once (invalidate op)', async () => {
    await h.ctx.ensurePolicy(channelId);
    assert.strictEqual(h.ctx.isChannelModerator(viewer.id, channelId), false);
    h.live.policies.get(channelId).moderator_ids = [viewer.id];       // added on Live's dashboard
    const r = await calls([{ op: 'invalidate', args: ['channel', channelId] }, { op: 'invalidate', args: ['nonsense', 1] }]);
    assert.deepStrictEqual(r.body.results.map((x) => x.ok), [true, false]);
    await h.sleep(150);
    assert.strictEqual(h.ctx.isChannelModerator(viewer.id, channelId), true);
});

t('presence snapshot for Live’s synchronous reads', async () => {
    const p = await h.http('GET', '/internal/live/presence', { token: h.serviceToken(['chat.presence.read']) });
    assert.strictEqual(p.status, 200);
    assert.ok(p.body.total >= 2);
    assert.strictEqual(p.body.streams[streamId], 1);
    assert.ok(p.body.users.some((u) => u.user_id === viewer.id && u.ip === '198.51.100.50'));
    assert.ok(p.body.anons.some((a) => a.ip === '198.51.100.51'));
});

t('disconnectUser (a ban in Live) closes the sockets and refreshes the ban list', async () => {
    const bye = await h.ws({ ip: '198.51.100.53', token: viewer.token });
    bye.sendJson({ type: 'join', token: viewer.token });
    await bye.next((m) => m.type === 'auth');
    h.live.addBan({ user_id: viewer.id });
    const closed = new Promise((r) => bye.on('close', r));
    await calls([{ op: 'disconnectUser', args: [{ userId: viewer.id }] }]);
    await bye.next((m) => m.type === 'system' && m.message === 'You have been banned.');
    await closed;
    assert.ok(h.ctx.isUserBanned(viewer.id, null), 'ban list refreshed');
    h.live.clearBans();
    await h.ctx.invalidateBans();
});

t.run(async () => { for (const w of [viewerWs, globalWs]) { try { w.close(); } catch { /* */ } } if (h) await h.close(); });
