'use strict';
/**
 * Reminders from a Vibe chat (plan L48, V1; server/rooms/vibe-reminders.js and the set_reminder, my_reminders and
 * stop_reminder tools): only Vibe in its person's own chat has them; set_reminder sends the person's words and time
 * zone to OpenVibe.Today as that person (Chat's own today.reminder.write token, X-OV-Subject) and returns what Today
 * understood; Today's "Say when" reaches the model to ask; a plain "remind me …" is recognised for the net in
 * ai-members.js even when the model only promised it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiTools, reminders;

const t = suite('vibe reminders');
let h, ann;
const sent = [];
let todayAnswer = null;
const todayFetch = async (url, o = {}) => {
    const call = { url: String(url), method: o.method || 'GET', subject: o.headers['X-OV-Subject'], auth: o.headers.Authorization, body: o.body ? JSON.parse(o.body) : null };
    sent.push(call);
    const { status, body } = todayAnswer(call);
    return { ok: status < 300, status, json: async () => body };
};
const REM = { id: 'rem_01JABCDEFGHJKMNPQRSTVWXYZ0', title: 'Stretch', summary: 'Every 2 hours, 9 am–5 pm', next_at: '2026-11-02T15:00:00.000Z', repeats: true, status: 'active' };
const vibeMember = { handle: 'vibe' };
const ownChat = { id: 1, assistant: 1 };
const run = async (name, args, ctx = {}) => JSON.parse(await aiTools.run(name, JSON.stringify(args), { member: vibeMember, room: ownChat, user: h.live.users.get(ann.id), fetchImpl: todayFetch, timezone: 'America/Chicago', ...ctx }));

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiTools = require('../server/rooms/ai-tools');
    reminders = require('../server/rooms/vibe-reminders');
    reminders._setTokens({ getToken: async () => 'chat-today-token' });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
});

t('only Vibe in its person\'s own chat has the tools', async () => {
    const names = (m, r) => aiTools.definitions(m, r).map((d) => d.function.name);
    ['set_reminder', 'my_reminders', 'stop_reminder'].forEach((n) => assert.ok(names(vibeMember, ownChat).includes(n), n));
    assert.ok(!names(vibeMember, { id: 2, assistant: 0 }).includes('set_reminder'), 'Vibe added to a room: never');
    assert.ok(!names({ handle: 'dealer' }, ownChat).includes('set_reminder'), 'another AI member: never');
    assert.match((await run('set_reminder', { text: 'x at 3pm' }, { room: { id: 2, assistant: 0 } })).error, /no tool called set_reminder/);
});

t('set_reminder sends the person\'s words and time zone to Today as them, and returns what Today understood', async () => {
    todayAnswer = () => ({ status: 201, body: { ...REM, said: 'stretch every 2 hours from 9 to 5', source: 'vibe' } });
    const out = await run('set_reminder', { text: 'stretch every 2 hours from 9 to 5' });
    const call = sent[sent.length - 1];
    assert.strictEqual(call.method, 'POST');
    assert.match(call.url, /\/api\/v1\/reminders$/);
    assert.strictEqual(call.subject, h.live.users.get(ann.id).subject_id, 'X-OV-Subject is the person');
    assert.strictEqual(call.auth, 'Bearer chat-today-token');
    assert.deepStrictEqual(call.body, { text: 'stretch every 2 hours from 9 to 5', tz: 'America/Chicago', source: 'vibe', url: 'https://openvibe.chat/vibe' });
    assert.deepStrictEqual(out.reminder, { id: REM.id, title: 'Stretch', when: 'Every 2 hours, 9 am–5 pm', next_at: REM.next_at, repeats: true, status: 'active' });
    assert.strictEqual(out.manage, 'https://openvibe.today/me#reminders');
});

t('Today\'s "Say when" reaches the model, so it can ask', async () => {
    todayAnswer = () => ({ status: 422, body: { error: 'Say when: "at 3pm", "tomorrow morning", "every day at 9" or "in 20 minutes".' } });
    const out = await run('set_reminder', { text: 'water the plants' });
    assert.match(out.error, /^Say when/);
});

t('my_reminders lists the active ones; stop_reminder stops one by its id', async () => {
    todayAnswer = (c) => (c.method === 'GET' ? { status: 200, body: { reminders: [REM, { ...REM, id: 'rem_01JABCDEFGHJKMNPQRSTVWXYZ1', status: 'done' }] } } : { status: 200, body: { ...REM, status: 'done' } });
    const list = await run('my_reminders', {});
    assert.deepStrictEqual(list.reminders.map((r) => r.id), [REM.id], 'only the active ones');
    const stopped = await run('stop_reminder', { id: REM.id });
    assert.match(sent[sent.length - 1].url, new RegExp(`/api/v1/reminders/${REM.id}/done$`));
    assert.strictEqual(stopped.stopped.status, 'done');
    assert.match((await run('stop_reminder', { id: '../../etc' })).error, /not a reminder id/);
});

t('a plain "remind me …" is recognised; a question about reminders is not', async () => {
    assert.strictEqual(reminders.fromRequest('Remind me to stretch every 2 hours from 9 to 5'), 'Remind me to stretch every 2 hours from 9 to 5');
    assert.strictEqual(reminders.fromRequest('can you remind me to call mom on Sunday at 6pm?'), 'can you remind me to call mom on Sunday at 6pm');
    assert.ok(reminders.fromRequest('hey vibe, set a reminder for 3pm to call the bank'));
    assert.strictEqual(reminders.fromRequest('what reminders do I have?'), null);
    assert.strictEqual(reminders.fromRequest('that reminds me of a song'), null);
});

t('done', async () => { await h.close(); });
