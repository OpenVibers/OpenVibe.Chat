'use strict';
/**
 * The audio queue's claim (plan T3 decision 3): two pumps — two module instances standing for two Chat processes,
 * each with its own pool connections on one database — race over the same queued requests. The claim is one atomic
 * UPDATE … WHERE state = 'queued' RETURNING *, so every request plays exactly once; the synth runs outside any
 * transaction. And enqueue's dedupe is the unique (room, dedupe_key) index: concurrent enqueues of one key store
 * one row. And a room plays one request at a time across processes: claim() holds the room's advisory lock and
 * takes nothing while the room has a playing row (backed by the one-playing-row partial unique index).
 * On PostgreSQL (npm run test:pg) the two pumps really run on separate connections.
 */
const assert = require('assert');
const { suite } = require('./helpers');

const t = suite('audio-claim');
const db = require('../server/db/database');
const QUEUE = require.resolve('../server/chat/audio-queue');

/** A fresh copy of server/chat/audio-queue.js (its own rooms and timers), sharing the database module. */
function instance(name, plays) {
    delete require.cache[QUEUE];
    const aq = require(QUEUE);
    delete require.cache[QUEUE];
    aq.init({
        performers: {
            tts: async () => {
                await new Promise((r) => setTimeout(r, Math.random() * 15));   // a synth: outside any transaction
                return { frame: { type: 'tts-audio', audio: '' }, durationMs: 1 };
            },
        },
        deliver: (row, frame) => { if (frame.type === 'tts-audio') plays.push({ by: name, id: row.id }); },
        instanceId: `proc-${name}`, heartbeat: false,
    });
    return aq;
}

const plays = [];
let a, b;

t('boot', async () => {
    await db.initDb();
    a = instance('a', plays);
    b = instance('b', plays);
    assert.notStrictEqual(a, b);
});

t('two pumps over 40 rooms: every request plays exactly once', async () => {
    const ROOMS = 40;
    const ids = [];
    // Queued rows no pump has seen yet (enqueue would start its own pump at once).
    for (let i = 0; i < ROOMS; i++) {
        const r = await db.run(`INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at)
                                VALUES (?, ?, 'tts', 'queued', ?, '{}', ?)`, [`stream:${9000 + i}`, 9000 + i, `r${i}`, Date.now()]);
        ids.push(Number(r.lastInsertRowid));
    }
    // Both pumps on every room at once.
    await Promise.all(ids.map((_, i) => Promise.all([a.pump(`stream:${9000 + i}`), b.pump(`stream:${9000 + i}`)])));
    const until = Date.now() + 10000;
    while (plays.length < ROOMS && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));   // a double play would arrive after the first
    const played = plays.map((p) => p.id).sort((x, y) => x - y);
    assert.deepStrictEqual(played, [...ids].sort((x, y) => x - y), 'each request delivered once, none twice');
    const rows = await db.all('SELECT id, state, attempts FROM audio_requests WHERE id = ANY(?) ORDER BY id', [ids]);
    assert.ok(rows.every((r) => ['playing', 'played'].includes(r.state) && r.attempts === 1), JSON.stringify(rows));
    const by = new Set(plays.map((p) => p.by));
    console.log(`  (plays by pump: ${[...by].map((n) => `${n} ${plays.filter((p) => p.by === n).length}`).join(', ')})`);
});

t('a request claimed by one pump is not claimed again', async () => {
    const r = await a.enqueue({ kind: 'tts', streamId: 9100, label: 'once', payload: {} });
    a.stop(); b.stop();   // no pump: claim by hand
    const [x, y] = await Promise.all([a.claim(r.id), b.claim(r.id)]);
    assert.strictEqual([x, y].filter(Boolean).length, 1, 'one claim wins');
    assert.strictEqual((x || y).state, 'playing');
    assert.strictEqual((await db.get('SELECT attempts FROM audio_requests WHERE id = ?', [r.id])).attempts, 1);
});

t('two requests in one room, two claimers at once: one plays, the other gets nothing until it ends', async () => {
    const ids = [];
    for (const label of ['first', 'second']) {
        const r = await db.run(`INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at)
                                VALUES ('stream:9300', 9300, 'tts', 'queued', ?, '{}', ?)`, [label, Date.now()]);
        ids.push(Number(r.lastInsertRowid));
    }
    for (let round = 0; round < 5; round++) {
        // Each claimer goes for a different request of the room at the same time.
        const [x, y] = await Promise.all([a.claim(ids[0]), b.claim(ids[1])]);
        assert.strictEqual([x, y].filter(Boolean).length, 1, `round ${round}: exactly one claim wins`);
        const won = x || y;
        const loser = x ? b : a;
        const other = ids.find((id) => id !== won.id);
        assert.strictEqual(won.claimed_by, x ? 'proc-a' : 'proc-b');
        assert.ok(won.lease_until > Date.now());
        assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM audio_requests WHERE room = 'stream:9300' AND state = 'playing'")).n, 1);
        // While it plays, the loser gets nothing, whichever request it tries.
        assert.strictEqual(await loser.claim(other), null);
        assert.strictEqual(await a.claim(other), null);
        assert.strictEqual((await db.get('SELECT state, attempts FROM audio_requests WHERE id = ?', [other])).state, 'queued');
        // It ends: the loser's next try takes the other one.
        assert.ok(await a.transition(won.id, 'played'));
        const next = await loser.claim(other);
        assert.ok(next && next.id === other && next.state === 'playing');
        assert.ok(await a.transition(other, 'played'));
        // Again with two fresh requests.
        ids.length = 0;
        for (const label of ['first', 'second']) {
            const r = await db.run(`INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at)
                                    VALUES ('stream:9300', 9300, 'tts', 'queued', ?, '{}', ?)`, [`${label}${round}`, Date.now()]);
            ids.push(Number(r.lastInsertRowid));
        }
    }
});

t('the store refuses a second playing row in a room, whoever writes it', async () => {
    const r = await db.run(`INSERT INTO audio_requests (room, stream_id, kind, state, label, payload, created_at)
                            VALUES ('stream:9300', 9300, 'tts', 'queued', 'raw', '{}', ?)`, [Date.now()]);
    const playing = await a.claim(Number(r.lastInsertRowid) - 2) || await a.claim(Number(r.lastInsertRowid) - 1);
    assert.ok(playing, 'one of the earlier requests is playing');
    // A claimer without the lock (the previous release's bare UPDATE) is refused by the partial unique index.
    await assert.rejects(db.run("UPDATE audio_requests SET state = 'playing' WHERE id = ?", [Number(r.lastInsertRowid)]), (err) => err.code === '23505');
});

t('concurrent enqueues of one dedupe key store one row', async () => {
    const outs = await Promise.all([a, b, a, b].map((q) => q.enqueue({ kind: 'tts', streamId: 9200, label: 'dup', payload: {}, dedupeKey: 'k1' })));
    assert.strictEqual(outs.filter((o) => o.queued).length, 1, JSON.stringify(outs));
    assert.ok(outs.filter((o) => !o.queued).every((o) => o.reason === 'duplicate'));
    assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM audio_requests WHERE room = 'stream:9200'")).n, 1);
});

t.run(async () => { if (a) a.stop(); if (b) b.stop(); });
