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
 *
 * /api/chat/inboxes — the inbox's people (signed in; an API token acts as its person):
 *   GET    /                 { inboxes }: the inboxes they work in, with waiting and open counts
 *   POST   /                 { name, greeting?, color?, ai_enabled?, ai_instructions?, knowledge_urls?, allowed_origins? } → 201
 *   GET    /:id              { inbox, members, embed }    PATCH /:id (owner)    DELETE /:id (owner)
 *   POST   /:id/members      { username } (owner)         DELETE /:id/members/:userId (owner)
 *   POST   /:id/identity     { action: on | rotate | off } (owner) → { identity_secret }: verified visitors
 *   GET    /:id/conversations                  ?status=active|bot|waiting|open|resolved
 *   GET    /:id/conversations/:cid/messages    ?after=
 *   POST   /:id/conversations/:cid/messages    { message } → 201: a person's answer (the conversation becomes open)
 *   PATCH  /:id/conversations/:cid             { status: open | resolved | bot }
 *   POST   /:id/conversations/:cid/read
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('openvibe-shared/cache-policy');
const config = require('../config');
const { requireAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const inboxes = require('./inbox');

function send(res, err) {
    if (err instanceof inboxes.InboxError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Inbox]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const noStore = (res) => res.set('Cache-Control', cache.htmlHeaders({ private: true }));
const tokenOf = (req) => String((req.body && req.body.token) || req.get('x-visitor-token') || req.query.token || '');

// ── Visitors ───────────────────────────────────────────────────────────────────────────────────────────────────────
const widget = express.Router({ mergeParams: true });
const visitLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const postLimit = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down a little', code: 'inbox.slow_down' } });

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
widget.post('/visit', visitLimit, async (req, res) => {
    const inbox = await inboxOr404(req, res); if (!inbox) return;
    try { noStore(res).json({ inbox: inboxes.publicConfig(inbox), ...(await inboxes.visit(inbox, tokenOf(req), req.body && req.body.user)) }); } catch (err) { send(res, err); }
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
    try { res.status(201).json(await inboxes.visitorPost(inbox, tokenOf(req), req.body || {})); } catch (err) { send(res, err); }
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
    noStore(res).json({ conversations: await inboxes.conversations(inbox, { status: req.query.status || 'active', limit: req.query.limit }) });
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
    try { res.json({ conversation: await inboxes.setStatus(req.inbox, conv, req.user, req.body && req.body.status) }); } catch (err) { send(res, err); }
});
agents.post('/:id/conversations/:cid/read', requireAuth, async (req, res) => {
    const conv = await agentConversation(req, res); if (!conv) return;
    await inboxes.markRead(req.inbox, conv);
    res.status(204).end();
});

module.exports = { widget, agents, embedOf };
