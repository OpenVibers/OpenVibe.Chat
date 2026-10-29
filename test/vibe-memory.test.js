'use strict';
/**
 * Vibe's memory of a person (server/rooms/vibe-memory.js, its remember/forget tools in server/rooms/ai-tools.js, the
 * prompt in ai-members.js, /vibe/memory and /api/chat/vibe/memory; migrations/0031_vibe_memory.sql): Vibe keeps a
 * note when asked, reads the notes in the person's own chats only (never a room it was added to), never while the memory
 * is off; notes refuse secrets, duplicates and more than MAX_NOTES; the person sees, adds, deletes and clears them on the
 * page and over the API, and nobody else reaches them; they go with the account export and deletion.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, aiTools, memory;

const t = suite('vibe memory');
const SITE = 'https://openvibe.chat';
let h, ann, bob;
const turns = [];
let script = [];   // the fake AI's answers to chat.member.turn, one per turn
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const callTools = (...tc) => ({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: tc }, finish_reason: 'tool_calls' }] });
const vibeApi = (method, path, u, body) => h.http(method, `/api/chat/vibe${path}`, { token: u && u.token, body });
const web = async (method, path, u, fields) => {
    const headers = { ...(u ? { cookie: `ov_token=${u.token}` } : {}), ...(fields ? { 'content-type': 'application/x-www-form-urlencoded', origin: SITE } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: fields ? new URLSearchParams(fields).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
const userOf = (u) => h.live.users.get(u.id);
/** Waits until Vibe has answered `n` times across the test (turns that ended in text). */
async function answered(n) {
    for (let i = 0; i < 80; i++) {
        if (turns.filter((x) => x.final).length >= n) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Vibe answered fewer than ${n} times`);
}
const lastSystem = () => turns.filter((x) => x.final).pop().input.messages[0].content;
const lastTools = () => turns.filter((x) => x.final).pop().input.tools.map((d) => d.function.name);

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    aiClient = require('../server/ai/client');
    aiTools = require('../server/rooms/ai-tools');
    memory = require('../server/rooms/vibe-memory');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(userOf(u));
    aiClient._setClient({
        runs: {
            create: async (workflow, input) => {
                const next = workflow === 'chat.member.turn' ? (script.shift() || (() => say('Sure.'))) : null;
                const output = next ? next(input) : { text: 'plain' };
                turns.push({ workflow, input: JSON.parse(JSON.stringify(input)), final: !!(output.choices && output.choices[0].message.content) });
                return { run: { status: 'succeeded', output } };
            },
        },
    });
});

t('notes: kept, listed newest first; secrets, duplicates, empty and too long are refused; full at MAX_NOTES', async () => {
    const a = userOf(ann);
    assert.ok((await memory.add(a, '  Ann is   vegetarian  ')).note, 'spaces folded');
    assert.deepStrictEqual((await memory.list(a)).map((n) => [n.text, n.source]), [['Ann is vegetarian', 'vibe']]);
    assert.match((await memory.add(a, 'ann is VEGETARIAN')).error, /already/);
    assert.match((await memory.add(a, 'Her card is 4111 1111 1111 1111')).error, /never keeps/);
    assert.match((await memory.add(a, 'My password is hunter2')).error, /never keeps/);
    assert.match((await memory.add(a, 'key sk-abcdefghijklmnop1234')).error, /never keeps/);
    assert.match((await memory.add(a, '   ')).error, /empty/);
    assert.match((await memory.add(a, 'x'.repeat(301))).error, /300/);
    assert.ok((await memory.add(a, 'Uses kilometres', { source: 'you' })).note);
    assert.deepStrictEqual((await memory.list(a)).map((n) => n.source), ['you', 'vibe'], 'newest first');
    const veg = (await memory.list(a))[1];
    assert.strictEqual(await memory.remove(userOf(bob), veg.id), false, 'not Bob\'s to remove');
    assert.strictEqual(await memory.remove(a, veg.id), true);
    const b = userOf(bob);
    for (let i = 0; i < memory.MAX_NOTES; i++) assert.ok((await memory.add(b, `note ${i}`)).note);
    assert.match((await memory.add(b, 'one more')).error, /full/);
    assert.strictEqual(await memory.clear(b), memory.MAX_NOTES);
});

t('the tools: only Vibe in its person\'s own chat with the memory on; another person\'s note cannot be forgotten', async () => {
    const vibeMember = { handle: 'vibe' };
    const ownChat = { id: 1, assistant: 1 };
    const names = (m, r, o) => aiTools.definitions(m, r, o).map((d) => d.function.name);
    assert.ok(names(vibeMember, ownChat, { memory: true }).includes('remember') && names(vibeMember, ownChat, { memory: true }).includes('forget'));
    assert.ok(!names(vibeMember, ownChat, { memory: false }).includes('remember'), 'memory off: no tool');
    assert.ok(!names(vibeMember, { id: 2, assistant: 0 }, { memory: true }).includes('remember'), 'Vibe added to a room: never');
    assert.ok(!names({ handle: 'dealer' }, ownChat, { memory: true }).includes('remember'), 'another AI member: never');
    assert.match(await aiTools.run('remember', '{"text":"x"}', { member: vibeMember, room: ownChat, user: userOf(ann) }), /no tool called remember/, 'a run without the memory flag');
    const bobNote = (await memory.add(userOf(bob), 'Bob likes jazz')).note;
    const out = JSON.parse(await aiTools.run('forget', JSON.stringify({ id: bobNote.id }), { member: vibeMember, room: ownChat, user: userOf(ann), memory: true }));
    assert.match(out.error, /no note/);
    assert.strictEqual((await memory.list(userOf(bob))).length, 1, 'Bob\'s note stays');
});

t('in a chat Vibe saves a note when asked; the next chat\'s instructions carry it; forget deletes it', async () => {
    script = [() => callTools(toolCall('c1', 'remember', { text: 'Ann has a dog called Pixel' })), () => say('Got it, I will remember Pixel.')];
    const r = await vibeApi('POST', '', ann, { message: 'Remember that my dog is called Pixel' });
    assert.strictEqual(r.status, 201, r.text);
    await answered(1);
    const notes = await memory.list(userOf(ann));
    assert.strictEqual(notes[0].text, 'Ann has a dog called Pixel');
    const row = await require('../server/db/database').get('SELECT room_id, source FROM vibe_memory WHERE id = ?', [notes[0].id]);
    assert.deepStrictEqual([row.source, Number(row.room_id) > 0], ['vibe', true], 'saved by Vibe, from that chat');
    const toolResult = turns.filter((x) => x.workflow === 'chat.member.turn')[1].input.messages.find((m) => m.role === 'tool');
    assert.match(toolResult.content, /"remembered":"Ann has a dog called Pixel"/);

    await vibeApi('POST', '', ann, { message: 'What should I name my cat?' });
    await answered(2);
    const sys = lastSystem();
    assert.ok(sys.includes('- Memory: when they ask you to remember something') && sys.includes('Never say you will remember something without calling remember'), sys);
    assert.ok(sys.includes(`[${notes[0].id}] Ann has a dog called Pixel`) && sys.includes(`[${notes[1].id}] Uses kilometres`), 'every note, with its id');
    assert.ok(lastTools().includes('remember') && lastTools().includes('forget'));

    script = [() => callTools(toolCall('c2', 'forget', { id: notes[0].id })), () => say('Forgotten.')];
    await vibeApi('POST', '', ann, { message: 'Forget about my dog' });
    await answered(3);
    assert.deepStrictEqual((await memory.list(userOf(ann))).map((n) => n.text), ['Uses kilometres']);
});

t('with the memory off Vibe neither reads nor saves; on again, it reads them', async () => {
    assert.deepStrictEqual((await vibeApi('PUT', '/memory/switch', ann, { on: false })).body, { on: false });
    assert.strictEqual((await vibeApi('PUT', '/memory/switch', ann, { on: 'no' })).status, 422);
    await vibeApi('POST', '', ann, { message: 'Hello again' });
    await answered(4);
    assert.ok(!lastSystem().includes('Uses kilometres') && !lastSystem().includes('- Memory:'), 'nothing read');
    assert.ok(lastSystem().includes('- Their memory is off: you keep no notes about them.'), 'and Vibe can say so');
    assert.ok(!lastTools().includes('remember'), 'nothing saved');
    assert.match((await memory.add(userOf(ann), 'Vibe tries anyway')).error, /off/);
    assert.ok((await memory.add(userOf(ann), 'Written by Ann herself', { source: 'you' })).note, 'their own notes still go in');
    await vibeApi('PUT', '/memory/switch', ann, { on: true });
    await vibeApi('POST', '', ann, { message: 'And now?' });
    await answered(5);
    assert.ok(lastSystem().includes('Written by Ann herself'));
});

t('a room Vibe was added to never reads anyone\'s notes', async () => {
    assert.strictEqual((await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Ann Crew', visibility: 'private' } })).status, 201);
    assert.strictEqual((await h.http('POST', '/api/chat/rooms/ann-crew/ai-members', { token: ann.token, body: { name: 'Vibe' } })).status, 201);
    await h.http('POST', '/api/chat/rooms/ann-crew/messages', { token: ann.token, body: { message: '@vibe what do you know about me?' } });
    await answered(6);
    assert.ok(!lastSystem().includes('Written by Ann herself') && !lastTools().includes('remember'));
});

t('the API: list, add, delete, clear; someone else\'s note is not there; signed out is refused', async () => {
    const list = await vibeApi('GET', '/memory', ann);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual([list.body.on, list.body.max, list.body.notes.map((n) => n.text)], [true, memory.MAX_NOTES, ['Written by Ann herself', 'Uses kilometres']]);
    const add = await vibeApi('POST', '/memory', ann, { text: 'Lives in Lyon' });
    assert.deepStrictEqual([add.status, add.body.note.source], [201, 'you']);
    assert.strictEqual((await vibeApi('POST', '/memory', ann, { text: 'lives in lyon' })).status, 422);
    assert.strictEqual((await vibeApi('DELETE', `/memory/${add.body.note.id}`, bob)).status, 404, 'Bob cannot delete Ann\'s note');
    assert.strictEqual((await vibeApi('DELETE', `/memory/${add.body.note.id}`, ann)).status, 204);
    assert.strictEqual((await vibeApi('GET', '/memory', null)).status, 401);
    assert.deepStrictEqual((await vibeApi('GET', '/memory', bob)).body.notes.map((n) => n.text), ['Bob likes jazz'], 'each sees only their own');
});

t('the page: the notes with Delete, add, switch, forget everything; signed out asks to sign in', async () => {
    const out = await web('GET', '/vibe/memory', null);
    // A gated page is served here with noindex, not redirected to Network sign-in (SEO-7).
    assert.strictEqual(out.status, 401);
    assert.match(out.text, /<meta name="robots" content="noindex/);
    assert.match(out.text, /href="\/auth\/login\?next=%2Fvibe%2Fmemory"/);
    const page = await web('GET', '/vibe/memory', ann);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /<h1>What Vibe remembers about you<\/h1>/);
    assert.match(page.text, /<b>Memory is on\.<\/b>/);
    assert.match(page.text, /<li><p>Uses kilometres<\/p><small>Added by you · /);
    assert.match(page.text, /<a href="\/vibe\/memory" title="[^"]+" aria-current="page">/, 'the rail marks Memory');
    assert.match(page.text, /noindex, nofollow/);
    const added = await web('POST', '/vibe/memory', ann, { text: 'Prefers short answers' });
    assert.deepStrictEqual([added.status, added.location], [303, '/vibe/memory']);
    const refused = await web('POST', '/vibe/memory', ann, { text: 'my password is swordfish' });
    assert.strictEqual(refused.status, 422);
    assert.ok(refused.text.includes('never keeps passwords') && refused.text.includes('value="my password is swordfish"'), 'the reason, and the text back in the box');
    const id = (await memory.list(userOf(ann))).find((n) => n.text === 'Prefers short answers').id;
    assert.strictEqual((await web('POST', `/vibe/memory/${id}/delete`, bob, {})).status, 303);
    assert.ok((await memory.list(userOf(ann))).some((n) => n.id === id), 'Bob\'s form deletes nothing of Ann\'s');
    await web('POST', `/vibe/memory/${id}/delete`, ann, {});
    assert.ok(!(await memory.list(userOf(ann))).some((n) => n.id === id));
    await web('POST', '/vibe/memory/switch', ann, { on: '0' });
    assert.match((await web('GET', '/vibe/memory', ann)).text, /<b>Memory is off\.<\/b>[\s\S]*Turn memory on/);
    await web('POST', '/vibe/memory/switch', ann, { on: '1' });
    assert.strictEqual(await memory.isOn(userOf(ann)), true);
    await web('POST', '/vibe/memory/clear', ann, {});
    assert.deepStrictEqual(await memory.list(userOf(ann)), []);
    assert.match((await web('GET', '/vibe/memory', ann)).text, /Nothing yet/);
    assert.match((await web('GET', '/vibe', ann)).text, /<a href="\/vibe\/memory" title="What Vibe remembers about you/, 'the rail links it from Vibe');
    assert.ok(!(await web('GET', '/vibe', null)).text.includes('href="/vibe/memory"'), 'signed out: no Memory link');
});

t('a plain "remember that …" is kept even when the model only promised it; a question, a reminder or a recollection is not', async () => {
    const pick = (t) => memory.fromRequest(t);
    assert.deepStrictEqual(['Please remember that my favourite colour is teal.', 'Don\'t forget I am allergic to peanuts.', 'Vibe, remember my birthday is May 3.'].map(pick),
        ['My favourite colour is teal', 'I am allergic to peanuts', 'My birthday is May 3']);
    assert.deepStrictEqual(['Remember to call mum tomorrow', 'Do you remember my name?', 'Remember when we met?', 'remember this', 'Don\'t forget the milk', 'Remember the time I asked about tacos', 'I remember that place.'].map(pick),
        [null, null, null, null, null, null, null]);
    script = [() => say('Sure, I will remember that.')];
    await vibeApi('POST', '', ann, { message: 'Please remember that I live in Lyon.' });
    await answered(7);
    assert.deepStrictEqual((await memory.list(userOf(ann))).map((n) => [n.text, n.source]), [['I live in Lyon', 'vibe']], 'kept although no remember call was made');
    await vibeApi('POST', '', ann, { message: 'Remember to call my mum tomorrow' });
    await answered(8);
    assert.strictEqual((await memory.list(userOf(ann))).length, 1, 'a reminder is not a note');
    await memory.clear(userOf(ann));
});

t('the account export carries the notes; deletion takes them', async () => {
    const b = userOf(bob);
    await memory.setOn(b, false);
    const accountData = require('../server/chat/account-data');
    const sent = [];
    const send = async (p, body) => { sent.push(body); return { ok: true, status: 200 }; };
    const ev = (type, payload) => ({ event_id: ids.newId('event'), event_type: type, version: 1, source: 'network', actor: { type: 'user', id: b.subject_id },
        timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: b.subject_id }, payload });
    assert.strictEqual(await accountData.apply(ev('network.account.export_requested', { export_id: `exp_${ids.ulid()}`, subject: b.subject_id, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() }), { send }), 'exported');
    const files = Object.fromEntries(sent[0].files.map((f) => [f.name, f.content]));
    assert.deepStrictEqual(files['vibe_memory.json'].map((n) => n.text), ['Bob likes jazz']);
    assert.strictEqual(files['vibe_memory_off.json'].length, 1);
    assert.strictEqual(await accountData.apply(ev('network.account.deleted', { deletion_id: `del_${ids.ulid()}`, subject: b.subject_id, aliases: [], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() }), { send }), 'erased');
    const db = require('../server/db/database');
    assert.deepStrictEqual([await db.get('SELECT 1 FROM vibe_memory WHERE user_id = ?', [b.id]), await db.get('SELECT 1 FROM vibe_memory_off WHERE user_id = ?', [b.id])], [undefined, undefined]);
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
