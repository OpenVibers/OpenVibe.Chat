'use strict';
/**
 * Workspace rooms and the staff room (server/rooms/workspace.js, server/web/workspace-pages.js, migration 0027):
 * the staff room exists, only staff read it and each member of staff becomes a member; anyone who may post adds work;
 * quick kinds run at once as OpenVibe.Actor tasks of the person who asked and their results come back into the room
 * from Vibe; code work waits for a worker to claim it and report, or the asker runs it on their own computer through
 * Actor; cancel is the asker's or a moderator's; Vibe queues
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
        actorTask = { id: 'tsk_1', state: 'succeeded', result: { answer: 'Three large images block the first paint.', sources: ['https://example.com/a', { url: 'https://example.com/b' }, 'javascript:alert(1)'] }, cost: { usd: 0.0031, free_allowance_used: 0.0031 } };
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

t('run on my computer: the asker hands their code task to Actor, which runs it on their own machine', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, o) => (String(url).startsWith('http://127.0.0.1:4950') ? actorFetch(url, o) : realFetch(url, o));
    try {
        let r = await api('POST', '/rooms/staff/tasks', staff, { title: 'Fix the Tools favicon on dark tabs', kind: 'code', details: 'OpenVibe.Tools, public/favicon.svg' });
        const id = r.body.task.id;
        assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/run`, staff2)).status, 403, 'only the person who asked');
        const research = (await api('GET', '/rooms/staff/tasks?status=succeeded', staff)).body.tasks.find((x) => x.kind === 'research').id;
        assert.strictEqual((await api('POST', `/rooms/staff/tasks/${research}/run`, staff)).status, 409, 'code and computer work only');
        const cookie = `ov_token=${staff.token}`;
        assert.match((await h.http('GET', '/r/staff/queue', { headers: { cookie } })).text, new RegExp(`/r/staff/tasks/${id}/run"`), 'the asker sees the button');
        assert.ok(!(await h.http('GET', '/r/staff/queue', { headers: { cookie: `ov_token=${staff2.token}` } })).text.includes(`/tasks/${id}/run"`), 'nobody else does');
        actorTask = { id: 'tsk_2', state: 'queued' };
        actorCalls.length = 0;
        r = await api('POST', `/rooms/staff/tasks/${id}/run`, staff);
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.body.task.status, r.body.task.runner], ['running', 'actor'], 'taken while Actor holds it');
        const create = actorCalls.find((c) => c.method === 'POST');
        assert.strictEqual(create.subject, h.live.users.get(staff.id).subject_id);
        assert.match(create.body.task, /^Make this code change with OpenVibe\.Codes on my own computer[^:]*: Fix the Tools favicon on dark tabs\n\nOpenVibe\.Tools, public\/favicon\.svg$/);
        assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/claim`, staff2)).status, 409, 'nobody claims it twice');
        assert.strictEqual((await api('POST', `/rooms/staff/tasks/${id}/run`, staff)).status, 409, 'once');
        actorTask = { id: 'tsk_2', state: 'succeeded', result: { answer: 'Opened a pull request with the dark favicon.' } };
        await workspace.poll();
        r = await api('GET', `/rooms/staff/tasks/${id}`, staff);
        assert.deepStrictEqual([r.body.task.status, r.body.task.result], ['succeeded', 'Opened a pull request with the dark favicon.']);
    } finally { globalThis.fetch = realFetch; }
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

t('a workspace room shows its shared screen to members only; only a Bot screen link is taken', async () => {
    const link = 'https://openvibe.bot/screen/' + 'a'.repeat(43);
    let r = await api('PATCH', '/rooms/staff', staff, { screen_url: 'https://evil.test/screen/x' });
    assert.strictEqual(r.status, 422);
    r = await api('PATCH', '/rooms/staff', staff, { screen_url: link });
    assert.strictEqual(r.status, 200, r.text);
    r = await api('GET', '/rooms/staff', staff2);
    assert.strictEqual(r.body.screen.url, link);
    const page = await h.http('GET', '/r/staff', { headers: { cookie: `ov_token=${staff.token}` } });
    assert.match(page.text, new RegExp(`<iframe src="${link.replace(/\//g, '\\/')}"`));
    assert.match(page.headers.get('content-security-policy'), /frame-src 'self' https:\/\/openvibe\.bot/);
    assert.strictEqual((await api('GET', '/rooms/staff', user)).status, 404, 'others never see the link');
    assert.strictEqual((await api('PATCH', '/rooms/staff', staff, { screen_url: '' })).status, 200);
    assert.ok(!(await api('GET', '/rooms/staff', staff)).body.screen, 'cleared');
});

t('any community room\'s owner makes it a workspace (and Vibe joins); the staff room stays one; a call never becomes one', async () => {
    const r = await api('POST', '/rooms', user, { name: 'Pat Builds', visibility: 'private' });
    assert.strictEqual(r.status, 201, r.text);
    const slug = r.body.room.slug;
    const cookie = `ov_token=${user.token}`;
    let page = await h.http('GET', `/r/${slug}/settings`, { headers: { cookie } });
    assert.match(page.text, /name="workspace" value="1">/, 'the owner sees the switch, off');
    const form = (body) => h.http('POST', `/r/${slug}/settings`, { headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, raw: body });
    let res = await form('name=Pat+Builds&visibility=private&slow_seconds=0&has_workspace=1&workspace=1');
    assert.ok(res.status < 400 && /Saved\./.test(res.text), 'saved (the redirect is followed)');
    const room = await rooms.bySlug(slug);
    assert.ok(rooms.isWorkspace(room), 'now a workspace');
    const ai = await h.db.getDb().prepare('SELECT handle FROM room_ai_members WHERE room_id = ?').all(room.id);
    assert.deepStrictEqual(ai.map((a) => a.handle), ['vibe'], 'Vibe joined to run and announce the work');
    page = await h.http('GET', `/r/${slug}`, { headers: { cookie } });
    assert.match(page.text, /<aside class="oc-queue" id="oc-queue"/);
    assert.strictEqual((await api('POST', `/rooms/${slug}/tasks`, user, { title: 'Plan the launch week', kind: 'other' })).status, 201, 'the owner adds work');
    await api('PATCH', `/rooms/${slug}`, user, { screen_url: 'https://openvibe.bot/screen/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' });
    res = await form('name=Pat+Builds&visibility=private&slow_seconds=0&has_workspace=1');
    assert.ok(res.status < 400 && /Saved\./.test(res.text));
    const after = await rooms.bySlug(slug);
    assert.ok(!rooms.isWorkspace(after) && !after.screen_url, 'off again, and the screen goes with it');
    assert.strictEqual((await api('PATCH', '/rooms/staff', staff, { workspace: false })).status, 409, 'the staff room stays a workspace');
    const call = await api('POST', '/rooms', user, { name: 'Pat Calls', kind: 'call', visibility: 'private' });
    assert.strictEqual(call.status, 201, call.text);
    assert.strictEqual((await api('PATCH', `/rooms/${call.body.room.slug}`, user, { workspace: true })).status, 409, 'a call room never becomes one');
    const kim = h.addUser('kim', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(kim.id));
    assert.ok([403, 404].includes((await api('PATCH', `/rooms/${slug}`, kim, { workspace: true })).status), 'someone else cannot');
});

t('starting a room: the Workspace kind (preselected from ?new=workspace) makes a workspace with Vibe in it', async () => {
    const cookie = `ov_token=${user.token}`;
    const go = await fetch(`${h.base}/work`, { redirect: 'manual' });
    assert.deepStrictEqual([go.status, go.headers.get('location')], [302, '/rooms?new=workspace#oc-new-room'], 'the navbar\'s Work together');
    assert.match((await h.http('GET', '/rooms?new=workspace')).text, /next=%2Frooms%3Fnew%3Dworkspace/, 'signed out: sign in, then back to it');
    const list = await h.http('GET', '/rooms?new=workspace&name=Launch%20week%00', { headers: { cookie } });
    assert.match(list.text, /name="kind" value="workspace" checked/);
    assert.match(list.text, /value="Launch week"/, 'the name is filled in, without control characters');
    const res = await h.http('POST', '/rooms/new', { headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, raw: 'name=Launch+week&kind=workspace&private=1' });
    assert.ok(res.status < 400, res.text.slice(0, 200));
    const made = await h.db.getDb().prepare("SELECT slug FROM rooms WHERE name = 'Launch week' ORDER BY id DESC LIMIT 1").get();
    const room = await rooms.bySlug(made.slug);
    assert.ok(room && rooms.isWorkspace(room) && room.visibility === 'private' && room.kind === 'community');
    const ai = await h.db.getDb().prepare('SELECT handle FROM room_ai_members WHERE room_id = ?').all(room.id);
    assert.deepStrictEqual(ai.map((a) => a.handle), ['vibe']);
});

t.run(async () => { if (h && h.close) await h.close(); });
