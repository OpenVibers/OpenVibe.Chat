'use strict';
/**
 * The support inbox's first answer goes through OpenVibe.Actor (one-engine slice): one turn per answer, on the
 * visitor's own account when they are signed in and on Chat's own budget when they are not, with the answer, its
 * cost and its failures as words. The old direct path is gone: the OpenVibe.AI stand-in here throws if anything
 * asks it for an inbox answer.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('support inbox through Actor');
let h, inboxes, actorModule, aiClient;
let ann, carol, inbox;
const SITE = 'https://openvibe.chat';

/** The Actor stand-in: it records every turn and answers, fails or holds it as the test says. */
function fakeActor({ answer = 'We ship in 3-5 days. https://example.com/faq' } = {}) {
    const turns = [];
    const behavior = { fail: null, pending: false, answer };
    return {
        turns, behavior,
        async turn(args) {
            turns.push(args);
            if (behavior.fail) throw behavior.fail;
            const taskId = `tsk_test_${turns.length}`;
            if (behavior.pending) return { pending: true, taskId };
            return {
                pending: false, taskId, answer: behavior.answer,
                agent: 'openvibe-runtime', model: 'stand-in-model', costUsd: 0.00012,
                explanation: [{ selected: 'openvibe-runtime', reasons: ['the cheapest healthy offer for your ceiling'] }],
                latencyMs: 1500,
            };
        },
        async read() { return { id: 'tsk_test_1', state: 'succeeded', result: { answer: 'late' }, cost: { usd: 0 } }; },
    };
}

/** The AI stand-in: the inbox must not ask it for an answer any more. */
const loudAi = { runs: { create: async (workflow, input) => {
    if (String(workflow || '').startsWith('chat.member')) throw new Error('the inbox must not call OpenVibe.AI for an answer any more');
    return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'unused' } }] } } };
} } };

const agentsApi = (method, path, u, body) => h.http(method, `/api/chat/inboxes${path}`, { token: u && u.token, body });
const widget = (method, path, body, headers) => fetch(`${h.base}/api/chat/widget/inbox/${inbox.id}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
async function until(fn, label) {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`timed out: ${label}`);
}
const visitorMessages = async (token) => (await widget('GET', `/messages?token=${token}`)).body.messages;

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE, CHAT_INBOX_POSTS_PER_MINUTE: '500' } });
    inboxes = require('../server/inbox/inbox');
    actorModule = require('../server/inbox/actor');
    aiClient = require('../server/ai/client');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    for (const u of [ann, carol]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient(loudAi);
    const made = await agentsApi('POST', '', ann, { name: 'Acme', ai_instructions: 'We ship worldwide in 3-5 days.', knowledge_urls: 'https://example.com/faq' });
    assert.strictEqual(made.status, 201, made.text);
    inbox = made.body.inbox;
});

t('an anonymous visitor\'s answer goes to Actor on Chat\'s own budget, and the words are the same', async () => {
    const actor = fakeActor();
    actorModule._setActor(actor);
    try {
        const v = await widget('POST', '/visit', {});
        const token = v.body.token;
        await widget('POST', '/messages', { token, message: 'When do you ship?' });
        const messages = await until(async () => {
            const m = await visitorMessages(token);
            return m.some((x) => x.author === 'ai') ? m : null;
        }, 'Vibe answers');
        assert.strictEqual(actor.turns.length, 1, 'one Actor turn');
        const call = actor.turns[0];
        assert.strictEqual(call.subject, null, 'an anonymous visitor has no account: the turn is Chat\'s own, nobody impersonated');
        assert.ok(call.task.includes('We ship worldwide in 3-5 days.'), 'the inbox instructions travel with the turn');
        assert.ok(call.task.includes('When do you ship?'), 'the visitor\'s words travel with the turn');
        assert.strictEqual(call.conversation.product, 'chat');
        assert.match(call.conversation.id, /^inbox:/);
        assert.ok(call.tools.includes('read_page'), 'the inbox may read its own pages');
        assert.strictEqual(call.budgetUsd, require('../server/config').inbox.actorPerTurnUsd, 'the turn draws the inbox\'s per-turn budget');
        const said = messages.find((x) => x.author === 'ai');
        assert.ok(said.body.includes('We ship in 3-5 days.'), 'the answer the visitor reads');
    } finally { actorModule._setActor(null); }
});

t('a signed-in visitor\'s answer is their own turn, on their own allowance', async () => {
    const actor = fakeActor({ answer: 'Your order left the warehouse.' });
    actorModule._setActor(actor);
    try {
        const as = { authorization: `Bearer ${carol.token}` };
        const v = await widget('POST', '/visit', {}, as);
        const token = v.body.token;
        await widget('POST', '/messages', { token, message: 'Where is my order?' }, as);
        await until(async () => {
            const m = await visitorMessages(token);
            return m.some((x) => x.author === 'ai') ? m : null;
        }, 'Vibe answers');
        assert.strictEqual(actor.turns.length, 1, 'one Actor turn');
        const call = actor.turns[0];
        assert.strictEqual(call.subject, carol.subject_id, 'the turn is the visitor\'s own, named in X-OV-Subject');
        assert.match(call.subject, /^usr_/, 'a subject id, not a name');
        const said = (await visitorMessages(token)).find((x) => x.author === 'ai');
        assert.ok(said.body.includes('left the warehouse'), 'the answer the visitor reads');
    } finally { actorModule._setActor(null); }
});

t('the cost is charged once, to the budget the turn belongs to', async () => {
    const actor = fakeActor();
    actorModule._setActor(actor);
    try {
        const v = await widget('POST', '/visit', {});
        const token = v.body.token;
        await widget('POST', '/messages', { token, message: 'One question' });
        await until(async () => {
            const m = await visitorMessages(token);
            return m.some((x) => x.author === 'ai') ? m : null;
        }, 'Vibe answers');
        await widget('POST', '/messages', { token, message: 'And another' });
        await until(async () => {
            const m = await visitorMessages(token);
            return m.filter((x) => x.author === 'ai').length >= 2 ? m : null;
        }, 'Vibe answers again');
        assert.strictEqual(actor.turns.length, 2, 'two turns, two answers: the cost is charged once each');
        // The inbox's own daily counter counts the answers, once each.
        const usage = await h.db.get('SELECT replies FROM inbox_ai_usage WHERE inbox_id = ? AND day = ?', [inbox.id, new Date().toISOString().slice(0, 10)]);
        assert.ok(Number(usage.replies) >= 2, `the inbox counted its answers (${usage && usage.replies})`);
    } finally { actorModule._setActor(null); }
});

t('a refusal is words the visitor reads', async () => {
    const actor = fakeActor();
    actor.behavior.fail = new actorModule.TurnError(502, 'actor.task.failed', 'That answer did not pass its check, so it was not delivered.');
    actorModule._setActor(actor);
    try {
        const v = await widget('POST', '/visit', {});
        const token = v.body.token;
        await widget('POST', '/messages', { token, message: 'Something odd' });
        const messages = await until(async () => {
            const m = await visitorMessages(token);
            return m.some((x) => x.author === 'ai') ? m : null;
        }, 'Vibe answers');
        const said = messages.find((x) => x.author === 'ai');
        assert.ok(said.body.includes('did not pass its check'), `the refusal in plain words: ${said.body}`);
    } finally { actorModule._setActor(null); }
});

t('an outage is words the visitor reads, and nothing falls back to AI', async () => {
    const actor = fakeActor();
    actor.behavior.fail = new actorModule.TurnError(503, 'actor.unreachable', 'The assistant could not be reached just now. Nothing was charged. Try again in a moment.');
    actorModule._setActor(actor);
    try {
        const v = await widget('POST', '/visit', {});
        const token = v.body.token;
        await widget('POST', '/messages', { token, message: 'Are you there?' });
        const messages = await until(async () => {
            const m = await visitorMessages(token);
            return m.some((x) => x.author === 'ai') ? m : null;
        }, 'Vibe answers');
        const said = messages.find((x) => x.author === 'ai');
        assert.ok(said.body.includes('could not be reached'), `the outage in plain words: ${said.body}`);
    } finally { actorModule._setActor(null); }
});

t('the old direct path is gone: the inbox answers through Actor only', async () => {
    // The AI stand-in throws for any chat.member workflow, so an inbox answer through OpenVibe.AI fails this test.
    const actor = fakeActor();
    actorModule._setActor(actor);
    try {
        const v = await widget('POST', '/visit', {});
        const token = v.body.token;
        await widget('POST', '/messages', { token, message: 'Does this still call AI directly?' });
        await until(async () => {
            const m = await visitorMessages(token);
            return m.some((x) => x.author === 'ai') ? m : null;
        }, 'Vibe answers');
        assert.strictEqual(actor.turns.length, 1, 'the answer came from Actor');
        // And the source itself no longer asks AI for an answer.
        const source = require('fs').readFileSync(require.resolve('../server/inbox/inbox'), 'utf8');
        assert.ok(!/aiClient\.structured|ai\/client/.test(source), 'the inbox no longer reaches for OpenVibe.AI');
    } finally { actorModule._setActor(null); }
});

t.run();
