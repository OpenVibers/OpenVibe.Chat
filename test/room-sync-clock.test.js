'use strict';
/**
 * A room's shared clock (B4, common.sync-clock@1) and control lease (B3, common.control-lease@1):
 *
 *   - only the current lease holder may set the clock, and Chat refuses everyone else;
 *   - Chat stamps at_ms and seq, fans the state out and gives it to a member who joins later;
 *   - `time` answers a ping with Chat's clock on the same socket;
 *   - the first request takes a free remote, the holder passes it on, take-back always wins, a time limit
 *     expires into nobody, and a person holder who leaves keeps the remote a minute (back in time: still theirs);
 *   - the clock plays OpenVibe media only, and only the owner hands the remote to an AI;
 *   - the durable rows survive dropping the modules' memory copies.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('room sync clock and control lease');
let h, ann, bob, cat;
let room;
const api = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const close = (ws) => ws.close();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(ws, slug = 'watch-party') {
    ws.sendJson({ type: 'join_room', room: slug });
    const joined = await ws.next((m) => m.type === 'room_joined');
    return joined;
}

/** The lease frame that follows a join (or an action); the prior frames stay available to next(). */
const lease = (ws, pred = () => true) => ws.next((m) => m.type === 'lease' && pred(m.state));
const sync = (ws) => ws.next((m) => m.type === 'sync');

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('a room has nobody holding the remote at seq 1, and a signed-out socket cannot set anything', async () => {
    const made = await api('POST', '/', ann, { name: 'Watch Party', topic: 'Friday film' });
    assert.strictEqual(made.status, 201, made.text);
    room = made.body.room;

    const annWs = await h.ws({ token: ann.token });
    const joined = await join(annWs);
    assert.strictEqual(joined.role, 'owner');
    assert.strictEqual(joined.subject, ann.subject_id);
    const first = await lease(annWs);
    assert.deepStrictEqual([first.state.thing, first.state.holder.kind, first.state.holder.subject, first.state.seq],
        [`chat.room:${room.slug}`, 'nobody', null, 1]);

    const guest = await h.ws({});
    await join(guest);
    guest.sendJson({ type: 'sync', media: 'https://openvibe.media/vod/test.webm', position_ms: 0 });
    const refused = await guest.next((m) => m.type === 'sync_error');
    assert.strictEqual(refused.code, 'sync.sign_in');
    guest.sendJson({ type: 'lease.request' });
    assert.strictEqual((await guest.next((m) => m.type === 'lease_error')).code, 'lease.sign_in');
    close(guest);
    close(annWs);
});

t('the first request takes the free remote, and only its holder can set the clock', async () => {
    const annWs = await h.ws({ token: ann.token });
    const bobWs = await h.ws({ token: bob.token });
    await join(annWs); await lease(annWs);
    await join(bobWs); await lease(bobWs);

    bobWs.sendJson({ type: 'sync', media: 'https://openvibe.media/vod/test.webm', position_ms: 1000 });
    assert.strictEqual((await bobWs.next((m) => m.type === 'sync_error')).code, 'sync.not_holder');

    annWs.sendJson({ type: 'lease.request' });
    const granted = await lease(bobWs, (s) => s.holder.kind === 'person');
    assert.strictEqual(granted.state.holder.subject, ann.subject_id);
    assert.strictEqual(granted.state.seq, 2);
    assert.deepStrictEqual(granted.state.watchers, [ann.subject_id, bob.subject_id].sort());
    assert.ok((await lease(annWs, (s) => s.holder.subject === ann.subject_id)).granted, 'the requester is told too');

    annWs.sendJson({ type: 'sync', media: 'https://openvibe.media/vod/test.webm', position_ms: 60000, rate: 1, paused: false });
    const clock = await sync(bobWs);
    assert.strictEqual(clock.room, room.slug);
    assert.deepStrictEqual([clock.state.media, clock.state.position_ms, clock.state.rate, clock.state.paused],
        ['https://openvibe.media/vod/test.webm', 60000, 1, false]);
    assert.strictEqual(clock.state.set_by, ann.subject_id);
    assert.strictEqual(clock.state.seq, 1);
    assert.ok(Math.abs(clock.state.at_ms - Date.now()) < 2000, 'at_ms is the server clock');
    assert.ok((await sync(annWs)).state.seq === 1);

    // A later member gets both the current timeline and the current holder.
    const catWs = await h.ws({ token: cat.token });
    await join(catWs);
    const lateSync = await sync(catWs);
    assert.deepStrictEqual([lateSync.state.position_ms, lateSync.state.seq, lateSync.state.set_by], [60000, 1, ann.subject_id]);
    const lateLease = await lease(catWs);
    assert.strictEqual(lateLease.state.holder.subject, ann.subject_id);
    assert.deepStrictEqual(lateLease.state.watchers, [ann.subject_id, bob.subject_id, cat.subject_id].sort());

    // A request on a held remote is a request, not a seizure.
    bobWs.sendJson({ type: 'lease.request', expires_ms: Date.now() + 60000 });
    const pending = await annWs.next((m) => m.type === 'lease.request');
    assert.deepStrictEqual([pending.request.requester.subject, pending.request.holder.subject], [bob.subject_id, ann.subject_id]);
    assert.strictEqual(pending.request.seq, lateLease.state.seq, 'a request is not a control change');
    assert.ok((await bobWs.next((m) => m.type === 'lease.request')).request, 'the requester sees it too');

    // The holder passes it on; the new holder sets.
    annWs.sendJson({ type: 'lease.grant', to: { kind: 'person', subject: bob.subject_id }, expires_ms: Date.now() + 60000 });
    const passed = await lease(catWs, (s) => s.holder.subject === bob.subject_id);
    assert.strictEqual(passed.state.seq, lateLease.state.seq + 1);
    bobWs.sendJson({ type: 'sync', position_ms: 90000, rate: 1.5 });
    const changed = await sync(catWs);
    assert.deepStrictEqual([changed.state.position_ms, changed.state.rate, changed.state.set_by, changed.state.seq], [90000, 1.5, bob.subject_id, 2]);

    // A member cannot take it; the owner can, and take-back always wins.
    bobWs.sendJson({ type: 'lease.take' });
    assert.strictEqual((await bobWs.next((m) => m.type === 'lease_error')).code, 'lease.not_owner');
    annWs.sendJson({ type: 'lease.take' });
    const back = await lease(catWs, (s) => s.holder.subject === ann.subject_id);
    assert.ok(back.taken);
    bobWs.sendJson({ type: 'sync', position_ms: 1000 });
    assert.strictEqual((await bobWs.next((m) => m.type === 'sync_error')).code, 'sync.not_holder');

    // A time limit expires into nobody even if the room is quiet.
    annWs.sendJson({ type: 'lease.grant', to: { kind: 'person', subject: bob.subject_id }, expires_ms: Date.now() + 250 });
    await lease(catWs, (s) => s.holder.subject === bob.subject_id);
    const expired = await lease(catWs, (s) => s.holder.kind === 'nobody');
    assert.strictEqual(expired.reason, 'expired');
    assert.strictEqual(expired.state.holder.subject, null);
    bobWs.sendJson({ type: 'sync', position_ms: 10 });
    assert.strictEqual((await bobWs.next((m) => m.type === 'sync_error')).code, 'sync.not_holder');

    // The clock is stamped with Chat's time on a time ping.
    const before = Date.now();
    annWs.sendJson({ type: 'time', id: 't1', t0: 12345 });
    const pong = await annWs.next((m) => m.type === 'time');
    assert.strictEqual(pong.id, 't1');
    assert.strictEqual(pong.t0, 12345);
    assert.ok(pong.t_server >= before && pong.t_server <= Date.now() + 1000);

    // Drop the memory copies: a fresh join reads the durable rows back.
    annWs.sendJson({ type: 'lease.request' });
    await lease(catWs, (s) => s.holder.subject === ann.subject_id);
    annWs.sendJson({ type: 'sync', position_ms: 30000 });
    await sync(catWs);
    require('../server/rooms/sync-clock').evict(room.id);
    require('../server/rooms/control-lease').evict(room.id);
    await join(catWs);
    const fromDbSync = await sync(catWs);
    const fromDbLease = await lease(catWs);
    assert.deepStrictEqual([fromDbSync.state.position_ms, fromDbSync.state.set_by, fromDbLease.state.holder.subject], [30000, ann.subject_id, ann.subject_id]);

    // The clock plays OpenVibe media only: a link to somebody else's server is refused.
    annWs.sendJson({ type: 'sync', media: 'https://tracker.example.com/film.webm', position_ms: 0 });
    assert.strictEqual((await annWs.next((m) => m.type === 'sync_error')).code, 'sync.media');

    // A person holder whose last socket leaves keeps the remote a minute (shortened here), then it is free.
    const controlLease = require('../server/rooms/control-lease');
    controlLease.setAwayGraceForTests(400);
    annWs.sendJson({ type: 'lease.grant', to: { kind: 'person', subject: bob.subject_id } });
    await lease(catWs, (s) => s.holder.subject === bob.subject_id && s.expires_ms == null);
    close(bobWs);
    const away = await lease(catWs, (s) => s.holder.subject === bob.subject_id && s.expires_ms != null);
    assert.ok(away.state.expires_ms <= Date.now() + 400 + 50, 'the seat waits at most the grace');
    const released = await lease(catWs, (s) => s.holder.kind === 'nobody');
    assert.strictEqual(released.state.holder.subject, null);
    assert.strictEqual(released.reason, 'expired');

    // Back inside the minute: still theirs, with their own (open) expiry again.
    controlLease.setAwayGraceForTests(10000);
    let bobBack = await h.ws({ token: bob.token });
    await join(bobBack);
    annWs.sendJson({ type: 'lease.take' });
    await lease(catWs, (s) => s.holder.subject === ann.subject_id);
    annWs.sendJson({ type: 'lease.grant', to: { kind: 'person', subject: bob.subject_id } });
    await lease(catWs, (s) => s.holder.subject === bob.subject_id && s.expires_ms == null);
    close(bobBack);
    await lease(catWs, (s) => s.holder.subject === bob.subject_id && s.expires_ms != null);
    bobBack = await h.ws({ token: bob.token });
    await join(bobBack);
    const kept = await lease(catWs, (s) => s.holder.subject === bob.subject_id && s.expires_ms == null);
    assert.strictEqual(kept.state.holder.kind, 'person');
    controlLease.setAwayGraceForTests(60 * 1000);
    close(bobBack);

    close(annWs);
    close(catWs);
});

t('an AI can hold the remote, and only the owner takes it back', async () => {
    const annWs = await h.ws({ token: ann.token });
    const catWs = await h.ws({ token: cat.token });
    await join(annWs); await lease(annWs);
    await join(catWs); await lease(catWs);

    annWs.sendJson({ type: 'lease.take' });
    await lease(catWs, (s) => s.holder.subject === ann.subject_id);
    // A guest holding the remote cannot hand it to an AI: that is the owner's call.
    annWs.sendJson({ type: 'lease.grant', to: { kind: 'person', subject: cat.subject_id } });
    await lease(catWs, (s) => s.holder.subject === cat.subject_id);
    catWs.sendJson({ type: 'lease.grant', to: { kind: 'ai', subject: 'ai:vibe' } });
    assert.strictEqual((await catWs.next((m) => m.type === 'lease_error')).code, 'lease.not_owner');
    annWs.sendJson({ type: 'lease.take' });
    await lease(catWs, (s) => s.holder.subject === ann.subject_id);
    annWs.sendJson({ type: 'lease.grant', to: { kind: 'ai', subject: 'ai:vibe' } });
    const ai = await lease(catWs, (s) => s.holder.kind === 'ai');
    assert.strictEqual(ai.state.holder.subject, 'ai:vibe');
    annWs.sendJson({ type: 'sync', position_ms: 1 });
    const refused = await annWs.next((m) => m.type === 'sync_error');
    assert.strictEqual(refused.code, 'sync.not_holder', 'even the owner cannot move a remote an AI holds');
    annWs.sendJson({ type: 'lease.take' });
    assert.strictEqual((await lease(catWs, (s) => s.holder.subject === ann.subject_id)).state.holder.kind, 'person');

    close(annWs);
    close(catWs);
});

t('close', async () => {
    await h.close();
});

t.run();
