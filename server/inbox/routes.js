'use strict';
/**
 * Support inboxes over HTTP (server/inbox/inbox.js, docs/platform.md). Two routers:
 *
 * /api/chat/widget/inbox/:id — the visitor's side, what openvibe.chat/embed/inbox/:id (the widget's panel) calls; no
 * sign-in, the visitor's token in the body (or X-Visitor-Token):
 *   GET    /                 { inbox }: name, greeting, color, whether Vibe answers
 *   POST   /visit            { token?, user? } → { token, verified, inbox, conversation, messages }  (a new token when theirs is
 *                             missing; user = { id, name?, email?, hash } signed by the site: a verified person's own token)
 *   GET    /messages         ?token=&after= → { conversation, messages }
 *   POST   /messages         { token, message, page_url?, name?, user? } → 201 { conversation, message }
 *   POST   /handoff          { token } → { conversation }  ("Talk to a person"; 409 when only Vibe answers)
 *   POST   /rating           { token, rating: 1 | -1, comment?, conversation? } → { conversation }  (else their latest resolved)
 *   POST   /picture          the body is a picture; X-Visitor-Token, an optional line in X-Caption → 201 { conversation, message,
 *                             picture } (signed in to OpenVibe only: it goes to OpenVibe.Pics as them; 403 inbox.sign_in_to_attach)
 *
 * /api/chat/support — a visitor's own conversations with sites' chats (signed in to OpenVibe in the panel):
 *   GET    /                 { conversations }: newest first, with the inbox's name
 *   GET    /:cid/messages    ?after= → { conversation, messages }
 *   POST   /:cid/messages    { message } → 201 { conversation, message } (a resolved one: a new conversation)
 *
 * /api/chat/inboxes — the inbox's people (signed in; an API token acts as its person):
 *   GET    /                 { inboxes }: the inboxes they work in, with waiting and open counts
 *   POST   /                 { name, greeting?, color?, ai_enabled?, ai_instructions?, knowledge_urls?, allowed_origins? } → 201
 *   GET    /:id              { inbox, members, embed }    PATCH /:id (owner)    DELETE /:id (owner)
 *   POST   /:id/members      { username } (owner)         DELETE /:id/members/:userId (owner)
 *   POST   /:id/identity     { action: on | rotate | off } (owner) → { identity_secret }: verified visitors
 *   GET    /:id/replies      { replies }: saved replies    POST /:id/replies { shortcut, body }    DELETE /:id/replies/:replyId
 *   POST   /:id/conversations/:cid/messages/:mid/translate  { to } → { text, lang, cached }: a message in the reader's language
 *   POST   /:id/translate    { text, to } → { text, lang }: a reply draft in the visitor's language
 *   POST   /:id/conversations/:cid/picture   the body is a picture, an optional line in X-Caption → 201 { message, picture }
 *   GET    /:id/webhooks     (owner) { webhooks }    POST /:id/webhooks { url } → 201 { webhook, secret }
 *   POST   /:id/webhooks/:hookId/test → { ok, status, error }    DELETE /:id/webhooks/:hookId
 *   GET    /:id/actions      (owner) { actions }    POST /:id/actions { name, description, url, params? } → 201 { action, secret }
 *   POST   /:id/actions/:actionId/test { arguments } → { ok, status, error, result }    DELETE /:id/actions/:actionId
 *   GET    /:id/conversations                  ?status=active|mine|bot|waiting|open|resolved
 *   GET    /:id/conversations/:cid/messages    ?after=
 *   POST   /:id/conversations/:cid/messages    { message } → 201: a person's answer (the conversation becomes open)
 *   PATCH  /:id/conversations/:cid             { status: open | resolved | bot, assignee_id: a person's id | null }
 *   POST   /:id/conversations/:cid/read
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('openvibe-shared/cache-policy');
const config = require('../config');
const { requireAuth, requestUser } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const inboxes = require('./inbox');
const webhooks = require('./webhooks');
const actions = require('./actions');
const translate = require('./translate');

function send(res, err) {
    if (err instanceof inboxes.InboxError || err instanceof webhooks.WebhookError || err instanceof actions.ActionError || err instanceof translate.TranslateError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Inbox]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const noStore = (res) => res.set('Cache-Control', cache.htmlHeaders({ private: true }));
const tokenOf = (req) => String((req.body && req.body.token) || req.get('x-visitor-token') || req.query.token || '');

// ── Visitors ───────────────────────────────────────────────────────────────────────────────────────────────────────
const widget = express.Router({ mergeParams: true });
const visitLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const postLimit = rateLimit({ windowMs: 60_000, max: () => config.inbox.postsPerMinute, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down a little', code: 'inbox.slow_down' } });

// An inbox that names its sites answers only them (and its own panel on openvibe.chat); a call with no Origin (a server)
// is let through, since a browser always sends one across sites.
async function inboxOr404(req, res) {
    const inbox = await inboxes.get(req.params.id);
    if (!inbox) { res.status(404).json({ error: 'No such inbox', code: 'inbox.not_found' }); return null; }
    const origin = req.get('origin');
    if (origin && inbox.allowed_origins.length && origin !== new URL(config.web.baseUrl).origin && !inbox.allowed_origins.includes(origin)) {
        res.status(403).json({ error: 'This inbox does not answer this site', code: 'inbox.origin' }); return null;
    }
    return inbox;
}

widget.get('/', visitLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    noStore(res).json({ inbox: inboxes.publicConfig(inbox) });
});
// A visitor signed in to OpenVibe (their own sign-in in Authorization, or the cookie on openvibe.chat itself; never an
// API token): their conversations are theirs. Only ever from the request's credentials, never from its body.
async function accountOf(req) {
    const u = await requestUser(req).catch(() => null);
    return u && u.auth_source !== 'api_token' ? u : null;
}
widget.post('/visit', visitLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    try { noStore(res).json({ inbox: inboxes.publicConfig(inbox), ...(await inboxes.visit(inbox, tokenOf(req), req.body && req.body.user, await accountOf(req))) }); } catch (err) { send(res, err); }
});
widget.get('/messages', visitLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    try {
        const v = await inboxes.visit(inbox, tokenOf(req));
        const after = Number(req.query.after) || 0;
        noStore(res).json({ conversation: v.conversation, messages: v.messages.filter((m) => m.id > after) });
    } catch (err) { send(res, err); }
});
widget.post('/messages', postLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    try { res.status(201).json(await inboxes.visitorPost(inbox, tokenOf(req), { ...(req.body || {}), account: await accountOf(req) })); } catch (err) { send(res, err); }
});
widget.post('/handoff', postLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    try { res.json({ conversation: await inboxes.handoff(inbox, tokenOf(req)) }); } catch (err) { send(res, err); }
});
widget.post('/rating', postLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    const b = req.body || {};
    try { res.json({ conversation: await inboxes.rate(inbox, tokenOf(req), { rating: b.rating, comment: b.comment, conversation: b.conversation }) }); } catch (err) { send(res, err); }
});

// ── The inbox's people ─────────────────────────────────────────────────────────────────────────────────────────────
const agents = express.Router();
const manageLimit = limits('chat.inbox.manage', { minute: 30, hour: 300 });
const replyLimit = limits('chat.inbox.reply', { minute: 60, hour: 1200 });

/** The snippet a site pastes, and the address of the panel it opens. */
function embedOf(inbox) {
    const base = config.web.baseUrl;
    return {
        script: `<script src="${base}/widget.js" data-inbox="${inbox.id}" async></script>`,
        panel: `${base}/embed/inbox/${inbox.id}`,
    };
}

async function agentInbox(req, res, { owner = false } = {}) {
    const inbox = await inboxes.get(req.params.id);
    const role = inbox ? (await inboxes.access(inbox, req.user)).role : null;
    if (!inbox || !role) { res.status(404).json({ error: 'No such inbox', code: 'inbox.not_found' }); return null; }
    if (owner && role !== 'owner') { res.status(403).json({ error: 'Only the inbox\'s owner does that', code: 'inbox.owner_only' }); return null; }
    req.inbox = inbox; req.role = role;
    return inbox;
}
async function agentConversation(req, res) {
    const inbox = await agentInbox(req, res); if (!inbox) return null;
    const conv = await inboxes.conversation(inbox, req.params.cid);
    if (!conv) { res.status(404).json({ error: 'No such conversation', code: 'inbox.no_conversation' }); return null; }
    return conv;
}

agents.get('/', requireAuth, async (req, res) => { noStore(res).json({ inboxes: await inboxes.mine(req.user) }); });
agents.post('/', requireAuth, manageLimit, async (req, res) => {
    try { const inbox = await inboxes.create(req.user, req.body || {}); res.status(201).json({ inbox: inboxes.shape(inbox), embed: embedOf(inbox) }); } catch (err) { send(res, err); }
});
agents.get('/:id', requireAuth, async (req, res) => {
    const inbox = await agentInbox(req, res); if (!inbox) return;
    noStore(res).json({ inbox: inboxes.shape(inbox), role: req.role, members: await inboxes.members(inbox), embed: embedOf(inbox) });
});
agents.patch('/:id', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { res.json({ inbox: inboxes.shape(await inboxes.update(inbox, req.user, req.body || {})) }); } catch (err) { send(res, err); }
});
agents.get('/:id/replies', requireAuth, async (req, res) => {
    const inbox = await agentInbox(req, res); if (!inbox) return;
    noStore(res).json({ replies: await inboxes.savedReplies(inbox) });
});
agents.post('/:id/replies', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res); if (!inbox) return;
    try { res.json({ replies: await inboxes.saveReply(inbox, req.user, req.body || {}) }); } catch (err) { send(res, err); }
});
agents.delete('/:id/replies/:replyId', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res); if (!inbox) return;
    try { res.json({ replies: await inboxes.deleteReply(inbox, req.user, req.params.replyId) }); } catch (err) { send(res, err); }
});
// A picture from one of the inbox's people: it goes to OpenVibe.Pics as them (their own sign-in, like a room's picture),
// and the conversation gets a message with its link, which the visitor's panel shows inline.
const bearerOf = (req) => { const m = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || '')); return m ? m[1].trim() : (req.cookies && req.cookies.ov_token) || null; };
const pictureLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down a little', code: 'inbox.slow_down' } });
agents.post('/:id/conversations/:cid/picture', requireAuth, pictureLimit, (req, res, next) => {
    if (req.authSource === 'api_token') return res.status(403).json({ error: 'Send pictures with your own sign-in', code: 'inbox.person_only' });
    return express.raw({ type: () => true, limit: (config.pics.maxBytes || 20 * 1024 * 1024) + 1 })(req, res, (err) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That picture is too large', code: 'pictures.too_large' });
        return next(err);
    });
}, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    const caption = (() => { try { return decodeURIComponent(String(req.get('x-caption') || '')).slice(0, 500); } catch { return ''; } })();
    const out = await require('../rooms/pictures').upload({ token: bearerOf(req), buffer: Buffer.isBuffer(req.body) ? req.body : null, contentType: req.get('content-type'), title: caption, ip: req.ip });
    if (!out.ok) return res.status(out.status || 502).json({ error: out.detail || 'That picture did not send', code: out.code || 'pictures.failed' });
    try { res.status(201).json({ message: await inboxes.agentPost(req.inbox, conv, req.user, `${caption ? `${caption}\n` : ''}${out.picture.direct}`), picture: out.picture }); } catch (err) { send(res, err); }
});
// A signed-in visitor's picture (the panel's attach button): it goes to OpenVibe.Pics as them, the same way, and the
// conversation gets their message with its link. Anonymous visitors cannot upload until Pics scans pictures.
widget.post('/picture', pictureLimit, async (req, res, next) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    if (!/^[A-Za-z0-9_-]{32}$/.test(tokenOf(req))) return res.status(401).json({ error: 'Open the chat again to start a conversation', code: 'inbox.visitor' });
    const account = await accountOf(req);
    if (!account) return res.status(403).json({ error: 'Sign in to send a picture', code: 'inbox.sign_in_to_attach' });
    req.inbox = inbox; req.account = account;
    return express.raw({ type: () => true, limit: (config.pics.maxBytes || 20 * 1024 * 1024) + 1 })(req, res, (err) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That picture is too large', code: 'pictures.too_large' });
        return next(err);
    });
}, async (req, res) => {
    const caption = (() => { try { return decodeURIComponent(String(req.get('x-caption') || '')).slice(0, 500); } catch { return ''; } })();
    const out = await require('../rooms/pictures').upload({ token: bearerOf(req), buffer: Buffer.isBuffer(req.body) ? req.body : null, contentType: req.get('content-type'), title: caption, ip: req.ip });
    if (!out.ok) return res.status(out.status || 502).json({ error: out.detail || 'That picture did not send', code: out.code || 'pictures.failed' });
    try {
        const posted = await inboxes.visitorPost(req.inbox, tokenOf(req), { message: `${caption ? `${caption}\n` : ''}${out.picture.direct}`, account: req.account });
        res.status(201).json({ ...posted, picture: out.picture });
    } catch (err) { send(res, err); }
});
const translateLimit = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down a little', code: 'inbox.slow_down' } });
agents.post('/:id/conversations/:cid/messages/:mid/translate', requireAuth, translateLimit, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    try { noStore(res).json(await translate.message(req.inbox, conv, req.params.mid, req.body && req.body.to)); } catch (err) { send(res, err); }
});
agents.post('/:id/translate', requireAuth, translateLimit, async (req, res) => {
    const inbox = await agentInbox(req, res); if (!inbox) return;
    try { noStore(res).json(await translate.draft(inbox, req.body && req.body.text, req.body && req.body.to)); } catch (err) { send(res, err); }
});
agents.get('/:id/webhooks', requireAuth, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    noStore(res).json({ webhooks: await webhooks.list(inbox) });
});
agents.post('/:id/webhooks', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { noStore(res).status(201).json(await webhooks.add(inbox, req.user, req.body && req.body.url)); } catch (err) { send(res, err); }
});
agents.post('/:id/webhooks/:hookId/test', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { res.json(await webhooks.test(inbox, req.params.hookId)); } catch (err) { send(res, err); }
});
agents.delete('/:id/webhooks/:hookId', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    await webhooks.remove(inbox, req.params.hookId); res.status(204).end();
});
agents.get('/:id/actions', requireAuth, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    noStore(res).json({ actions: await actions.list(inbox) });
});
agents.post('/:id/actions', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { noStore(res).status(201).json(await actions.add(inbox, req.user, req.body || {})); } catch (err) { send(res, err); }
});
agents.post('/:id/actions/:actionId/test', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { noStore(res).json(await actions.test(inbox, req.params.actionId, req.body && req.body.arguments)); } catch (err) { send(res, err); }
});
agents.delete('/:id/actions/:actionId', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    await actions.remove(inbox, req.params.actionId); res.status(204).end();
});
agents.post('/:id/identity', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { noStore(res).json(await inboxes.setIdentity(inbox, req.user, String((req.body && req.body.action) || ''))); } catch (err) { send(res, err); }
});
agents.delete('/:id', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { await inboxes.remove(inbox, req.user); res.status(204).end(); } catch (err) { send(res, err); }
});
agents.post('/:id/members', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { res.json({ members: await inboxes.addMember(inbox, req.user, req.body && req.body.username) }); } catch (err) { send(res, err); }
});
agents.delete('/:id/members/:userId', requireAuth, manageLimit, async (req, res) => {
    const inbox = await agentInbox(req, res, { owner: true }); if (!inbox) return;
    try { res.json({ members: await inboxes.removeMember(inbox, req.user, req.params.userId) }); } catch (err) { send(res, err); }
});
agents.get('/:id/conversations', requireAuth, async (req, res) => {
    const inbox = await agentInbox(req, res); if (!inbox) return;
    noStore(res).json({ conversations: await inboxes.conversations(inbox, { status: req.query.status || 'active', limit: req.query.limit, user: req.user }) });
});
agents.get('/:id/conversations/:cid/messages', requireAuth, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    noStore(res).json({ conversation: inboxes.convShape(conv), messages: await inboxes.messages(conv, { after: req.query.after }) });
});
agents.post('/:id/conversations/:cid/messages', requireAuth, replyLimit, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    try { res.status(201).json({ message: await inboxes.agentPost(req.inbox, conv, req.user, req.body && req.body.message) }); } catch (err) { send(res, err); }
});
agents.patch('/:id/conversations/:cid', requireAuth, manageLimit, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    const b = req.body || {};
    try {
        let out = null;
        if (Object.prototype.hasOwnProperty.call(b, 'assignee_id')) out = await inboxes.assign(req.inbox, conv, req.user, b.assignee_id);
        if (b.status !== undefined) out = await inboxes.setStatus(req.inbox, { ...conv, assignee_id: out ? out.assignee_id : conv.assignee_id }, req.user, b.status);
        if (!out) return res.status(422).json({ error: 'Send a status or an assignee_id', code: 'inbox.nothing' });
        res.json({ conversation: out });
    } catch (err) { send(res, err); }
});
agents.post('/:id/conversations/:cid/read', requireAuth, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    await inboxes.markRead(req.inbox, conv);
    res.status(204).end();
});

// ── A visitor's own support conversations (signed in to OpenVibe; an app acting with their sign-in) ─────────────────
const support = express.Router();
support.get('/', requireAuth, async (req, res) => { noStore(res).json({ conversations: await inboxes.mySupport(req.user, { limit: req.query.limit }) }); });
support.get('/:cid/messages', requireAuth, async (req, res) => {
    const conv = await inboxes.myConversation(req.user, req.params.cid);
    if (!conv) return res.status(404).json({ error: 'No such conversation', code: 'inbox.no_conversation' });
    noStore(res).json({ conversation: inboxes.convShape(conv), messages: await inboxes.messages(conv, { after: req.query.after }) });
});
support.post('/:cid/messages', requireAuth, postLimit, async (req, res) => {
    const conv = await inboxes.myConversation(req.user, req.params.cid);
    if (!conv) return res.status(404).json({ error: 'No such conversation', code: 'inbox.no_conversation' });
    try { res.status(201).json(await inboxes.accountPost(req.user, conv, req.body && req.body.message)); } catch (err) { send(res, err); }
});

module.exports = { widget, agents, support, embedOf };
