'use strict';
/**
 * /ws/chat protocol parity with Live's chat server, against a stub Live context:
 * anonymous connect → join, anonymous → signed-in upgrade on the same socket, chat into a stream
 * room (delivery, global cross-feed, persistence with the Network subject, outbox, Live's
 * reactions and the coin reply), history, /w (DMs replaced whispers), the DM participant check on
 * delivery, moderation (/ban /timeout /unban /slow /clear with moderator checks), /tts, /paste,
 * !-commands routed to Live (arena reply to the sending socket, media queue), and the upgrade guards
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
    await h.db.addChannelModerator(channelId, mod.id, streamer.id);   // the moderator row is Chat's own (C-04)
    streamId = h.addStream(streamer.id, channelId, { managed: { id: 71, slug: 'main-slot', title: 'Main slot' } });
    await h.ctx.sync();
    assert.ok(await h.ctx.getStreamById(streamId), 'stream projected');
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

t('the pre-admission buffer is capped: 201 early messages close the socket (1008); a few are replayed', async () => {
    const warm = h.ctx.warm;
    h.ctx.warm = async (...a) => { await h.sleep(250); return warm.apply(h.ctx, a); };
    try {
        // 201 messages while the socket is being admitted: the buffer does not grow past the cap.
        const flood = await h.ws({ ip: '198.51.100.90', token: alice.token, stream: streamId });
        const closed = new Promise((r) => flood.on('close', (code) => r(code)));
        for (let i = 0; i < 201; i++) flood.sendJson({ type: 'join', streamId });
        assert.strictEqual(await closed, 1008, 'closed with 1008, not buffered without bound');
        assert.ok(!flood.all.some((m) => m.type === 'auth'), 'never registered');
        // A few messages before admission: still registered, and the buffer is replayed in order.
        const few = await h.ws({ ip: '198.51.100.91', token: mod.token, stream: streamId });
        few.sendJson({ type: 'join', streamId, token: mod.token });
        few.sendJson({ type: 'chat', message: 'from the buffer' });
        const auth = await few.next((m) => m.type === 'auth');
        assert.strictEqual(auth.username, 'Moddy');
        const end = Date.now() + 2000;
        let saved = null;
        for (;;) {
            saved = (await h.http('GET', `/api/chat/${streamId}/history`)).body.messages.find((m) => m.message === 'from the buffer');
            if (saved) break;
            if (Date.now() > end) throw new Error('the buffered chat frame was not replayed');
            await h.sleep(20);
        }
        assert.strictEqual(saved.core_username, 'moddy', 'the early chat frame was replayed once admitted');
        few.close();
    } finally { h.ctx.warm = warm; }
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
    const row = await h.db.getChatMessageById(msgId);
    assert.strictEqual(row.user_id, alice.id);
    assert.strictEqual(row.channel_user_id, streamer.id);
    assert.strictEqual(row.subject_id, 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA');
    // Outbox envelope in the same transaction.
    const ev = (await h.db.all("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'chat.message.created'")).map((r) => r.envelope).find((e) => e.payload.message_id === msgId);
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

t('a message that could not be saved is not broadcast; the sender is told', async () => {
    const orig = h.db.saveChatMessage;
    h.db.saveChatMessage = () => { throw new Error('disk full'); };
    try {
        bobWs.sendJson({ type: 'chat', message: 'ghost line' });   // bob has not spoken yet (no rate limit)
        const err = await bobWs.next((m) => m.type === 'error' && /could not be sent/.test(m.message));
        assert.ok(err);
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(!aliceWs.all.some((m) => m.type === 'chat' && m.message === 'ghost line'), 'nobody else received it');
    } finally { h.db.saveChatMessage = orig; }
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
    await h.chatServer.sendDm(eve.id, { type: 'dm', conversation_id: convId, message: { message: 'leak' } });
    assert.ok(await eveWs.none((m) => m.type === 'dm'), 'participant check held');
    assert.strictEqual((await h.http('GET', `/api/dm/conversations/${convId}/messages`, { token: eve.token })).status, 403);
    // Offline notification went to Live; the DM event is subject-scoped and carries no text.
    assert.ok(h.live.effects.some((e) => e.name === 'notify/dm' && e.body.recipient_ids.includes(bob.id)));
    const ev = (await h.db.all("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'chat.dm.created'")).map((r) => r.envelope).pop();
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
    // /slow: slowmode event + system line to the room, persisted in Chat's own settings row (C-04).
    // It applies to viewers; the room's moderators keep only the 1 s flood limit (the check runs
    // before commands, so a slowed moderator could not even turn it off).
    await h.sleep(1100);
    modWs.sendJson({ type: 'chat', message: '/slow 5' });
    assert.strictEqual((await aliceWs.next((m) => m.type === 'slowmode')).seconds, 5);
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Slow mode enabled: 5s between messages');
    await h.sleep(100);
    assert.strictEqual((await h.ctx.getChannelModerationSettings(channelId)).slow_mode_seconds, 5, 'saved on Chat’s own row');
    assert.strictEqual((await h.chatServer.slowModeByStream()).get(streamId), 5000);
    // Every action is logged (and announced as an internal moderation event).
    const actions = (await h.db.all('SELECT action_type FROM moderation_actions ORDER BY id')).map((r) => r.action_type);
    for (const a of ['channel_ban', 'channel_unban', 'channel_timeout', 'slowmode_update', 'clear_chat']) assert.ok(actions.includes(a), a);
    const modEv = (await h.db.all("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'chat.moderation.action'")).map((r) => r.envelope);
    assert.ok(modEv.length >= 5 && modEv.every((e) => e.visibility === 'internal'));
    aliceWs.sendJson({ type: 'chat', message: 'slow one' });
    await bobWs.next((m) => m.type === 'chat' && m.message === 'slow one');
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: 'slow two' });
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Slow down! You are sending messages too fast.');
    assert.ok(await bobWs.none((m) => m.type === 'chat' && m.message === 'slow two'), 'a viewer is slowed');
    // The moderator, 1.1 s after /slow 5 (inside the 5 s window), is not.
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

t('/paste creates the paste through Live and announces the Community link', async () => {
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '/paste const x = 1;' });
    const m = await bobWs.next((x) => x.type === 'system' && /shared a paste/.test(x.message));
    assert.strictEqual(m.message, `📋 Anonymous shared a paste: ${require('../server/config').web.communityUrl}/p/abc123`);
    const fx = h.live.effects.find((e) => e.name === 'paste');
    assert.strictEqual(fx.body.content, 'const x = 1;');
    assert.strictEqual(fx.body.user_id, alice.id);
    assert.strictEqual(fx.body.stream_id, streamId);
});

t('!hype goes to Live with the socket’s conn_id; sendToConn answers that socket', async () => {
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!hype' });
    await h.sleep(200);
    const fx = h.live.effects.find((e) => e.name === 'arena-command');
    assert.strictEqual(fx.body.cmd, '!hype');
    assert.strictEqual(fx.body.client.user.id, alice.id);
    h.chatServer.sendToConn(fx.body.client.conn_id, { type: 'system', message: 'Hyped!' });
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Hyped!');
});

t('arena replies returned by the effect reach the sender through Chat’s ingress', async () => {
    await h.sleep(1100);
    h.live.arenaReplies = [{ type: 'system', message: 'Ingress hyped!' }];
    try {
        aliceWs.sendJson({ type: 'chat', message: '!beef' });
        const m = await aliceWs.next((x) => x.type === 'system' && x.message === 'Ingress hyped!');
        assert.strictEqual(m.message, 'Ingress hyped!');
        const fx = h.live.effects.filter((e) => e.name === 'arena-command').pop();
        assert.strictEqual(fx.body.cmd, '!beef');
    } finally { h.live.arenaReplies = null; }
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
    // The robot command goes to Live with the viewer's Network subject (Live forwards it to OpenVibe.Bot as them),
    // and Live's refusal is shown to the viewer as it said it.
    await aliceWs.next((x) => x.type === 'system' && x.message === `No robot here (asked as usr_01J9AAAAAAAAAAAAAAAAAAAAAA, user ${alice.id}).`);
});

t('Bench votes reach Live once with signed-in viewer and stream ids', async () => {
    await h.sleep(1100);
    // Bob is still timed out by the moderation test. Use a viewer with no moderation history.
    const viewer = h.addUser('benchvoter');
    await h.ctx.sync();
    const viewerWs = await h.ws({ ip: '198.51.100.75', token: viewer.token, stream: streamId });
    try {
        viewerWs.sendJson({ type: 'join', streamId, token: viewer.token });
        await viewerWs.next((m) => m.type === 'auth');
        const before = h.live.effects.length;
        aliceWs.sendJson({ type: 'chat', message: '!1' });
        await aliceWs.next((x) => x.type === 'system' && x.message === 'Your Bench vote is counted.');
        viewerWs.sendJson({ type: 'chat', message: '!tie' });
        await viewerWs.next((x) => x.type === 'system' && x.message === 'Your Bench vote is counted.');
        assert.deepStrictEqual(h.live.effects.slice(before).filter((e) => e.name === 'bench-vote').map((e) => e.body), [
            { stream_id: streamId, viewer_user_id: alice.id, choice: 'left' },
            { stream_id: streamId, viewer_user_id: viewer.id, choice: 'tie' },
        ]);
    } finally { viewerWs.close(); }
});

t('a !word that is not a channel sound is pressed as the robot button of that name, quietly', async () => {
    await h.sleep(1100);
    const before = h.live.effects.length;
    const hardware = () => h.live.effects.slice(before).filter((e) => e.name === 'hardware');
    const seen = aliceWs.all.length;
    aliceWs.sendJson({ type: 'chat', message: '!ir_light' });
    const deadline = Date.now() + 5000;
    while (!hardware().length && Date.now() < deadline) await h.sleep(50);
    assert.deepStrictEqual(hardware().map((e) => [e.body.command, e.body.from_subject, e.body.from_user_id]), [['button:ir_light', 'usr_01J9AAAAAAAAAAAAAAAAAAAAAA', alice.id]]);
    // Live's "no robot" is not said: most channels have no robot and most words are no button.
    await h.sleep(300);
    assert.ok(!aliceWs.all.slice(seen).some((m) => m.type === 'system' && /No robot here/.test(m.message)));
    // Not a plain word, or a viewer who is not signed in: nothing is asked.
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: '!Not/A_Button' });
    const anon = await h.ws({ ip: '198.51.100.71', stream: streamId });
    anon.sendJson({ type: 'join', streamId });
    await anon.next((m) => m.type === 'auth');
    anon.sendJson({ type: 'chat', message: '!cycle_gear' });
    await h.sleep(600);
    assert.strictEqual(hardware().length, 1);
    anon.close();
});

t('a token in the socket address is not read, and the socket says how to send it', async () => {
    const ws = await h.ws({ ip: '198.51.100.72', query: `?token=${alice.token}` });
    const told = await ws.next((m) => m.type === 'system' && m.code === 'token_in_url');
    assert.match(told.message, /Authorization: Bearer/);
    assert.ok(!told.message.includes(alice.token), 'the token is never echoed');
    ws.sendJson({ type: 'join' });
    assert.strictEqual((await ws.next((m) => m.type === 'auth')).authenticated, false, 'still anonymous');
    ws.close();
    const fine = await h.ws({ ip: '198.51.100.73', token: alice.token });
    fine.sendJson({ type: 'join' });
    assert.strictEqual((await fine.next((m) => m.type === 'auth')).authenticated, true);
    assert.ok(await fine.none((m) => m.code === 'token_in_url'), 'a header token gets no notice');
    fine.close();
});

t('upgrade guards: foreign origin refused, banned address refused (admins exempt)', async () => {
    assert.strictEqual(await h.wsRefused({ origin: 'https://evil.example' }), true);
    h.live.addBan({ ip_address: '192.0.2.0/24' });
    await h.ctx.invalidateBans();
    assert.strictEqual(await h.wsRefused({ ip: '192.0.2.55' }), true, 'CIDR network ban');
    assert.strictEqual(await h.wsRefused({ ip: '192.0.2.56', token: admin.token }), false, 'admin passes');
    // A browser cannot show its token before this check: the session cookie exempts it (identity still comes from the join).
    assert.strictEqual(await h.wsRefused({ ip: '192.0.2.57', cookie: `ov_token=${admin.token}` }), false, 'admin passes with the session cookie');
    assert.strictEqual(await h.wsRefused({ ip: '192.0.2.58', cookie: `token=${admin.token}` }), true, "Live's legacy cookie does not exempt");
    // And REST from a banned network (through Cloudflare: the hop before nginx is a Cloudflare edge).
    const r = await h.http('GET', '/api/chat/global/history', { headers: { 'X-Forwarded-For': '192.0.2.9, 104.16.0.1' } });
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

t('a channel-only WebSocket line records the first chat for that channel', async () => {
    // An offline/PowerChat channel room has no streamId, only channelUserId. The save itself must
    // record the welcome there too, or Live's first-chat read would answer true forever.
    const carol = h.addUser('carol');
    await h.ctx.sync();
    const ws = await h.ws({ ip: '198.51.100.61', token: carol.token });
    ws.sendJson({ type: 'join', channelUserId: streamer.id, token: carol.token });
    await ws.next((m) => m.type === 'auth');
    const identity = `user:${carol.id}`;
    assert.strictEqual(await h.db.isFirstChatInChannel(identity, streamer.id), true, 'carol has not chatted in the channel');
    ws.sendJson({ type: 'chat', message: 'offline channel line' });
    await ws.next((m) => m.type === 'chat' && m.message === 'offline channel line');
    assert.strictEqual(await h.db.isFirstChatInChannel(identity, streamer.id), false, 'the channel-only save recorded it');
    ws.close();
});

t('the same line again and again is refused after three in 30 s (punctuation counts as one line); a new line, a command and a moderator are not', async () => {
    const dana = h.addUser('dana');
    await h.ctx.sync();
    const ws = await h.ws({ ip: '198.51.100.62', token: dana.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: dana.token });
    await ws.next((m) => m.type === 'auth');
    // ".", ".." and "..." are the same line to the guard: three go through, the fourth does not.
    for (const line of ['.', '..', '...']) {
        ws.sendJson({ type: 'chat', message: line });
        await aliceWs.next((m) => m.type === 'chat' && m.message === line);
        await h.sleep(1100);
    }
    const dots = () => aliceWs.all.filter((m) => m.type === 'chat' && m.message === '.' && m.core_username === 'dana').length;
    const before = dots();
    ws.sendJson({ type: 'chat', message: '.' });
    await ws.next((m) => m.type === 'system' && m.message === 'You already said that. Try something new.');
    await h.sleep(300);
    assert.strictEqual(dots(), before, 'the fourth is not delivered');
    await h.sleep(1100);
    ws.sendJson({ type: 'chat', message: 'something new' });
    await aliceWs.next((m) => m.type === 'chat' && m.message === 'something new');
    ws.close();

    // The rules on their own: case and spacing do not make a new line; commands never count; the window moves on.
    const cs = h.chatServer;
    const t0 = 1_000_000;
    assert.deepStrictEqual(['Hi', 'hi ', 'HI', 'hi'].map((x, i) => cs._repeats('k1', x, t0 + i)), [false, false, false, true]);
    assert.strictEqual(cs._repeats('k1', 'hi', t0 + 31_000), false, 'thirty seconds later it may be said again');
    assert.ok([1, 2, 3, 4, 5].every((i) => cs._repeats('k2', '!forward', t0 + i) === false), 'a robot driver repeats its commands');
    assert.ok(['😂', '😂', '😂'].every((x, i) => cs._repeats('k3', x, t0 + i) === false) && cs._repeats('k3', '😂', t0 + 9) === true, 'an emoji is a line of its own');
    assert.strictEqual(cs._repeats('k3', '.', t0 + 10), false, 'punctuation is not the emoji');

    // The room's moderators may repeat themselves.
    const mws = await h.ws({ ip: '198.51.100.63', token: mod.token, stream: streamId });
    mws.sendJson({ type: 'join', streamId, token: mod.token });
    await mws.next((m) => m.type === 'auth');
    for (let i = 0; i < 4; i++) {
        mws.sendJson({ type: 'chat', message: 'raid incoming' });
        await aliceWs.next((m) => m.type === 'chat' && m.message === 'raid incoming');
        await h.sleep(1100);
    }
    mws.close();
});

t('a new Go Live moves sockets left on the channel\'s ended stream onto the new one, and says so', async () => {
    const gus = h.addUser('gus', { role: 'streamer' });
    const gusChannel = h.addChannel(gus.id);
    const slot = { id: 81, slug: 'gus-main', title: 'Main' };
    const first = h.addStream(gus.id, gusChannel, { managed: slot });
    const other = h.addStream(gus.id, gusChannel, { managed: { id: 82, slug: 'gus-two', title: 'Second' } });
    await h.ctx.sync();
    const join = async (ip, stream) => {
        const ws = await h.ws({ ip, token: bob.token, stream });
        ws.sendJson({ type: 'join', streamId: stream, token: bob.token });
        await ws.next((m) => m.type === 'auth');
        return ws;
    };
    const bot = await join('198.51.100.74', first);
    const secondSlot = await join('198.51.100.75', other);
    // The first session ends; the same slot goes live again with a new stream id.
    h.live.streams.get(first).is_live = 0;
    const second = h.addStream(gus.id, gusChannel, { managed: slot });
    await h.ctx.sync();
    const told = await bot.next((m) => m.type === 'stream_changed');
    assert.deepStrictEqual([told.stream_id, told.previous_stream_id, told.channel_user_id], [second, first, gus.id]);
    const client = [...h.chatServer.clients.values()].find((c) => c.ip && c.ip.endsWith('100.74'));
    assert.strictEqual(client.streamId, second, 'now in the new stream\'s room');
    assert.ok(await secondSlot.none((m) => m.type === 'stream_changed'), 'a still-live second slot keeps its viewers');
    bot.close(); secondSlot.close();
});

t.run(async () => { for (const w of [aliceWs, bobWs, globalWs]) { try { w.close(); } catch { /* */ } } if (h) await h.close(); });
