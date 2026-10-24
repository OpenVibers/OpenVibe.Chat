'use strict';
/**
 * Vibe, OpenVibe's assistant, on openvibe.chat (server/rooms/vibe.js, vibe-routes.js, web/vibe-pages.js,
 * migrations/0015_vibe_chats.sql): a person starts a chat with a message, Vibe answers every message without being
 * named (its own instructions, a longer answer), the chat is private to them and kept out of their rooms, the daily
 * allowance is theirs across chats, deleting a chat deletes its messages, and the app page works signed in and out.
 * Vibe's answers render as escaped Markdown (public/web/vibe-md.js).
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const md = require('../public/web/vibe-md.js');
let aiClient, config, vibe;

const t = suite('vibe');
const SITE = 'https://openvibe.chat';
let h, ann, bob, slug;
const calls = [];
const vibeApi = (method, path, u, body) => h.http(method, `/api/chat/vibe${path}`, { token: u && u.token, body });
const rooms = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const web = async (method, path, u, fields) => {
    const headers = { ...(u ? { cookie: `ov_token=${u.token}` } : {}), ...(fields ? { 'content-type': 'application/x-www-form-urlencoded', origin: SITE } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: fields ? new URLSearchParams(fields).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
/** Vibe's answers in a chat, waiting until there are `n`. */
async function answers(s, n) {
    for (let i = 0; i < 60; i++) {
        const got = ((await rooms('GET', `/${s}/messages`, ann)).body.messages || []).filter((m) => m.ai_member_id);
        if (got.length >= n) return got;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Vibe gave fewer than ${n} answers in ${s}`);
}

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    aiClient = require('../server/ai/client');
    config = require('../server/config');
    vibe = require('../server/rooms/vibe');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({
        runs: {
            create: async (workflow, input) => {
                calls.push({ workflow, input });
                const n = calls.filter((c) => c.workflow === 'chat.member.turn').length;
                return { run: { status: 'succeeded', output: { choices: [{ message: { content: `**Answer ${n}**\n\n- rice\n- lentils` } }] } } };
            },
        },
    });
});

t('a first message starts a private chat named after it, and Vibe answers it unasked with its own instructions', async () => {
    const r = await vibeApi('POST', '', ann, { message: 'Plan a cheap dinner for four people tonight, nothing spicy please' });
    assert.strictEqual(r.status, 201, r.text);
    slug = r.body.room.slug;
    assert.ok(/^v-[0-9a-f]{12}$/.test(slug), slug);
    assert.strictEqual(r.body.room.name, 'Plan a cheap dinner for four people…');
    assert.deepStrictEqual([r.body.room.visibility, r.body.room.assistant], ['private', true]);
    assert.strictEqual(r.body.message.message, 'Plan a cheap dinner for four people tonight, nothing spicy please');
    const [a] = await answers(slug, 1);
    assert.deepStrictEqual([a.display_name, a.message], ['Vibe', '**Answer 1**\n\n- rice\n- lentils']);
    const turn = calls.find((c) => c.workflow === 'chat.member.turn');
    assert.ok(turn.input.messages[0].content.startsWith('You are Vibe, OpenVibe\'s assistant, in a private chat with Ann'), turn.input.messages[0].content.slice(0, 120));
    assert.strictEqual(turn.input.max_tokens, 1500);
    assert.ok(turn.input.tools.some((x) => x.function.name === 'read_page'), 'Vibe can read a page');
});

t('a follow-up is answered with the conversation so far', async () => {
    assert.strictEqual((await rooms('POST', `/${slug}/messages`, ann, { message: 'make it vegetarian' })).status, 201);
    await answers(slug, 2);
    const last = calls.filter((c) => c.workflow === 'chat.member.turn').pop();
    const prompt = last.input.messages[1].content;
    assert.ok(prompt.includes('Vibe (AI): **Answer 1**') && prompt.includes('Ann: make it vegetarian'), prompt.slice(0, 400));
    const list = await vibeApi('GET', '', ann);
    assert.deepStrictEqual(list.body.chats.map((c) => c.slug), [slug]);
    assert.deepStrictEqual(list.body.allowance, { per_day: config.ai.vibeRepliesPerDay, used_today: 2 });
});

t('the chat is theirs alone and stays out of their rooms', async () => {
    assert.strictEqual((await rooms('GET', `/${slug}`, bob)).status, 404);
    assert.strictEqual((await rooms('GET', `/${slug}/messages`, bob)).status, 404);
    assert.deepStrictEqual((await vibeApi('GET', '', bob)).body.chats, []);
    assert.strictEqual((await vibeApi('PATCH', `/${slug}`, bob, { name: 'mine now' })).status, 404);
    assert.strictEqual((await vibeApi('DELETE', `/${slug}`, bob)).status, 404);
    assert.strictEqual((await rooms('POST', `/${slug}/members`, ann, { username: 'bob', role: 'member' })).status, 409, 'nobody is added to a Vibe chat');
    assert.strictEqual((await rooms('PATCH', `/${slug}`, ann, { visibility: 'public' })).status, 409, 'a Vibe chat stays private');
    const mine = (await rooms('GET', '/', ann)).body;
    assert.ok(!mine.mine.some((r) => r.slug === slug) && !mine.public.some((r) => r.slug === slug), 'not listed with rooms');
    for (let i = 0; i < 3; i++) assert.strictEqual((await vibeApi('POST', '', ann, { message: `question ${i}` })).status, 201);
    assert.strictEqual((await rooms('POST', '/', ann, { name: 'Ann Room' })).status, 201, 'Vibe chats do not use up the rooms a person may own');
});

t('the daily allowance is the person\'s across all their chats', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const used = await vibe.repliesToday({ id: ann.id });
    const keep = config.ai.vibeRepliesPerDay;
    config.ai.vibeRepliesPerDay = used;
    try {
        const before = calls.length;
        assert.strictEqual((await rooms('POST', `/${slug}/messages`, ann, { message: 'one more?' })).status, 201);
        const got = await answers(slug, 3);
        assert.ok(/I have answered you \d+ times today, which is the free limit/.test(got[2].message), got[2].message);
        assert.strictEqual(calls.length, before, 'no model call past the allowance');
    } finally { config.ai.vibeRepliesPerDay = keep; }
});

t('rename, then delete: the chat and its messages go, the day\'s count stays', async () => {
    const r = await vibeApi('PATCH', `/${slug}`, ann, { name: 'Dinner for four' });
    assert.strictEqual(r.body.room.name, 'Dinner for four');
    const roomId = (await h.db.get('SELECT id FROM rooms WHERE slug = ?', [slug])).id;
    const used = await vibe.repliesToday({ id: ann.id });
    assert.strictEqual((await vibeApi('DELETE', `/${slug}`, ann)).status, 204);
    assert.strictEqual(Number((await h.db.get('SELECT COUNT(*) AS n FROM room_messages WHERE room_id = ?', [roomId])).n), 0);
    assert.strictEqual(await h.db.get('SELECT id FROM rooms WHERE id = ?', [roomId]), undefined);
    assert.strictEqual(await vibe.repliesToday({ id: ann.id }), used, 'deleting a chat gives no answers back');
    assert.strictEqual((await rooms('GET', `/${slug}`, ann)).status, 404);
});

t('the app page: signed out it invites a sign-in, signed in it lists the chats and starts one from a form', async () => {
    const out = await web('GET', '/vibe');
    assert.strictEqual(out.status, 200);
    assert.ok(out.text.includes('Hi, I&#39;m Vibe. What can I help with?') || out.text.includes('Hi, I\'m Vibe. What can I help with?'), 'the greeting');
    assert.ok(out.text.includes('data-signin="1"') && out.text.includes('Sign in to keep your chats'));
    assert.ok(!out.text.includes('id="ov-footer"'), 'the app has no footer');
    const signed = await web('GET', '/vibe', ann);
    assert.ok(signed.text.includes('What can I help with, Ann?'));
    assert.ok(signed.text.includes('class="vb-chat" href="/vibe/v-'), 'the rail lists their chats');
    const form = await web('POST', '/vibe', ann, { message: 'hello from a form' });
    assert.strictEqual(form.status, 303);
    assert.ok(/^\/vibe\/v-[0-9a-f]{12}$/.test(form.location), form.location);
    const page = await web('GET', form.location, ann);
    assert.ok(page.text.includes('hello from a form') && page.text.includes('vb-composer'));
    assert.strictEqual((await web('GET', form.location, bob)).status, 404, 'someone else\'s chat is not there');
});

t('answers render as escaped Markdown with http(s) links only', () => {
    assert.strictEqual(md.render('**hi** `<b>`'), '<p><strong>hi</strong> <code>&lt;b&gt;</code></p>');
    assert.ok(!md.render('<script>alert(1)</script>').includes('<script'));
    assert.ok(!md.render('[x](javascript:alert(1))').includes('href'));
    assert.ok(md.render('see https://openvibe.live/docs.').includes('<a href="https://openvibe.live/docs" rel="nofollow ugc noopener" target="_blank">https://openvibe.live/docs</a>.'));
    assert.ok(!md.render('[x](https://a.com" onmouseover="alert(1))').includes('onmouseover="'));
    assert.strictEqual(md.render('```\n<i>\n```'), '<pre><code>&lt;i&gt;</code></pre>');
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
