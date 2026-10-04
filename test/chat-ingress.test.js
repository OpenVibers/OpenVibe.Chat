'use strict';

const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('chat-ingress');
let h, streamer, viewer, streamId, channelId, room, globalRoom;
const CAPS = {
    messages: 'chat.message.send', events: 'chat.event.publish', moderation: 'chat.moderation.write',
    invalidate: 'chat.cache.invalidate', presence: 'chat.presence.read',
};
const post = (family, body, token = h.serviceToken([CAPS[family]]), headers) =>
    h.http('POST', `/internal/chat/${family}`, { body, token, headers });

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('ingress-streamer', { role: 'streamer' });
    viewer = h.addUser('ingress-viewer');
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
    room = await h.ws({ token: viewer.token, stream: streamId });
    room.sendJson({ type: 'join', streamId, token: viewer.token });
    await room.next((m) => m.type === 'auth');
    globalRoom = await h.ws();
    globalRoom.sendJson({ type: 'join' });
    await globalRoom.next((m) => m.type === 'auth');
});

t('each route requires its own service capability and loopback', async () => {
    for (const family of ['messages', 'events', 'moderation', 'invalidate']) {
        assert.strictEqual((await h.http('POST', `/internal/chat/${family}`, { body: {} })).status, 401);
        assert.strictEqual((await post(family, {}, h.serviceToken(['chat.presence.read']))).status, 403);
        assert.strictEqual((await post(family, {}, h.serviceToken([CAPS[family]], { aud: 'openvibe.live' }))).status, 401);
        assert.strictEqual((await post(family, {}, h.serviceToken([CAPS[family]]), { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
    }
    assert.strictEqual((await h.http('GET', '/internal/chat/presence')).status, 401);
    assert.strictEqual((await h.http('GET', '/internal/chat/presence', { token: h.serviceToken(['chat.message.send']) })).status, 403);
});

let messageId;
t('messages persist once, broadcast with the real id, and mirror', async () => {
    const body = { key: 'ingress:line:1', stream_id: streamId, user_id: viewer.id, username: viewer.username, message: 'owned ingress line', mirror: true };
    const r = await post('messages', body);
    assert.strictEqual(r.status, 200, r.text);
    messageId = r.body.id;
    assert.ok(messageId > 0);
    assert.strictEqual((await room.next((m) => m.type === 'chat' && m.message === body.message)).id, messageId);
    assert.strictEqual((await globalRoom.next((m) => m.type === 'chat' && m.message === body.message)).id, messageId);
    assert.strictEqual((await h.db.getChatMessageById(messageId)).message, body.message);
    const received = room.all.filter((m) => m.type === 'chat' && m.id === messageId).length;
    const retry = await post('messages', body);
    assert.strictEqual(retry.body.id, messageId);
    assert.strictEqual((await post('messages', { message: body.message, username: body.username, user_id: body.user_id, stream_id: body.stream_id, mirror: true, key: body.key })).body.id, messageId);
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM chat_messages WHERE message = ?', [body.message])).n, 1);
    await h.sleep(300);
    assert.strictEqual(room.all.filter((m) => m.type === 'chat' && m.id === messageId).length, received);
    assert.strictEqual((await post('messages', { ...body, message: 'changed' })).status, 409);
    assert.strictEqual((await post('messages', { ...body, key: 'ingress:bad:1', frame: { type: 'delete-messages' } })).status, 400);
    assert.strictEqual((await post('messages', { ...body, key: 'ingress:bad:2', frame: { profile_color: 'red;}' } })).status, 400);
    assert.strictEqual((await post('messages', { ...body, key: 'ingress:bad:3', frame: { role: 'superuser' } })).status, 400);
    assert.strictEqual((await post('messages', { ...body, key: 'ingress:bad:4', frame: { is_ai: 'yes' } })).status, 400);
});

t('relayed and AI lines keep their colour, role and threading', async () => {
    const body = { key: 'ingress:relay-line:1', stream_id: streamId, username: 'twitch:outside', message: 'relayed reply',
        source_platform: 'twitch', reply_to_id: messageId, is_global: false, auto_delete_at: new Date(Date.now() + 600e3).toISOString(),
        frame: { role: 'external', profile_color: '#33aaff', avatar_url: 'https://example.test/a.png', is_ai: false, filtered: false, core_username: 'outside' } };
    const r = await post('messages', body);
    assert.strictEqual(r.status, 200, r.text);
    const frame = await room.next((m) => m.type === 'chat' && m.id === r.body.id);
    assert.strictEqual(frame.role, 'external');
    assert.strictEqual(frame.profile_color, '#33aaff');
    assert.strictEqual(frame.reply_to_id, messageId);
    assert.strictEqual(frame.is_global, false);
    assert.strictEqual(frame.auto_delete_at, body.auto_delete_at);
    assert.strictEqual(frame.core_username, 'outside');
});

t('first-chat records use the keys the welcome checks read; only chat lines use one up', async () => {
    const keys = async () => (await h.db.all('SELECT chatter_key FROM stream_first_chats WHERE channel_user_id = ?', [streamer.id])).map((r) => r.chatter_key);
    assert.ok((await keys()).includes(`user:${viewer.id}`));
    assert.ok((await keys()).includes('ext:twitch:outside'));
    assert.strictEqual(await h.db.isFirstChatInChannel(`user:${viewer.id}`, streamer.id), false);
    const donor = h.addUser('ingress-donor');
    await h.ctx.sync();
    const donation = await post('messages', { key: 'ingress:first:donation', stream_id: streamId, user_id: donor.id, username: donor.username, message: 'donated 5', message_type: 'donation' });
    assert.strictEqual(donation.status, 200, donation.text);
    assert.ok(!(await keys()).includes(`user:${donor.id}`));
    const anon = await post('messages', { key: 'ingress:first:anon', stream_id: streamId, anon_id: 'anon-first-1', username: 'anon-first-1', message: 'hi' });
    assert.strictEqual(anon.status, 200, anon.text);
    assert.ok((await keys()).includes('anon:anon-first-1'));
    const explicit = await post('messages', { key: 'ingress:first:explicit', stream_id: streamId, username: 'Bot', message: 'hello', message_type: 'system', first_chat_key: 'ext:kick:someone' });
    assert.strictEqual(explicit.status, 200, explicit.text);
    assert.ok((await keys()).includes('ext:kick:someone'));
    assert.strictEqual((await post('messages', { key: 'ingress:first:bad', stream_id: streamId, username: 'Bot', message: 'x', first_chat_key: '42' })).status, 400);
});

t('a retry while another process holds the delivery claim is told to retry', async () => {
    const body = { key: 'ingress:claim:1', stream_id: streamId, username: 'ClaimBot', message: 'claimed line' };
    const r = await post('messages', body);
    assert.strictEqual(r.status, 200, r.text);
    await h.db.run('UPDATE chat_ingress_applied SET delivered = 2, delivery_claimed_at = ? WHERE key = ?', [Date.now(), body.key]);
    assert.strictEqual((await post('messages', body)).status, 503);
    await h.db.run('UPDATE chat_ingress_applied SET delivery_claimed_at = ? WHERE key = ?', [Date.now() - 10 * 60_000, body.key]);
    const reclaimed = await post('messages', body);
    assert.strictEqual(reclaimed.status, 200, reclaimed.text);
    assert.strictEqual(reclaimed.body.id, r.body.id);
    await h.sleep(300);
    assert.strictEqual(room.all.filter((m) => m.type === 'chat' && m.id === r.body.id).length, 2);
    assert.strictEqual(Number((await h.db.get('SELECT delivered FROM chat_ingress_applied WHERE key = ?', [body.key])).delivered), 1);
});

t('DM mode persists and delivers to the recipient', async () => {
    const body = { key: 'ingress:dm:1', user_id: streamer.id, dm: { to_user_id: viewer.id }, username: streamer.username, message: 'private ingress line' };
    const r = await post('messages', body);
    assert.strictEqual(r.status, 200, r.text);
    const frame = await room.next((m) => m.type === 'dm' && m.message?.message === body.message);
    assert.strictEqual(frame.message.id, r.body.id);
    assert.strictEqual(frame.message.sender_id, streamer.id);
    assert.strictEqual(frame.message.username, streamer.username);
    assert.ok(frame.message.created_at);
    assert.ok('profile_color' in frame.message && !('sender_subject_id' in frame.message));
    assert.strictEqual((await post('messages', { ...body, key: 'ingress:dm:blank', message: '   ' })).status, 400);
    assert.strictEqual((await h.db.get('SELECT message FROM dm_messages WHERE id = ?', [r.body.id])).message, body.message);
    assert.strictEqual((await post('messages', body)).body.id, r.body.id);
    await h.db.run('INSERT INTO dm_blocks (blocker_id, blocked_id) VALUES (?, ?)', [viewer.id, streamer.id]);
    assert.strictEqual((await post('messages', { ...body, key: 'ingress:dm:blocked' })).status, 403);
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM dm_messages WHERE message = ?', [body.message])).n, 1);
    await h.db.run('DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?', [viewer.id, streamer.id]);
});

t('optional TTS uses the persisted message id as its queue key', async () => {
    const original = h.chatServer.synthesizeAndBroadcastTTS;
    let args;
    h.chatServer.synthesizeAndBroadcastTTS = async (...received) => { args = received; };
    try {
        const r = await post('messages', { key: 'ingress:tts:1', stream_id: streamId, username: 'TTSBot', message: 'read this line', tts: { voice: 'en-US' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(args[0], streamId);
        assert.strictEqual(args[2], 'read this line');
        assert.strictEqual(args[7], `m${r.body.id}`);
        assert.strictEqual((await post('messages', { key: 'ingress:tts:1', stream_id: streamId, username: 'TTSBot', message: 'read this line', tts: { voice: 'en-US' } })).body.id, r.body.id);
    } finally { h.chatServer.synthesizeAndBroadcastTTS = original; }
});

t('events validate targets and frame types, then publish once', async () => {
    const body = { key: 'ingress:event:1', target: { kind: 'stream', id: streamId }, frame: { type: 'system', message: 'ingress notice' } };
    assert.strictEqual((await post('events', body)).status, 200);
    await room.next((m) => m.type === 'system' && m.message === body.frame.message);
    const received = room.all.filter((m) => m.type === 'system' && m.message === body.frame.message).length;
    assert.strictEqual((await post('events', body)).status, 200);
    await h.sleep(300);
    assert.strictEqual(room.all.filter((m) => m.type === 'system' && m.message === body.frame.message).length, received);
    assert.strictEqual((await post('events', { ...body, key: 'ingress:event:bad', frame: { type: 'chat', message: 'injected' } })).status, 400);
    assert.strictEqual((await post('events', { ...body, key: 'ingress:event:bad2', target: { kind: 'stream' } })).status, 400);
});

t('the transient news card reaches a stream and is never saved', async () => {
    const frame = { type: 'chat', message_type: 'news', username: 'News', message: 'ingress headline', url: 'https://example.test/n',
        news_source: 'wire', timestamp: new Date().toISOString(), source_platform: 'news', system: true };
    const r = await post('events', { key: 'ingress:news:1', target: { kind: 'stream', id: streamId }, frame });
    assert.strictEqual(r.status, 200, r.text);
    const got = await room.next((m) => m.type === 'chat' && m.message === frame.message);
    assert.strictEqual(got.message_type, 'news');
    assert.strictEqual(got.url, frame.url);
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM chat_messages WHERE message = ?', [frame.message])).n, 0);
    for (const [key, bad] of [
        ['global', { target: { kind: 'global' }, frame }],
        ['type', { target: { kind: 'stream', id: streamId }, frame: { ...frame, message_type: 'chat' } }],
        ['url', { target: { kind: 'stream', id: streamId }, frame: { ...frame, url: 'x'.repeat(501) } }],
        ['extra', { target: { kind: 'stream', id: streamId }, frame: { ...frame, user_id: viewer.id } }],
        ['platform', { target: { kind: 'stream', id: streamId }, frame: { ...frame, source_platform: 'twitch' } }],
        ['time', { target: { kind: 'stream', id: streamId }, frame: { ...frame, timestamp: 'soon' } }],
    ]) assert.strictEqual((await post('events', { key: `ingress:news:bad:${key}`, ...bad })).status, 400, key);
});

t('bad input and missing rows are refused with a 4xx, never a retryable 503', async () => {
    assert.strictEqual((await post('events', { key: 'ingress:4xx:stream', target: { kind: 'stream', id: 987654 }, frame: { type: 'system', message: 'nobody' } })).status, 404);
    assert.strictEqual((await post('events', { key: 'ingress:4xx:alert', target: { kind: 'channel', id: streamer.id }, frame: { type: 'alert', streamerId: streamer.id, streamId: 'x', kind: 'goal' } })).status, 400);
    assert.strictEqual((await post('messages', { key: 'ingress:4xx:line', stream_id: 987654, username: 'Bot', message: 'nowhere' })).status, 404);
    assert.strictEqual((await post('moderation', { key: 'ingress:4xx:by', action: 'delete-message', id: 1, deleted_by: { id: 1 } })).status, 400);
    assert.strictEqual((await post('moderation', { key: 'ingress:4xx:reason', action: 'relay-hide', channel_id: channelId, platform: 'twitch', external_username: 'x', reason: 5 })).status, 400);
    const dmBody = { key: 'ingress:4xx:dm', user_id: streamer.id, dm: { to_user_id: viewer.id }, username: streamer.username, message: 'soon gone' };
    const sent = await post('messages', dmBody);
    assert.strictEqual(sent.status, 200, sent.text);
    await h.db.run('UPDATE chat_ingress_applied SET delivered = 0 WHERE key = ?', [dmBody.key]);
    await h.db.run('DELETE FROM dm_messages WHERE id = ?', [sent.body.id]);
    const retry = await post('messages', dmBody);
    assert.strictEqual(retry.status, 200, retry.text);
    assert.strictEqual(retry.body.id, sent.body.id);
});

t('media, redemption and vibe-coding frames reach their streams; call frames reach one user', async () => {
    const media = { key: 'ingress:media:1', target: { kind: 'owner-streams', id: streamer.id }, frame: { type: 'media_queue_update', state: { queue: [] }, timestamp: new Date().toISOString() } };
    assert.strictEqual((await post('events', media)).status, 200);
    await room.next((m) => m.type === 'media_queue_update' && Array.isArray(m.state.queue));
    assert.strictEqual((await post('events', { ...media, key: 'ingress:media:bad', target: { kind: 'stream', id: streamId } })).status, 400);
    assert.strictEqual((await post('events', { ...media, key: 'ingress:media:bad2', frame: { type: 'media_now_playing', request: 'x' } })).status, 400);
    const redemption = { key: 'ingress:redeem:1', target: { kind: 'stream', id: streamId }, frame: { type: 'redemption', username: viewer.username, reward_title: 'Hydrate', reward_icon: null, reward_color: '#fff', cost: 100, user_input: '' } };
    assert.strictEqual((await post('events', redemption)).status, 200);
    await room.next((m) => m.type === 'redemption' && m.reward_title === 'Hydrate');
    const vibe = { key: 'ingress:vibe:1', target: { kind: 'stream', id: streamId }, frame: { type: 'vibe-coding', managed_stream_id: 7, slot_slug: 'main', delay_ms: 0, event: { kind: 'edit' } } };
    assert.strictEqual((await post('events', vibe)).status, 200);
    await room.next((m) => m.type === 'vibe-coding' && m.event.kind === 'edit');

    const invite = { key: 'ingress:call:1', target: { kind: 'user', id: viewer.id }, frame: { type: 'vc-call-invite', channelId: 'room-abc', channelName: 'Call',
        fromUserId: streamer.id, fromUsername: streamer.username, fromDisplayName: 'Streamer', fromAvatarUrl: null, createdAt: Date.now() } };
    assert.strictEqual((await post('events', invite)).status, 200);
    await room.next((m) => m.type === 'vc-call-invite' && m.channelId === 'room-abc');
    await h.sleep(200);
    assert.ok(!globalRoom.all.some((m) => m.type === 'vc-call-invite'));
    const response = { ...invite, key: 'ingress:call:2', frame: { ...invite.frame, type: 'vc-call-response', status: 'accepted' } };
    assert.strictEqual((await post('events', response)).status, 200);
    await room.next((m) => m.type === 'vc-call-response' && m.status === 'accepted');
    assert.strictEqual((await post('events', { ...response, key: 'ingress:call:bad', frame: { ...response.frame, status: 'maybe' } })).status, 400);
    assert.strictEqual((await post('events', { ...invite, key: 'ingress:call:bad2', target: { kind: 'stream', id: streamId } })).status, 400);
    assert.strictEqual((await post('events', { key: 'ingress:call:bad3', target: { kind: 'user', id: viewer.id }, frame: { type: 'system', message: 'hi' } })).status, 400);
    assert.strictEqual((await post('events', { ...invite, key: 'ingress:call:bad4', frame: { ...invite.frame, conversation_id: 1 } })).status, 400);
});

t('sound events pass a typed stream client to the Chat sound queue', async () => {
    const original = h.chatServer.triggerChannelSound;
    let call;
    h.chatServer.triggerChannelSound = async (...args) => { call = args; };
    try {
        const frame = { type: 'channel-sound', streamId, command: 'honk', args: ['0.5'], relay: { username: 'external' } };
        const r = await post('events', { key: 'ingress:sound:1', target: { kind: 'stream', id: streamId }, frame });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(call[1].streamId, streamId);
        assert.strictEqual(call[2].id, streamId);
        assert.strictEqual(call[3], 'honk');
        assert.strictEqual(call[5].username, 'external');
        assert.strictEqual((await post('events', { key: 'ingress:sound:bad', target: { kind: 'all' }, frame })).status, 400);
    } finally { h.chatServer.triggerChannelSound = original; }
});

t('moderation deletes once, announces deleted ids, and writes a log', async () => {
    const body = { key: 'ingress:delete:1', action: 'delete-message', id: messageId, deleted_by: streamer.username };
    const r = await post('moderation', body);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.ids, [messageId]);
    assert.strictEqual((await room.next((m) => m.type === 'delete-messages' && m.ids.includes(messageId))).type, 'delete-messages');
    assert.strictEqual((await h.db.getChatMessageById(messageId)).is_deleted, 1);
    const received = room.all.filter((m) => m.type === 'delete-messages' && m.ids.includes(messageId)).length;
    assert.deepStrictEqual((await post('moderation', body)).body.ids, [messageId]);
    await h.sleep(300);
    assert.strictEqual(room.all.filter((m) => m.type === 'delete-messages' && m.ids.includes(messageId)).length, received);
    const log = await post('moderation', { key: 'ingress:log:1', action: 'log', action_type: 'ingress_test', actor_user_id: streamer.id, details: { case: 'test' } });
    assert.strictEqual(log.status, 200, log.text);
    assert.ok((await h.db.get('SELECT id FROM moderation_actions WHERE id = ?', [log.body.id])).id);
});

t('moderation handles bulk deletes, pending IP decisions, relay identities and voice overrides', async () => {
    const a = await post('messages', { key: 'ingress:bulk:a', stream_id: streamId, user_id: viewer.id, username: viewer.username, message: 'bulk A' });
    const b = await post('messages', { key: 'ingress:bulk:b', stream_id: streamId, user_id: viewer.id, username: viewer.username, message: 'bulk B' });
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(b.status, 200, b.text);
    const gone = await post('moderation', { key: 'ingress:bulk:delete', action: 'delete-user-messages', user_id: viewer.id, stream_id: streamId, deleted_by: streamer.username });
    assert.strictEqual(gone.status, 200, gone.text);
    assert.ok(gone.body.ids.includes(a.body.id) && gone.body.ids.includes(b.body.id));
    await room.next((m) => m.type === 'delete-messages' && m.ids.includes(a.body.id));

    const ip = '198.51.100.80';
    const pending = await h.db.run('INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, username, message) VALUES (?, ?, ?, ?, ?)', [channelId, streamId, ip, 'waiting', 'let me in']);
    const review = await post('moderation', { key: 'ingress:review:1', action: 'review-pending-ip', id: Number(pending.lastInsertRowid), status: 'denied', channel_id: channelId, reviewed_by: streamer.id });
    assert.strictEqual(review.status, 200, review.text);
    assert.strictEqual((await h.db.get('SELECT status FROM pending_ip_messages WHERE id = ?', [pending.lastInsertRowid])).status, 'denied');
    const pending2 = await h.db.run('INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, username, message) VALUES (?, ?, ?, ?, ?)', [channelId, streamId, ip, 'waiting', 'try again']);
    assert.strictEqual((await post('moderation', { key: 'ingress:approve:1', action: 'approve-ip-messages', channel_id: channelId, ip, reviewed_by: streamer.id })).status, 200);
    assert.strictEqual((await h.db.get('SELECT status FROM pending_ip_messages WHERE id = ?', [pending2.lastInsertRowid])).status, 'approved');

    const hide = await post('moderation', { key: 'ingress:relay:hide', action: 'relay-hide', channel_id: channelId, platform: 'twitch', external_username: 'outside', created_by: streamer.id });
    assert.strictEqual(hide.status, 200, hide.text);
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM hidden_relay_users WHERE external_username = ?', ['outside'])).n, 1);
    assert.strictEqual((await post('moderation', { key: 'ingress:relay:unhide', action: 'relay-unhide', id: hide.body.id })).status, 200);
    assert.strictEqual((await h.db.get('SELECT COUNT(*) AS n FROM hidden_relay_users WHERE external_username = ?', ['outside'])).n, 0);
    const voice = await post('moderation', { key: 'ingress:voice:set', action: 'tts-voice-override', identity_key: 'viewer', params: { voice: 'en-US', pitch: 1, speed: 1, gap: 0 }, set_by: streamer.id });
    assert.strictEqual(voice.status, 200, voice.text);
    assert.strictEqual((await h.db.getTtsVoiceOverride('viewer')).voice, 'en-US');
    assert.strictEqual((await post('moderation', { key: 'ingress:voice:clear', action: 'tts-voice-override', identity_key: 'viewer' })).status, 200);
    assert.strictEqual(await h.db.getTtsVoiceOverride('viewer'), null);
});

t('invalidate accepts typed hints; presence retains the bridge snapshot shape', async () => {
    const hint = { key: 'ingress:hint:1', user: viewer.id, approvals: channelId, bans: true };
    assert.strictEqual((await post('invalidate', hint)).status, 200);
    assert.strictEqual((await post('invalidate', hint)).status, 200);
    const changed = await post('invalidate', { key: 'ingress:hint:user-update', user: viewer.id,
        user_data: { id: viewer.id, username: viewer.username, display_name: 'Renamed Viewer' } });
    assert.strictEqual(changed.status, 200, changed.text);
    assert.strictEqual((await room.next((m) => m.type === 'user-updated' && m.user.display_name === 'Renamed Viewer')).user.id, viewer.id);
    assert.strictEqual((await h.db.get('SELECT username FROM chat_messages WHERE id = ?', [messageId])).username, 'Renamed Viewer');
    assert.strictEqual((await post('invalidate', { key: 'ingress:hint:bad', nonsense: true })).status, 400);
    const r = await h.http('GET', '/internal/chat/presence', { token: h.serviceToken(['chat.presence.read']) });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.total >= 2);
    assert.strictEqual(r.body.streams[streamId], 1);
    assert.ok(r.body.users.some((u) => u.user_id === viewer.id));
    assert.strictEqual((await h.http('GET', '/internal/live/presence', { token: h.serviceToken(['chat.presence.read']) })).status, 200);
});

t('moderation disconnect closes only the selected user socket', async () => {
    const closed = new Promise((resolve) => room.on('close', resolve));
    const r = await post('moderation', { key: 'ingress:disconnect:1', action: 'disconnect', user_id: viewer.id, stream_id: streamId });
    assert.strictEqual(r.status, 200, r.text);
    await Promise.race([closed, h.sleep(3000).then(() => { throw new Error('socket stayed open'); })]);
    assert.strictEqual(globalRoom.readyState, 1);
});

t.run(async () => {
    if (room) room.close();
    if (globalRoom) globalRoom.close();
    if (h) await h.close();
});
