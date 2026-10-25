'use strict';
/**
 * Incoming hooks for workspace rooms (server/rooms/hooks.js, migration 0029): only the room's owner (staff, in the staff
 * room) makes one and sees its secret once; a delivery signed like an OpenVibe.Events delivery becomes a message from
 * the room's Vibe (a Watch firing, an OpenVibe event, a line); a missing, wrong or stale signature is 401, an unknown
 * hook 404, a body it cannot read 422; a repeat of a delivery id changes nothing; a hook with a queue kind adds a task
 * for the person who made it; the settings page lists hooks without their secrets.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, suite } = require('./helpers');

const t = suite('room hooks');
let h, staff, user, rooms, hooks, made;
const deliver = (id, body, secret, headers = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return h.http('POST', `/api/chat/hooks/${id}`, { raw, headers: { 'content-type': 'application/json', ...(secret ? signDeliveryHeaders(raw, secret) : {}), ...headers } });
};
const lastMessage = async () => {
    const room = await rooms.bySlug('staff');
    return h.db.getDb().prepare('SELECT message, ai_member_id FROM room_messages WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(room.id);
};

t('boot', async () => {
    h = await boot();
    rooms = require('../server/rooms/rooms');
    hooks = require('../server/rooms/hooks');
    staff = h.addUser('mia', { role: 'admin', subject: ids.newId('user') });
    user = h.addUser('pat', { subject: ids.newId('user') });
    for (const u of [staff, user]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('the owner makes a hook and sees its secret once; nobody else makes one', async () => {
    const room = await rooms.bySlug('staff');
    const me = await require('../server/live-context').getUserById(staff.id);
    made = await hooks.create(room, me, { label: 'Site errors' });
    assert.match(made.hook.id, /^rh_/);
    assert.match(made.secret, /^whsec_/);
    assert.ok(!JSON.stringify(await hooks.list(room)).includes(made.secret), 'never listed with its secret');
    const pat = await require('../server/live-context').getUserById(user.id);
    await assert.rejects(hooks.create(room, pat, { label: 'Mine' }), (e) => e.status === 404, 'not staff: no such room');
    const cookie = `ov_token=${staff.token}`;
    const r = await h.http('POST', '/r/staff/hooks', { headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, raw: 'label=Deploys&queue_kind=research' });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, /whsec_[A-Za-z0-9_-]+/);
    assert.match(r.text, /\/api\/chat\/hooks\/rh_/);
    const page = await h.http('GET', '/r/staff/settings', { headers: { cookie } });
    assert.match(page.text, /Site errors/);
    assert.match(page.text, /Deploys/);
    assert.ok(!/whsec_/.test(page.text), 'the settings page never shows a secret');
});

t('a signed Watch firing becomes a message from Vibe', async () => {
    const firing = { type: 'watch.watch.triggered', watch: { id: 'wch_1', name: 'Live home p95', url: 'https://openvibe.watch/watches/wch_1' }, check_run_id: 'run_1', observation: { value: 2.4, previous_value: 0.9 } };
    const r = await deliver(made.hook.id, firing, made.secret, { 'x-openvibe-delivery-id': 'run_1.0' });
    assert.strictEqual(r.status, 202, r.text);
    const m = await lastMessage();
    assert.ok(m.ai_member_id, 'from the room\'s Vibe');
    assert.strictEqual(m.message, '🔔 Site errors: Live home p95 fired: 2.4 (was 0.9)\nhttps://openvibe.watch/watches/wch_1');
    const again = await deliver(made.hook.id, firing, made.secret, { 'x-openvibe-delivery-id': 'run_1.0' });
    assert.strictEqual(again.status, 202);
    assert.strictEqual(again.body.repeat, true);
    assert.strictEqual((await lastMessage()).message, m.message);
});

t('other bodies: an event, a line; refusals', async () => {
    let r = await deliver(made.hook.id, { event: { type: 'media.vod.ready', data: { title: 'VOD 6100 is ready' } } }, made.secret);
    assert.strictEqual(r.status, 202);
    assert.strictEqual((await lastMessage()).message, '🔔 Site errors: media.vod.ready: VOD 6100 is ready');
    r = await deliver(made.hook.id, { text: 'Backup finished\u0007 in 4 minutes' }, made.secret);
    assert.strictEqual(r.status, 202);
    assert.strictEqual((await lastMessage()).message, '🔔 Site errors: Backup finished in 4 minutes');
    assert.strictEqual((await deliver(made.hook.id, { text: 'no signature' }, null)).status, 401);
    assert.strictEqual((await deliver(made.hook.id, { text: 'wrong key' }, 'whsec_notthesecretnotthesecret12345')).status, 401);
    const raw = JSON.stringify({ text: 'old' });
    const stale = signDeliveryHeaders(raw, made.secret, { now: Date.now() - 20 * 60_000 });
    assert.strictEqual((await h.http('POST', `/api/chat/hooks/${made.hook.id}`, { raw, headers: { 'content-type': 'application/json', ...stale } })).status, 401, 'stale');
    assert.strictEqual((await deliver('rh_nosuchhooknosuchhook123', { text: 'x' }, made.secret)).status, 404);
    assert.strictEqual((await deliver(made.hook.id, { nothing: true }, made.secret)).status, 422);
    assert.strictEqual((await deliver(made.hook.id, 'not json', made.secret)).status, 422);
});

t('a hook with a queue kind adds a task for the person who made it', async () => {
    const room = await rooms.bySlug('staff');
    const me = await require('../server/live-context').getUserById(staff.id);
    const q = await hooks.create(room, me, { label: 'Broken builds', queue_kind: 'code' });
    const r = await deliver(q.hook.id, { text: 'OpenVibe.Tools main is red' }, q.secret);
    assert.strictEqual(r.status, 202, r.text);
    assert.ok(r.body.task_id);
    const task = h.db.getDb().prepare('SELECT title, kind, via, requested_by, status FROM room_tasks WHERE id = ?');
    const row = await task.get(r.body.task_id);
    assert.deepStrictEqual([row.title, row.kind, row.via, Number(row.requested_by), row.status], ['Broken builds: OpenVibe.Tools main is red', 'code', 'api', staff.id, 'queued']);
    await hooks.remove(room, me, q.hook.id);
    assert.strictEqual((await deliver(q.hook.id, { text: 'gone' }, q.secret)).status, 404, 'a deleted hook is gone');
});

t('lineOf reads only the forms it knows', () => {
    assert.strictEqual(hooks.lineOf(null), null);
    assert.strictEqual(hooks.lineOf([1]), null);
    assert.strictEqual(hooks.lineOf({ text: '   ' }), null);
    assert.ok(!hooks.lineOf({ type: 'watch.watch.triggered', watch: { name: 'x', url: 'javascript:alert(1)' }, observation: {} }).text.includes('javascript'), 'only https links');
});

t.run(async () => { if (h && h.close) await h.close(); });
