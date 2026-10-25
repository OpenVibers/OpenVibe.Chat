'use strict';
/**
 * A chat room on any website (docs/platform.md, the widget's community room mode):
 *
 *   <script src="https://openvibe.chat/widget.js" data-room="<slug>" async></script>                a bubble
 *   <script src="https://openvibe.chat/widget.js" data-room="<slug>" data-target="#chat" async></script>   inline
 *
 *   GET  /embed/room/:slug       the room in a frame (public rooms only; frame-ancestors any site): its latest messages,
 *                                live over the chat socket (public/web/room-embed.js); anyone reads, people sign in to write
 *   GET  /embed/signin#t=…       the sign-in window the frame opens: it keeps the ticket (in the address's fragment, so
 *                                no server or log ever sees it) in its own session storage through OpenVibe's sign-in,
 *                                then binds it with POST /embed/bind (the person's session, same site only)
 *   POST /embed/bind             { ticket } → the ticket is bound to the signed-in person for two minutes
 *   POST /embed/ticket           { ticket } → { token } once the window bound it (the frame asks every second or two)
 *
 * Why a ticket: a frame on another site gets no openvibe.chat cookies (browsers block or partition them), and the
 * sign-in window loses its link to the frame when it passes through openvibe.network (Cross-Origin-Opener-Policy
 * same-origin), so neither a cookie nor postMessage can carry the sign-in back. The frame makes a random ticket, the
 * window binds it after sign-in, and the frame collects the token once. Moderation is the room's and OpenVibe's
 * global standard: posting goes through rooms.post like everywhere else.
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const rooms = require('../rooms/rooms');
const { esc, asset } = require('./layout');

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const TICKET_MS = 2 * 60 * 1000;
const tickets = new Map();   // sha256(ticket) → { token, at }

function sweep(now = Date.now()) { for (const [k, v] of tickets) if (now - v.at > TICKET_MS) tickets.delete(k); }
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const hhmm = (ts) => { const d = new Date(String(ts || '').includes('T') ? ts : `${String(ts || '').replace(' ', 'T')}Z`); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };

/** May this room be put on other sites? Public, readable by anyone, not a Vibe chat or a server's channel. */
async function embeddable(room) {
    if (!room || room.visibility !== 'public' || Number(room.assistant) === 1 || room.server_id) return false;
    return !!(await rooms.access(room, null)).read;
}

function messageHtml(m) {
    const ai = m.ai_member_id != null;
    return `<li class="re-msg${ai ? ' re-ai' : ''}" data-id="${Number(m.id) || 0}"><time datetime="${esc(hhmm(m.created_at))}"></time><b>${esc(m.display_name || m.username || 'someone')}</b>${ai ? '<span class="re-badge">AI</span>' : ''} <span class="re-text">${esc(m.message)}</span></li>`;
}

function embedHtml(room, members, msgs, { bubble }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(room.name)} · OpenVibe Chat</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="${asset('embed.css')}">
<script src="${asset('room-embed.js')}" defer></script>
</head>
<body style="--accent:#3b82f6">
<div class="em re" id="re" data-room="${esc(room.slug)}"${bubble ? ' data-bubble="1"' : ''}>
<header class="em-head"><span class="em-mark" aria-hidden="true">#</span>
<div><b>${esc(room.name)}</b><span>${members} ${members === 1 ? 'member' : 'members'}${room.topic ? ` · ${esc(room.topic)}` : ''}</span></div>
<a class="em-x" href="https://openvibe.chat/r/${esc(room.slug)}" target="_blank" rel="noopener" aria-label="Open the room on OpenVibe" title="Open on OpenVibe">&#8599;</a>${bubble ? '<button class="em-x" type="button" data-close aria-label="Close the chat">&times;</button>' : ''}</header>
<ol class="em-thread re-thread" id="re-thread" aria-live="polite" aria-label="Messages">${msgs.map(messageHtml).join('') || '<li class="em-system" id="re-empty">No messages yet. Say hello.</li>'}</ol>
<p class="em-error" role="alert" hidden></p>
<form class="em-composer" id="re-form" hidden><label class="em-sr" for="re-input" hidden>Your message</label>
<textarea id="re-input" rows="1" maxlength="2000" placeholder="Message ${esc(room.name)}" aria-label="Your message"></textarea>
<button type="submit" aria-label="Send">&#8593;</button></form>
<div class="re-dock" id="re-dock"><button type="button" class="re-signin" id="re-signin">Sign in with OpenVibe to chat</button></div>
<p class="em-foot">Chat by <a href="https://openvibe.chat" target="_blank" rel="noopener">OpenVibe</a><span id="re-who"></span></p>
</div>
<noscript><p style="padding:16px">This chat needs JavaScript.</p></noscript>
</body>
</html>`;
}

function mountRoomEmbedPages(router, { viewerOf, sameSite, config }) {
    const base = config.web.baseUrl;
    const ticketLimit = rateLimit({ windowMs: 60_000, max: 90, standardHeaders: true, legacyHeaders: false });

    router.get('/embed/room/:slug', async (req, res) => {
        const room = await rooms.bySlug(req.params.slug);
        if (!(await embeddable(room))) return res.status(404).set('Cache-Control', 'no-store').type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Room not found</title><p style="font-family:system-ui;padding:16px">This room is not available here.</p>');
        const msgs = await rooms.history(room, { limit: 50 });
        const members = (await rooms.publicRoom(room)).members;
        res.set('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:",
            `connect-src 'self' ${base.replace(/^http/, 'ws')}`, 'frame-ancestors *', "base-uri 'self'", "form-action 'self'", "object-src 'none'",
        ].join('; ')).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html')
            .send(embedHtml(room, members, msgs, { bubble: req.query.bubble === '1' }));
    });

    router.get('/embed/signin', async (req, res) => {
        const actor = await viewerOf(req);
        const nonce = crypto.randomBytes(16).toString('base64');
        const signedIn = actor.kind === 'user';
        res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`)
            .set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').set('Referrer-Policy', 'no-referrer').type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · OpenVibe Chat</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center;padding:16px">
<div><p id="say" style="font-size:1.25rem;font-weight:700;margin:0 0 6px">${signedIn ? `Signing you in as ${esc(actor.user.display_name || actor.user.username)}…` : 'Taking you to OpenVibe sign-in…'}</p>
<p style="margin:0;color:#5b6577">Go back to the chat afterwards; this window closes by itself.</p></div>
<script nonce="${nonce}">(function () {
  var say = document.getElementById('say'), KEY = 'ov-embed-ticket', t = null;
  var m = /(?:^|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash.slice(1));
  try { if (m) sessionStorage.setItem(KEY, m[1]); t = sessionStorage.getItem(KEY); } catch (e) { t = m && m[1]; }
  if (m) history.replaceState(null, '', location.pathname);
  if (!t) { say.textContent = 'This sign-in link is not complete. Close this window and try again from the chat.'; return; }
  if (!${signedIn ? 'true' : 'false'}) { location.replace('/auth/login?next=' + encodeURIComponent('/embed/signin')); return; }
  fetch('/embed/bind', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t }) })
    .then(function (r) {
      try { sessionStorage.removeItem(KEY); } catch (e) { /* gone */ }
      if (!r.ok) { say.textContent = 'That did not work. Close this window and try again from the chat.'; return; }
      say.textContent = 'You\u2019re signed in. Go back to the chat.';
      setTimeout(function () { window.close(); }, 1200);
    }, function () { say.textContent = 'You seem to be offline. Try again from the chat.'; });
})();</script>
</body></html>`);
    });

    router.post('/embed/bind', ticketLimit, sameSite, async (req, res) => {
        const ticket = String((req.body && req.body.ticket) || '');
        if (!TICKET_RE.test(ticket)) return res.status(400).json({ error: 'No such ticket', code: 'embed.ticket' });
        const actor = await viewerOf(req);
        if (actor.kind !== 'user') return res.status(401).json({ error: 'Sign in first', code: 'embed.sign_in' });
        sweep();
        if (tickets.size > 10000) return res.status(503).json({ error: 'Too many sign-ins at once. Try again in a minute.', code: 'embed.busy' });
        tickets.set(hash(ticket), { token: actor.token, at: Date.now() });
        res.set('Cache-Control', 'no-store').json({ ok: true });
    });

    router.post('/embed/ticket', ticketLimit, (req, res) => {
        const ticket = String((req.body && req.body.ticket) || '');
        if (!TICKET_RE.test(ticket)) return res.status(400).json({ error: 'No such ticket', code: 'embed.ticket' });
        sweep();
        const key = hash(ticket);
        const hit = tickets.get(key);
        if (!hit) return res.status(202).set('Cache-Control', 'no-store').json({ pending: true });
        tickets.delete(key);   // once
        res.set('Cache-Control', 'no-store').json({ token: hit.token });
    });
}

function _reset() { tickets.clear(); }

module.exports = { mountRoomEmbedPages, embeddable, _reset };
