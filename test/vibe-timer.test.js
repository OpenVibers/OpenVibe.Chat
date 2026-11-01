'use strict';
/**
 * The Dock's timer from a Vibe chat (plan L48 R2; server/rooms/vibe-timer.js and the start_timer and stop_timer
 * tools): only Vibe in its person's own chat has them; start_timer asks the Network to set that person's Dock timer
 * (Chat's own network.dock.timer.write token, X-OV-Subject) and answers with the timer the Dock will count down;
 * stop_timer clears it; a plain "a 25 minute timer" is recognised for the net in ai-members.js even when the model
 * only promised it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiTools, timer;

const t = suite('vibe timer');
let h, ann;
const sent = [];
let netAnswer = null;
const netFetch = async (url, o = {}) => {
    const call = { url: String(url), method: o.method || 'GET', subject: o.headers['X-OV-Subject'], auth: o.headers.Authorization, body: o.body ? JSON.parse(o.body) : null };
    sent.push(call);
    const { status, body } = netAnswer(call);
    return { ok: status < 300, status, json: async () => body };
};
// The timer the Dock reads (openvibe-shared/dock-timer.js start()).
const TIMER = { kind: 'focus', label: 'Write the post', started_at: '2026-11-01T09:00:00.000Z', ends_at: '2026-11-01T09:25:00.000Z', round: 1, rounds: 4, focus_min: 25, break_min: 5 };
const PLAIN = { kind: 'timer', started_at: '2026-11-01T09:00:00.000Z', ends_at: '2026-11-01T09:10:00.000Z' };
const vibeMember = { handle: 'vibe' };
const ownChat = { id: 1, assistant: 1 };
const run = async (name, args, ctx = {}) => JSON.parse(await aiTools.run(name, JSON.stringify(args), { member: vibeMember, room: ownChat, user: h.live.users.get(ann.id), fetchImpl: netFetch, ...ctx }));

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiTools = require('../server/rooms/ai-tools');
    timer = require('../server/rooms/vibe-timer');
    timer._setTokens({ getToken: async () => 'chat-network-token' });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    netAnswer = () => ({ status: 200, body: { state: { timer: TIMER }, counts: { running: 0, waiting: 0, unread: 0 }, sources_partial: false } });
});

t('only Vibe in its person\'s own chat has the tools', async () => {
    const names = (m, r) => aiTools.definitions(m, r).map((d) => d.function.name);
    ['start_timer', 'stop_timer'].forEach((n) => assert.ok(names(vibeMember, ownChat).includes(n), n));
    assert.ok(!names(vibeMember, { id: 2, assistant: 0 }).includes('start_timer'), 'Vibe added to a room: never');
    assert.ok(!names({ handle: 'dealer' }, ownChat).includes('start_timer'), 'another AI member: never');
    assert.match((await run('start_timer', { minutes: 25 }, { room: { id: 2, assistant: 0 } })).error, /no tool called start_timer/);
});

t('start_timer asks the Network to set that person\'s timer, and answers with the timer the Dock reads', async () => {
    const out = await run('start_timer', { minutes: 25, label: 'Write the post', focus_rounds: 4 });
    const call = sent[sent.length - 1];
    assert.strictEqual(call.method, 'PUT');
    assert.match(call.url, /\/api\/v1\/people\/usr_[0-9A-HJKMNP-TV-Z]{26}\/dock\/timer$/);
    assert.strictEqual(call.subject, h.live.users.get(ann.id).subject_id, 'X-OV-Subject is the person');
    assert.strictEqual(call.auth, 'Bearer chat-network-token');
    assert.deepStrictEqual(call.body, { minutes: 25, kind: 'focus', label: 'Write the post', rounds: 4 });
    assert.deepStrictEqual(out.timer, TIMER);
    assert.strictEqual(out.said, "Timer set: 25 min, focus. It's in the Dock on every site.");
});

t('a plain timer has no rounds and no focus', async () => {
    netAnswer = () => ({ status: 200, body: { state: { timer: PLAIN }, counts: { running: 0, waiting: 0, unread: 0 }, sources_partial: false } });
    const out = await run('start_timer', { minutes: 10 });
    assert.deepStrictEqual(sent[sent.length - 1].body, { minutes: 10 }, 'no kind, no rounds, no label');
    assert.strictEqual(out.timer.kind, 'timer');
    assert.strictEqual(out.said, "Timer set: 10 min. It's in the Dock on every site.");
});

t('stop_timer clears it', async () => {
    netAnswer = () => ({ status: 200, body: { state: { timer: null }, counts: { running: 0, waiting: 0, unread: 0 }, sources_partial: false } });
    const out = await run('stop_timer', {});
    assert.deepStrictEqual(sent[sent.length - 1].body, { clear: true });
    assert.strictEqual(out.stopped, true);
    assert.strictEqual(out.said, 'Timer stopped.');
});

t('a timer outside 1 to 180 minutes never reaches the Network', async () => {
    const before = sent.length;
    assert.match((await run('start_timer', { minutes: 0 })).error, /1 to 180/);
    assert.match((await run('start_timer', { minutes: 200 })).error, /1 to 180/);
    assert.strictEqual(sent.length, before, 'nothing was sent');
});

t('the Network\'s refusal reaches the model', async () => {
    netAnswer = () => ({ status: 422, body: { code: 'dock.invalid', detail: 'minutes: must be integer' } });
    const out = await run('start_timer', { minutes: 25 });
    assert.match(out.error, /minutes: must be integer/);
    netAnswer = () => ({ status: 403, body: { code: 'capability.denied', detail: 'network.dock.timer.write not granted' } });
    assert.match((await run('start_timer', { minutes: 25 })).error, /not granted/);
});

t('a plain "a 25 minute timer" is recognised; a question about timers is not', async () => {
    assert.deepStrictEqual(timer.fromRequest('a 25 minute timer'), { minutes: 25, kind: 'timer' });
    assert.deepStrictEqual(timer.fromRequest('Vibe, start a 25 minute focus timer'), { minutes: 25, kind: 'focus' });
    assert.deepStrictEqual(timer.fromRequest('set a timer for 10 minutes'), { minutes: 10, kind: 'timer' });
    assert.deepStrictEqual(timer.fromRequest('focus timer'), { minutes: 25, kind: 'focus' });
    assert.deepStrictEqual(timer.fromRequest('give me a pomodoro'), { minutes: 25, kind: 'focus' });
    assert.deepStrictEqual(timer.fromRequest('stop the timer'), { stop: true });
    assert.deepStrictEqual(timer.fromRequest('can you cancel my timer?'), { stop: true });
    assert.strictEqual(timer.fromRequest('how does the timer work?'), null, 'a question is not a request');
    assert.strictEqual(timer.fromRequest('what is in my dock?'), null);
    assert.strictEqual(timer.fromRequest('start a 200 minute timer'), null, 'out of range: let Vibe ask');
});

t('done', async () => { await h.close(); });

t.run(async () => { if (h && h.close) await h.close(); });
