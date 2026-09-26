'use strict';
/**
 * Chat parity (roadmap WS-I task 6). scripts/parity.js's scenarios (join, send, DM, /tts,
 * soundboard, ban, timeout, purge, slow mode, sub-only mode, the popout, reconnect convergence for
 * deleted and blocked messages) run here against Chat booted with stubs, with two or three people
 * connected, each from their own address: the same code the CLI runs against a running Chat. Alice
 * (A) holds an active subscription to the channel (the stub Live's GET /subscriber); the driver sets
 * network blocks itself (network.block.changed, as the Events consumer applies it).
 *
 * On top, what only a test can reach: Live's moderator paths through the bridge (the context-menu
 * ban that disconnects, the single-message delete) and the global feed's cursor read (Live's
 * floating widget, openvibe.chat), sub-only failing closed when Live cannot be asked, slow mode as
 * the saved setting (a restart of every cache, the dashboard's value), /clear's answer, blocks
 * leaving moderation logs and DMs as they were, the DM participant rule on delivery, and the CLI
 * itself: its dry run touches nothing, and --apply refuses to run for an account that is not a
 * named test account. Every scenario must pass here: none is a gap or a skip. The matrix is printed
 * at the end.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const parity = require('../scripts/parity');

const t = suite('parity');
let h, p, streamer, mod, alice, bob, dave, channelId, streamId;
const IPS = { a: '198.51.100.101', b: '198.51.100.102', mod: '198.51.100.103', streamer: '198.51.100.104', anon: '198.51.100.105', dave: '198.51.100.106' };
const results = [];
let bridgeSeq = 0;
let blockRev = 0;
const bridge = (ops) => h.http('POST', '/internal/live/calls', {
    token: h.serviceToken(['chat.live_bridge.write', 'chat.message.send']),
    body: { boot: 'parity-live', ops: ops.map((o) => ({ seq: ++bridgeSeq, ...o })) },
});

/** 8 kHz 8-bit mono WAV of `seconds`. */
function wav(seconds) {
    const n = Math.floor(8000 * seconds);
    const b = Buffer.alloc(44 + n);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
    b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
    b.fill(128, 44);
    return b;
}

// Each role's sockets come from its own address (through nginx: CF-Connecting-IP).
const driver = {
    address: (role) => IPS[role],
    connect: ({ role, stream }) => h.ws({ ip: IPS[role], stream }),
    http: (method, path, { token, body } = {}) => h.http(method, path, { token, body }),
    // A network block, as the Events consumer applies network.block.changed.
    block: (blocker, blocked, active) => {
        const subject = { a: alice, b: bob, mod, streamer }[blocker].subject_id, target = { a: alice, b: bob, mod, streamer }[blocked].subject_id;
        require('../server/chat/network-blocks').apply({ blocker: subject, blocked: target, active, revision: ++blockRev });
    },
};

t('boot: a channel with a moderator, a live stream, a channel sound, TTS that synthesizes', async () => {
    h = await boot();
    streamer = h.addUser('streamer', { role: 'streamer', subject: 'usr_01J9PAR1TY00000000000000S1' });
    mod = h.addUser('moddy', { subject: 'usr_01J9PAR1TY00000000000000M1' });
    alice = h.addUser('alice', { subject: 'usr_01J9PAR1TY00000000000000A1' });
    bob = h.addUser('bob', { subject: 'usr_01J9PAR1TY00000000000000B1' });
    dave = h.addUser('dave');
    channelId = h.addChannel(streamer.id, { moderators: [mod.id] });
    streamId = h.addStream(streamer.id, channelId);
    h.live.subscribers.add(`${alice.id}|${streamer.id}`);   // A subscribes to the channel; B does not
    await h.ctx.sync();
    // TTS without an engine: every utterance is 0.2 s of silence.
    const tts = require('../server/chat/tts-engine');
    const fake = async (text) => ({ audio: wav(0.2).toString('base64'), mimeType: 'audio/wav', engine: 'test', voiceName: 'test', voiceId: 'test', text });
    tts.synthesize = fake;
    tts.synthesizeUserVoice = fake;
    // The streamer's [+] modal uploads a channel sound (converted to MP3).
    const fd = new FormData();
    fd.append('command', '!honk'); fd.append('channel_id', String(streamer.id));
    fd.append('sound', new Blob([wav(0.4)], { type: 'audio/wav' }), 'honk.wav');
    const up = await fetch(`${h.base}/api/sounds`, { method: 'POST', headers: { Authorization: `Bearer ${streamer.token}` }, body: fd });
    assert.strictEqual(up.status, 200, await up.text());
    p = new parity.Parity({
        driver, streamId, sound: 'honk',
        tokens: { a: alice.token, b: bob.token, mod: mod.token, streamer: streamer.token },
        testAccounts: ['alice', 'bob', 'moddy', 'streamer'],
        subscriber: 'a',
    });
    await p.resolve();
    assert.deepStrictEqual(Object.fromEntries(Object.entries(p.users).map(([r, u]) => [r, u.id])), { a: alice.id, b: bob.id, mod: mod.id, streamer: streamer.id });
    assert.strictEqual(p.owner, 'streamer');
    assert.strictEqual(p.ownerId, streamer.id);
    assert.deepStrictEqual(p.untested(), []);
});

for (const s of parity.SCENARIOS) {
    t(`${s.key}: ${s.does}`, async () => {
        const r = await p.run(s);
        results.push(r);
        if (r.status === 'fail') throw r.error;
        assert.notStrictEqual(r.status, 'skip', `nothing is skipped here: ${r.note}`);
    });
}

t('dm: delivery keeps the participant rule (chatServer.sendDm checks dm.isParticipant)', async () => {
    const conv = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id] } });
    const convId = conv.body.conversation.id;
    const outsider = await p.join('mod', { stream: false });
    const bobWs = await p.join('b', { stream: false });
    h.chatServer.sendDm(mod.id, { type: 'dm', conversation_id: convId, message: { message: 'not for you' } });
    h.chatServer.sendDm(bob.id, { type: 'dm', conversation_id: convId, message: { message: 'for bob' } });
    await bobWs.next((m) => m.type === 'dm' && m.message.message === 'for bob');
    assert.ok(await outsider.none((m) => m.type === 'dm'), 'a non-participant never receives it');
    await p.closeAll();
});

t('ban from Live’s context menu (/api/mod/stream-ban → the bridge): the socket is closed, the user list drops them, they cannot talk', async () => {
    const watcher = await p.join('a');
    const daveTokens = { ...p.tokens, dave: dave.token };
    const q = new parity.Parity({ driver, tokens: daveTokens, streamId });
    q.ownerId = streamer.id;
    const daveWs = await q.join('dave');
    const listed = (m) => m.type === 'users-list' && m.users.logged.some((u) => u.username === 'dave');
    await watcher.next(listed);
    // Live writes the bans row, then asks Chat to disconnect (Live server/admin/mod-routes.js).
    h.live.addBan({ stream_id: streamId, user_id: dave.id });
    const r = await bridge([{ op: 'disconnectUser', args: [{ userId: dave.id, ip: null, streamId }] }]);
    assert.strictEqual(r.status, 200, r.text);
    await daveWs.next((m) => m.type === 'system' && m.message === 'You have been banned.');
    await new Promise((res) => (daveWs.readyState === 3 ? res() : daveWs.once('close', res)));
    await watcher.next((m) => m.type === 'users-list' && !m.users.logged.some((u) => u.username === 'dave'));
    const again = await q.join('dave');
    await q.say(again, 'let me back in');
    await q.system(again, 'You are banned from this chat.');
    assert.ok(await watcher.none((m) => m.type === 'chat' && m.message === 'let me back in'));
    await q.closeAll();
    await p.closeAll();
    h.live.clearBans();
    await h.ctx.invalidateBans();
});

t('reconnect in global chat (Live’s floating widget, openvibe.chat): Live’s moderator delete while away, then ?after_id= converges', async () => {
    const stayer = await p.join('a', { stream: false });
    let leaver = await p.join('b', { stream: false });
    const writer = await p.join('mod', { stream: false });
    const viewA = new parity.RoomView((await h.http('GET', '/api/chat/global/history?limit=500')).body); const fromA = stayer.all.length;
    const viewB = new parity.RoomView((await h.http('GET', '/api/chat/global/history?limit=500')).body); const fromB = leaver.all.length;
    const doomed = p.text('global line a moderator deletes');
    await p.say(writer, doomed);
    const m1 = await p.saw(stayer, doomed); await p.saw(leaver, doomed);
    viewB.frames(leaver.all.slice(fromB));
    await p.left(leaver);
    // Live's /api/mod/delete-message: the row through the bridge, then the frame to the global feed.
    const r = await bridge([
        { op: 'db', args: ['deleteChatMessage', m1.id, mod.id] },
        { op: 'broadcastGlobal', args: [{ type: 'delete-messages', ids: [m1.id] }] },
    ]);
    assert.ok(r.body.results.every((x) => x.ok), r.text);
    await stayer.next((m) => m.type === 'delete-messages' && m.ids.includes(m1.id));
    const later = p.text('global line while B was away');
    await p.say(stayer, later);
    const m2 = await p.saw(stayer, later);
    viewA.frames(stayer.all.slice(fromA));
    leaver = await p.join('b', { stream: false });
    const d = (await h.http('GET', `/api/chat/global/history?after_id=${viewB.cursor}&limit=200`)).body;
    assert.ok(d.deleted_ids.includes(m1.id), 'the delete is in deleted_ids');
    viewB.delta(d);
    assert.ok(!viewB.ids.has(m1.id) && viewB.ids.has(m2.id));
    assert.deepStrictEqual(viewB.sorted(), viewA.sorted(), 'the widget converges on what the connected reader saw');
    await p.closeAll();
});

t('sub-only fails closed: while Live cannot say whether someone subscribes they are told sub-only is on; the streamer, moderators and a known subscriber talk', async () => {
    const q = new parity.Parity({ driver, tokens: { ...p.tokens, dave: dave.token }, streamId });
    q.ownerId = streamer.id;
    const modWs = await q.join('mod'); const a = await q.join('a');
    await q.say(modWs, '/subonly');
    await a.next((m) => m.type === 'subonly' && m.enabled === true);
    h.live.subscriberDown = true;
    try {
        // Nobody has asked Live about dave; Alice's "yes" is cached from the subonly scenario.
        const daveWs = await q.join('dave');
        await q.sleep(parity.PACE_MS);   // dave's last line (the ban test) may be under a second old
        const t1 = q.text('dave while Live cannot say');
        await q.say(daveWs, t1);
        assert.match((await daveWs.next((m) => m.type === 'system' && /^This chat is in sub-only mode/.test(m.message))).message, /only subscribers/);
        assert.ok(await a.none((m) => m.type === 'chat' && m.message === t1), 'fails closed: the line reaches nobody');
        const t2 = q.text('alice, a known subscriber'); await q.say(a, t2); await q.saw(modWs, t2);
        const t3 = q.text('the moderator'); await q.say(modWs, t3); await q.saw(a, t3);
        const own = await q.join('streamer');
        const t4 = q.text('the streamer'); await q.say(own, t4); await q.saw(a, t4);
    } finally {
        h.live.subscriberDown = false;
        await q.say(modWs, '/subonly off');
        await a.next((m) => m.type === 'subonly' && m.enabled === false);
        await q.closeAll();
    }
});

t('slow mode is the channel’s saved setting: the dashboard’s value is enforced and announced, and a restart keeps it', async () => {
    const pol = h.live.policies.get(channelId);
    const a = await p.join('a'); const b = await p.join('b');
    // The dashboard saves 3 s in Live, which tells Chat (the bridge's invalidate: Live chat-remote.js OBSERVED_DB).
    pol.settings = { ...(pol.settings || {}), slow_mode_seconds: 3 };
    await bridge([{ op: 'invalidate', args: ['channel', channelId] }]);
    assert.strictEqual((await a.next((m) => m.type === 'slowmode')).seconds, 3, 'the room is told');
    await p.system(b, 'Slow mode enabled: 3s between messages');
    const slowed = async (ws, label) => {
        await p.sleep(3200);
        const one = p.text(`${label} one`), two = p.text(`${label} two`);
        await p.say(ws, one); await p.saw(b, one);
        await p.say(ws, two);
        await p.system(ws, 'Slow down! You are sending messages too fast.');
        assert.ok(await b.none((m) => m.type === 'chat' && m.message === two), `${label}: a slowed line reaches nobody`);
    };
    await slowed(a, 'dashboard slow');
    // A restart: every cache is gone and nothing was announced yet; the value is read back from Live.
    h.ctx._reset();
    h.chatServer._announcedModes.clear();
    const again = await p.join('a');
    assert.strictEqual(again.auth.slowmode_seconds, 3, 'read back after a restart');
    await slowed(again, 'after a restart');
    // The dashboard turns it off.
    pol.settings.slow_mode_seconds = 0;
    await bridge([{ op: 'invalidate', args: ['channel', channelId] }]);
    assert.strictEqual((await b.next((m) => m.type === 'slowmode' && m.seconds === 0)).seconds, 0);
    await p.system(b, 'Slow mode disabled.');
    await p.closeAll();
});

t('/clear clears screens only and says so: the lines stay in history', async () => {
    const a = await p.join('a'); const modWs = await p.join('mod');
    const line = p.text('still in history after /clear');
    await p.say(a, line);
    const m = await p.saw(modWs, line);
    await p.say(modWs, '/clear');
    await a.next((f) => f.type === 'clear');
    await p.system(modWs, 'Chat cleared on screen; messages stay in history — use purge to remove them.');
    assert.ok((await h.http('GET', `/api/chat/${streamId}/history?limit=50`)).body.messages.some((x) => x.id === m.id), 'still in history');
    await p.closeAll();
});

t('blocks in public chat leave the rest alone: the streamer who blocked B does not get B’s lines, their moderation log does; DMs are refused both ways as before', async () => {
    driver.block('streamer', 'b', true);
    try {
        const own = await p.join('streamer'); const b = await p.join('b'); const a = await p.join('a');
        const t1 = p.text('B, blocked by the streamer');
        await p.say(b, t1);
        await p.saw(a, t1);
        assert.ok(await own.none((m) => m.type === 'chat' && m.message === t1), 'the blocker does not get it');
        const logs = await h.http('GET', `/api/chat/admin/logs?streamId=${streamId}&search=${encodeURIComponent(t1)}`, { token: streamer.token });
        assert.strictEqual(logs.status, 200, logs.text);
        assert.ok(logs.body.rows.some((r) => r.message === t1), 'the moderation log shows everything');
        for (const [from, to] of [[bob, streamer], [streamer, bob]]) {
            const conv = await h.http('POST', '/api/dm/conversations', { token: from.token, body: { user_ids: [to.id] } });
            assert.strictEqual(conv.status, 403, `a DM ${from.username} → ${to.username} (${conv.text})`);
        }
    } finally {
        driver.block('streamer', 'b', false);
        await p.closeAll();
    }
});

t('the CLI: a dry run lists every scenario and opens nothing; --apply refuses accounts that are not named test accounts', async () => {
    const env = {
        OV_PARITY_BASE: h.base, OV_PARITY_STREAM: String(streamId), OV_PARITY_SOUND: 'honk',
        OV_PARITY_TOKEN_A: alice.token, OV_PARITY_TOKEN_B: bob.token, OV_PARITY_TOKEN_MOD: mod.token,
        OV_PARITY_TEST_ACCOUNTS: 'alice,bob',
    };
    const out = [];
    const sockets = h.chatServer.clients.size;
    const requests = h.live.requests.length;
    assert.strictEqual(await parity.main([], env, (l) => out.push(l)), 0);
    const text = out.join('\n');
    assert.match(text, /dry run/);
    for (const s of parity.SCENARIOS) assert.match(text, new RegExp(`\\b${s.key}\\b`), s.key);
    assert.match(text, /purge\s+destructive\s+would skip: needs OV_PARITY_TOKEN_STREAMER/);
    assert.ok(![alice.token, bob.token, mod.token].some((tok) => text.includes(tok)), 'tokens are never printed');
    assert.strictEqual(h.chatServer.clients.size, sockets, 'no connection');
    assert.strictEqual(h.live.requests.length, requests, 'nothing reached Chat');
    // --apply: moddy and the channel owner are not named → nothing runs.
    const before = h.db.get('SELECT COUNT(*) AS n FROM chat_messages').n;
    out.length = 0;
    assert.strictEqual(await parity.main(['--apply'], env, (l) => out.push(l)), 2);
    assert.match(out.join('\n'), /refused: moddy, streamer are not named in OV_PARITY_TEST_ACCOUNTS; nothing was run/);
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM chat_messages').n, before, 'no message was written');
    // Named: the CLI's own network client runs a scenario end to end.
    out.length = 0;
    assert.strictEqual(await parity.main(['--apply', '--only', 'join,send'], { ...env, OV_PARITY_TEST_ACCOUNTS: 'Alice, bob, moddy, streamer' }, (l) => out.push(l)), 0, out.join('\n'));
    assert.match(out.join('\n'), /PASS join/);
    assert.match(out.join('\n'), /PASS send/);
    assert.match(out.join('\n'), /2 passed, 0 gap\(s\), 0 skipped, 0 failed/);
});

t('the parity matrix', async () => {
    const width = Math.max(...results.map((r) => r.key.length));
    for (const r of results) console.log(`    ${r.key.padEnd(width)}  ${r.status.toUpperCase().padEnd(4)}  ${r.note}`);
    assert.deepStrictEqual(results.map((r) => r.key), parity.SCENARIOS.map((s) => s.key), 'every scenario ran');
    assert.deepStrictEqual(results.filter((r) => r.status !== 'pass').map((r) => `${r.key}: ${r.status}`), [], 'no gap, skip or failure');
});

t.run(async () => { if (p) await p.closeAll(); if (h) await h.close(); });
