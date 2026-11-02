'use strict';
/**
 * "Plan my day" (plan L48 V3; server/rooms/vibe-day.js and the my_day tool): only Vibe in its person's own chat has it;
 * it reads the person's day from OpenVibe.Today as that person (Chat's own today.agenda.read token, X-OV-Subject) with
 * their reminders that fire in the next 24 hours, times in their zone; and in the answer that read the day, Vibe may
 * not set a reminder or start a timer: it suggests, and sets what the person agrees to when they reply.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiTools, day, reminders;

const t = suite('vibe plan my day');
let h, ann;
const sent = [];
const soon = (min) => new Date(Date.now() + min * 60_000).toISOString();
const todayFetch = async (url, o = {}) => {
    const u = String(url);
    sent.push({ url: u, method: o.method || 'GET', subject: o.headers['X-OV-Subject'], auth: o.headers.Authorization });
    if (/\/api\/v1\/me\/agenda\?days=1$/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ from: soon(-120), to: soon(1440), days: 1, follows_unavailable: false, events: [
            { id: 'evt_1', title: 'Dentist', starts_at: soon(90), ends_at: soon(150), kind: 'event', own: true, reminded: false, url: null },
            { id: 'evt_2', title: 'Tokyo walk', starts_at: soon(300), kind: 'stream', channel: 'japaneseoldguy', own: false, reminded: true, url: 'https://openvibe.live/@japaneseoldguy' },
            { id: 'evt_3', title: 'Next week', starts_at: soon(60 * 24 * 3), kind: 'event', own: true },
        ] }) };
    }
    if (/\/api\/v1\/reminders$/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ reminders: [
            { id: 'rem_01JABCDEFGHJKMNPQRSTVWXYZ0', title: 'Stretch', summary: 'Every 2 hours', next_at: soon(45), repeats: true, status: 'active' },
            { id: 'rem_01JABCDEFGHJKMNPQRSTVWXYZ1', title: 'Pay rent', summary: 'On the 1st', next_at: soon(60 * 24 * 20), repeats: true, status: 'active' },
        ] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
};
const vibeMember = { handle: 'vibe' };
const ownChat = { id: 1, assistant: 1 };
const run = async (name, args, ctx = {}) => JSON.parse(await aiTools.run(name, JSON.stringify(args), { member: vibeMember, room: ownChat, user: h.live.users.get(ann.id), fetchImpl: todayFetch, timezone: 'Asia/Tokyo', ...ctx }));

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiTools = require('../server/rooms/ai-tools');
    day = require('../server/rooms/vibe-day');
    reminders = require('../server/rooms/vibe-reminders');
    day._setTokens({ getToken: async () => 'chat-agenda-token' });
    reminders._setTokens({ getToken: async () => 'chat-reminder-token' });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
});

t('only Vibe in its person\'s own chat has my_day', async () => {
    const names = (m, r) => aiTools.definitions(m, r).map((d) => d.function.name);
    assert.ok(names(vibeMember, ownChat).includes('my_day'));
    assert.ok(!names(vibeMember, { id: 2, assistant: 0 }).includes('my_day'), 'Vibe added to a room: never');
    assert.ok(!names({ handle: 'dealer' }, ownChat).includes('my_day'), 'another AI member: never');
    assert.match((await run('my_day', {}, { room: { id: 2, assistant: 0 } })).error, /no tool called my_day/);
});

t('my_day reads the next 24 hours as the person: events and reminders, in their zone', async () => {
    const out = await run('my_day', {});
    const agenda = sent.find((c) => /me\/agenda/.test(c.url));
    assert.strictEqual(agenda.subject, h.live.users.get(ann.id).subject_id, 'X-OV-Subject is the person');
    assert.strictEqual(agenda.auth, 'Bearer chat-agenda-token', 'its own today.agenda.read token');
    assert.deepStrictEqual(out.events.map((e) => e.title), ['Dentist', 'Tokyo walk'], 'next week is not today');
    assert.strictEqual(out.events[0].yours, true);
    assert.strictEqual(out.events[1].reminded, true);
    assert.deepStrictEqual(out.reminders.map((r) => r.title), ['Stretch'], 'the rent reminder fires in 20 days, not today');
    assert.strictEqual(out.timezone, 'Asia/Tokyo');
    assert.match(out.events[0].at, /^[A-Z][a-z]{2} \d{2}:\d{2}$/, 'a time in their zone, the way Vibe should say it');
    assert.match(out.plan_rule, /Set nothing in this answer/);
    assert.strictEqual(out.manage, 'https://openvibe.today/me/week');
});

t('in the answer that read the day, nothing is set: Vibe suggests and asks first', async () => {
    const called = new Set(['my_day', 'set_reminder']);
    const set = await run('set_reminder', { text: 'stretch every 2 hours' }, { called });
    assert.match(set.error, /suggest it and ask first/);
    const timer = await run('start_timer', { minutes: 25 }, { called: new Set(['my_day', 'start_timer']) });
    assert.match(timer.error, /suggest it and ask first/);
    assert.ok(!sent.some((c) => c.method === 'POST'), 'nothing reached Today');
});

t('when Today cannot answer, Vibe is told so plainly', async () => {
    const down = async () => { throw new Error('ECONNREFUSED'); };
    const out = await run('my_day', {}, { fetchImpl: down });
    assert.match(out.error, /unreachable/);
});

t('"plan my day" reaches the model with the day already read, so a small model cannot skip it', async () => {
    const { PLAN_DAY } = require('../server/rooms/ai-members');
    ['Plan my day for me', 'plan out my afternoon', "what's on today?", 'What does my day look like', 'hows my week looking'].forEach((m) => assert.ok(PLAN_DAY.test(m), m));
    ['Plan a trip to Lisbon', 'remind me at 3pm', 'what is on TV'].forEach((m) => assert.ok(!PLAN_DAY.test(m), m));
    const aiClient = require('../server/ai/client');
    const seen = [];
    const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    aiClient._setClient({ runs: { create: async (workflow, ...rest) => { seen.push(JSON.stringify(rest)); return { run: { status: 'succeeded', output: workflow === 'chat.member.turn' ? say('Here is a plan. Shall I set the reminders?') : { text: 'ok' } } }; } } });
    const ask = await h.http('POST', '/api/vibe/ask', { token: ann.token, body: { message: 'Plan my day for me', timezone: 'Asia/Tokyo', fresh: true } });
    assert.strictEqual(ask.status, 201, ask.text);
    let answer = null;
    let tries = 0;
    while (!answer && tries++ < 60) {
        const r = await h.http('GET', `/api/vibe/chat?slug=${encodeURIComponent(ask.body.chat.slug)}&after=${ask.body.message.id}`, { token: ann.token });
        answer = (r.body.messages || []).find((m) => m.from === 'vibe') || null;
        if (!answer) await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.ok(answer, 'Vibe answered');
    assert.ok(seen.some((x) => x.includes('call_my_day')), 'the model saw the day as a my_day result');
    aiClient._setClient(null);
});

t('done', async () => { await h.close(); });

t.run();
