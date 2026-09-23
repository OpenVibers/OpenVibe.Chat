'use strict';
/**
 * /ws/chat protocol parity with Live's chat server, against a stub Live context:
 * anonymous connect → join, anonymous → signed-in upgrade on the same socket, chat into a stream
 * room (delivery, global cross-feed, persistence with the Network subject, outbox, Live's
 * reactions and the coin reply), history, /w (DMs replaced whispers), the DM participant check on
 * delivery, moderation (/ban /timeout /unban /slow /clear with moderator checks), /tts, /paste,
 * !-commands routed to Live (arena reply through the bridge, media queue), and the upgrade guards
 * (origin allow-list, IP bans, the per-address cap).
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('ws-protocol');
let h, streamer, mod, alice, bob, admin, channelId, streamId;

t('boot Chat against a stub Live', async () => {
    h = await boot();
    streamer = h.addUser('streamer', { role: 'streamer' });
    mod = h.addUser('moddy');
    alice = h.addUser('alice', { subject: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
    bob = h.addUser('bob');
    admin = h.addUser('boss', { role: 'admin' });
    channelId = h.addChannel(streamer.id, { moderators: [mod.id] });
    streamId = h.addStream(streamer.id, channelId, { managed: { id: 71, slug: 'main-slot', title: 'Main slot' } });
    await h.ctx.sync();
    assert.ok(h.ctx.getStreamById(streamId), 'stream projected');
});

t('anonymous connect, join global → auth as an anon number from Live', async () => {
    const ws = await h.ws({ ip: '198.51.100.7' });
    ws.sendJson({ type: 'join' });
    const auth = await ws.next((m) => m.type === 'auth');
    assert.strictEqual(auth.authenticated, false);
    assert.match(auth.username, /^anon\d+$/);
    assert.strictEqual(auth.role, 'anon');
    assert.strictEqual(auth.channel_language, 'en');
    assert.ok(h.live.effects.some((e) => e.name === 'anon' && e.body.ip === '198.51.100.7'), 'Live allocated the anon number');
    // Same address, same number (cached, one allocation).
    const ws2 = await h.ws({ ip: '198.51.100.7' });
    ws2.sendJson({ type: 'join' });
    assert.strictEqual((await ws2.next((m) => m.type === 'auth')).username, auth.username);
    assert.strictEqual(h.live.effects.filter((e) => e.name === 'anon' && e.body.ip === '198.51.100.7').length, 1);
    ws.close(); ws2.close();
});

t('anonymous socket upgrades to signed-in on join with a token', async () => {
    const ws = await h.ws({ ip: '198.51.100.8' });
    ws.sendJson({ type: 'join', streamId });
    assert.strictEqual((await ws.next((m) => m.type === 'auth')).authenticated, false);
    ws.sendJson({ type: 'join', streamId, token: alice.token });
    const auth = await ws.next((m) => m.type === 'auth');
    assert.strictEqual(auth.authenticated, true);
    assert.strictEqual(auth.username, 'Alice');
    assert.strictEqual(auth.core_username, 'alice');
    assert.strictEqual(auth.user_id, alice.id);
    assert.strictEqual(auth.role, 'user');
    // A different account's token on the same socket is ignored (account switch rebuilds the socket).
    ws.sendJson({ type: 'join', streamId, token: bob.token });
    assert.strictEqual((await ws.next((m) => m.type === 'auth')).user_id, alice.id);
    ws.close();
});

let aliceWs, bobWs, globalWs, msgId;
t('chat into a stream room: room delivery, global cross-feed, persistence, outbox, Live reactions', async () => {
    aliceWs = await h.ws({ ip: '198.51.100.20', token: alice.token, stream: streamId });
    aliceWs.sendJson({ type: 'join', streamId, token: alice.token });
    await aliceWs.next((m) => m.type === 'auth');
    bobWs = await h.ws({ ip: '198.51.100.21', token: bob.token, stream: streamId });
    bobWs.sendJson({ type: 'join', streamId, token: bob.token });
    await bobWs.next((m) => m.type === 'auth');
    globalWs = await h.ws({ ip: '198.51.100.22' });
    globalWs.sendJson({ type: 'join' });
    await globalWs.next((m) => m.type === 'auth');

    aliceWs.sendJson({ type: 'chat', message: 'hello stream' });
    const got = await bobWs.next((m) => m.type === 'chat' && m.message === 'hello stream');
    assert.strictEqual(got.username, 'Alice');
    assert.strictEqual(got.core_username, 'alice');
    assert.strictEqual(got.user_id, alice.id);
    assert.strictEqual(got.stream_id, streamId);
    assert.strictEqual(got.channel_user_id, streamer.id);
    assert.strictEqual(got.is_global, false);
    assert.ok(Number.isInteger(got.id));
    msgId = got.id;
    const cross = await globalWs.next((m) => m.type === 'chat' && m.message === 'hello stream');
    assert.strictEqual(cross.stream_channel, 'streamer');
    assert.strictEqual(cross.source_slug, 'main-slot');
    assert.strictEqual(cross.source_stream_title, 'Main slot');
    // First chat in the channel → welcome line to the room.
    await bobWs.next((m) => m.type === 'system' && /^Welcome Alice to the chat!/.test(m.message));
    // Persisted with Live's ids and the Network subject.
    const row = h.db.getChatMessageById(msgId);
    assert.strictEqual(row.user_id, alice.id);
    assert.strictEqual(row.channel_user_id, streamer.id);
    assert.strictEqual(row.subject_id, 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA');
    // Outbox envelope in the same transaction.
    const ev = h.db.all("SELECT event FROM events_outbox WHERE event_type = 'chat.message.created'").map((r) => JSON.parse(r.event)).find((e) => e.payload.message_id === msgId);
    assert.ok(ev, 'chat.message.created in the outbox');
    assert.strictEqual(ev.visibility, 'public');
    assert.deepStrictEqual(ev.actor, { type: 'user', id: 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA' });
    assert.strictEqual(ev.source, 'chat');
    // One call to Live for the reactions; the coin reply comes back to the sender.
    const coin = await aliceWs.next((m) => m.type === 'coin_earned');
    assert.strictEqual(coin.reason, 'Chat bonus');
    const reaction = h.live.effects.find((e) => e.name === 'chat-message' && e.body.msg_id === msgId);
    assert.ok(reaction && reaction.body.award && reaction.body.ai && reaction.body.powerchat);
    assert.strictEqual(reaction.body.powerchat_chat.externalChatterId, `u${alice.id}`);
});

t('stream history and channel history return the message like Live did', async () => {
    const hist = await h.http('GET', `/api/chat/${streamId}/history`);
    assert.strictEqual(hist.status, 200);
    const m = hist.body.messages.find((x) => x.id === msgId);
    assert.ok(m);
    assert.strictEqual(m.core_username, 'alice');
    assert.strictEqual(m.source_channel, 'streamer');
    assert.strictEqual(m.source_slug, 'main-slot');
    assert.ok(!('subject_id' in m), 'Chat-internal columns stay internal');
    assert.strictEqual(hist.body.channel, 'streamer');
    assert.strictEqual(hist.body.activeStreamId, streamId);
    const delta = await h.http('GET', `/api/chat/${streamId}/history?after_id=${msgId - 1}`);
    assert.strictEqual(delta.body.complete, true);
    assert.strictEqual(delta.body.messages[0].id, msgId);
    const ch = await h.http('GET', `/api/chat/channel/${streamer.id}/history`);
    assert.ok(ch.body.messages.some((x) => x.id === msgId));
    assert.strictEqual(ch.body.channel, 'streamer');
    assert.strictEqual(ch.body.latest_id >= msgId, true);
    const users = await h.http('GET', `/api/chat/${streamId}/users`);
    assert.strictEqual(users.body.count, 2, 'two addresses in the stream room');
});

t('/w and /whisper answer that DMs replaced whispers', async () => {
    await h.sleep(1100); // chat rate limit (1 message per second per address and room)
    aliceWs.sendJson({ type: 'chat', message: '/w bob hi' });
    const m = await aliceWs.next((x) => x.type === 'system' && /Whispers have been replaced by DMs/.test(x.message)).catch((e) => { console.log(JSON.stringify(aliceWs.all)); throw e; });
    assert.ok(m);
});

t('DM delivery keeps the participant check (REST send → live socket; a non-participant gets nothing)', async () => {
    const created = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(created.status, 200, created.text);
    const convId = created.body.conversation.id;
    assert.deepStrictEqual(created.body.conversation.participants.map((p) => p.id).sort(), [alice.id, bob.id].sort());
    const sent = await h.http('POST', `/api/dm/conversations/${convId}/messages`, { token: alice.token, body: { message: 'secret hello' } });
    assert.strictEqual(sent.status, 200, sent.text);
    assert.ok(!('sender_subject_id' in sent.body.message));
    const dm = await bobWs.next((m) => m.type === 'dm');
    assert.strictEqual(dm.conversation_id, convId);
    assert.strictEqual(dm.message.message, 'secret hello');
    assert.ok(await aliceWs.none((m) => m.type === 'dm'), 'the sender is not echoed');
    // chatServer.sendDm is guarded by dm.isParticipant: a non-participant never receives it.
    const eve = h.addUser('eve');
    await h.ctx.sync();
    const eveWs = await h.ws({ ip: '198.51.100.30', token: eve.token });
    eveWs.sendJson({ type: 'join', token: eve.token });
    await eveWs.next((m) => m.type === 'auth');
    h.chatServer.sendDm(eve.id, { type: 'dm', conversation_id: convId, message: { message: 'leak' } });
    assert.ok(await eveWs.none((m) => m.type === 'dm'), 'participant check held');
    assert.strictEqual((await h.http('GET', `/api/dm/conversations/${convId}/messages`, { token: eve.token })).status, 403);
    // Offline notification went to Live; the DM event is subject-scoped and carries no text.
    assert.ok(h.live.effects.some((e) => e.name === 'notify/dm' && e.body.recipient_ids.includes(bob.id)));
    const ev = h.db.all("SELECT event FROM events_outbox WHERE event_type = 'chat.dm.created'").map((r) => JSON.parse(r.event)).pop();
    assert.strictEqual(ev.visibility, 'subject');
    assert.ok(!JSON.stringify(ev).includes('secret hello'), 'no DM text in the event');
    eveWs.close();
});

t('moderation: only moderators; /ban goes to Live and takes effect at once', async () => {
    bobWs.sendJson({ type: 'chat', message: '/ban alice' });
    assert.ok(await bobWs.next((m) => m.type === 'system' && m.message === 'You do not have permission.'));
    const modWs = await h.ws({ ip: '198.51.100.40', token: mod.token, stream: streamId });
    modWs.sendJson({ type: 'join', streamId, token: mod.token });
    await modWs.next((m) => m.type === 'auth');
    modWs.sendJson({ type: 'chat', message: '/ban bob' });
    await modWs.next((m) => m.type === 'system' && m.message === 'bob has been banned.');
    const banFx = h.live.effects.find((e) => e.name === 'ban' && e.body.user_id === bob.id);
    assert.strictEqual(banFx.body.actor_user_id, mod.id);
    assert.strictEqual(banFx.body.moderation_stream_id, streamId);
    assert.strictEqual(banFx.body.stream_id, streamId);
    await bobWs.next((m) => m.type === 'system' && m.message === 'bob has been banned.');
    await h.sleep(1100); // chat rate limit (1 msg/s per address+room)
    bobWs.sendJson({ type: 'chat', message: 'am I banned?' });
    await bobWs.next((m) => m.type === 'system' && m.message === 'You are banned from this chat.');
    // A moderator cannot ban an admin.
    await h.sleep(1100);
    modWs.sendJson({ type: 'chat', message: '/ban boss' });
    await modWs.next((m) => m.type === 'system' && m.message === 'You cannot ban an admin.');
    // /unban lifts it.
    await h.sleep(1100);
    modWs.sendJson({ type: 'chat', message: '/unban bob' });
    await modWs.next((m) => m.type === 'system' && m.message === 'bob has been unbanned.');
    await h.sleep(1100);
    bobWs.sendJson({ type: 'chat', message: 'back again' });
    await aliceWs.next((m) => m.type === 'chat' && m.message === 'back again');
    // /timeout writes an expiring ban.
    await h.sleep(1100);
    modWs.sendJson({ type: 'chat', message: '/timeout bob 60' });
    await modWs.next((m) => m.type === 'system' && m.message === 'bob timed out for 60s.');
    const to = h.live.effects.filter((e) => e.name === 'ban' && e.body.user_id === bob.id).pop();
    assert.strictEqual(to.body.reason, 'Timeout 60s');
    assert.ok(to.body.expires_at);
    // /clear
    await h.sleep(1100);
    modWs.sendJson({ type: 'chat', message: '/clear' });
    await aliceWs.next((m) => m.type === 'clear');
    // /slow: slowmode event + system line to the room, persisted through Live (it applies to
    // everyone's next message, moderators included — Live's rate limit runs before commands).
    await h.sleep(1100);
    modWs.sendJson({ type: 'chat', message: '/slow 5' });
    assert.strictEqual((await aliceWs.next((m) => m.type === 'slowmode')).seconds, 5);
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Slow mode enabled: 5s between messages');
    await h.sleep(100);
    assert.ok(h.live.effects.some((e) => e.name === 'channel-settings' && e.body.fields.slow_mode_seconds === 5 && e.body.actor_user_id === mod.id));
    assert.strictEqual(h.chatServer.slowModeByStream.get(streamId), 5000);
    // Every action is logged (and announced as an internal moderation event).
    const actions = h.db.all('SELECT action_type FROM moderation_actions ORDER BY id').map((r) => r.action_type);
    for (const a of ['channel_ban', 'channel_unban', 'channel_timeout', 'slowmode_update', 'clear_chat']) assert.ok(actions.includes(a), a);
    const modEv = h.db.all("SELECT event FROM events_outbox WHERE event_type = 'chat.moderation.action'").map((r) => JSON.parse(r.event));
    assert.ok(modEv.length >= 5 && modEv.every((e) => e.visibility === 'internal'));
    await h.sleep(5100);
    modWs.sendJson({ type: 'chat', message: '/slow off' });
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Slow mode disabled.').catch((e) => { console.log('MOD', JSON.stringify(modWs.all.slice(-6))); throw e; });
    modWs.close();
});

t('/tts broadcasts the line to the room', async () => {
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '/tts hello voice' });
    const m = await bobWs.next((x) => x.type === 'tts');
    assert.strictEqual(m.message, 'hello voice');
    assert.strictEqual(m.core_username, 'alice');
});

t('/paste creates the paste through Live and announces it', async () => {
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '/paste const x = 1;' });
    const m = await bobWs.next((x) => x.type === 'system' && /shared a paste/.test(x.message));
    assert.strictEqual(m.message, '📋 Anonymous shared a paste: https://openvibe.live/p/abc123');
    const fx = h.live.effects.find((e) => e.name === 'paste');
    assert.strictEqual(fx.body.content, 'const x = 1;');
    assert.strictEqual(fx.body.user_id, alice.id);
    assert.strictEqual(fx.body.stream_id, streamId);
});

t('!hype goes to Live; Live answers this socket through the bridge (sendToConn)', async () => {
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!hype' });
    await h.sleep(200);
    const fx = h.live.effects.find((e) => e.name === 'arena-command');
    assert.strictEqual(fx.body.cmd, '!hype');
    assert.strictEqual(fx.body.client.user.id, alice.id);
    const res = await h.http('POST', '/internal/live/calls', { token: h.serviceToken(['chat.live_bridge.write']), body: { boot: 'b1', ops: [{ seq: 1, op: 'sendToConn', args: [fx.body.client.conn_id, { type: 'system', message: 'Hyped!' }] }] } });
    assert.strictEqual(res.status, 200);
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Hyped!');
});

t('media commands go to Live’s queue with the same replies', async () => {
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!sr https://youtu.be/x' });
    const m = await bobWs.next((x) => x.type === 'system' && /added/.test(x.message));
    assert.strictEqual(m.message, 'Alice added “A Video” (1m5s) to the media queue for 25 gold.');
    await aliceWs.next((x) => x.type === 'coin_earned' && x.reason === 'Media request purchase');
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!queue' });
    await aliceWs.next((x) => x.type === 'system' && /^The media queue is empty/.test(x.message));
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!skip' });
    await aliceWs.next((x) => x.type === 'system' && x.message === 'Only the streamer or a moderator can skip media.');
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!forward' });
    await aliceWs.next((x) => x.type === 'system' && x.message === 'No hardware client connected.');
});

t('upgrade guards: foreign origin refused, banned address refused (admins exempt)', async () => {
    assert.strictEqual(await h.wsRefused({ origin: 'https://evil.example' }), true);
    h.live.addBan({ ip_address: '192.0.2.0/24' });
    await h.ctx.invalidateBans();
    assert.strictEqual(await h.wsRefused({ ip: '192.0.2.55' }), true, 'CIDR network ban');
    assert.strictEqual(await h.wsRefused({ ip: '192.0.2.56', token: admin.token }), false, 'admin passes');
    // And REST from a banned network.
    const r = await h.http('GET', '/api/chat/global/history', { headers: { 'X-Forwarded-For': '192.0.2.9, 10.0.0.1' } });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.body, { error: 'Access denied' });
    h.live.clearBans();
    await h.ctx.invalidateBans();
});

t('messages sent before the connection is ready are handled in order', async () => {
    const ws = await h.ws({ ip: '198.51.100.60', token: bob.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: bob.token });
    ws.sendJson({ type: 'chat', message: 'right after join' });
    await ws.next((m) => m.type === 'auth');
    await aliceWs.next((m) => m.type === 'chat' && m.message === 'right after join');
    ws.close();
});

t.run(async () => { for (const w of [aliceWs, bobWs, globalWs]) { try { w.close(); } catch { /* */ } } if (h) await h.close(); });
