'use strict';
/**
 * The persisted TTS and sound queue (server/chat/audio-queue.js, roadmap Wave 6 D4): requests are
 * rows that go queued → playing → played, or skipped / failed; one plays at a time per room; the
 * broadcaster and moderators skip and clear (/skiptts, /cleartts, /api/tts/queue); failures are
 * recorded and the queue moves on; a keyed request is queued once; and a Chat restart keeps the
 * queue: what was playing is finished, what waited plays, in order, once. The restart tests run on an
 * injected clock, timers, instance ids and performer gates (no sleeps): stop() waits for the work in
 * flight, and a pump asked for while recover() runs waits for it. The frames clients already know
 * (tts-audio, soundboard-audio) are unchanged apart from a new request_id. The restart boundary across
 * processes runs the same way:
 * a live owner's playing row is never touched by another process's recover(); a dead owner's row
 * is replayed once if it was never delivered, finished if it was.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, suite } = require('./helpers');

const t = suite('audio-queue');
let h, aq, tts, streamer, mod, viewer, listenerUser, chatters, channelId, streamId, listener;
const sockets = [];

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
const rows = async () => await h.db.all('SELECT * FROM audio_requests ORDER BY id');
const byLabel = async (label) => await h.db.get('SELECT * FROM audio_requests WHERE label = ?', [label]);
async function until(fn, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await h.sleep(25); }
}

t('boot', async () => {
    h = await boot();
    aq = require('../server/chat/audio-queue');
    tts = require('../server/chat/tts-engine');
    streamer = h.addUser('streamer', { role: 'streamer' });
    mod = h.addUser('moddy');
    viewer = h.addUser('viewer');
    listenerUser = h.addUser('listener');
    chatters = ['ann', 'ben', 'cat', 'dan'].map((n) => h.addUser(n));
    channelId = h.addChannel(streamer.id, { moderators: [mod.id] });
    await h.db.addChannelModerator(channelId, mod.id, streamer.id);   // the moderator row is Chat's own (C-04)
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
    assert.strictEqual((await aq.getRequest(first.request_id)).state, 'playing');
    // The chat line is announced before its request is stored: wait for the rows, not just the frame.
    await until(async () => !!(await byLabel('hello from ben')) && !!(await byLabel('hello from cat')), 3000);
    assert.strictEqual((await byLabel('hello from ben')).state, 'queued');
    assert.strictEqual((await byLabel('hello from cat')).state, 'queued');
    assert.ok(await listener.none((m) => m.type === 'tts-audio' && m.message === 'hello from ben', 400), 'the next waits for the one playing');
    second = await listener.next((m) => m.type === 'tts-audio' && m.message === 'hello from ben', 3000);
    assert.ok(Date.now() - t0 >= 1200, 'paced by the clip length');
    const r1 = await aq.getRequest(first.request_id);
    assert.strictEqual(r1.state, 'played');
    assert.strictEqual(r1.duration_ms, 1200);
    assert.strictEqual(r1.kind, 'tts');
    assert.strictEqual(r1.room, `stream:${streamId}`);
});

t('only the broadcaster and moderators skip: /skiptts skips the playing clip and the next goes out at once', async () => {
    const v = await joined(viewer, '198.51.100.110');
    v.sendJson({ type: 'chat', message: '/skiptts' });
    await v.next((m) => m.type === 'system' && m.message === 'You do not have permission.');
    assert.strictEqual((await aq.getRequest(second.request_id)).state, 'playing');

    const s = await joined(streamer, '198.51.100.111');
    const at = Date.now();
    s.sendJson({ type: 'chat', message: '/skiptts' });
    const reply = await s.next((m) => m.type === 'system' && /^Skipped TTS/.test(m.message));
    assert.match(reply.message, new RegExp(`#${second.request_id} from Ben`));
    const stop = await listener.next((m) => m.type === 'audio-skip');
    assert.strictEqual(stop.request_id, second.request_id);
    const row = await aq.getRequest(second.request_id);
    assert.strictEqual(row.state, 'skipped');
    assert.strictEqual(row.actor, 'user:streamer');
    third = await listener.next((m) => m.type === 'tts-audio' && m.message === 'hello from cat');
    assert.ok(Date.now() - at < 900, 'no waiting out the skipped clip');
    const log = await h.db.get("SELECT * FROM moderation_actions WHERE action_type = 'tts_skip' ORDER BY id DESC LIMIT 1");
    assert.strictEqual(log.actor_user_id, streamer.id);
});

t('the queue over REST: list, skip by id, clear — moderators yes, others 403', async () => {
    // Fill the room: cat plays, three more wait (an AI viewer's lines, keyed like chat messages).
    synthPlan = [5, 5, 5];
    for (const n of [1, 2, 3]) await h.chatServer.synthesizeAndBroadcastTTS(streamId, 'ChatBot', `bot line ${n}`, null, 'ai', 'ai:bot', null, `m9${n}`);

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
    assert.strictEqual((await aq.getRequest(two)).state, 'skipped');
    assert.strictEqual((await aq.getRequest(third.request_id)).state, 'playing', 'skipping a waiting request leaves the playing one');
    assert.ok(await listener.none((m) => m.type === 'audio-skip' && m.request_id === two, 150), 'nothing to stop on clients for a request never delivered');

    const cl = await h.http('POST', '/api/tts/queue/clear', { token: mod.token, body: { stream_id: streamId } });
    assert.strictEqual(cl.status, 200, cl.text);
    assert.strictEqual(cl.body.cleared.length, 3, 'the playing one and the two still waiting');
    const frame = await listener.next((m) => m.type === 'audio-clear');
    assert.deepStrictEqual(frame.request_ids.sort((a, b) => a - b), cl.body.cleared.sort((a, b) => a - b));
    assert.strictEqual(cl.body.queue.playing, null);
    assert.deepStrictEqual(cl.body.queue.queued, []);
    assert.ok(await listener.none((m) => m.type === 'tts-audio' && /^bot line/.test(m.message), 300), 'nothing cleared is read');
    assert.ok(await h.db.get("SELECT 1 FROM moderation_actions WHERE action_type = 'tts_clear' AND actor_user_id = ?", [mod.id]));
    assert.strictEqual((await h.http('POST', '/api/tts/queue/skip', { token: mod.token, body: { stream_id: streamId } })).status, 409, 'nothing to skip');
});

t('failures are recorded and the queue moves on', async () => {
    synthPlan = [null, new Error('voice service down'), 6];
    for (const [i, l] of ['no audio', 'throws', 'fine'].entries()) await h.chatServer.synthesizeAndBroadcastTTS(streamId, 'ChatBot', l, null, 'ai', `ai:bot${i}`, null, `mf${i}`);
    await listener.next((m) => m.type === 'tts-audio' && m.message === 'fine');
    assert.strictEqual((await byLabel('no audio')).state, 'failed');
    assert.strictEqual((await byLabel('no audio')).error, 'no audio');
    assert.strictEqual((await byLabel('throws')).state, 'failed');
    assert.strictEqual((await byLabel('throws')).error, 'voice service down');
    assert.strictEqual((await byLabel('fine')).state, 'playing');
});

t('the playing client reports: failed with its reason; final states stay final', async () => {
    const fine = await byLabel('fine');
    const bad = await h.http('POST', `/api/tts/queue/${fine.id}/report`, { token: streamer.token, body: { stream_id: streamId, state: 'skipped' } });
    assert.strictEqual(bad.status, 400);
    const rep = await h.http('POST', `/api/tts/queue/${fine.id}/report`, { token: streamer.token, body: { stream_id: streamId, state: 'failed', error: 'NotAllowedError' } });
    assert.strictEqual(rep.status, 200, rep.text);
    assert.strictEqual((await aq.getRequest(fine.id)).state, 'failed');
    assert.strictEqual((await aq.getRequest(fine.id)).error, 'NotAllowedError');
    assert.strictEqual((await h.http('POST', `/api/tts/queue/${fine.id}/report`, { token: streamer.token, body: { stream_id: streamId, state: 'played' } })).status, 409, 'final states stay final');
});

t('a keyed request is queued once; a requester’s limit holds', async () => {
    synthPlan = [3, 3, 3, 3, 3, 3];
    const before = (await rows()).length;
    const a = await h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', 'same message', null, null, 'user:ann', null, 'm777');
    const b = await h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', 'same message', null, null, 'user:ann', null, 'm777');
    assert.strictEqual(a.queued, true);
    assert.deepStrictEqual(b, { queued: false, reason: 'duplicate' });
    // tts_max_queue_per_user defaults to 3 (queued or playing).
    const more = [];
    for (const n of [1, 2, 3]) more.push(await h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', `more ${n}`, null, null, 'user:ann', null, `m78${n}`));
    assert.deepStrictEqual(more.map((x) => x.queued), [true, true, false]);
    assert.strictEqual(more[2].reason, 'full');
    assert.strictEqual((await rows()).length, before + 3);
    assert.strictEqual(await h.chatServer.synthesizeAndBroadcastTTS(streamId, 'Ann', '.not read', null, null, 'user:ann', null, 'm790'), undefined, "'.' opts a message out");
    const s = await joined(streamer, '198.51.100.112');
    s.sendJson({ type: 'chat', message: '/cleartts' });
    await s.next((m) => m.type === 'system' && /^Cleared 3 TTS\/sound requests/.test(m.message));
});

t('channel !sounds go through the same queue (announce at once, audio in turn)', async () => {
    const file = path.join(process.env.SOUNDS_PATH, 'honk-test.wav');
    fs.writeFileSync(file, wav(0.8));
    await h.db.createChannelSound({ channel_owner_id: streamer.id, command: 'honk', url: file, mime: 'audio/wav', duration_seconds: 0.8 });
    const c = await joined(chatters[3], '198.51.100.113');
    c.sendJson({ type: 'chat', message: '!honk' });
    const ann = await listener.next((m) => m.type === 'chat' && m.message_type === 'channel-sound');
    assert.strictEqual(ann.message, 'played !honk');
    const audio = await listener.next((m) => m.type === 'soundboard-audio' && m.title === '!honk');
    assert.strictEqual(audio.source, 'channel-sound');
    assert.strictEqual(Buffer.from(audio.audio, 'base64').length, fs.statSync(file).size);
    const row = await aq.getRequest(audio.request_id);
    assert.strictEqual(row.kind, 'channel-sound');
    assert.strictEqual(row.duration_ms, 800);
    assert.strictEqual(row.dedupe_key, `m${ann.id}`);
    await until(async () => (await aq.getRequest(audio.request_id)).state === 'played', 3000);
});

// ── A restart, step by step: injected clock, timers, instance id and performer gates, no sleeps ─────────────
// The same instance id (a restarted process) lives three lives on one database; every wait is a hand-fired timer
// or a gate the test opens, so each ordering the old code left to chance is forced: a pump asked for while
// recover() runs, and stop() arriving while a clip is being made.
t('restart: what was playing is finished, what waited plays in order once, stale requests expire', async () => {
    const T = Date.now() + 2 * 24 * 3600e3;   // ahead of the wall clock (and of the boundary test's day): nothing else's rows look stale or live
    const clock = { now: T };
    const plays = [];
    const room = 'stream:9701';
    const NAME = 'chat-under-test';
    const put = async (label, { attempts = 0, created = clock.now } = {}) => Number((await h.db.run(
        `INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at, attempts)
         VALUES (?, 9701, 'tts', 'queued', ?, '{}', ?, ?)`, [room, label, created, attempts])).lastInsertRowid);
    const row = async (id) => await h.db.get('SELECT state, attempts, claimed_by, started_at, error FROM audio_requests WHERE id = ?', [id]);
    const states = async (...ids) => await Promise.all(ids.map(async (id) => (await row(id)).state));

    // Timers by hand: advance(life, ms) fires what falls due in order, letting each one's work finish first.
    const arrivals = [];
    let blocked = 0;
    const settled = (q) => (blocked ? Promise.resolve() : Promise.race([q.idle(), new Promise((r) => arrivals.push(r))]));
    const gates = new Map();
    const gateOn = (id) => {
        const g = {};
        g.released = new Promise((r) => { g.release = r; });
        gates.set(id, g);
        return g;
    };
    const performer = async (r) => {
        const g = gates.get(r.id);
        if (g) { blocked++; arrivals.splice(0).forEach((f) => f()); await g.released; blocked--; }
        return { frame: { type: 'tts-audio', audio: '' }, durationMs: 2000 };
    };
    const life = () => {
        const pending = new Map();
        let seq = 0;
        const timers = {
            setTimeout: (fn, ms) => { const handle = { seq: ++seq }; pending.set(handle, { fn, due: clock.now + ms }); return handle; },
            clearTimeout: (handle) => { pending.delete(handle); },
        };
        return { pending, q: proc(NAME, clock, plays, { performer, timers }) };
    };
    const advance = async (l, ms) => {
        const target = clock.now + ms;
        for (;;) {
            await settled(l.q);
            const next = [...l.pending.entries()].filter(([, x]) => x.due <= target).sort((x, y) => x[1].due - y[1].due)[0];
            if (!next) break;
            l.pending.delete(next[0]);
            clock.now = Math.max(clock.now, next[1].due);
            next[1].fn();
        }
        clock.now = target;
        await settled(l.q);
    };

    // Life 1. Left over from an earlier life: one queued an hour ago, one that crashed Chat three times.
    const stale = await put('stale', { created: T - 3600e3 });
    const crashy = await put('crashy', { attempts: 3 });
    const a = life();
    const boot1 = await a.q.recover();
    assert.ok(boot1.expired >= 1, JSON.stringify(boot1));
    assert.deepStrictEqual([(await row(stale)).state, (await row(stale)).error], ['failed', 'expired']);
    await advance(a, 300);
    assert.strictEqual((await row(crashy)).state, 'queued', 'held until the room has listeners');
    a.q.roomJoined(room);
    await advance(a, 1000);
    assert.deepStrictEqual([(await row(crashy)).state, (await row(crashy)).error], ['failed', 'gave up after repeated attempts']);

    const c1 = await put('c1');
    const c2 = await put('c2');
    const c3 = await put('c3');
    await a.q.pump(room);
    assert.deepStrictEqual(await states(c1, c2, c3), ['playing', 'queued', 'queued']);
    assert.deepStrictEqual(plays, [{ by: NAME, id: c1 }]);
    // SIGTERM while c1 plays: stop() cancels its window; nothing of this life finishes it.
    await a.q.stop();
    assert.strictEqual(a.pending.size, 0, 'no timer survives stop()');
    clock.now += 5000;
    assert.deepStrictEqual(await states(c1, c2, c3), ['playing', 'queued', 'queued']);

    // Life 2, same instance id. A pump asked for while recover() runs (a socket's request) waits for it: it must
    // not claim a row (its own claim would be requeued by recover, and c3 would play before c2).
    const b = life();
    const booting = b.q.recover();
    await b.q.pump(room);
    const boot2 = await booting;
    assert.strictEqual(boot2.played, 1, JSON.stringify(boot2));
    assert.deepStrictEqual(await states(c1, c2, c3), ['played', 'queued', 'queued']);
    assert.strictEqual((await row(c1)).error, 'delivered before a restart', 'delivered before the restart: finished, not replayed');
    assert.strictEqual((await row(c2)).claimed_by, null);
    assert.strictEqual((await row(c3)).attempts, 0);
    await advance(b, 300);
    assert.deepStrictEqual(await states(c2, c3), ['queued', 'queued'], 'nothing plays into an empty room');
    const gate3 = gateOn(c3);
    b.q.roomJoined(room);
    await advance(b, 999);
    assert.deepStrictEqual(await states(c2, c3), ['queued', 'queued'], 'a second after the socket rejoins');
    await advance(b, 1);
    assert.deepStrictEqual(await states(c2, c3), ['playing', 'queued']);
    assert.deepStrictEqual(plays.map((x) => x.id), [c1, c2]);
    // c2's window ends, c3 is claimed and being made: SIGTERM arrives now. stop() waits for the clip in
    // hand, which then goes nowhere: no frame, no timer, and the row is left for the next life.
    await advance(b, 2250);
    assert.deepStrictEqual(await states(c2, c3), ['played', 'playing']);
    assert.strictEqual((await row(c3)).started_at, null, 'c3 is still being made');
    const stopping = b.q.stop();
    assert.strictEqual(await Promise.race([stopping.then(() => 'stopped'), new Promise((r) => setImmediate(() => r('waiting')))]), 'waiting', 'stop() waits for the clip being made');
    gate3.release();
    await stopping;
    assert.strictEqual(b.pending.size, 0, 'no timer survives stop()');
    assert.deepStrictEqual(plays.map((x) => x.id), [c1, c2], 'the clip made after the stop is not delivered');
    assert.deepStrictEqual({ ...await row(c3) }, { state: 'playing', attempts: 1, claimed_by: NAME, started_at: null, error: null });

    // Life 3, same instance id: c3 never went out, so it is queued again in its place and plays, once.
    const c = life();
    const boot3 = await c.q.recover();
    assert.strictEqual(boot3.requeued, 1, JSON.stringify(boot3));
    assert.deepStrictEqual(await states(c3), ['queued']);
    c.q.roomJoined(room);
    await advance(c, 1000);
    assert.deepStrictEqual(plays, [c1, c2, c3].map((id) => ({ by: NAME, id })), 'every waiting clip, in order, once');
    await advance(c, 2250);
    await advance(c, 10 * 60e3);
    assert.deepStrictEqual(await states(c1, c2, c3), ['played', 'played', 'played']);
    assert.strictEqual(plays.length, 3, 'nothing plays twice');
    assert.deepStrictEqual((await c.q.list(room)).queued, []);
    await c.q.stop();
});

t('restart: a stop that arrives as a clip is delivered leaves no pacing timer, and the clip counts as delivered', async () => {
    const clock = { now: Date.now() + 3 * 24 * 3600e3 };
    const plays = [];
    const set = [];
    const timers = { setTimeout: (fn, ms) => { const handle = { fn, ms }; set.push(handle); return handle; }, clearTimeout: (handle) => { handle.cleared = true; } };
    let q = null;
    let stopping = null;
    q = proc('chat-stop-in-delivery', clock, plays, { timers, onDeliver: () => { stopping = q.stop(); } });
    const id = Number((await h.db.run(
        `INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at, attempts) VALUES ('stream:9702', 9702, 'tts', 'queued', 'solo', '{}', ?, 0)`, [clock.now])).lastInsertRowid);
    await q.pump('stream:9702');
    await stopping;
    assert.deepStrictEqual(plays, [{ by: 'chat-stop-in-delivery', id }]);
    assert.deepStrictEqual(set.filter((x) => !x.cleared), [], 'no live timer after stop()');
    const next = proc('chat-stop-in-delivery', clock, plays, { timers });
    const out = await next.recover();
    assert.strictEqual(out.played, 1, JSON.stringify(out));
    assert.strictEqual((await h.db.get('SELECT state, error FROM audio_requests WHERE id = ?', [id])).error, 'delivered before a restart');
    await next.stop();
});

// ── The restart boundary between processes: injected clock and instance ids, no sleeps ─────────────────────────
const QUEUE = require.resolve('../server/chat/audio-queue');
/** A fresh copy of the queue module standing for one Chat process (its own instance id, clock and rooms). */
function proc(name, clockRef, plays, { performer = null, timers = null, onDeliver = null } = {}) {
    delete require.cache[QUEUE];
    const q = require(QUEUE);
    delete require.cache[QUEUE];
    q.init({
        performers: { tts: performer || (async () => ({ frame: { type: 'tts-audio', audio: '' }, durationMs: 1 })) },
        deliver: (row, frame) => { if (frame.type === 'tts-audio') plays.push({ by: name, id: row.id }); if (onDeliver) onDeliver(); },
        instanceId: name, clock: () => clockRef.now, heartbeat: false, ...(timers ? { timers } : {}),
    });
    return q;
}
t('restart boundary: live owners are left alone, a dead owner\'s clip is replayed once if undelivered, finished if delivered', async () => {
    // A day ahead of the wall clock: nothing here can look expired to the queues running on real time in this run.
    const T = Date.now() + 24 * 3600e3;
    const clock = { now: T };
    const plays = [];
    const LEASE = aq.LEASE_MS;
    const put = async (room, label, f) => Number((await h.db.run(
        `INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at, attempts, claimed_by, lease_until, started_at)
         VALUES (?, ?, 'tts', ?, ?, '{}', ?, ?, ?, ?, ?)`,
        [room, Number(room.split(':')[1]), f.state, label, T - 1000, f.attempts || 0, f.owner || null, f.lease || null, f.started || null],
    )).lastInsertRowid);
    const row = async (id) => await h.db.get('SELECT state, attempts, claimed_by, lease_until, error FROM audio_requests WHERE id = ?', [id]);

    // stream:9601 — process P is alive and playing; stream:9602 — a dead owner's clip still being made;
    // stream:9603 — a dead owner's clip already delivered.
    const live = await put('stream:9601', 'live', { state: 'playing', attempts: 1, owner: 'proc-p', lease: T + LEASE, started: T - 500 });
    const liveNext = await put('stream:9601', 'live-next', { state: 'queued' });
    const undelivered = await put('stream:9602', 'undelivered', { state: 'playing', attempts: 1, owner: 'proc-dead', lease: T - 1 });
    const behind = await put('stream:9602', 'behind', { state: 'queued' });
    const delivered = await put('stream:9603', 'delivered', { state: 'playing', attempts: 1, owner: 'proc-dead', lease: T - 1, started: T - 3000 });

    const p = proc('proc-p', clock, plays);
    const q = proc('proc-q', clock, plays);
    const out = await q.recover({ now: T });   // Q boots while P lives
    assert.ok(out.requeued >= 1 && out.played >= 1, JSON.stringify(out));
    assert.deepStrictEqual(await row(live), { state: 'playing', attempts: 1, claimed_by: 'proc-p', lease_until: T + LEASE, error: null }, 'a live owner\'s row is untouched');
    assert.strictEqual(await q.claim(liveNext), null, 'and its room plays nothing else meanwhile');
    assert.deepStrictEqual(await row(undelivered), { state: 'queued', attempts: 1, claimed_by: null, lease_until: null, error: null }, 'undelivered: queued again');
    assert.deepStrictEqual((await q.list('stream:9602')).queued.map((x) => x.id), [undelivered, behind], 'in its old place');
    assert.deepStrictEqual(await row(delivered), { state: 'played', attempts: 1, claimed_by: 'proc-dead', lease_until: T - 1, error: 'delivered before a restart' }, 'delivered: finished, not replayed');

    // P's heartbeat renews its lease; at the old expiry, Q's sweep still leaves P's row alone.
    clock.now = T + LEASE - 1;
    assert.strictEqual((await p.tick()).renewed, 1);
    clock.now = T + LEASE + 1;
    await q.tick();
    assert.strictEqual((await row(live)).state, 'playing');
    assert.strictEqual((await row(live)).claimed_by, 'proc-p');

    // The replay: Q claims the requeued clip (its second claim), then dies before delivering it.
    const again = await q.claim(undelivered);
    assert.strictEqual(again.attempts, 2);
    assert.strictEqual(again.claimed_by, 'proc-q');
    q.stop();
    // Within Q's lease nobody touches it; past it, R's sweep fails it (no second replay) and the room moves on.
    const r = proc('proc-r', clock, plays);
    clock.now = again.lease_until - 1;
    await p.tick();   // P is still alive
    clock.now = again.lease_until;
    await r.tick();
    assert.strictEqual((await row(undelivered)).state, 'playing', 'lease not yet passed');
    clock.now = again.lease_until + 1;
    const swept = await r.tick();
    assert.ok(swept.failed >= 1, JSON.stringify(swept));
    const dead = await row(undelivered);
    assert.strictEqual(dead.state, 'failed');
    assert.strictEqual(dead.error, 'not delivered: its owner stopped twice');
    assert.strictEqual((await h.db.get('SELECT state, claimed_by FROM audio_requests WHERE id = ?', [behind])).claimed_by, 'proc-r');
    assert.deepStrictEqual(plays, [{ by: 'proc-r', id: behind }], 'the next clip plays; the failed one never does');
    assert.strictEqual((await row(live)).claimed_by, 'proc-p', 'P, alive throughout, still owns its clip');
    assert.strictEqual((await row(live)).state, 'playing');
    // A later recover() by anyone does not bring the failed clip back.
    const s = proc('proc-s', clock, plays);
    await s.recover({ now: clock.now });
    assert.strictEqual((await row(undelivered)).state, 'failed');
    for (const x of [p, r, s]) x.stop();
});

t.run(async () => {
    for (const w of sockets) { try { w.close(); } catch { /* */ } }
    if (h) await h.close();
});
