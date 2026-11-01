'use strict';
/**
 * What Vibe really did in its answer (plan L48, V2: the result chips; server/rooms/vibe-results.js,
 * migrations/0036_vibe_results.sql): the reminders and timers Vibe set or stopped are kept with the answer, as a
 * small JSON list on the message (room_messages.results), and the person can undo one of them
 * (POST /api/vibe/undo): only in their own chat, only what Vibe set, and only within a day of the answer.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe results');
let h, ann, bob, bot, aiClient;
let script = [];
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const callTools = (...tc) => ({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: tc }, finish_reason: 'tool_calls' }] });

// OpenVibe.Today, the stand-in: it takes the reminder Vibe sets and stops it again.
const REM = { id: 'rem_01JABCDEFGHJKMNPQRSTVWXYZ0', title: 'Stretch', summary: 'Every 2 hours, 9 am–5 pm', next_at: '2026-11-02T15:00:00.000Z', repeats: true, status: 'active' };
const today = { calls: [] };
const todayServer = http.createServer(async (req, res) => {
    const raw = await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s)); });
    today.calls.push({ method: req.method, url: req.url, subject: req.headers['x-ov-subject'], body: raw ? JSON.parse(raw) : null });
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/api/v1/reminders') return send(201, { ...REM, source: 'vibe' });
    if (req.method === 'POST' && /\/api\/v1\/reminders\/rem_[0-9A-Z]+\/done$/.test(req.url)) return send(200, { ...REM, status: 'done' });
    if (req.method === 'GET' && req.url === '/api/v1/reminders') return send(200, { reminders: [REM] });
    return send(404, { error: 'not found' });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Vibe's answer in that chat, as the Dock reads it. */
async function answer(slug, after) {
    for (let i = 0; i < 80; i++) {
        const r = await h.http('GET', '/api/vibe/chat?slug=' + encodeURIComponent(slug) + '&after=' + after, { token: ann.token });
        const v = (r.body.messages || []).find((m) => m.from === 'vibe');
        if (v) return v;
        await wait(50);
    }
    throw new Error('Vibe did not answer');
}
const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

t('boot', async () => {
    await new Promise((r) => todayServer.listen(0, '127.0.0.1', r));
    todayServer.unref();
    const local = 'http://127.0.0.1:' + todayServer.address().port;
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat', CHAT_TODAY_INTERNAL_URL: local } });
    aiClient = require('../server/ai/client');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    bot = h.addUser('bot', { subject: ids.newId('user'), apiScopes: ['rooms.read'] });
    for (const u of [ann, bob, bot]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({ runs: { create: async (workflow) => ({ run: { status: 'succeeded', output: workflow === 'chat.member.turn' ? (script.shift() || (() => say('Sure.')))() : { text: 'plain' } } }) } });
});

t('the reminder Vibe set is kept with its answer', async () => {
    script = [() => callTools(toolCall('c1', 'set_reminder', { text: 'stretch every 2 hours from 9 to 5' })), () => say('Set: **Stretch**, every 2 hours.')];
    const asked = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Remind me to stretch every 2 hours' } });
    assert.strictEqual(asked.status, 201, asked.text);
    const a = await answer(asked.body.chat.slug, asked.body.message.id);
    assert.deepStrictEqual(a.results, [{
        kind: 'reminder', action: 'set', id: REM.id, title: 'Stretch', when: 'Every 2 hours, 9 am–5 pm', url: 'https://openvibe.today/me#reminders',
    }], 'the chip says what Vibe did');
    const chat = await h.http('GET', '/api/vibe/chat?slug=' + encodeURIComponent(asked.body.chat.slug), { token: ann.token });
    const mine = chat.body.messages.find((m) => m.id === asked.body.message.id);
    assert.strictEqual(mine.results, undefined, 'the person\'s own message has no results');
    const stored = await h.db.getDb().prepare('SELECT results FROM room_messages WHERE id = ?').get(a.id);
    assert.deepStrictEqual(stored.results, a.results, 'the same list is kept with the message');
});

t('an answer with nothing to show carries no results', async () => {
    script = [() => say('Hello!')];
    const asked = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'hello' } });
    const a = await answer(asked.body.chat.slug, asked.body.message.id);
    assert.strictEqual(a.results, undefined);
});

t('a plain "remind me …" the model only promised is a result too', async () => {
    script = [() => say('Of course, I will remind you.')];
    const asked = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'remind me to stretch every 2 hours from 9 to 5' } });
    const a = await answer(asked.body.chat.slug, asked.body.message.id);
    assert.deepStrictEqual((a.results || []).map((r) => [r.kind, r.action, r.title]), [['reminder', 'set', 'Stretch']], 'the net set it, so it is kept');
});

t('undo stops the reminder and is offered only once', async () => {
    script = [() => callTools(toolCall('c1', 'set_reminder', { text: 'stretch every 2 hours from 9 to 5' })), () => say('Set.')];
    const asked = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Remind me to stretch every 2 hours' } });
    const a = await answer(asked.body.chat.slug, asked.body.message.id);
    today.calls.length = 0;
    const undone = await h.http('POST', '/api/vibe/undo', { token: ann.token, body: { message_id: a.id, index: 0 } });
    assert.strictEqual(undone.status, 200, undone.text);
    assert.deepStrictEqual(undone.body.results, [{ kind: 'reminder', action: 'stopped', id: REM.id, title: 'Stretch', when: 'Every 2 hours, 9 am–5 pm', url: 'https://openvibe.today/me#reminders' }]);
    assert.deepStrictEqual(undone.body.undone, { kind: 'reminder', id: REM.id, title: 'Stretch' });
    const stopped = today.calls.filter((c) => c.url.endsWith('/done'));
    assert.strictEqual(stopped.length, 1, 'the reminder was stopped at OpenVibe.Today');
    assert.strictEqual(stopped[0].subject, ann.subject_id, 'as the person themself');
    const again = await h.http('POST', '/api/vibe/undo', { token: ann.token, body: { message_id: a.id, index: 0 } });
    assert.strictEqual(again.status, 409, again.text);
    assert.strictEqual(today.calls.filter((c) => c.url.endsWith('/done')).length, 1, 'and not stopped twice');
    const chat = await h.http('GET', '/api/vibe/chat?slug=' + encodeURIComponent(asked.body.chat.slug), { token: ann.token });
    const kept = chat.body.messages.find((m) => m.id === a.id);
    assert.deepStrictEqual(kept.results[0].action, 'stopped', 'the chip reads as stopped, not as something to undo');
});

t('only the person themself may undo it', async () => {
    script = [() => callTools(toolCall('c1', 'set_reminder', { text: 'stretch every 2 hours from 9 to 5' })), () => say('Set.')];
    const asked = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Remind me to stretch every 2 hours' } });
    const a = await answer(asked.body.chat.slug, asked.body.message.id);
    const other = await h.http('POST', '/api/vibe/undo', { token: bob.token, body: { message_id: a.id, index: 0 } });
    assert.strictEqual(other.status, 404, 'someone else\'s answer is not there to undo');
    const api = await h.http('POST', '/api/vibe/undo', { token: bot.token, body: { message_id: a.id, index: 0 } });
    assert.strictEqual(api.status, 403, 'an API token is not a person');
    const nowhere = await h.http('POST', '/api/vibe/undo', { token: ann.token, body: { message_id: 999999, index: 0 } });
    assert.strictEqual(nowhere.status, 404);
});

t('a result of a day and a half ago is gone for good', async () => {
    script = [() => callTools(toolCall('c1', 'set_reminder', { text: 'stretch every 2 hours from 9 to 5' })), () => say('Set.')];
    const asked = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Remind me to stretch every 2 hours' } });
    const a = await answer(asked.body.chat.slug, asked.body.message.id);
    await h.db.getDb().prepare('UPDATE room_messages SET created_at = ? WHERE id = ?').run(ago(25), a.id);
    const old = await h.http('POST', '/api/vibe/undo', { token: ann.token, body: { message_id: a.id, index: 0 } });
    assert.strictEqual(old.status, 410, old.text);
    today.calls.length = 0;
    assert.strictEqual(today.calls.length, 0, 'and nothing was stopped');
});

t('the Dock\'s own timer shape reads as a chip', async () => {
    const results = require('../server/rooms/vibe-results');
    assert.deepStrictEqual(results.ofTool('start_timer', { timer: { kind: 'focus', focus_min: 25, rounds: 4, started_at: '2026-11-01T10:00:00.000Z', ends_at: '2026-11-01T10:25:00.000Z' } }),
        { kind: 'timer', action: 'set', title: '25 min focus' }, 'a focus block says how long it runs');
    assert.deepStrictEqual(results.ofTool('start_timer', { timer: { kind: 'timer', minutes: 10, label: 'Coffee' } }),
        { kind: 'timer', action: 'set', title: '10 min Coffee' }, 'a plain countdown says so too');
    assert.deepStrictEqual(results.ofTool('stop_timer', { stopped: { kind: 'focus', focus_min: 25 } }),
        { kind: 'timer', action: 'stopped', title: '25 min focus' });
    assert.strictEqual(results.ofTool('start_timer', { error: 'no timer' }), null, 'a tool that changed nothing is no chip');
    assert.strictEqual(results.ofTool('web_search', { ok: true }), null, 'and neither is something else Vibe did');
});

t('done', async () => { if (aiClient) aiClient._setClient(null); todayServer.close(); await h.close(); });

t.run();
