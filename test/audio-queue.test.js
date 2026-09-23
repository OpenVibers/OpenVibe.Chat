'use strict';
/**
 * The persisted TTS and sound queue (server/chat/audio-queue.js, roadmap Wave 6 D4): requests are
 * rows that go queued → playing → played, or skipped / failed; one plays at a time per room; the
 * broadcaster and moderators skip and clear (/skiptts, /cleartts, /api/tts/queue); failures are
 * recorded and the queue moves on; a keyed request is queued once; and a Chat restart (a real
 * process, SIGTERM) keeps the queue: what was playing is finished, what waited plays, in order,
 * once. The frames clients already know (tts-audio, soundboard-audio) are unchanged apart from a
 * new request_id.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { boot, suite } = require('./helpers');

const t = suite('audio-queue');
let h, aq, tts, streamer, mod, viewer, listenerUser, chatters, channelId, streamId, listener;
const sockets = [];
const realSynth = {};

/** 8 kHz 8-bit mono WAV of `seconds`, base64 (1 s = 8000 bytes of audio). */
function wav(seconds) {
    const n = Math.floor(8000 * seconds);
    const b = Buffer.alloc(44 + n);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
    b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
    b.fill(128, 44);
    return b;
}

let synthPlan = [];   // per call: seconds of audio, null (no audio) or an Error
function stubSynth() {
    const fake = async (text) => {
        const step = synthPlan.length ? synthPlan.shift() : 0.6;
        if (step instanceof Error) throw step;
        if (step == null) return null;
        return { audio: wav(step).toString('base64'), mimeType: 'audio/wav', engine: 'test', voiceName: 'test', voiceId: 'test', text };
    };
    tts.synthesize = fake;
    tts.synthesizeUserVoice = fake;
}

async function joined(user, ip, stream = streamId) {
    const ws = await h.ws({ ip, token: user && user.token, stream });
    sockets.push(ws);
    ws.sendJson({ type: 'join', streamId: stream, ...(user ? { token: user.token } : {}) });
    await ws.next((m) => m.type === 'auth');
    return ws;
}
const rows = () => h.db.all('SELECT * FROM audio_requests ORDER BY id');
const byLabel = (label) => h.db.get('SELECT * FROM audio_requests WHERE label = ?', [label]);
async function until(fn, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await h.sleep(25); }
}

t('boot', async () => {
    h = await boot();
    aq = require('../server/chat/audio-queue');
    tts = require('../server/chat/tts-engine');
    realSynth.synthesize = tts.synthesize;
    realSynth.synthesizeUserVoice = tts.synthesizeUserVoice;
    streamer = h.addUser('streamer', { role: 'streamer' });
    mod = h.addUser('moddy');
    viewer = h.addUser('viewer');
    listenerUser = h.addUser('listener');
    chatters = ['ann', 'ben', 'cat', 'dan'].map((n) => h.addUser(n));
    channelId = h.addChannel(streamer.id, { moderators: [mod.id] });
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
    listener = await joined(listenerUser, '198.51.100.90');
});

t('the state machine and clip lengths', async () => {
    assert.deepStrictEqual(aq.STATES, ['queued', 'playing', 'played', 'skipped', 'failed']);
    const allowed = [];
    for (const a of aq.STATES) for (const b of aq.STATES) if (aq.canTransition(a, b)) allowed.push(`${a}>${b}`);
    assert.deepStrictEqual(allowed.sort(), ['playing>failed', 'playing>played', 'playing>skipped', 'queued>failed', 'queued>playing', 'queued>skipped'].sort());
    assert.strictEqual(aq.estimatePlayMs({ audio: wav(1.5).toString('base64'), mimeType: 'audio/wav' }), 1500);
    // MPEG-1 layer III, 128 kbit/s frames behind an ID3 tag: 16000 bytes = 1 s.
    const mp3 = Buffer.alloc(16000);
    mp3.write('ID3', 0); mp3[3] = 4; mp3[9] = 20;           // tag of 20 bytes after the 10-byte header
    mp3[30] = 0xff; mp3[31] = 0xfb; mp3[32] = 0x90;
    assert.strictEqual(aq.mp3Bitrate(mp3), 128000);
    assert.strictEqual(aq.estimatePlayMs({ audio: mp3.toString('base64'), mimeType: 'audio/mpeg' }), 1000);
    assert.strictEqual(aq.estimatePlayMs({ seconds: 2, speed: 0.5 }), 4000, 'a slowed clip plays longer');
    assert.strictEqual(aq.estimatePlayMs({ seconds: 600 }), 60000, 'capped');
});

let first, second, third;
t('TTS of chat messages: queued rows, delivered one at a time, each frame carries request_id', async () => {
    stubSynth();
    synthPlan = [1.2, 1.2, 6];
    const t0 = Date.now();
    for (const [i, c] of chatters.slice(0, 3).entries()) {
        const ws = await joined(c, `198.51.100.${100 + i}`);
        ws.sendJson({ type: 'chat', message: `hello from ${c.username}` });
        await ws.next((m) => m.type === 'chat' && m.message === `hello from ${c.username}`);
    }
    first = await listener.next((m) => m.type === 'tts-audio' && m.message === 'hello from ann');
    assert.ok(first.request_id > 0);
    assert.ok(first.audio && first.mimeType === 'audio/wav' && first.ttsKey, 'the frame clients already play');
    assert.strictEqual(aq.getRequest(first.request_id).state, 'playing');
    assert.strictEqual(byLabel('hello from ben').state, 'queued');
    assert.strictEqual(byLabel('hello from cat').state, 'queued');
    assert.ok(await listener.none((m) => m.type === 'tts-audio' && m.message === 'hello from ben', 400), 'the next waits for the one playing');
    second = await listener.next((m) => m.type === 'tts-audio' && m.message === 'hello from ben', 3000);
    assert.ok(Date.now() - t0 >= 1200, 'paced by the clip length');
    const r1 = aq.getRequest(first.request_id);
    assert.strictEqual(r1.state, 'played');
    assert.strictEqual(r1.duration_ms, 1200);
    assert.strictEqual(r1.kind, 'tts');
    assert.strictEqual(r1.room, `stream:${streamId}`);
});

t('only the broadcaster and moderators skip: /skiptts skips the playing clip and the next goes out at once', async () => {
    const v = await joined(viewer, '198.51.100.110');
    v.sendJson({ type: 'chat', message: '/skiptts' });
    await v.next((m) => m.type === 'system' && m.message === 'You do not have permission.');
    assert.strictEqual(aq.getRequest(second.request_id).state, 'playing');

    const s = await joined(streamer, '198.51.100.111');
    const at = Date.now();
    s.sendJson({ type: 'chat', message: '/skiptts' });
    const reply = await s.next((m) => m.type === 'system' && /^Skipped TTS/.test(m.message));
    assert.match(reply.message, new RegExp(`#${second.request_id} from Ben`));
    const stop = await listener.next((m) => m.type === 'audio-skip');
    assert.strictEqual(stop.request_id, second.request_id);
    const row = aq.getRequest(second.request_id);
    assert.strictEqual(row.state, 'skipped');
    assert.strictEqual(row.actor, 'user:streamer');
    third = await listener.next((m) => m.type === 'tts-audio' && m.message === 'hello from cat');
    assert.ok(Date.now() - at < 900, 'no waiting out the skipped clip');
    const log = h.db.get("SELECT * FROM moderation_actions WHERE action_type = 'tts_skip' ORDER BY id DESC LIMIT 1");
    assert.strictEqual(log.actor_user_id, streamer.id);
});

t('the queue over REST: list, skip by id, clear — moderators yes, others 403', async () => {
    // Fill the room: cat plays, three more wait (through Live's bridge, keyed like chat messages).
    synthPlan = [5, 5, 5];
    const BRIDGE = h.serviceToken(['chat.live_bridge.write', 'chat.message.send']);
    const r = await h.http('POST', '/internal/live/calls', { token: BRIDGE, body: { boot: 'b', ops: [1, 2, 3].map((n) => ({ seq: n, op: 'synthesizeAndBroadcastTTS', args: [streamId, 'ChatBot', `bot line ${n}`, null, 'ai', 'ai:bot', null, `m9${n}`] })) } });
    assert.ok(r.body.results.every((x) => x.ok), r.text);

    assert.strictEqual((await h.http('GET', `/api/tts/queue?stream_id=${streamId}`, { token: viewer.token })).status, 403);
    assert.strictEqual((await h.http('GET', `/api/tts/queue?stream_id=${streamId}`)).status, 401);
    const list = await h.http('GET', `/api/tts/queue?stream_id=${streamId}`, { token: mod.token });
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.body.playing.id, third.request_id);
    assert.deepStrictEqual(list.body.queued.map((x) => x.label), ['bot line 1', 'bot line 2', 'bot line 3']);
    assert.ok(list.body.recent.some((x) => x.id === second.request_id && x.state === 'skipped'));

    const two = list.body.queued[1].id;
    assert.strictEqual((await h.http('POST', '/api/tts/queue/skip', { token: viewer.token, body: { stream_id: streamId, id: two } })).status, 403);
    const sk = await h.http('POST', '/api/tts/queue/skip', { token: mod.token, body: { stream_id: streamId, id: two } });
    assert.strictEqual(sk.status, 200, sk.text);
    assert.strictEqual(aq.getRequest(two).state, 'skipped');
    assert.strictEqual(aq.getRequest(third.request_id).state, 'playing', 'skipping a waiting request leaves the playing one');
    assert.ok(await listener.none((m) => m.type === 'audio-skip' && m.request_id === two, 150), 'nothing to stop on clients for a request never delivered');

    const cl = await h.http('POST', '/api/tts/queue/clear', { token: mod.token, body: { stream_id: streamId } });
    assert.strictEqual(cl.status, 200, cl.text);
    assert.strictEqual(cl.body.cleared.length, 3, 'the playing one and the two still waiting');
    const frame = await listener.next((m) => m.type === 'audio-clear');
    assert.deepStrictEqual(frame.request_ids.sort((a, b) => a - b), cl.body.cleared.sort((a, b) => a - b));
    assert.strictEqual(cl.body.queue.playing, null);
    assert.deepStrictEqual(cl.body.queue.queued, []);
    assert.ok(await listener.none((m) => m.type === 'tts-audio' && /^bot line/.test(m.message), 300), 'nothing cleared is read');
    assert.ok(h.db.get("SELECT 1 FROM moderation_actions WHERE action_type = 'tts_clear' AND actor_user_id = ?", [mod.id]));
    assert.strictEqual((await h.http('POST', '/api/tts/queue/skip', { token: mod.token, body: { stream_id: streamId } })).status, 409, 'nothing to skip');
});

t('failures are recorded and the queue moves on', async () => {
    synthPlan = [null, new Error('voice service down'), 6];
    const BRIDGE = h.serviceToken(['chat.live_bridge.write', 'chat.message.send']);
    await h.http('POST', '/internal/live/calls', { token: BRIDGE, body: { boot: 'b', ops: ['no audio', 'throws', 'fine'].map((l, i) => ({ seq: i + 1, op: 'synthesizeAndBroadcastTTS', args: [streamId, 'ChatBot', l, null, 'ai', `ai:bot${i}`, null, `mf${i}`] })) } });
    await listener.next((m) => m.type === 'tts-audio' && m.message === 'fine');
    assert.strictEqual(byLabel('no audio').state, 'failed');
    assert.strictEqual(byLabel('no audio').error, 'no audio');
    assert.strictEqual(byLabel('throws').state, 'failed');
    assert.strictEqual(byLabel('throws').error, 'voice service down');
    assert.strictEqual(byLabel('fine').state, 'playing');
});

t('the playing client reports: failed with its reason; final states stay final', async () => {
    const fine = byLabel('fine');
    const bad = await h.http('POST', `/api/tts/queue/${fine.id}/report`, { token: streamer.token, body: { stream_id: streamId, state: 'skipped' } });
    assert.strictEqual(bad.status, 400);
    const rep = await h.http('POST', `/api/tts/queue/${fine.id}/report`, { token: streamer.token, body: { stream_id: streamId, state: 'failed', error: 'NotAllowedError' } });
    assert.strictEqual(rep.status, 200, rep.text);
    assert.strictEqual(aq.getRequest(fine.id).state, 'failed');
    assert.strictEqual(aq.getRequest(fine.id).error, 'NotAllowedError');
    assert.strictEqual((await h.http('POST', `/api/tts/queue/${fine.id}/report`, { token: streamer.token, body: { stream_id: streamId, state: 'played' } })).status, 409, 'final states stay final');
});

t('a keyed request is queued once; a requester’s limit holds', async () => {
    synthPlan = [3, 3, 3, 3, 3, 3];
    const before = rows().length;
    const a = h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', 'same message', null, null, 'user:ann', null, 'm777');
    const b = h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', 'same message', null, null, 'user:ann', null, 'm777');
    assert.strictEqual(a.queued, true);
    assert.deepStrictEqual(b, { queued: false, reason: 'duplicate' });
    // tts_max_queue_per_user defaults to 3 (queued or playing).
    const more = [1, 2, 3].map((n) => h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', `more ${n}`, null, null, 'user:ann', null, `m78${n}`));
    assert.deepStrictEqual(more.map((x) => x.queued), [true, true, false]);
    assert.strictEqual(more[2].reason, 'full');
    assert.strictEqual(rows().length, before + 3);
    assert.strictEqual(h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', '.not read', null, null, 'user:ann', null, 'm790'), undefined, "'.' opts a message out");
    const s = await joined(streamer, '198.51.100.112');
    s.sendJson({ type: 'chat', message: '/cleartts' });
    await s.next((m) => m.type === 'system' && /^Cleared 3 TTS\/sound requests/.test(m.message));
});

t('channel !sounds go through the same queue (announce at once, audio in turn)', async () => {
    const file = path.join(process.env.SOUNDS_PATH, 'honk-test.wav');
    fs.writeFileSync(file, wav(0.8));
    h.db.createChannelSound({ channel_owner_id: streamer.id, command: 'honk', url: file, mime: 'audio/wav', duration_seconds: 0.8 });
    const c = await joined(chatters[3], '198.51.100.113');
    c.sendJson({ type: 'chat', message: '!honk' });
    const ann = await listener.next((m) => m.type === 'chat' && m.message_type === 'channel-sound');
    assert.strictEqual(ann.message, 'played !honk');
    const audio = await listener.next((m) => m.type === 'soundboard-audio' && m.title === '!honk');
    assert.strictEqual(audio.source, 'channel-sound');
    assert.strictEqual(Buffer.from(audio.audio, 'base64').length, fs.statSync(file).size);
    const row = aq.getRequest(audio.request_id);
    assert.strictEqual(row.kind, 'channel-sound');
    assert.strictEqual(row.duration_ms, 800);
    assert.strictEqual(row.dedupe_key, `m${ann.id}`);
    await until(() => aq.getRequest(audio.request_id).state === 'played', 3000);
});

// ── Restart: Chat as its own process ────────────────────────────────────────────────────────────
let chat, port, dbFile;
const raw = (fn) => { const d = new Database(dbFile); try { return fn(d); } finally { d.close(); } };
t('restart: what was playing is finished, what waited plays in order once, stale requests expire', async () => {
    tts.synthesize = realSynth.synthesize;
    tts.synthesizeUserVoice = realSynth.synthesizeUserVoice;
    dbFile = path.join(h.tmp, 'chat.db');
    for (const w of sockets) { try { w.close(); } catch { /* */ } }
    await h.detach();
    // Long enough clips that the queue is still full when Chat stops.
    const file = path.join(process.env.SOUNDS_PATH, 'long-test.wav');
    fs.writeFileSync(file, wav(2));
    raw((d) => {
        d.prepare("INSERT INTO channel_sounds (channel_owner_id, command, url, mime, duration_seconds) VALUES (?, 'long', ?, 'audio/wav', 2)").run(streamer.id, file);
        // Left over from an earlier life: one queued an hour ago, one that crashed Chat three times.
        const ins = d.prepare("INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at, attempts) VALUES (?, ?, 'channel-sound', 'queued', ?, ?, ?, ?)");
        ins.run(`stream:${streamId}`, streamId, 'stale', JSON.stringify({ file, title: '!stale' }), Date.now() - 3600e3, 0);
        ins.run(`stream:${streamId}`, streamId, 'crashy', JSON.stringify({ file, title: '!crashy' }), Date.now(), 3);
    });
    port = await h.freePort();
    chat = await h.spawnChat({ port });
    assert.strictEqual(raw((d) => d.prepare("SELECT state, error FROM audio_requests WHERE label = 'stale'").get()).error, 'expired');
    // The room's queue is held until it has listeners again (a second after the first rejoins).
    await h.sleep(300);
    assert.strictEqual(raw((d) => d.prepare("SELECT state FROM audio_requests WHERE label = 'crashy'").get().state), 'queued', 'held for listeners');
    const ears = await joined(listenerUser, '198.51.100.120');
    await until(() => raw((d) => d.prepare("SELECT state FROM audio_requests WHERE label = 'crashy'").get().state) === 'failed');
    assert.strictEqual(raw((d) => d.prepare("SELECT error FROM audio_requests WHERE label = 'crashy'").get()).error, 'gave up after repeated attempts');

    for (const [i, c] of chatters.slice(0, 3).entries()) {
        const ws = await joined(c, `198.51.100.${121 + i}`);
        ws.sendJson({ type: 'chat', message: '!long' });
        await ws.next((m) => m.type === 'chat' && m.message_type === 'channel-sound');
        ws.close();
    }
    const firstClip = await ears.next((m) => m.type === 'soundboard-audio' && m.title === '!long');
    const queued = raw((d) => d.prepare("SELECT id, state FROM audio_requests WHERE label = '!long' ORDER BY id").all());
    assert.deepStrictEqual(queued.map((x) => x.state), ['playing', 'queued', 'queued']);
    assert.strictEqual(queued[0].id, firstClip.request_id);

    const exit = await h.stopChat(chat);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, chat.log);
    chat = await h.spawnChat({ port });
    await h.sleep(300);
    assert.strictEqual(raw((d) => d.prepare('SELECT state FROM audio_requests WHERE id = ?').get(queued[1].id).state), 'queued', 'nothing plays into an empty room');
    const ears2 = await joined(listenerUser, '198.51.100.130');
    const got = [];
    got.push(await ears2.next((m) => m.type === 'soundboard-audio' && m.title === '!long', 4000));
    got.push(await ears2.next((m) => m.type === 'soundboard-audio' && m.title === '!long', 5000));
    assert.deepStrictEqual(got.map((m) => m.request_id), [queued[1].id, queued[2].id], 'the waiting clips, in order');
    assert.ok(await ears2.none((m) => m.type === 'soundboard-audio' && m.request_id === queued[0].id, 100), 'the clip delivered before the restart is not played again');
    const after = raw((d) => d.prepare("SELECT id, state, error FROM audio_requests WHERE label = '!long' ORDER BY id").all());
    assert.strictEqual(after[0].state, 'played');
    assert.strictEqual(after[0].error, 'delivered before a restart');
    assert.strictEqual(after[1].state, 'played');
    assert.strictEqual(after[2].state, 'playing');

    // Moderation still works on the new process.
    const s = await joined(mod, '198.51.100.131');
    s.sendJson({ type: 'chat', message: '/cleartts' });
    await s.next((m) => m.type === 'system' && /^Cleared 1 TTS\/sound request\./.test(m.message));
    assert.strictEqual(raw((d) => d.prepare('SELECT state FROM audio_requests WHERE id = ?').get(queued[2].id).state), 'skipped');
});

t.run(async () => {
    for (const w of sockets) { try { w.close(); } catch { /* */ } }
    if (h) await h.close();
});
