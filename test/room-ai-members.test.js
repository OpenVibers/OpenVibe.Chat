'use strict';
/**
 * AI members of a room (server/rooms/ai-members.js, migrations/0012_room_ai_members.sql): the room's owner adds one;
 * writing @handle makes it answer through OpenVibe.AI's chat.member.reply with the recent messages and the room's
 * notes, as a room message with ai_member_id and its name, live to the room's sockets with a "writing" frame first.
 * Only managers change AI members; only the first one named answers; it never answers itself; the room's daily cap and
 * the switch hold; members can be added by account subject; the openvibe.chat pages show and manage them.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
// Required after boot(): the server's config reads the environment boot() sets.
let aiClient, aiMembers, config;

const t = suite('room AI members');
const SITE = 'https://openvibe.chat';
let h, ann, bob, cat;
// openvibe.chat pages: the session cookie; a form comes from the site itself; redirects are answers.
const web = async (method, path, u, fields) => {
    const headers = { cookie: `ov_token=${u.token}`, ...(fields ? { 'content-type': 'application/x-www-form-urlencoded', origin: SITE } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: fields ? new URLSearchParams(fields).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text() };
};
const api = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const calls = [];
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    aiClient = require('../server/ai/client');
    aiMembers = require('../server/rooms/ai-members');
    config = require('../server/config');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({
        runs: {
            create: async (workflow, input, o) => {
                calls.push({ workflow, input, o });
                return { run: { status: 'succeeded', output: { text: `Rice and lentils, ${input.asked_by}. (${input.memory || 'no notes'})` } } };
            },
        },
    });
    assert.strictEqual((await api('POST', '/', ann, { name: 'Our Kitchen', visibility: 'private' })).status, 201);
    const added = await api('POST', '/our-kitchen/members', ann, { subject: `user:${h.live.users.get(bob.id).subject_id}` });
    assert.strictEqual(added.status, 200, added.text);
    assert.strictEqual(added.body.username, 'bob', 'a member can be added by account subject (what Food knows)');
});

t('only the room\'s owner adds, changes and removes AI members; names are checked', async () => {
    assert.strictEqual((await api('POST', '/our-kitchen/ai-members', bob, { name: 'Pantry' })).status, 403);
    assert.strictEqual((await api('POST', '/our-kitchen/ai-members', ann, { name: '!' })).status, 422);
    const r = await api('POST', '/our-kitchen/ai-members', ann, { name: 'Pantry', persona: 'A cheerful cook', memory: 'Bob is vegetarian' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.name, r.body.handle, r.body.memory], ['Pantry', 'pantry', 'Bob is vegetarian']);
    assert.strictEqual((await api('POST', '/our-kitchen/ai-members', ann, { name: 'pantry' })).status, 409, 'one @pantry per room');
    const seen = await api('GET', '/our-kitchen/ai-members', bob);
    assert.deepStrictEqual(Object.keys(seen.body.ai_members[0]).sort(), ['enabled', 'handle', 'id', 'model', 'name'], 'members see who it is and its model, not its set-up');
    assert.strictEqual((await api('GET', '/our-kitchen/ai-members', ann)).body.ai_members[0].persona, 'A cheerful cook');
    assert.strictEqual((await api('PATCH', `/our-kitchen/ai-members/${r.body.id}`, bob, { memory: 'x' })).status, 403);
});

t('@pantry answers with the recent messages and the room\'s notes, live, attributed to the room', async () => {
    const bobWs = await h.ws({ token: bob.token }); bobWs.sendJson({ type: 'join_room', room: 'our-kitchen' });
    await bobWs.next((m) => m.type === 'room_joined');
    await api('POST', '/our-kitchen/messages', ann, { message: 'home late tonight' });
    const asked = await api('POST', '/our-kitchen/messages', bob, { message: 'hey @Pantry what can we cook?' });
    assert.strictEqual(asked.status, 201);
    await bobWs.next((m) => m.type === 'room_ai_typing' && m.name === 'Pantry');
    const reply = await bobWs.next((m) => m.type === 'room_message' && m.message.ai_member_id);
    assert.deepStrictEqual([reply.message.display_name, reply.message.username, reply.message.user_id], ['Pantry', 'pantry', 0]);
    assert.strictEqual(reply.message.message, 'Rice and lentils, Bob. (Bob is vegetarian)', 'asked_by is the display name');
    const call = calls[calls.length - 1];
    assert.strictEqual(call.workflow, 'chat.member.reply');
    assert.ok(call.input.transcript.includes('Ann: home late tonight') && call.input.transcript.includes('Bob: hey @Pantry'), call.input.transcript);
    assert.deepStrictEqual([call.input.ai_name, call.input.persona, call.input.room], ['Pantry', 'A cheerful cook', 'Our Kitchen']);
    assert.deepStrictEqual(call.o.attribution, { service: 'chat', type: 'room', id: String(reply.message.room_id), label: 'Our Kitchen' });
    const hist = (await api('GET', '/our-kitchen/messages', ann)).body.messages;
    assert.strictEqual(hist[hist.length - 1].display_name, 'Pantry', 'the history names it');
    bobWs.close();
});

t('no answer without a mention, to itself, or past the room\'s day; mentions are whole words', async () => {
    const before = calls.length;
    await api('POST', '/our-kitchen/messages', ann, { message: 'the pantry is empty' });
    await api('POST', '/our-kitchen/messages', ann, { message: 'mail me at x@pantryhouse.com' });
    await settle();
    assert.strictEqual(calls.length, before, 'no @pantry, no answer');
    const members = await aiMembers.list({ id: (await h.db.get("SELECT id FROM rooms WHERE slug = 'our-kitchen'")).id });
    assert.strictEqual(aiMembers.mentioned(members, '@pantry, hi'), members[0]);
    assert.strictEqual(aiMembers.mentioned(members, 'x@pantry'), null);

    const keep = config.ai.memberRepliesPerDay;
    config.ai.memberRepliesPerDay = 1;
    try {
        await api('POST', '/our-kitchen/messages', ann, { message: '@pantry again?' });
        await settle();
        const last = (await api('GET', '/our-kitchen/messages', ann)).body.messages.pop();
        assert.match(last.message, /my limit/, 'past the day\'s cap it says so instead of calling AI');
        assert.strictEqual(calls.length, before);
    } finally { config.ai.memberRepliesPerDay = keep; }
});

t('the switch: CHAT_AI_MEMBERS=0 keeps every AI member quiet', async () => {
    const before = calls.length;
    config.ai.members = false;
    try {
        await api('POST', '/our-kitchen/messages', ann, { message: '@pantry are you there?' });
        await settle();
        assert.strictEqual(calls.length, before);
    } finally { config.ai.members = true; }
});

t('the pages: AI messages are badged and not profile links; settings add and remove AI members', async () => {
    const page = await web('GET', '/r/our-kitchen', ann);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('<span class="oc-name oc-ai-name">Pantry</span> <span class="oc-badge oc-ai"'), 'badged');
    assert.ok(page.text.includes('<code>@pantry</code>'), 'the room says how to ask it');
    const settings = await web('GET', '/r/our-kitchen/settings', ann);
    assert.ok(settings.text.includes('id="oc-ai"') && settings.text.includes('Notes it always knows'));
    // One click adds Vibe, OpenVibe's assistant, as a member anyone can ask with @vibe; then the button goes.
    assert.ok(settings.text.includes('<input type="hidden" name="name" value="Vibe">') && settings.text.includes('Add Vibe</button>'));
    const vibeAdd = await web('POST', '/r/our-kitchen/ai-members', ann, { name: 'Vibe', persona: 'Vibe, OpenVibe\'s assistant' });
    assert.strictEqual(vibeAdd.status, 303, vibeAdd.text.slice(0, 200));
    const vibeMember = (await api('GET', '/our-kitchen/ai-members', ann)).body.ai_members.find((m) => m.handle === 'vibe');
    assert.ok(vibeMember, 'Vibe is a member');
    assert.ok(!(await web('GET', '/r/our-kitchen/settings', ann)).text.includes('Add Vibe</button>'), 'no second Vibe');
    assert.strictEqual((await web('POST', `/r/our-kitchen/ai-members/${vibeMember.id}/delete`, ann, { go: '1' })).status, 303);
    const add = await web('POST', '/r/our-kitchen/ai-members', ann, { name: 'Coach', persona: 'Keeps us honest' });
    assert.strictEqual(add.status, 303, add.text.slice(0, 200));
    const coach = (await api('GET', '/our-kitchen/ai-members', ann)).body.ai_members.find((m) => m.handle === 'coach');
    assert.ok(coach);
    assert.strictEqual((await web('POST', `/r/our-kitchen/ai-members/${coach.id}/delete`, ann, { go: '1' })).status, 303);
    assert.ok(!(await api('GET', '/our-kitchen/ai-members', ann)).body.ai_members.some((m) => m.handle === 'coach'));
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
