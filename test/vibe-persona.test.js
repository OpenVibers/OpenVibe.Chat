'use strict';
/**
 * Vibe personas (the owner, 2026-11-12): every Vibe conversation is named and faced from what it is about,
 * remade when its topic changes, on Chat's cheapest Exchange model, under the owner's monthly cap.
 *
 * The model answers here are recorded fixtures (test/fixtures/vibe-persona/recorded.json), fed through
 * aiClient._setClient(); the catalogue is injected too, so no test touches the network or a provider. The
 * Media upload is a stand-in. The behaviour under test is ours: when a persona is due, how a changed topic
 * is decided, what happens to an invalid glyph, the cap, the API shape and the owner-only panel.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const glyphs = require('openvibe-shared/glyphs');
const FIX = require('./fixtures/vibe-persona/recorded.json');

const t = suite('vibe personas');
let h, owner, ann, aiCalls, personaQueue, checkQueue, uploads, aiClient, media, persona;

const systemOf = (call) => String(((call.input && call.input.messages) || []).find((m) => m.role === 'system')?.content || '');
const isPersonaCall = (call) => call.workflow === 'ai.complete' && /You name a private chat/.test(systemOf(call));
const isCheckCall = (call) => call.workflow === 'ai.complete' && /You decide whether/.test(systemOf(call));
const personaCalls = () => aiCalls.filter(isPersonaCall);
const checkCalls = () => aiCalls.filter(isCheckCall);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, { tries = 120, ms = 50 } = {}) {
    for (let i = 0; i < tries; i++) {
        const value = await fn();
        if (value) return value;
        await sleep(ms);
    }
    throw new Error(`Timed out waiting for ${what}`);
}
const chatOf = async (slug, u = ann) => (await h.http('GET', `/api/vibe/chat?slug=${encodeURIComponent(slug)}`, { token: u.token })).body;
const waitAnswer = async (slug, n = 1) => until(async () => {
    const r = await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token });
    return (r.body.messages || []).filter((m) => m.ai_member_id).length >= n;
}, `an answer in ${slug}`);
const waitPersona = async (slug, pred = (p) => !!p) => until(async () => {
    const chat = await chatOf(slug);
    return chat.chat && pred(chat.chat.persona) ? chat.chat.persona : null;
}, `a persona in ${slug}`);
const ask = async (message, slug = null, u = ann) => {
    const r = await h.http('POST', '/api/vibe/ask', { token: u.token, body: { message, ...(slug ? { slug } : { fresh: true }) } });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.chat.slug;
};
const save = (body, u = owner) => h.http('POST', '/api/admin/persona', { token: u.token, body });
const clearSpend = async () => { await h.db.getDb().prepare('DELETE FROM vibe_persona_spend').run(); };
const resetAnswers = ({ personas = [], checks = [] } = {}) => {
    personaQueue = personas.slice();
    checkQueue = checks.slice();
};

t('boot', async () => {
    h = await boot();
    aiClient = require('../server/ai/client');
    media = require('../server/media/client');
    persona = require('../server/persona');
    owner = h.addUser('owner', { role: 'admin', is_owner: 1, subject: ids.newId('user') });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    for (const u of [owner, ann]) await h.ctx.upsertUser(h.live.users.get(u.id));
    persona._reset();
    aiCalls = [];
    uploads = [];
    resetAnswers();
    aiClient._setCatalog(async () => ({ models: [
        { slug: 'cheap/text', name: 'Cheap Text', kind: 'chat', offers: [{ price: { in: 0.01, out: 0.02 } }] },
        { slug: 'pricey/text', name: 'Pricey Text', kind: 'chat', offers: [{ price: { in: 10, out: 20 } }] },
        { slug: 'cheap/image', name: 'Cheap Image', kind: 'image', offers: [{ price: { in: 0.1, out: 0.2 } }] },
    ] }));
    aiClient._setClient({ runs: { create: async (workflow, input) => {
        aiCalls.push({ workflow, input });
        if (workflow === 'chat.persona.image') {
            return { run: { id: `img_${aiCalls.length}`, status: 'succeeded', output: { images: [{ b64: FIX.image.b64, url: null }], count: 1 }, usage: { cost_usd: 0.02 } } };
        }
        if (workflow !== 'ai.complete') return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'ok' } }] } } };
        let content;
        if (/You decide whether/.test(systemOf({ input }))) content = checkQueue.shift() || FIX.checks.no_change;
        else content = JSON.stringify(personaQueue.shift() || FIX.persona.first);
        return { run: { id: `run_${aiCalls.length}`, status: 'succeeded', output: { choices: [{ message: { content } }] }, usage: { cost_usd: 0.01 } } };
    } } });
    media._setClient({ upload: async (buffer, opts) => { uploads.push({ buffer, opts }); return { id: 'med_persona', public_url: 'https://media.openvibe.test/vibe-persona.png' }; } });
});

t('the first answer makes a persona, the chat takes its name, and both APIs carry the shape', async () => {
    await clearSpend();
    assert.strictEqual((await save({ enabled: true, text_model: '', images: false, check_every: 8, monthly_cap_usd: 5 })).status, 200);
    resetAnswers({ personas: [FIX.persona.first] });
    const slug = await ask('I want a quiet mechanical keyboard with hot-swap switches and a nice thock');
    await waitAnswer(slug);
    const p = await waitPersona(slug);
    assert.strictEqual(p.name, 'Keyboard Scout');
    assert.strictEqual(p.glyph, 'keyboard');
    assert.strictEqual(p.hue, 210);
    assert.strictEqual(p.topic, 'mechanical keyboards and switches');
    assert.strictEqual(p.image_url, null);
    assert.ok(Number.isFinite(Date.parse(p.made_at)), p.made_at);
    const chat = await chatOf(slug);
    assert.deepStrictEqual(chat.chat.persona, p, 'GET /api/vibe/chat carries the same shape');
    assert.strictEqual(chat.chat.name, 'Keyboard Scout', 'the persona names the conversation');
    const list = await h.http('GET', '/api/vibe/conversations', { token: ann.token });
    const item = list.body.conversations.find((c) => c.slug === slug);
    assert.deepStrictEqual(item.persona, p, 'every item of /api/vibe/conversations carries the shape');
    assert.strictEqual(aiCalls.filter(isPersonaCall)[0].input.model, 'cheap/text', 'Auto picks the cheapest chat model');
});

t('a topic check that says NO keeps the same persona and waits the interval', async () => {
    await clearSpend();
    assert.strictEqual((await save({ check_every: 2 })).status, 200);
    resetAnswers({ personas: [FIX.persona.first], checks: [FIX.checks.no_change] });
    const slug = await ask('Help me pick a keyboard switch that is not too loud');
    const first = await waitPersona(slug);
    await ask('What about keycaps that fit it?', slug);
    await until(async () => checkCalls().length >= 1, 'the topic check');
    await sleep(120);
    const same = await waitPersona(slug);
    assert.deepStrictEqual(same, first, 'NO leaves the made_at and every field alone');
    assert.strictEqual(same.name, 'Keyboard Scout');
});

t('a changed topic makes a new persona, and the old name and face go', async () => {
    await clearSpend();
    assert.strictEqual((await save({ check_every: 2 })).status, 200);
    resetAnswers({ personas: [FIX.persona.first, FIX.persona.changed], checks: [FIX.checks.changed] });
    const slug = await ask('My mechanical keyboard sounds hollow; what foam fits?');
    const first = await waitPersona(slug);
    await ask('Now I want to start a live stream with OBS and three cameras; where do I begin?', slug);
    const changed = await waitPersona(slug, (p) => p && p.name !== first.name);
    assert.strictEqual(changed.name, 'Stream Doctor');
    assert.strictEqual(changed.glyph, 'video');
    assert.strictEqual(changed.topic, 'live streaming setups and OBS');
    assert.strictEqual((await chatOf(slug)).chat.name, 'Stream Doctor');
});

t('an invalid glyph is retried and then replaced from the shared registry, never stored', async () => {
    await clearSpend();
    assert.strictEqual((await save({ check_every: 100 })).status, 200);
    resetAnswers({ personas: [FIX.persona.invalid_glyph, FIX.persona.invalid_glyph] });
    const slug = await ask('Tell me a ghost story about a house that hates doors');
    const p = await waitPersona(slug);
    await until(async () => personaCalls().length >= 2, 'the one retry');
    assert.strictEqual(p.name, 'Ghost Guide');
    assert.strictEqual(p.hue, 40, '400 wraps to 40');
    assert.ok(glyphs.NAMES.includes(p.glyph), `${p.glyph} is a glyph the registry names`);
    assert.ok(p.topic.includes('haunted') || p.topic.includes('ghost'), p.topic);
});

t('the monthly cap stops new personas: a run that reached it makes no call', async () => {
    await clearSpend();
    assert.strictEqual((await save({ check_every: 100, monthly_cap_usd: 0.001 })).status, 200);
    resetAnswers({ personas: [FIX.persona.first] });
    const first = await ask('What is a good first mechanical keyboard under a hundred dollars?');
    await waitAnswer(first);
    const made = await waitPersona(first);
    assert.strictEqual(made.name, 'Keyboard Scout');
    const spent = (await h.http('GET', '/api/admin/persona', { token: owner.token })).body.spend;
    assert.ok(spent.usd >= 0.01, `the run's own cost is recorded (${spent.usd})`);
    assert.strictEqual(spent.reached, true);
    const callsBefore = aiCalls.length;
    const second = await ask('What about a keyboard for a small desk?');
    await waitAnswer(second);
    await sleep(250);
    assert.strictEqual((await chatOf(second)).chat.persona, null, 'a chat past the cap gets no persona');
    assert.strictEqual(aiCalls.length, callsBefore, 'and no model call is made for it');
});

t('images on makes an avatar through the image model and stores it in Media', async () => {
    await clearSpend();
    assert.strictEqual((await save({ images: true, image_model: '', check_every: 100, monthly_cap_usd: 5 })).status, 200);
    resetAnswers({ personas: [FIX.persona.first] });
    const slug = await ask('Which keyboard plate material gives the best sound?');
    const p = await waitPersona(slug);
    assert.strictEqual(p.image_url, 'https://media.openvibe.test/vibe-persona.png');
    assert.strictEqual(uploads.length, 1);
    assert.ok(uploads[0].buffer.length > 8);
    const imageCall = aiCalls.find((c) => c.workflow === 'chat.persona.image');
    assert.strictEqual(imageCall.input.size, '256x256');
    assert.strictEqual(imageCall.input.model, 'cheap/image', 'Auto asks for the cheapest image model');
    assert.strictEqual((await save({ images: false })).status, 200);
});

t('only the owner reads or changes the panel; it lists and remakes only their own chats, never losing a title they chose', async () => {
    assert.strictEqual((await h.http('GET', '/api/admin/persona', { token: ann.token })).status, 403);
    assert.strictEqual((await save({ enabled: false }, ann)).status, 403);
    const state = await h.http('GET', '/api/admin/persona', { token: owner.token });
    assert.strictEqual(state.status, 200, state.text);
    assert.strictEqual(state.body.settings.enabled, true);
    assert.ok(state.body.spend && Number.isFinite(state.body.spend.usd));
    assert.ok(Array.isArray(state.body.conversations));
    assert.ok(state.body.models.text.some((m) => m.id === 'cheap/text'));
    assert.ok(state.body.models.image.some((m) => m.id === 'cheap/image'));

    const ownerPage = await h.http('GET', '/admin/persona', { token: owner.token });
    assert.strictEqual(ownerPage.status, 200);
    assert.match(ownerPage.text, /Vibe personas/);
    const annPage = await h.http('GET', '/admin/persona', { token: ann.token });
    assert.strictEqual(annPage.status, 403);
    assert.match(annPage.text, /Only the owner/);

    // Another person's Vibe chats are private: a persona's topic summarises them, so the panel never lists them and
    // the owner cannot remake one.
    const theirs = await ask('Help me plan a surprise party for my sister');
    await waitPersona(theirs);
    const listed = (await h.http('GET', '/api/admin/persona', { token: owner.token })).body.conversations.map((c) => c.slug);
    assert.ok(!listed.includes(theirs), 'someone else\'s chat is not on the owner\'s panel');
    const refused = await h.http('POST', '/api/admin/persona/remake', { token: owner.token, body: { slug: theirs } });
    assert.strictEqual(refused.status, 404, 'and it cannot be remade from there');

    const slug = await ask('I need to fix a squeaky desk; what tools should I get?', null, owner);
    await waitPersona(slug, (p) => !!p);
    assert.ok((await h.http('GET', '/api/admin/persona', { token: owner.token })).body.conversations.some((c) => c.slug === slug), 'the owner\'s own chat is listed');
    const renamed = await h.http('PATCH', `/api/chat/vibe/${slug}`, { token: owner.token, body: { name: 'My Own Desk Chat' } });
    assert.strictEqual(renamed.status, 200, renamed.text);
    resetAnswers({ personas: [FIX.persona.remade] });
    const made = await h.http('POST', '/api/admin/persona/remake', { token: owner.token, body: { slug } });
    assert.strictEqual(made.status, 200, made.text);
    assert.strictEqual(made.body.persona.name, 'Desk Mechanic');
    assert.strictEqual(made.body.persona.glyph, 'wrench');
    const chat = await chatOf(slug, owner);
    assert.strictEqual(chat.chat.name, 'My Own Desk Chat', 'a person\'s rename is never overwritten by a persona');
    assert.strictEqual(chat.chat.persona.name, 'Desk Mechanic');
});
