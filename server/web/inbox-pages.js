'use strict';
/**
 * Support inboxes on openvibe.chat (server/inbox/inbox.js, docs/platform.md):
 *
 *   GET  /widget.js                  the one-tag loader any website includes (public/web/widget.js)
 *   GET  /embed/inbox/:id            the chat panel the widget opens in an iframe (public/web/embed.js); its
 *                                    Content-Security-Policy frame-ancestors are the inbox's allowed sites (any when none)
 *   GET  /inbox                      the inboxes a person works in, and a form to make one
 *   GET  /inbox/:id                  the inbox: conversations down the left (waiting first), one open in the middle, a
 *                                    reply box; live through public/web/inbox.js (inbox_watch). ?c=<conversation>
 *   GET  /inbox/:id/settings         name, greeting, colour, Vibe's instructions and pages, allowed sites, people, the snippet
 *   POST /inbox · /inbox/:id/settings · /inbox/:id/members · /inbox/:id/members/:uid/delete ·
 *        /inbox/:id/c/:cid (reply) · /inbox/:id/c/:cid/status       forms, so all of it works without JavaScript
 */
const path = require('path');
const md = require('../../public/web/vibe-md.js');
const inboxes = require('../inbox/inbox');
const webhooks = require('../inbox/webhooks');
const { embedOf } = require('../inbox/routes');
const { esc, asset } = require('./layout');

const WIDGET = path.join(__dirname, '..', '..', 'public', 'web', 'widget.js');
const STATUS = { bot: ['Vibe', 'vb-st-bot'], waiting: ['Waiting', 'vb-st-wait'], open: ['Open', 'vb-st-open'], resolved: ['Resolved', 'vb-st-done'] };
const json = (v, d) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || 'null') || d; } catch { return d; } };
const ago = (ts) => {
    const t = Date.parse(String(ts || '').includes('T') ? ts : `${String(ts || '').replace(' ', 'T')}Z`);
    if (!Number.isFinite(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function embedHtml(inbox) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat with ${esc(inbox.name)}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="${asset('embed.css')}">
<script src="${asset('vibe-md.js')}" defer></script>
<script src="${asset('embed.js')}" defer></script>
</head>
<body style="--accent:${esc(inbox.color)}">
<div class="em" id="em" data-inbox="${esc(inbox.id)}" data-ai="${Number(inbox.ai_enabled) ? '1' : '0'}" data-people="${inboxes.peopleAnswer(inbox) ? '1' : '0'}">
<header class="em-head"><span class="em-mark" aria-hidden="true">${esc(inbox.name.slice(0, 1).toUpperCase())}</span>
<div><b>${esc(inbox.name)}</b><span id="em-state">${!Number(inbox.ai_enabled) ? 'We usually reply within a few hours.' : inboxes.peopleAnswer(inbox) ? 'Vibe answers right away. Ask for a person any time.' : 'Vibe, the assistant, answers right away.'}</span></div>
<button class="em-x" type="button" data-close aria-label="Close the chat">&times;</button></header>
<ol class="em-thread" id="em-thread" aria-live="polite"><li class="em-msg em-them"><small>${esc(inbox.name)}</small><div class="em-bubble">${esc(inbox.greeting)}</div></li></ol>
<div class="em-handoff"><button type="button" id="em-person" hidden>Talk to a person</button></div>
<form class="em-composer" id="em-form"><label class="em-sr" for="em-input" hidden>Your message</label>
<textarea id="em-input" rows="1" maxlength="4000" placeholder="Write a message" aria-label="Your message"></textarea>
<button type="submit" aria-label="Send">&#8593;</button></form>
<p class="em-foot">Chat by <a href="https://openvibe.chat" target="_blank" rel="noopener">OpenVibe</a>${Number(inbox.ai_enabled) ? ' · Vibe can get things wrong' : ''}</p>
</div>
<noscript><p style="padding:16px">This chat needs JavaScript.</p></noscript>
</body>
</html>`;
}

function mountInboxPages(router, { page, viewerOf, needUser, sameSite, formLimit, notice, config }) {
    router.get('/widget.js', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300').type('application/javascript').sendFile(WIDGET);
    });

    router.get('/embed/inbox/:id', async (req, res) => {
        const inbox = await inboxes.get(req.params.id);
        if (!inbox) return res.status(404).set('Cache-Control', 'no-store').type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Chat not found</title><p style="font-family:system-ui;padding:16px">This chat is not available.</p>');
        const origins = json(inbox.allowed_origins, []);
        const wsOrigin = config.web.baseUrl.replace(/^http/, 'ws');
        res.set('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:",
            `connect-src 'self' ${wsOrigin}`, `frame-ancestors ${origins.length ? origins.join(' ') : '*'}`,
            "base-uri 'self'", "form-action 'self'", "object-src 'none'",
        ].join('; ')).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(embedHtml(inbox));
    });

    // ── The inbox's people ──
    const statusChip = (s) => `<span class="vb-st ${STATUS[s] ? STATUS[s][1] : ''}">${esc(STATUS[s] ? STATUS[s][0] : s)}</span>`;

    router.get('/inbox', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const mine = await inboxes.mine(actor.user);
        const list = mine.length
            ? `<ul class="ib-list">${mine.map((i) => `<li><a href="/inbox/${esc(i.id)}"><span class="ib-dot" style="background:${esc(i.color)}"></span><b>${esc(i.name)}</b>
<span class="oc-muted">${i.waiting ? `${i.waiting} waiting · ` : ''}${i.open} open · ${i.role === 'owner' ? 'owner' : 'agent'}</span></a></li>`).join('')}</ul>`
            : '<p class="oc-muted">No inboxes yet. Make one below, paste its snippet into your site, and visitors can write to you: Vibe answers first, you take over when it matters.</p>';
        await page(req, res, 200, {
            actor, title: 'Inbox', path: '/inbox', active: 'inbox', robots: 'noindex, nofollow',
            body: `<h1>Inbox</h1>
<p class="oc-muted">Live chat for your website or community: one line of HTML adds a chat bubble. Vibe, OpenVibe's assistant, answers visitors from your own instructions and pages, and hands them to you or your team when they ask for a person.</p>
${req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : ''}
${list}
<h2>Make an inbox</h2>
<form class="oc-form" method="post" action="/inbox">
<label>Name <input name="name" required minlength="2" maxlength="60" placeholder="Acme support"></label>
<label>Greeting <input name="greeting" maxlength="300" placeholder="Hi! Ask us anything."></label>
<label>What Vibe should know <textarea name="ai_instructions" rows="4" maxlength="4000" placeholder="We ship worldwide in 3-5 days. Refunds within 30 days. Hours: 9-5 PT."></textarea></label>
<label>Pages Vibe may read (one per line) <textarea name="knowledge_urls" rows="3" placeholder="https://example.com/faq"></textarea></label>
<p><button type="submit">Make the inbox</button></p></form>`,
        });
    });

    router.post('/inbox', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        try { const inbox = await inboxes.create(actor.user, req.body || {}); res.redirect(303, `/inbox/${inbox.id}/settings?made=1`); }
        catch (err) { res.redirect(303, `/inbox?error=${encodeURIComponent(err.message || 'That did not work')}`); }
    });

    async function agentInbox(req, res) {
        const actor = await needUser(req, res); if (!actor) return null;
        const inbox = await inboxes.get(req.params.id);
        const role = inbox ? (await inboxes.access(inbox, actor.user)).role : null;
        if (!inbox || !role) { await page(req, res, 404, { actor, title: 'Inbox not found', path: '/inbox', robots: 'noindex, nofollow', body: '<h1>Inbox not found</h1><p><a href="/inbox">Your inboxes</a></p>' }); return null; }
        return { actor, inbox, role };
    }

    router.get('/inbox/:id', async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        const { actor, inbox } = a;
        const filter = ['active', 'waiting', 'resolved'].includes(req.query.f) ? req.query.f : 'active';
        const list = await inboxes.conversations(inbox, { status: filter });
        const current = req.query.c ? await inboxes.conversation(inbox, req.query.c) : null;
        const saved = await inboxes.savedReplies(inbox);
        const msgs = current ? await inboxes.messages(current) : [];
        if (current) await inboxes.markRead(inbox, current);
        const item = (c) => `<li><a class="vb-chat ib-conv" href="/inbox/${esc(inbox.id)}?c=${esc(c.id)}&amp;f=${filter}"${current && c.id === current.id ? ' aria-current="page"' : ''} data-conv="${esc(c.id)}">
<span class="ib-row"><b>${esc(c.visitor_name || 'Visitor')}</b>${c.verified ? '<span class="ib-ok" title="Verified by your site">✓</span>' : ''}${statusChip(c.status)}${c.rating ? `<span class="ib-rate" title="${esc(c.rating_comment || '')}">${c.rating > 0 ? '👍' : '👎'}</span>` : ''}<time>${esc(ago(c.last_message_at))}</time></span>
<span class="ib-prev">${esc(c.preview || '')}</span></a></li>`;
        const turn = (m) => {
            if (m.author === 'system') return `<li class="ib-sys" data-id="${m.id}">${esc(m.body)}</li>`;
            if (m.author === 'visitor') return `<li class="vb-turn vb-ai ib-visitor" data-id="${m.id}"><span class="ib-av" aria-hidden="true">${esc((current.visitor_name || 'V').slice(0, 1).toUpperCase())}</span><div class="vb-body"><p class="ib-who">${esc(current.visitor_name || 'Visitor')}</p><div class="vb-md">${esc(m.body).replace(/\n/g, '<br>')}</div></div></li>`;
            return `<li class="vb-turn vb-me" data-id="${m.id}"><div class="vb-bubble${m.author === 'ai' ? ' ib-ai' : ''}"><p class="ib-who">${m.author === 'ai' ? 'Vibe (AI)' : esc(m.author_name || 'Agent')}</p>${m.author === 'ai' ? `<div class="vb-md">${md.render(m.body)}</div>` : esc(m.body).replace(/\n/g, '<br>')}</div></li>`;
        };
        const tabs = [['active', 'Active'], ['waiting', 'Waiting'], ['resolved', 'Resolved']].map(([k, l]) => `<a href="/inbox/${esc(inbox.id)}?f=${k}"${k === filter ? ' aria-current="page"' : ''}>${l}</a>`).join('');
        const actions = current ? `<form method="post" action="/inbox/${esc(inbox.id)}/c/${esc(current.id)}/status" class="ib-actions">
${current.status !== 'resolved' ? '<button name="status" value="resolved">Resolve</button>' : '<button name="status" value="open">Reopen</button>'}
${Number(inbox.ai_enabled) && current.status !== 'bot' && current.status !== 'resolved' ? '<button name="status" value="bot">Back to Vibe</button>' : ''}</form>` : '';
        const body = `<div class="vb ib" id="vb" data-inbox="${esc(inbox.id)}" data-conv="${current ? esc(current.id) : ''}">
<aside class="vb-rail" id="vb-rail" aria-label="Conversations">
<div class="vb-rail-top"><a class="vb-new" href="/inbox/${esc(inbox.id)}/settings"><span class="ib-dot" style="background:${esc(inbox.color)}"></span><span>${esc(inbox.name)}</span></a>
<button class="vb-icon vb-rail-close" type="button" data-vb-close aria-label="Close the list">&times;</button></div>
<nav class="ib-tabs" aria-label="Filter">${tabs}</nav>
<nav class="vb-rail-list" aria-label="Conversations">${list.length ? `<ul class="vb-chats" id="ib-list">${list.map(item).join('')}</ul>` : '<p class="vb-rail-note" id="ib-empty">No conversations here yet. Add the snippet from Settings to your site.</p>'}</nav>
<nav class="vb-rail-more" aria-label="More"><a href="/inbox/${esc(inbox.id)}/settings"><span>Settings and snippet</span></a><a href="/inbox"><span>All inboxes</span></a></nav>
</aside>
<div class="vb-scrim" data-vb-close hidden></div>
<section class="vb-main" aria-label="Conversation">
<header class="vb-head"><button class="vb-icon vb-menu" type="button" data-vb-open aria-controls="vb-rail" aria-expanded="false" aria-label="Show conversations">&#9776;</button>
<h1 class="vb-title">${current ? `${esc(current.visitor_name || 'Visitor')}${Number(current.verified) ? ' <span class="ib-ok" title="Verified by your site">✓</span>' : ''} ${statusChip(current.status)}${current.rating ? ` <span class="ib-rate" title="${esc(current.rating_comment || 'The visitor\'s rating')}">${Number(current.rating) > 0 ? '👍' : '👎'}</span>` : ''}` : esc(inbox.name)}</h1>${actions}</header>
<div class="vb-scroll" id="vb-scroll">
${current ? `${Number(current.verified) ? `<p class="ib-page">Verified by your site${current.visitor_email ? ` · <a href="mailto:${esc(current.visitor_email)}">${esc(current.visitor_email)}</a>` : ''} · id ${esc(current.external_id || '')}</p>` : ''}${current.rating_comment ? `<p class="ib-page">Rated ${Number(current.rating) > 0 ? '👍' : '👎'}: “${esc(current.rating_comment)}”</p>` : ''}${current.page_url ? `<p class="ib-page">From <a href="${esc(current.page_url)}" rel="noopener nofollow" target="_blank">${esc(current.page_url)}</a></p>` : ''}<ol class="vb-thread" id="vb-thread">${msgs.map(turn).join('')}</ol>`
        : `<div class="vb-hello"><h1>${list.length ? 'Pick a conversation' : 'No conversations yet'}</h1><p class="vb-sub">${list.length ? 'Waiting ones come first: those visitors asked for a person.' : 'Paste the snippet from Settings into your site. Visitors write; Vibe answers; you take over when it matters.'}</p></div>`}
</div>
${current ? `<div class="vb-dock"><form class="vb-composer" id="vb-composer" method="post" action="/inbox/${esc(inbox.id)}/c/${esc(current.id)}">
<label class="oc-sr" for="vb-input">Reply</label><textarea id="vb-input" name="message" rows="1" maxlength="4000" placeholder="Reply as ${esc(actor.user.display_name || actor.user.username)}${saved.length ? ' · / for saved replies' : ''}" required aria-autocomplete="list"></textarea>
<button class="vb-send" type="submit" aria-label="Send">&#8593;</button></form><p class="vb-fine">Replying takes the conversation from Vibe.</p></div>` : ''}
</section>
</div>`;
        await page(req, res, 200, {
            actor, app: true, appScript: 'inbox.js', active: 'inbox', path: `/inbox/${inbox.id}`, title: `${inbox.name} · Inbox`, robots: 'noindex, nofollow', body,
            page: { view: 'inbox', inbox: inbox.id, conversation: current ? current.id : null, latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: actor.user.id, filter, saved: saved.map((r) => ({ shortcut: r.shortcut, body: r.body })) },
        });
    });

    router.post('/inbox/:id/c/:cid', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        const conv = await inboxes.conversation(a.inbox, req.params.cid);
        if (!conv) return res.redirect(303, `/inbox/${a.inbox.id}`);
        try { await inboxes.agentPost(a.inbox, conv, a.actor.user, req.body && req.body.message); } catch { /* the page shows the thread as it is */ }
        res.redirect(303, `/inbox/${a.inbox.id}?c=${conv.id}`);
    });
    router.post('/inbox/:id/c/:cid/status', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        const conv = await inboxes.conversation(a.inbox, req.params.cid);
        if (conv) { try { await inboxes.setStatus(a.inbox, conv, a.actor.user, req.body && req.body.status); } catch { /* unchanged */ } }
        res.redirect(303, `/inbox/${a.inbox.id}${conv ? `?c=${conv.id}` : ''}`);
    });

    router.get('/inbox/:id/settings', async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        const { actor, inbox, role } = a;
        const shape = inboxes.shape(inbox);
        const team = await inboxes.members(inbox);
        const embed = embedOf(inbox);
        const owner = role === 'owner';
        const saved = await inboxes.savedReplies(inbox);
        const hooks = owner ? await webhooks.list(inbox) : [];
        await page(req, res, 200, {
            actor, title: `${inbox.name}: settings`, path: `/inbox/${inbox.id}/settings`, active: 'inbox', robots: 'noindex, nofollow',
            body: `<p><a href="/inbox/${esc(inbox.id)}">&larr; ${esc(inbox.name)}</a></p><h1>${esc(inbox.name)}</h1>
${req.query.made ? notice('ok', 'Your inbox is ready. Paste the snippet into your site, before </body>.') : ''}${req.query.saved ? notice('ok', 'Saved.') : ''}${req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : ''}
<h2>Add it to your site</h2>
<p>Paste this before <code>&lt;/body&gt;</code> on every page that should show the chat bubble:</p>
<pre class="ib-snippet"><code>${esc(embed.script)}</code></pre>
<p class="oc-muted">Your page can open it with <code>OpenVibeChat.open()</code>. Try it: <a href="${esc(embed.panel)}" target="_blank" rel="noopener">open the chat panel</a>.</p>
${owner ? `<h2>Verified visitors</h2>
${shape.verified_visitors ? `<p>On. Your site signs who its signed-in visitor is, and Chat trusts the name and email that come with it; their conversation follows them to every device. Keep this secret on your server only:</p>
<pre class="ib-snippet"><code>${esc(inbox.identity_secret)}</code></pre>
<p>For a signed-in visitor, add <code>data-user-id</code>, <code>data-user-name</code>, <code>data-user-email</code> and <code>data-user-hash</code> to the tag (or call <code>OpenVibeChat.identify({ id, name, email, hash })</code>), where the hash is the HMAC-SHA256 of the id with the secret, in hex:</p>
<pre class="ib-snippet"><code>${esc(`// Node
crypto.createHmac('sha256', SECRET).update(String(user.id)).digest('hex')
# Python
hmac.new(SECRET.encode(), str(user.id).encode(), hashlib.sha256).hexdigest()
// PHP
hash_hmac('sha256', (string) $user->id, $secret)`)}</code></pre>
<form class="oc-inline" method="post" action="/inbox/${esc(inbox.id)}/identity"><button name="action" value="rotate">Make a new secret</button></form>
<form class="oc-inline" method="post" action="/inbox/${esc(inbox.id)}/identity"><button class="oc-link" name="action" value="off">Turn it off</button></form>`
        : `<p class="oc-muted">Off: every visitor is anonymous to you unless they give a name. When your site has its own accounts, turn this on and your server signs who each visitor is; you see their verified name and email, and they find their conversation on any device.</p>
<form method="post" action="/inbox/${esc(inbox.id)}/identity"><button name="action" value="on">Turn on verified visitors</button></form>`}
<h2>Webhooks</h2>
<p class="oc-muted">Your systems hear what happens: a Slack or Discord webhook address gets a line when a visitor waits for a person, writes while waiting, or rates a conversation; any other https address gets every event as signed JSON (verify it with <code>openvibe-sdk/events</code> <code>parseDelivery</code>).</p>
${hooks.length ? `<ul class="oc-members">${hooks.map((w) => `<li><b>${esc(w.format === 'openvibe' ? 'JSON' : w.format === 'slack' ? 'Slack' : 'Discord')}</b> <span class="oc-muted">${esc(w.url.replace(/^https:\/\//, '').slice(0, 60))}${w.url.length > 68 ? '…' : ''} · ${w.on ? (w.last_status ? `last answer ${w.last_status}${w.last_error ? ` (${esc(w.last_error)})` : ''}` : 'nothing sent yet') : 'off after repeated failures: add it again to switch it on'}</span>
<form class="oc-inline" method="post" action="/inbox/${esc(inbox.id)}/webhooks/${w.id}/test"><button class="oc-link" type="submit">Send a test</button></form>
<form class="oc-inline" method="post" action="/inbox/${esc(inbox.id)}/webhooks/${w.id}/delete"><button class="oc-link" type="submit">Remove</button></form></li>`).join('')}</ul>` : ''}
${hooks.length < webhooks.MAX_WEBHOOKS ? `<form class="oc-form" method="post" action="/inbox/${esc(inbox.id)}/webhooks"><label>Address (https) <input name="url" type="url" required maxlength="1000" placeholder="https://hooks.slack.com/services/…"></label><p><button type="submit">Add the webhook</button></p></form>` : ''}
<h2>How it looks and what Vibe knows</h2>
<form class="oc-form" method="post" action="/inbox/${esc(inbox.id)}/settings">
<label>Name <input name="name" required minlength="2" maxlength="60" value="${esc(shape.name)}"></label>
<label>Greeting <input name="greeting" maxlength="300" value="${esc(shape.greeting)}"></label>
<label>Colour <input name="color" type="color" value="${esc(shape.color)}"></label>
<label class="oc-check"><input type="checkbox" name="ai_enabled" value="1"${shape.ai_enabled ? ' checked' : ''}> Vibe answers first</label>
<label class="oc-check"><input type="checkbox" name="handoff" value="1"${shape.handoff ? ' checked' : ''}> People answer here too (visitors can ask for a person; off: a site assistant where only Vibe answers)</label>
<label>What Vibe should know <textarea name="ai_instructions" rows="6" maxlength="4000">${esc(shape.ai_instructions)}</textarea></label>
<label>Pages Vibe may read (https, one per line) <textarea name="knowledge_urls" rows="3">${esc(shape.knowledge_urls.join('\n'))}</textarea></label>
<label>Sites that may show it (one per line; empty: any site) <textarea name="allowed_origins" rows="2" placeholder="https://example.com">${esc(shape.allowed_origins.join('\n'))}</textarea></label>
<p><button type="submit">Save</button></p></form>` : '<p class="oc-muted">Only the owner changes the settings.</p>'}
<h2>People</h2>
<ul class="oc-members">${team.map((m) => `<li><b>${esc(m.display_name || m.username || `user ${m.user_id}`)}</b> <span class="oc-muted">@${esc(m.username || '')} · ${m.role}</span>${owner && m.role !== 'owner' ? ` <form class="oc-inline" method="post" action="/inbox/${esc(inbox.id)}/members/${m.user_id}/delete"><button class="oc-link" type="submit">Remove</button></form>` : ''}</li>`).join('')}</ul>
${owner ? `<form class="oc-form" method="post" action="/inbox/${esc(inbox.id)}/members"><label>Add a person by username <input name="username" required maxlength="40" placeholder="username"></label><p><button type="submit">Add</button></p></form>` : ''}
<h2>Saved replies</h2>
<p class="oc-muted">Ready answers for the whole team: type <code>/</code> in the reply box and its shortcut.</p>
${saved.length ? `<ul class="oc-members">${saved.map((r) => `<li><b>/${esc(r.shortcut)}</b> <span class="oc-muted">${esc(r.body.slice(0, 120))}${r.body.length > 120 ? '…' : ''}</span> <form class="oc-inline" method="post" action="/inbox/${esc(inbox.id)}/replies/${r.id}/delete"><button class="oc-link" type="submit">Delete</button></form></li>`).join('')}</ul>` : ''}
<form class="oc-form" method="post" action="/inbox/${esc(inbox.id)}/replies"><label>Shortcut <input name="shortcut" required maxlength="30" pattern="/?[a-zA-Z0-9][a-zA-Z0-9-]*" placeholder="refund"></label>
<label>Reply <textarea name="body" rows="3" maxlength="4000" required placeholder="Refunds go back to the card you paid with within 5 days."></textarea></label><p><button type="submit">Save the reply</button></p></form>`,
        });
    });

    router.post('/inbox/:id/settings', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        const b = req.body || {};
        try {
            await inboxes.update(a.inbox, a.actor.user, { name: b.name, greeting: b.greeting, color: b.color, ai_enabled: b.ai_enabled === '1', handoff: b.handoff === '1', ai_instructions: b.ai_instructions, knowledge_urls: b.knowledge_urls, allowed_origins: b.allowed_origins });
            res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`);
        } catch (err) { res.redirect(303, `/inbox/${a.inbox.id}/settings?error=${encodeURIComponent(err.message || 'That did not save')}`); }
    });
    router.post('/inbox/:id/webhooks', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        if (a.role !== 'owner') return res.redirect(303, `/inbox/${a.inbox.id}/settings`);
        try {
            const { secret } = await webhooks.add(a.inbox, a.actor.user, req.body && req.body.url);
            if (!secret) return res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`);
            // The secret is shown on this answer only (never in a URL: addresses end up in histories and logs).
            await page(req, res, 201, { actor: a.actor, title: `${a.inbox.name}: webhook`, path: `/inbox/${a.inbox.id}/settings`, active: 'inbox', robots: 'noindex, nofollow',
                body: `<p><a href="/inbox/${esc(a.inbox.id)}/settings">&larr; ${esc(a.inbox.name)} settings</a></p><h1>Webhook added</h1>
${notice('ok', 'Here is its signing secret. Copy it now: it is shown only this once.')}<pre class="ib-snippet"><code>${esc(secret)}</code></pre>
<p class="oc-muted">Check each delivery with it: <code>parseDelivery(rawBody, headers, secret, { requireV2: true })</code> from <code>openvibe-sdk/events</code> (X-OpenVibe-Timestamp and X-OpenVibe-Signature-V2).</p>` });
        } catch (err) { res.redirect(303, `/inbox/${a.inbox.id}/settings?error=${encodeURIComponent(err.message || 'That did not work')}`); }
    });
    router.post('/inbox/:id/webhooks/:wid/test', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a || a.role !== 'owner') return a && res.redirect(303, `/inbox/${a.inbox.id}/settings`);
        try { const r = await webhooks.test(a.inbox, req.params.wid); res.redirect(303, `/inbox/${a.inbox.id}/settings?${r.ok ? 'saved=1' : `error=${encodeURIComponent(`The test got ${r.error}`)}`}`); }
        catch (err) { res.redirect(303, `/inbox/${a.inbox.id}/settings?error=${encodeURIComponent(err.message || 'That did not work')}`); }
    });
    router.post('/inbox/:id/webhooks/:wid/delete', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        if (a.role === 'owner') await webhooks.remove(a.inbox, req.params.wid);
        res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`);
    });
    router.post('/inbox/:id/replies', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        try { await inboxes.saveReply(a.inbox, a.actor.user, req.body || {}); res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`); }
        catch (err) { res.redirect(303, `/inbox/${a.inbox.id}/settings?error=${encodeURIComponent(err.message || 'That did not save')}`); }
    });
    router.post('/inbox/:id/replies/:rid/delete', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        try { await inboxes.deleteReply(a.inbox, a.actor.user, req.params.rid); } catch { /* unchanged */ }
        res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`);
    });
    router.post('/inbox/:id/identity', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        try { await inboxes.setIdentity(a.inbox, a.actor.user, String((req.body && req.body.action) || '')); res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`); }
        catch (err) { res.redirect(303, `/inbox/${a.inbox.id}/settings?error=${encodeURIComponent(err.message || 'That did not work')}`); }
    });
    router.post('/inbox/:id/members', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        try { await inboxes.addMember(a.inbox, a.actor.user, req.body && req.body.username); res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`); }
        catch (err) { res.redirect(303, `/inbox/${a.inbox.id}/settings?error=${encodeURIComponent(err.message || 'That did not work')}`); }
    });
    router.post('/inbox/:id/members/:uid/delete', formLimit, sameSite, async (req, res) => {
        const a = await agentInbox(req, res); if (!a) return;
        try { await inboxes.removeMember(a.inbox, a.actor.user, req.params.uid); } catch { /* unchanged */ }
        res.redirect(303, `/inbox/${a.inbox.id}/settings?saved=1`);
    });
}

module.exports = { mountInboxPages, embedHtml };
