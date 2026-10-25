'use strict';
/**
 * Workspace rooms and the staff room (server/rooms/workspace.js, server/web/workspace-pages.js, migration 0027):
 * the staff room exists, only staff read it and each member of staff becomes a member; anyone who may post adds work;
 * quick kinds run at once as OpenVibe.Actor tasks of the person who asked and their results come back into the room
 * from Vibe; code work waits for a worker to claim it and report; cancel is the asker's or a moderator's; Vibe queues
 * work with queue_task in a workspace room and nowhere else; the room page shows the queue beside the conversation.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('workspace rooms');
let h, staff, staff2, user, aiTools, workspace, rooms;
const api = (method, path, u, body) => h.http(method, `/api/chat${path}`, { token: u && u.token, body });
const actorCalls = [];
let actorTask = { id: 'tsk_1', state: 'queued' };
const actorFetch = async (url, o = {}) => {
    actorCalls.push({ url, method: o.method || 'GET', subject: o.headers['X-OV-Subject'], body: o.body ? JSON.parse(o.body) : null });
    if ((o.method || 'GET') === 'POST' && /\/cancel$/.test(url)) return { ok: true, status: 200, json: async () => ({ ...actorTask, state: 'cancelled' }) };
    if ((o.method || 'GET') === 'POST') return { ok: true, status: 201, json: async () => actorTask };
    return { ok: true, status: 200, json: async () => actorTask };
};

t('boot: the staff room is there, with Vibe', async () => {
    h = await boot();
    workspace = require('../server/rooms/workspace');
    rooms = require('../server/rooms/rooms');
    aiTools = require('../server/rooms/ai-tools');
    workspace._setTokens({ getToken: async () => 'chat-actor-token' });
    require('../server/config').oauth.clientSecret = require('../server/config').oauth.clientSecret || 'test-secret';
    staff = h.addUser('mia', { role: 'admin', subject: ids.newId('user') });
    staff2 = h.addUser('ola', { role: 'global_mod', subject: ids.newId('user') });
    user = h.addUser('pat', { subject: ids.newId('user') });
    for (const u of [staff, staff2, user]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const room = await rooms.bySlug('staff');
    assert.ok(room && rooms.isWorkspace(room) && room.visibility === 'private');
    const ai = await h.db.getDb().prepare("SELECT handle FROM room_ai_members WHERE room_id = ?").all(room.id);
    assert.deepStrictEqual(ai.map((a) => a.handle), ['vibe']);
});

t('only staff read the staff room; each becomes a member on their first visit', async () => {
    let r = await api('GET', '/rooms/staff', user);
    assert.strictEqual(r.status, 404, 'not even that it exists');
    assert.strictEqual((await api('GET', '/rooms/staff/tasks', user)).status, 404);
    assert.strictEqual((await api('GET', '/rooms/staff', null)).status, 404);
    r = await api('GET', '/rooms/staff', staff);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.room.workspace, true);
    const room = await rooms.bySlug('staff');
    const a = await rooms.access(room, await require('../server/live-context').getUserById(staff.id));
    assert.ok(a.post, 'staff post');
    assert.strictEqual((await h.db.getDb().prepare("SELECT role FROM room_members WHERE room_id = ? AND user_id = ?").get(room.id, staff.id)).role, 'member');
    // Someone who is not staff reads nothing there, even with a membership row (a former member of staff).
    await h.db.getDb().prepare("INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')").run(room.id, user.id);
    assert.strictEqual((await api('GET', '/rooms/staff/tasks', user)).status, 404, 'membership alone is not enough');
    assert.strictEqual((await api('POST', '/rooms/staff/messages', user, { message: 'hi' })).status, 404);
});

t('a quick task runs on Actor as the person who asked; its result comes back from Vibe', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, o) => (String(url).startsWith('http://127.0.0.1:4950') ? actorFetch(url, o) : realFetch(url, o));
    try {
        let r = await api('POST', '/rooms/staff/tasks', staff, { title: 'Why does the Live home load slowly on phones', kind: 'research', details: 'Look at the last week.' });
        assert.strictEqual(r.status, 201, r.text);
        const task = r.body.task;
        assert.strictEqual(task.kind, 'research');
        assert.strictEqual(task.quick, true);
        assert.strictEqual(task.runner, 'actor');
        const create = actorCalls.find((c) => c.method === 'POST');
        assert.strictEqual(create.subject, h.live.users.get(staff.id).subject_id, 'Actor runs it as the person who asked');
        assert.match(create.body.task, /^Research this and write a short report for a team, with the links of your sources: Why does the Live home/);
        assert.strictEqual(create.body.idempotency_key, `chat-room-task-${task.id}`);
        assert.strictEqual((await api('POST', `/rooms/staff/tasks/${task.id}/claim`, staff2)).status, 409, 'Actor runs it: nobody claims it');
        // Actor finishes; the poller stores the result and Vibe posts it in the room.
        actorTask = { id: 'tsk_1', state: 'succeeded', result: { answer: 'Three large images block the first paint.', sources: ['https://example.com/a', { url: 'https://example.com/b' }, 'javascript:alert(1)'] }, cost: { total_usd: 0.0031 } };
        await workspace.poll();
        r = await api('GET', `/rooms/staff/tasks/${task.id}`, staff2);
        assert.strictEqual(r.body.task.status, 'succeeded');
        assert.strictEqual(r.body.task.result, 'Three large images block the first paint.');
        assert.deepStrictEqual(r.body.task.sources, ['https://example.com/a', 'https://example.com/b'], 'only http(s) links');
        assert.strictEqual(r.body.task.cost_usd, 0.0031);
        const msgs = (await api('GET', '/rooms/staff/messages', staff)).body.messages;
        const last = msgs[msgs.length - 1];
        assert.ok(last.ai_member_id && /^✅ Done: "Why does the Live home load slowly on phones" \(asked by Mia\)/.test(last.message), last.message);
        assert.match(last.message, /Three large images block the first paint\./);
        assert.match(last.message, new RegExp(`/r/staff/tasks/${task.id}$`));
        await workspace.poll();
        assert.strictEqual((await api('GET', '/rooms/staff/messages', staff)).body.messages.length, msgs.length, 'announced once');
    } finally { globalThis.fetch = realFetch; }
});

t('code work waits for a worker: claim, report, the room hears it', async () => {
    let r = await api('POST', '/rooms/staff/tasks', staff, { title: 'Add a dark favicon to Tools', kind: 'code' });
    assert.strictEqual(r.status, 201);
    const id = r.body.task.id;
    assert.strictEqual(r.body.task.status, 'queued');
    assert.strictEqual(r.body.task.runner, null);
    assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/report`, staff2, { status: 'succeeded' })).status, 409, 'claim first');
    r = await api('POST', `/rooms/staff/tasks/${id}/claim`, staff2, { runner: 'codex harness' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.task.status, 'running');
    assert.strictEqual(r.body.task.runner, 'codex harness (for ola)');
    assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/claim`, staff)).status, 409, 'taken');
    assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/report`, staff2, { status: 'succeeded', result_url: 'http://x.test/pr' })).status, 422, 'https only');
    r = await api('POST', `/rooms/staff/tasks/${id}/report`, staff2, { status: 'succeeded', result: 'Added favicon-dark.svg and the media query.', result_url: 'https://github.com/OpenVibers/OpenVibe.Tools/pull/1' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.task.status, 'succeeded');
    const msgs = (await api('GET', '/rooms/staff/messages', staff)).body.messages;
    assert.match(msgs[msgs.length - 1].message, /^✅ Done: "Add a dark favicon to Tools"[\s\S]*https:\/\/github\.com\/OpenVibers\/OpenVibe\.Tools\/pull\/1/);
});

t('cancel: the asker or a moderator; others not', async () => {
    let r = await api('POST', '/rooms/staff/tasks', staff2, { title: 'Draft the November roadmap', kind: 'other' });
    const id = r.body.task.id;
    assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/cancel`, staff2)).body.task.status, 'cancelled');
    r = await api('POST', '/rooms/staff/tasks', staff2, { title: 'x' });
    assert.strictEqual(r.status, 422, 'a title says what to do');
    assert.strictEqual((await api('POST', '/rooms/staff/tasks', user, { title: 'Sneak in' })).status, 404, 'not staff: no such room');
});

t('Vibe queues work in a workspace room only', async () => {
    const room = await rooms.bySlug('staff');
    const names = (r) => aiTools.definitions({ handle: 'vibe' }, r).map((d) => d.function.name);
    assert.ok(names(room).includes('queue_task') && names(room).includes('queue_status'));
    assert.ok(!names({ slug: 'game-night', workspace: 0 }).includes('queue_task'));
    const me = await require('../server/live-context').getUserById(staff.id) || { id: staff.id, role: 'admin', username: 'mia', display_name: 'Mia' };
    const out = JSON.parse(await aiTools.run('queue_task', JSON.stringify({ title: 'Make the staff room screen shareable', kind: 'code', details: 'Plan only.' }), { member: { handle: 'vibe' }, room, user: me, messageId: 7 }));
    assert.strictEqual(out.queued.kind, 'code');
    assert.match(out.queued.runs, /worker/);
    const row = await h.db.getDb().prepare('SELECT via, source_message FROM room_tasks WHERE id = ?').get(out.queued.id);
    assert.deepStrictEqual([row.via, Number(row.source_message)], ['vibe', 7]);
    const status = JSON.parse(await aiTools.run('queue_status', '{}', { member: { handle: 'vibe' }, room, user: me }));
    assert.ok(status.tasks.some((x) => x.title === 'Make the staff room screen shareable' && x.status === 'queued'));
    assert.match(await aiTools.run('queue_task', '{"title":"nope","kind":"code"}', { member: { handle: 'vibe' }, room: { slug: 'x', workspace: 0 }, user: me }), /no tool called queue_task/);
});

t('the room page shows the queue beside the conversation; the task page has the full result', async () => {
    const cookie = `ov_token=${staff.token}`;
    let r = await h.http('GET', '/r/staff', { headers: { cookie } });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /<div class="oc-ws"><div class="oc-ws-main"><ol class="oc-feed"/);
    assert.match(r.text, /<aside class="oc-queue" id="oc-queue"[^>]*data-queue="\/r\/staff\/queue"/);
    assert.match(r.text, /Add a dark favicon to Tools/);
    r = await h.http('GET', '/r/staff/queue', { headers: { cookie } });
    assert.match(r.text, /^<h2 id="oc-queue-h">Work queue/);
    const id = (await api('GET', '/rooms/staff/tasks?status=succeeded', staff)).body.tasks.find((x) => x.kind === 'research').id;
    r = await h.http('GET', `/r/staff/tasks/${id}`, { headers: { cookie } });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Three large images block the first paint\./);
    assert.match(r.text, /run by OpenVibe\.Actor/);
    assert.strictEqual((await h.http('GET', `/r/staff/tasks/${id}`, { headers: { cookie: `ov_token=${user.token}` } })).status, 404);
});

t.run(async () => { if (h && h.close) await h.close(); });
