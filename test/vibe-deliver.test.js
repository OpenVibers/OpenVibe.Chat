'use strict';
/**
 * Each run is a chat you can open (server/chat/internal-vibe.js POST /internal/chat/vibe/deliver, capability
 * chat.vibe.deliver, contracts 0.214.0; migrations/0034_vibe_deliveries.sql): Actor posts an agent's run into the
 * person's Vibe chat named after the agent, as Vibe's message with a link to the whole run; the next run of the same
 * agent goes to the same chat, another agent gets its own; the same key posts once; no AI answer and nothing counted; the
 * person replies and Vibe answers seeing the result; a person Chat has not seen is 422; only a service token with the
 * capability reaches it; export and deletion carry the rows.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe deliver');
let h, ann, vibe;
const ACTOR = (cap = 'chat.vibe.deliver') => h.serviceToken([cap], { sub: 'svc:actor' });
const AGENT = 'agt_01JABCDEFGHJKMNPQRSTVWXYZ0';
const send = (body, token = ACTOR()) => h.http('POST', '/internal/chat/vibe/deliver', { token, body });
const calls = [];
const pushes = [];
let subject;
const run = (n, extra = {}) => ({ subject, source: { kind: 'agent', id: AGENT, name: 'Remote jobs' }, text: `**${n} new jobs** today:\n\n- [Editor](https://example.com/jobs/${n})`, url: `https://openvibe.actor/tasks/tsk_run${n}`, idempotency_key: `tsk_run${n}`, ...extra });

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    vibe = require('../server/rooms/vibe');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    subject = h.live.users.get(ann.id).subject_id;
    require('../server/inbox/notify')._setPush(async (n) => { pushes.push(n); return { sent: true }; });
    require('../server/ai/client')._setClient({
        runs: { create: async (workflow, input) => { calls.push({ workflow, input }); return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'The Editor one pays best.' } }] } } }; } },
    });
});

t('a run lands in the chat named after its agent, as Vibe, with the link; no AI answer and nothing counted', async () => {
    const before = await vibe.repliesToday({ id: ann.id });
    const r = await send(run(3));
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.repeated, false);
    assert.match(r.body.url, /^https:\/\/openvibe\.chat\/vibe\/v-[0-9a-f]{12}$/);
    const room = await h.db.get('SELECT * FROM rooms WHERE slug = ?', [r.body.chat]);
    assert.deepStrictEqual([room.name, room.assistant_source, Number(room.owner_id), Number(room.assistant)], ['Remote jobs', `agent:${AGENT}`, ann.id, 1]);
    const msgs = await h.db.all('SELECT message, ai_member_id FROM room_messages WHERE room_id = ? ORDER BY id', [room.id]);
    assert.strictEqual(msgs.length, 1);
    assert.ok(msgs[0].ai_member_id, 'Vibe\'s message');
    assert.strictEqual(msgs[0].message, '**3 new jobs** today:\n\n- [Editor](https://example.com/jobs/3)\n\n[See the whole run on OpenVibe Agents](https://openvibe.actor/tasks/tsk_run3)');
    assert.strictEqual(calls.length, 0, 'no AI answer');
    assert.strictEqual(await vibe.repliesToday({ id: ann.id }), before, 'nothing counted');
    assert.ok((await vibe.list({ id: ann.id })).some((c) => c.slug === r.body.chat), 'listed with their chats');
    for (let i = 0; i < 40 && !pushes.length; i++) await new Promise((res) => setTimeout(res, 25));
    assert.deepStrictEqual(pushes.map((n) => [n.subjectId, n.type, n.category, n.title, n.message, n.url]),
        [[subject, 'AGENT_RESULT', 'chat', 'Remote jobs has a new result', '3 new jobs today:', r.body.url]], 'one notification, to the chat');
});

t('the next run goes to the same chat; the same key posts once; another agent gets its own chat', async () => {
    const first = await send(run(3));
    assert.deepStrictEqual([first.status, first.body.repeated], [200, true]);
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(pushes.length, 1, 'a repeat tells nobody again');
    const next = await send(run(4));
    assert.strictEqual(next.status, 201);
    const room = await h.db.get('SELECT id FROM rooms WHERE slug = ?', [next.body.chat]);
    assert.strictEqual(Number((await h.db.get('SELECT count(*) AS n FROM room_messages WHERE room_id = ?', [room.id])).n), 2, 'one per run');
    const other = await send(run(5, { source: { kind: 'agent', id: 'agt_01JABCDEFGHJKMNPQRSTVWXYZ1', name: 'Price watch' } }));
    assert.notStrictEqual(other.body.chat, next.body.chat);
    assert.strictEqual((await h.db.get('SELECT name FROM rooms WHERE slug = ?', [other.body.chat])).name, 'Price watch');
});

t('the person replies in the chat and Vibe answers seeing the result', async () => {
    const room = await h.db.get('SELECT * FROM rooms WHERE assistant_source = ?', [`agent:${AGENT}`]);
    const r = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: ann.token, body: { message: 'Which one pays best?' } });
    assert.ok(r.status < 300, r.text);
    for (let i = 0; i < 80 && !calls.length; i++) await new Promise((res) => setTimeout(res, 25));
    assert.ok(calls.length, 'Vibe answered');
    const prompt = JSON.stringify(calls[0].input);
    assert.ok(prompt.includes('4 new jobs') && prompt.includes('Which one pays best?'), 'the result is in what Vibe reads');
});

t('refused: bad bodies, a person Chat has not seen, a token without the capability', async () => {
    assert.strictEqual((await send(run(6, { source: { kind: 'voice', id: 'dev_1' } }))).status, 400);
    assert.strictEqual((await send(run(6, { url: 'http://example.com/x' }))).status, 400);
    assert.strictEqual((await send({ ...run(6), idempotency_key: undefined })).status, 400);
    assert.strictEqual((await send(run(6, { text: 'x'.repeat(8001) }))).status, 400);
    assert.strictEqual((await send(run(6, { subject: ids.newId('user') }))).status, 422);
    assert.strictEqual((await send(run(6), ACTOR('chat.vibe.ask'))).status, 403);
    assert.strictEqual((await h.http('POST', '/internal/chat/vibe/deliver', { body: run(6) })).status, 401);
});

t('account export and deletion include the posted runs', async () => {
    const accountData = require('../server/chat/account-data');
    const sent = [];
    const ev = (type, payload) => ({ event_id: ids.newId('event'), event_type: type, version: 1, source: 'network', actor: { type: 'user', id: subject },
        timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: subject }, payload });
    assert.strictEqual(await accountData.apply(ev('network.account.export_requested', { export_id: `exp_${ids.ulid()}`, subject, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() }), { send: async (p, body) => { sent.push(body); return { ok: true, status: 200 }; } }), 'exported');
    const files = Object.fromEntries(sent[0].files.map((f) => [f.name, f.content]));
    assert.strictEqual(files['vibe_deliveries.json'].length, 3);
    assert.strictEqual(await accountData.apply(ev('network.account.deleted', { deletion_id: `del_${ids.ulid()}`, subject, aliases: [], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() }), { send: async () => ({ ok: true, status: 200 }) }), 'erased');
    assert.strictEqual(await h.db.get('SELECT 1 FROM vibe_deliveries WHERE user_id = ?', [ann.id]), undefined);
});

t.run(async () => { require('../server/ai/client')._setClient(null); require('../server/inbox/notify')._setPush(null); if (h && h.close) await h.close(); });
