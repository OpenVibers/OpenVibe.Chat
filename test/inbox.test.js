'use strict';
/**
 * Support inboxes (server/inbox/, docs/platform.md): an owner makes an inbox and gets the snippet; a visitor writes from
 * the widget with only a token; Vibe answers first from the inbox's instructions (and hands off when it ends with
 * [HANDOFF]); "Talk to a person" hands off too; the inbox's people see and answer conversations, which stops Vibe;
 * resolving closes one and the next message starts another; the socket delivers to the visitor and to the people; the
 * embed page's frame-ancestors follow the allowed sites; the pages work for the people.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, inboxes;

const t = suite('support inbox');
const SITE = 'https://openvibe.chat';
let h, ann, bob, inbox, token, conv;
const turns = [];
let reply = 'We ship in 3-5 days. https://example.com/faq';
const agentsApi = (method, path, u, body) => h.http(method, `/api/chat/inboxes${path}`, { token: u && u.token, body });
const widget = (method, path, body, headers) => fetch(`${h.base}/api/chat/widget/inbox/${inbox.id}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
async function until(fn, label) {
    for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`timed out: ${label}`);
}
const visitorMessages = async () => (await widget('GET', `/messages?token=${token}`)).body.messages;

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    aiClient = require('../server/ai/client');
    inboxes = require('../server/inbox/inbox');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({ runs: { create: async (workflow, input) => {
        turns.push({ workflow, input });
        return { run: { status: 'succeeded', output: { choices: [{ message: { content: reply } }] } } };
    } } });
});

t('an owner makes an inbox and gets the snippet; bad sites and pages are refused', async () => {
    assert.strictEqual((await agentsApi('POST', '', ann, { name: 'Acme', allowed_origins: 'not a site' })).status, 422);
    assert.strictEqual((await agentsApi('POST', '', ann, { name: 'Acme', knowledge_urls: 'http://plain.example/faq' })).status, 422, 'pages Vibe reads are https');
    const r = await agentsApi('POST', '', ann, { name: 'Acme', ai_instructions: 'We ship worldwide in 3-5 days.', knowledge_urls: 'https://example.com/faq' });
    assert.strictEqual(r.status, 201, r.text);
    inbox = r.body.inbox;
    assert.ok(/^inb_[0-9A-HJKMNP-TV-Z]{26}$/.test(inbox.id));
    assert.strictEqual(r.body.embed.script, `<script src="${SITE}/widget.js" data-inbox="${inbox.id}" async></script>`);
    assert.deepStrictEqual((await agentsApi('GET', '', ann)).body.inboxes.map((i) => [i.id, i.role]), [[inbox.id, 'owner']]);
    const pub = (await widget('GET', '')).body.inbox;
    assert.deepStrictEqual(Object.keys(pub).sort(), ['ai', 'color', 'greeting', 'id', 'name'], 'the widget learns no instructions or people');
});

t('a visitor writes with only a token, and Vibe answers from the inbox\'s instructions', async () => {
    const v = await widget('POST', '/visit', {});
    assert.strictEqual(v.status, 200);
    token = v.body.token;
    assert.ok(/^[A-Za-z0-9_-]{32}$/.test(token));
    assert.strictEqual(v.body.conversation, null);
    const p = await widget('POST', '/messages', { token, message: 'How long does shipping take?', page_url: 'https://shop.example/cart' });
    assert.strictEqual(p.status, 201, JSON.stringify(p.body));
    conv = p.body.conversation;
    assert.deepStrictEqual([conv.status, conv.page_url], ['bot', 'https://shop.example/cart']);
    const msgs = await until(async () => { const m = await visitorMessages(); return m.some((x) => x.author === 'ai') && m; }, 'Vibe\'s answer');
    assert.strictEqual(msgs.find((x) => x.author === 'ai').body, reply);
    const turn = turns.find((x) => x.workflow === 'chat.member.turn');
    assert.ok(turn.input.messages[0].content.includes('answering for "Acme"') && turn.input.messages[0].content.includes('We ship worldwide in 3-5 days.'));
    assert.ok(turn.input.messages[0].content.includes('[HANDOFF]'));
    assert.ok(turn.input.tools.some((x) => x.function.name === 'read_page'), 'Vibe may read the inbox\'s pages');
    const again = await widget('POST', '/visit', { token });
    assert.strictEqual(again.body.conversation.id, conv.id, 'the same token resumes the conversation');
});

t('Vibe hands off when it ends with [HANDOFF]; "Talk to a person" hands off too', async () => {
    reply = 'Let me get someone from Acme for that.\n[HANDOFF]';
    await widget('POST', '/messages', { token, message: 'I want a refund for order 1234' });
    const c = await until(async () => { const r = await widget('GET', `/messages?token=${token}`); return r.body.conversation.status === 'waiting' && r.body; }, 'handoff');
    const last = c.messages.filter((m) => m.author === 'ai').pop();
    assert.strictEqual(last.body, 'Let me get someone from Acme for that.', 'the marker is not shown');
    // A second visitor uses the button.
    const v2 = (await widget('POST', '/visit', {})).body.token;
    await widget('POST', '/messages', { token: v2, message: 'hello' });
    await new Promise((r) => setTimeout(r, 200));
    const hand = await widget('POST', '/handoff', { token: v2 });
    assert.strictEqual(hand.body.conversation.status, 'waiting');
});

t('the inbox\'s people see conversations, waiting first; a reply stops Vibe; others get 404', async () => {
    assert.strictEqual((await agentsApi('GET', `/${inbox.id}/conversations`, bob)).status, 404, 'not on the team');
    assert.strictEqual((await agentsApi('POST', `/${inbox.id}/members`, ann, { username: 'bob' })).status, 200);
    const list = (await agentsApi('GET', `/${inbox.id}/conversations`, bob)).body.conversations;
    assert.ok(list.length === 2 && list.every((c) => c.status === 'waiting'));
    const r = await agentsApi('POST', `/${inbox.id}/conversations/${conv.id}/messages`, bob, { message: 'Hi, I can help with the refund.' });
    assert.strictEqual(r.status, 201);
    const seen = await visitorMessages();
    assert.ok(seen.some((m) => m.author === 'agent' && m.author_name === 'Bob' && m.body.includes('refund')), 'the visitor sees the reply');
    const before = turns.length;
    await widget('POST', '/messages', { token, message: 'Thanks! It is order 1234.' });
    await new Promise((r2) => setTimeout(r2, 200));
    assert.strictEqual(turns.length, before, 'Vibe stays quiet once a person answered');
    assert.strictEqual((await widget('GET', `/messages?token=${token}`)).body.conversation.status, 'open');
});

t('resolving closes it; the next message starts a new conversation', async () => {
    const r = await agentsApi('PATCH', `/${inbox.id}/conversations/${conv.id}`, bob, { status: 'resolved' });
    assert.strictEqual(r.body.conversation.status, 'resolved');
    reply = 'Happy to help again.';
    const p = await widget('POST', '/messages', { token, message: 'One more question' });
    assert.notStrictEqual(p.body.conversation.id, conv.id);
    assert.strictEqual(p.body.conversation.status, 'bot');
});

t('the socket: the visitor hears the people, the people hear new conversations', async () => {
    const agent = await h.ws({ token: bob.token });
    agent.sendJson({ type: 'inbox_watch', inbox: inbox.id });
    await agent.next((m) => m.type === 'inbox_watching');
    const v3 = (await widget('POST', '/visit', {})).body.token;
    const first = await widget('POST', '/messages', { token: v3, message: 'Is anyone there?' });
    await agent.next((m) => m.type === 'inbox_conversation' && m.conversation.id === first.body.conversation.id);
    const visitor = await h.ws({});
    visitor.sendJson({ type: 'inbox_watch', inbox: inbox.id, conversation: first.body.conversation.id, visitor_token: 'x'.repeat(32) });
    await visitor.next((m) => m.type === 'inbox_error');
    visitor.sendJson({ type: 'inbox_watch', inbox: inbox.id, conversation: first.body.conversation.id, visitor_token: v3 });
    await visitor.next((m) => m.type === 'inbox_watching');
    await agentsApi('POST', `/${inbox.id}/conversations/${first.body.conversation.id}/messages`, bob, { message: 'Yes, hi!' });
    const got = await visitor.next((m) => m.type === 'inbox_message' && m.message.author === 'agent');
    assert.strictEqual(got.message.body, 'Yes, hi!');
    agent.close(); visitor.close();
});

t('the embed page and the loader: frame-ancestors follow the allowed sites', async () => {
    let r = await fetch(`${h.base}/embed/inbox/${inbox.id}`);
    assert.strictEqual(r.status, 200);
    assert.ok(/frame-ancestors \*/.test(r.headers.get('content-security-policy')), 'any site until the owner names some');
    assert.ok((await r.text()).includes(`data-inbox="${inbox.id}"`));
    await agentsApi('PATCH', `/${inbox.id}`, ann, { allowed_origins: ['https://shop.example'] });
    r = await fetch(`${h.base}/embed/inbox/${inbox.id}`);
    assert.ok(/frame-ancestors https:\/\/shop\.example;/.test(r.headers.get('content-security-policy')));
    // The visitor API answers named sites across origins (a site can build its own panel), and refuses the others.
    const shop = await widget('POST', '/visit', {}, { origin: 'https://shop.example' });
    assert.strictEqual(shop.status, 200);
    assert.strictEqual(shop.headers.get('access-control-allow-origin'), 'https://shop.example');
    assert.strictEqual(shop.headers.get('access-control-allow-credentials'), null, 'no cookies cross sites');
    assert.strictEqual((await widget('POST', '/visit', {}, { origin: SITE })).status, 200, 'its own panel always');
    const other = await widget('POST', '/visit', {}, { origin: 'https://elsewhere.example' });
    assert.deepStrictEqual([other.status, other.body.code], [403, 'inbox.origin']);
    assert.strictEqual((await fetch(`${h.base}/embed/inbox/inb_00000000000000000000000000`)).status, 404);
    assert.strictEqual((await agentsApi('PATCH', `/${inbox.id}`, bob, { name: 'Mine now' })).status, 403, 'only the owner changes it');
    const js = await fetch(`${h.base}/widget.js`);
    assert.ok(/javascript/.test(js.headers.get('content-type')) && (await js.text()).includes('OpenVibeChat'));
});

t('the people\'s pages: the list, a conversation and the settings with the snippet', async () => {
    const page = async (path, u) => { const r = await fetch(`${h.base}${path}`, { headers: { cookie: `ov_token=${u.token}` }, redirect: 'manual' }); return { status: r.status, text: await r.text() }; };
    assert.ok((await page('/inbox', ann)).text.includes(`href="/inbox/${inbox.id}"`));
    const view = await page(`/inbox/${inbox.id}?c=${conv.id}`, bob);
    assert.ok(view.text.includes('Hi, I can help with the refund.') && view.text.includes('vb-composer'));
    const settings = await page(`/inbox/${inbox.id}/settings`, ann);
    assert.ok(settings.text.includes('data-inbox=&quot;') && settings.text.includes('/widget.js'), 'the snippet is shown escaped');
    assert.strictEqual((await page(`/inbox/${inbox.id}`, h.addUser('cat', { subject: ids.newId('user') }))).status, 404);
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
