'use strict';
/**
 * A Chat restart and the client that reconnects after it (roadmap Wave 6 exit criterion "Chat
 * restart resumes persisted messages").
 *
 * Chat runs as its own process here (`node server/index.js` on one database and port) and is
 * restarted with a real SIGTERM. Readers of a stream room, global chat and a channel keep the
 * cursor Live's chat.js keeps (the highest message id they have shown, from history pages and live
 * frames) and, after the restart, reconnect, join, and read `?after_id=<cursor>`. What they end up
 * with must be exactly the room's rows in the database: nothing missing (messages written while
 * the reader was away, before and after the restart, by people and through Live's ingress) and
 * nothing twice (no row at or under the cursor comes back, every live frame carries the row's real
 * id, and an ingress message Live sends again after the restart with its key is one row).
 */
const assert = require('assert');
const path = require('path');
const { boot, suite } = require('./helpers');

const t = suite('restart-resume');
let h, chat, port, streamer, posters, reader, channelId, streamId;
let SEND;
const sockets = [];

// Live's AI viewer posting through Chat's ingress (POST /internal/chat/messages), keyed like Live's.
const ingest = (key, message) => h.http('POST', '/internal/chat/messages', { token: SEND, body: { key, stream_id: streamId, username: 'ChatBot', message, message_type: 'chat', source_platform: 'ai', mirror: true } });

// What the database says the rooms hold (this process's own handle on the same database: Chat is another process).
async function roomRows(where, params) {
    return await h.db.getDb().prepare(`SELECT id, message, message_type FROM chat_messages WHERE is_deleted = 0 AND ${where} ORDER BY id`).all(...params);
}

/** A reader as Live's chat.js keeps one: shown rows by id and the cursor (the highest id shown). */
function makeReader(name) {
    return {
        name,
        shown: new Map(),   // id → message text
        texts: [],          // every text shown, in order (a duplicate under another id shows up twice)
        cursor: 0,
        bad: [],            // frames without a real row id (the reader could not dedupe them)
        show(m) {
            if (!m || m.id == null) return;
            const id = Number(m.id);
            if (!Number.isInteger(id) || id <= 0) { this.bad.push(m); return; }
            if (this.shown.has(id)) return;   // chat.js dedupes by id
            this.shown.set(id, m.message);
            this.texts.push(m.message);
            if (id > this.cursor) this.cursor = id;
        },
    };
}

async function openReader(r, { ip, token, stream }) {
    const ws = await h.ws({ ip, token, stream });
    sockets.push(ws);
    ws.on('message', (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.type === 'chat') r.show(m);
    });
    ws.sendJson({ type: 'join', ...(stream ? { streamId: stream } : {}), ...(token ? { token } : {}) });
    await ws.next((m) => m.type === 'auth');
    r.ws = ws;
    return ws;
}

async function post(user, ip, text) {
    const ws = await h.ws({ ip, token: user.token, stream: streamId });
    sockets.push(ws);
    ws.sendJson({ type: 'join', streamId, token: user.token });
    await ws.next((m) => m.type === 'auth');
    ws.sendJson({ type: 'chat', message: text });
    const own = await ws.next((m) => m.type === 'chat' && m.message === text);
    ws.close();
    return own.id;
}

const streamRoom = { key: 'stream', rows: async () => await roomRows('channel_user_id = ?', [streamer.id]), delta: (after) => h.http('GET', `/api/chat/${streamId}/history?after_id=${after}`) };
const channelRoom = { key: 'channel', rows: async () => await roomRows('channel_user_id = ?', [streamer.id]), delta: (after) => h.http('GET', `/api/chat/channel/${streamer.id}/history?after_id=${after}`) };
const globalRoom = { key: 'global', rows: async () => await roomRows("message_type IN ('chat', 'system', 'channel-sound', 'soundboard', 'donation')", []), delta: (after) => h.http('GET', `/api/chat/global/history?after_id=${after}`) };

const readers = {};

t('boot the stubs, then Chat as its own process', async () => {
    h = await boot();
    SEND = h.serviceToken(['chat.message.send']);
    streamer = h.addUser('streamer', { role: 'streamer' });
    reader = h.addUser('reader');
    posters = ['ann', 'ben', 'cat', 'dan', 'eve', 'fay'].map((n) => h.addUser(n));
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.detach();
    port = await h.freePort();
    chat = await h.spawnChat({ port });
});

t('readers load the rooms and follow live frames', async () => {
    await post(posters[0], '198.51.100.10', 'before 1');
    readers.stream = makeReader('stream');
    readers.global = makeReader('global');
    readers.channel = makeReader('channel');
    await openReader(readers.stream, { ip: '198.51.100.20', token: reader.token, stream: streamId });
    await openReader(readers.global, { ip: '198.51.100.21' });
    for (const [r, room] of [[readers.stream, streamRoom], [readers.global, globalRoom], [readers.channel, channelRoom]]) {
        const page = await h.http('GET', room.key === 'global' ? '/api/chat/global/history' : room.key === 'stream' ? `/api/chat/${streamId}/history` : `/api/chat/channel/${streamer.id}/history`);
        assert.strictEqual(page.status, 200, page.text);
        page.body.messages.forEach((m) => r.show(m));
        assert.strictEqual(r.cursor, page.body.latest_id, `${r.name}: the page's latest_id is the cursor`);
    }
    // A live message and an ingress message (Live's AI viewer) reach the connected readers.
    const id2 = await post(posters[1], '198.51.100.11', 'before 2');
    const b = await ingest('live:r1', 'ingress before');
    assert.strictEqual(b.status, 200, b.text);
    assert.strictEqual((await readers.stream.ws.next((m) => m.type === 'chat' && m.message === 'ingress before')).id, b.body.id);
    assert.strictEqual((await readers.global.ws.next((m) => m.type === 'chat' && m.message === 'ingress before')).id, b.body.id);
    assert.ok(readers.stream.shown.has(id2) && readers.global.shown.has(id2));
    // The channel reader is a page that polls (no socket): it read before these two.
});

let beforeMax;
t('the stream reader drops off; messages keep coming; Chat restarts (SIGTERM, new process)', async () => {
    readers.stream.ws.close();
    await post(posters[2], '198.51.100.12', 'missed while away');
    // An ingress message whose response Live never got: it will send it again after the restart.
    const lost = await ingest('live:r4', 'ingress retried');
    assert.strictEqual(lost.status, 200, lost.text);
    await readers.global.ws.next((m) => m.type === 'chat' && m.message === 'ingress retried');
    beforeMax = (await roomRows('1 = 1', [])).reduce((m, x) => Math.max(m, x.id), 0);

    const closed = new Promise((r) => readers.global.ws.on('close', r));
    const exit = await h.stopChat(chat);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, `clean exit:\n${chat.log}`);
    await closed;
    assert.ok(readers.global.ws.all.some((m) => m.type === 'server_restart'), 'clients were told Chat is restarting');

    chat = await h.spawnChat({ port });
});

t('after the restart: a retried ingress message, new messages', async () => {
    // The global reader reconnects at once (chat.js reconnects on close); the stream reader later.
    await openReader(readers.global, { ip: '198.51.100.21' });
    // The message whose answer was lost comes again with its key: applied once, with the first id.
    const retry = await ingest('live:r4', 'ingress retried');
    assert.strictEqual(retry.status, 200, retry.text);
    const once = await roomRows("message = 'ingress retried'", []);
    assert.strictEqual(once.length, 1, 'a retried message is applied once across the restart');
    assert.strictEqual(retry.body.id, once[0].id);

    const after1 = await post(posters[3], '198.51.100.13', 'after restart 1');
    assert.ok(after1 > beforeMax, 'ids keep increasing across the restart');
    const after2 = await ingest('live:r3', 'ingress after');
    assert.strictEqual(after2.status, 200, after2.text);
    assert.strictEqual((await readers.global.ws.next((m) => m.type === 'chat' && m.message === 'ingress after')).id, after2.body.id);
});

for (const [name, room] of [['stream', streamRoom], ['global', globalRoom], ['channel', channelRoom]]) {
    t(`${name} reader: reconnect, join, read after_id=<cursor> — no gap, no duplicate`, async () => {
        const r = readers[name];
        const cursor = r.cursor;
        assert.ok(cursor > 0);
        if (name === 'stream') await openReader(r, { ip: '198.51.100.20', token: reader.token, stream: streamId });
        // A message that lands between the socket join and the cursor read reaches the reader
        // twice (frame and delta); the id makes it one row.
        if (name === 'stream') await post(posters[4], '198.51.100.14', 'during reconnect');
        const d = await room.delta(cursor);
        assert.strictEqual(d.status, 200, d.text);
        assert.strictEqual(d.body.complete, true);
        const ids = d.body.messages.map((m) => m.id);
        assert.ok(ids.every((id) => id > cursor), `${name}: nothing at or under the cursor comes back (${ids} vs ${cursor})`);
        assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'oldest → newest');
        assert.strictEqual(d.body.latest_id, ids.length ? Math.max(...ids) : cursor);
        d.body.messages.forEach((m) => r.show(m));
        if (name === 'stream') await r.ws.next((m) => m.type === 'chat' && m.message === 'during reconnect');

        assert.deepStrictEqual(r.bad, [], `${name}: every frame carries its row's real id`);
        const want = await room.rows();
        assert.deepStrictEqual([...r.shown.keys()].sort((a, b) => a - b), want.map((x) => x.id), `${name}: exactly the room's rows`);
        const seen = new Set();
        for (const text of r.texts) { assert.ok(!seen.has(text), `${name}: "${text}" shown twice`); seen.add(text); }
        for (const text of ['before 1', 'before 2', 'ingress before', 'missed while away', 'ingress retried', 'after restart 1', 'ingress after']) {
            assert.ok(seen.has(text), `${name}: "${text}" missing`);
        }
        // The next read from the new cursor is empty.
        const again = await room.delta(r.cursor);
        assert.deepStrictEqual(again.body.messages, []);
        assert.strictEqual(again.body.latest_id, r.cursor);
    });
}

t('a live frame after the resume continues from the cursor', async () => {
    const r = readers.stream;
    const before = r.cursor;
    const id = await post(posters[5], '198.51.100.15', 'after resume');
    await r.ws.next((m) => m.type === 'chat' && m.message === 'after resume');
    assert.ok(id > before);
    assert.strictEqual(r.cursor, id);
});

t.run(async () => {
    for (const ws of sockets) { try { ws.close(); } catch { /* */ } }
    if (h) await h.close();
});
