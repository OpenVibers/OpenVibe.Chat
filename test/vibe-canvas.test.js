'use strict';
/**
 * The agent's canvas beside a Vibe chat (plan HO9): the page names the newest Actor task's thread and loads
 * openvibe-shared's ov-canvas.js only on Vibe's chat pages; the browser reads the document with the person's own
 * token, and a newer non-Actor task (or no task) means there is nothing to draw. The client itself is read-only:
 * it asks OVCanvas for a drawn canvas without onCheck/onAsk, and filters buttons out before drawing.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe canvas');
const TASK = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB';
let h, ann, workspace, room, slug, task;

const pageJson = (html) => JSON.parse((/window\.__OV_PAGE = (\{.*?\});\n/.exec(html) || [])[1].replace(/\\u003c/g, '<')).chat;

t('boot: a Vibe chat whose newest task is Actor\'s', async () => {
    h = await boot();
    workspace = require('../server/rooms/workspace');
    workspace._setTokens({ getToken: async () => 'chat-actor-token' });
    ann = h.addUser('mira', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, o = {}) => {
        if (!String(url).startsWith('http://127.0.0.1:4950')) return realFetch(url, o);
        return { ok: true, status: (o.method || 'GET') === 'POST' ? 201 : 200, json: async () => ({ id: TASK, state: 'running' }) };
    };
    const r = await h.http('POST', '/api/chat/vibe', { token: ann.token, body: { message: 'Plan three days in Lisbon for two', mode: 'research' } });
    assert.strictEqual(r.status, 201, r.text);
    slug = r.body.room.slug;
    task = r.body.task;
    assert.strictEqual(task.actor_task, TASK);
    room = await require('../server/rooms/rooms').bySlug(slug);
});

t('the Vibe page names the Actor thread, loads ov-canvas.js, and allows the Actor origin', async () => {
    const p = await h.http('GET', `/vibe/${slug}`, { headers: { cookie: `ov_token=${ann.token}` } });
    assert.strictEqual(p.status, 200, p.text.slice(0, 300));
    const cfg = pageJson(p.text);
    assert.deepStrictEqual(cfg.canvas, { thread: TASK, task: task.id, status: 'running' });
    assert.match(p.text, /shared\/ov-canvas\.js/, 'the shared renderer is on the page');
    assert.match(String(p.headers.get('content-security-policy') || ''), /connect-src[^;]*https:\/\/openvibe\.actor/, 'the browser may read the canvas from Actor');

    const home = await h.http('GET', '/', { headers: { cookie: `ov_token=${ann.token}` } });
    assert.strictEqual(home.status, 200);
    assert.ok(!/shared\/ov-canvas\.js/.test(home.text), 'ov-canvas.js is only on Vibe pages');
});

t('a newer task that is not Actor\'s leaves nothing to draw', async () => {
    const user = h.live.users.get(ann.id);
    await h.db.getDb().prepare(`INSERT INTO room_tasks (room_id, title, details, kind, requested_by, requested_subject, via, status)
        VALUES (?, ?, '', 'code', ?, ?, 'person', 'queued')`).run(room.id, 'A task a person takes', ann.id, user.subject_id);
    const newest = await workspace.newestActor(room, user);
    assert.strictEqual(newest, null, 'the newest task has no Actor thread');
    const p = await h.http('GET', `/vibe/${slug}`, { headers: { cookie: `ov_token=${ann.token}` } });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(pageJson(p.text).canvas, null);
    assert.match(p.text, /shared\/ov-canvas\.js/, 'the Vibe chat page still has the renderer for the next task');
});

t('the client draws it read-only and refreshes only while the task runs', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'web', 'vibe.js'), 'utf8');
    assert.match(src, /Open in Actor to tick or press/);
    assert.match(src, /ACTOR \+ '\/chat\/' \+ encodeURIComponent\(canvas\.thread\)/);
    assert.match(src, /filter\(function \(b\) \{ return b && b\.type !== 'button'; \}\)/, 'buttons are not drawn');
    assert.match(src, /window\.OVCanvas\.render\(host, shown, \{\}\)/, 'no onCheck or onAsk: the canvas only shows');
    assert.match(src, /credentials: 'omit'/, 'the person\'s Bearer, no cookies');
    assert.match(src, /\}, 30000\);/, 'at most every 30 s while the task runs');
    assert.match(src, /m\.type === 'room_task'[\s\S]{0,120}canvasTaskStatus/, 'a task status change refreshes it');
});

t.run();
