'use strict';
/**
 * openvibe.chat, the site (roadmap WS-I task 8): the network-wide chat room, your direct messages and
 * your chat settings, served by OpenVibe.Chat itself, so it keeps working while OpenVibe.Live is down.
 *
 *   GET  /                    global chat: the last messages server-rendered (readable without
 *                             JavaScript); public/web/chat.js adds the live feed over /ws/chat
 *   POST /send                the composer without JavaScript (the same handler as POST /api/chat/send)
 *   GET  /messages            your inbox: conversations with unread counts, people you blocked;
 *                             POST /messages/new starts one by username; POST /messages/unblock/:userId
 *   GET  /messages/:id        one conversation (participants only); POST /messages/:id replies;
 *                             POST /messages/:id/block blocks the other person of a 1:1 conversation;
 *                             POST /messages/:id/call rings them (the call-user route) and opens /call/<channel>
 *   GET  /call/:channel       a 1:1 call's page (its caller and the people it invited): public/web/call.js joins
 *                             it, and while the caller waits it says ringing until the answer comes
 *   GET  /rooms, /r/:slug     rooms: community, call (a voice/video call in the page, public/web/call.js)
 *                             and system (staff announcements); /r/:slug/settings for moderators
 *   GET  /settings            your portable chat settings (Network module chat.preferences); POST saves
 *   GET  /updates             what shipped on openvibe.chat (the shared changelog)
 *   GET  /robots.txt, /sitemap.xml
 *   /auth/*                   sign in with OpenVibe.Network (./session.js), cookies host-only
 *
 * Forms go through the same API handlers the JavaScript client calls (apiBridge), so rate limits,
 * bans, blocks, spam checks and DM participation are enforced in one place. Posts must come from this
 * site (Origin check; the session cookie is SameSite=Lax).
 *
 * Working with Live down: nothing here waits on OpenVibe.Live. People are signed in from their Network
 * token and the ctx_users projection (auth/network-session.js), and every page reads Chat's own
 * tables; the only openvibe.live URLs are links to people's profiles (navigation, never fetched).
 * test/live-down.test.js renders every page and uses the core APIs with Live refusing and hanging.
 */
const showcase = require('openvibe-shared/showcase');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const cache = require('openvibe-shared/cache-policy');
const { renderPage, contentSecurityPolicy, assetVersion, esc, SITE_NAME } = require('./layout');
const { createSessionRoutes } = require('./session');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const home = require('./home');
const sharedSeo = require('openvibe-shared/seo');
const session = require('../auth/network-session');
const historyStore = require('../chat/history-store');
const dm = require('../chat/dm');
const prefs = require('../prefs/chat-preferences');
const prefStores = require('../prefs/stores');
const ctx = require('../live-context');
const permissions = require('../auth/permissions');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public', 'web');
const ANON = Object.freeze({ kind: 'anonymous' });
const LIVE = 'https://openvibe.live';
const FONT_SCALES = { small: 0.88, default: null, large: 1.18 };

async function viewerOf(req) {
    const token = req.cookies && req.cookies.ov_token;
    if (!token) return ANON;
    const u = await session.authenticate(token).catch(() => null);
    if (!u || u.auth_source === 'api_token') return ANON;
    return { kind: 'user', user: u, token };
}

async function prefsOf(actor) {
    if (actor.kind !== 'user' || !actor.user.subject_id) return {};
    try { return (await prefs.get(actor.user.subject_id)).preferences || {}; } catch { return {}; }
}

const hhmm = (ts) => {
    const d = new Date(String(ts || '').includes('T') ? ts : `${String(ts || '').replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? { iso: '', text: '' } : { iso: d.toISOString(), text: d.toISOString().slice(11, 16) };
};
/** Plain text with http(s) links, escaped. */
// ||Spoilers|| (and /spoiler, sent as one): hidden until selected. The raw text is split before escaping, so a marker
// never lands inside a link; without JavaScript a spoiler shows while it has focus, chat.js keeps it shown.
const SPOILER_RE = /\|\|([\s\S]+?)\|\|/g;
function linkify(text) {
    const raw = String(text ?? '');
    let out = '';
    let last = 0;
    for (const m of raw.matchAll(SPOILER_RE)) {
        if (!m[1].trim()) continue;
        out += linkifyPart(raw.slice(last, m.index)) + `<span class="oc-spoiler" tabindex="0" role="button" aria-label="Spoiler, select to show">${linkifyPart(m[1])}</span>`;
        last = m.index + m[0].length;
    }
    return out + linkifyPart(raw.slice(last));
}
function linkifyPart(text) {
    return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" rel="nofollow ugc noopener" target="_blank">${u}</a>`);
}
/** The author's badge, from the staff map (ADR-022): staff run the site, moderators moderate chat. */
function roleBadge(role) {
    const who = { role: String(role || 'user') };
    if (permissions.can(who, 'staff.site.configure')) return '<span class="oc-badge oc-badge-staff" title="OpenVibe staff">staff</span>';
    if (permissions.can(who, 'staff.moderation.chat')) return '<span class="oc-badge oc-badge-mod" title="Moderator">mod</span>';
    return '';
}
// The name effect a person wears (OpenVibe.Inventory through Live's decor): a class openvibe-shared items.css draws.
const NAME_FX_RE = /^name-fx-[a-z]{2,24}$/;
const nameFxClass = (m) => (m && m.nameFX && NAME_FX_RE.test(String(m.nameFX.cssClass || '')) ? m.nameFX.cssClass : null);
// The hat they wear (m.hatFX: its emoji and Live's float/pulse/warp motion), just before the name (items.css .ov-hat).
const HAT_MOTION = ['float', 'pulse', 'warp'];
function hatHtml(m) {
    // A community badge (the Workshop, m.badgeFX): its reviewed image on OpenVibe.Media, first.
    const b = m && m.badgeFX && /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(m.badgeFX.mediaId || '')) ? `<img class="ov-badge" src="https://openvibe.media/o/${m.badgeFX.mediaId}" alt="" width="16" height="16" loading="lazy" aria-hidden="true">` : '';
    return b + hatOnly(m);
}
function hatOnly(m) {
    const h = m && m.hatFX;
    const glyph = h && typeof h.hatChar === 'string' ? h.hatChar.slice(0, 8) : '';
    if (!glyph) return '';
    return `<span class="ov-hat${HAT_MOTION.includes(h.animated) ? ` ov-hat-${h.animated}` : ''}" aria-hidden="true">${esc(glyph)}</span>`;
}
function globalMessage(m) {
    const t = hhmm(m.timestamp);
    const handle = m.core_username || (m.user_id ? m.username : null);
    const fx = nameFxClass(m);
    const name = fx ? `<span class="ov-fx ${fx}">${esc(m.display_name || m.username || m.anon_id || 'someone')}</span>` : esc(m.display_name || m.username || m.anon_id || 'someone');
    const who = handle ? `<a class="oc-name" href="${LIVE}/@${encodeURIComponent(handle)}" style="--nc:${esc(/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '') ? m.profile_color : 'inherit')}">${hatHtml(m)}${name}</a>` : `<span class="oc-name oc-anon">${name}</span>`;
    const where = m.stream_channel ? ` <a class="oc-where" href="${LIVE}/@${encodeURIComponent(m.stream_channel)}" title="Sent from ${esc(m.stream_channel)}'s channel">@${esc(m.stream_channel)}</a>` : '';
    return `<li class="oc-msg" data-id="${Number(m.id) || 0}"><time class="oc-time" datetime="${t.iso}">${t.text}</time> ${who}${roleBadge(m.role)}${where} <span class="oc-text">${linkify(m.message)}</span></li>`;
}
function dmMessage(m, me) {
    const t = hhmm(m.created_at);
    const mine = me && m.sender_id === me.id;
    return `<li class="oc-msg${mine ? ' oc-mine' : ''}" data-id="${Number(m.id) || 0}"><time class="oc-time" datetime="${t.iso}">${t.text}</time> <span class="oc-name">${esc(m.display_name || m.username)}</span> <span class="oc-text">${linkify(m.message)}</span></li>`;
}
const notice = (kind, text) => `<p class="oc-notice oc-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</p>`;

/**
 * Run a form through an existing JSON API handler: the route is re-dispatched under `apiPath`, and its
 * JSON answer becomes a redirect (success) or an error page. One set of checks for both clients.
 */
function apiBridge(apiRouter, apiPath, { body, ok, fail }) {
    return (req, res, next) => {
        const original = req.url;
        req.url = typeof apiPath === 'function' ? apiPath(req) : apiPath;
        if (body) req.body = body(req);
        res.json = (payload) => {
            req.url = original;
            if (res.statusCode < 400) return ok(req, res, payload || {});
            return fail(req, res, res.statusCode, (payload && payload.error) || 'That did not work');
        };
        apiRouter(req, res, (err) => { req.url = original; next(err); });
    };
}

function createWebRoutes({ config }) {
    const router = express.Router();
    const site = config.web.baseUrl;
    const siteOrigin = (() => { try { return new URL(site).origin; } catch { return null; } })();
    const webConfig = { ...config, baseUrl: site };
    const viewers = { resolve: async (req) => await viewerOf(req) };
    const formLimit = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
    const sameSite = (req, res, next) => {
        const o = req.get('origin');
        if (o && o !== siteOrigin && o !== 'null') return res.status(403).type('text').send('Forms are only accepted from this site.');
        next();
    };
    const countsOf = async (actor) => {
        if (actor.kind !== 'user') return {};
        const n = async (fn) => { try { return Number(await fn()) || 0; } catch { return 0; } };
        const rooms = require('../rooms/rooms');
        return {
            messages: await n(async () => await dm.getTotalUnread(actor.user.id)),
            rooms: await n(async () => await rooms.unreadTotal(actor.user)),
            servers: await n(async () => await rooms.unreadTotal(actor.user, { servers: true })),
        };
    };
    // Under the global room on the front page: what openvibe.chat is for (openvibe-shared/showcase), each card a real
    // place to go. Every line is true today (calls run since CHAT_CALLS=1; rooms, messages and settings are pages here).
    const whatChatDoes = (signedIn) => showcase.features({
        id: 'what-chat-does', title: 'What OpenVibe.Chat does',
        lede: 'The chat behind every OpenVibe site, with one account and one set of preferences everywhere.',
        items: [
            { icon: 'ov:chat', title: 'One room for the network', text: 'Global chat reaches everyone on Live, Tools, Games and the rest, and reads without an account.', href: '#oc-h' },
            { icon: 'ov:live', title: 'Stream chat on Live', text: 'Every channel on OpenVibe.Live has its room, with the streamer\'s moderators, timeouts, bans, emotes and text to speech.', href: 'https://openvibe.live/' },
            { icon: 'ov:community', title: 'Servers and rooms', text: 'Start a server with text and voice channels, roles and invite links, or a single room, public or private.', href: '/servers' },
            { icon: 'ov:account', title: 'Direct messages', text: 'One-to-one and group conversations. You choose who may start one, and whether groups may add you.', href: signedIn ? '/messages' : '/auth/login?next=%2Fmessages' },
            { icon: 'ov:stream', title: 'Voice and video calls', text: 'Call a person, open a call room, or join a stream\'s call: up to eight people, with mute, camera and kick controls.', href: '/rooms' },
            { icon: 'ov:theme', title: 'Your preferences everywhere', text: 'Compact mode, timestamps, text size, badges and emotes follow your account to every site.', href: signedIn ? '/settings' : '/auth/login?next=%2Fsettings' },
        ],
    });

    const page = async (req, res, status, o) => {
        const actor = o.actor || await viewerOf(req);
        const nonce = require('crypto').randomBytes(16).toString('base64');
        res.status(status).set('Cache-Control', o.cache || cache.htmlHeaders({ private: true })).set('Content-Security-Policy', contentSecurityPolicy(nonce)).type('html')
            .send(renderPage({ config, actor, prefs: await prefsOf(actor), counts: await countsOf(actor), nonce, ringScript: actor.kind === 'user' && !!(config.calls && config.calls.enabled), ...o }));
    };
    const needUser = async (req, res) => {
        const actor = await viewerOf(req);
        if (actor.kind === 'user') return actor;
        res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        return null;
    };

    router.use('/auth', createSessionRoutes({ config: webConfig, viewers }));
    router.use('/shared', ovServe.handler());
    // A /web asset is content-addressed by layout.asset()'s ?v=: only that exact version is immutable,
    // anything else (a stale link, a hand-typed URL) gets the short public window.
    router.use('/web', express.static(PUBLIC_DIR, {
        index: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── Global chat ──
    router.get('/', async (req, res) => {
        const actor = await viewerOf(req);
        const { messages, latest_id } = await historyStore.page('global', { limit: 60 });
        // Not the lines of people this reader blocked on the network (chat/network-blocks.js).
        const hidden = actor.kind === 'user' ? await require('../chat/network-blocks').blockedUserIds(actor.user) : new Set();
        const shown = messages.filter((m) => !m.is_deleted && (m.message_type || 'chat') === 'chat' && !(m.user_id && hidden.has(Number(m.user_id))));
        // What people wear: their name effects, from the decor cache (one Live read per 200 people, kept a minute). The
        // page waits for that read a quarter of a second at most: Live slow or down never holds the page, the names just
        // stay plain until the cache is warm.
        try {
            const warm = ctx.ensureDecor(shown.map((m) => m.user_id).filter(Boolean)).catch(() => {});
            await Promise.race([warm, new Promise((r) => { const tm = setTimeout(r, 250); if (tm.unref) tm.unref(); })]);
            for (const m of shown) {
                if (!m.user_id) continue;
                const prof = ctx.getCosmeticProfile(m.user_id);
                if (!m.nameFX && prof.nameFX) m.nameFX = prof.nameFX;
                if (!m.hatFX && prof.hatFX) m.hatFX = prof.hatFX;
                if (!m.badgeFX && prof.badgeFX) m.badgeFX = prof.badgeFX;
            }
        } catch { /* the names stay plain */ }
        const composer = actor.kind === 'user'
            ? (actor.user.is_banned ? notice('error', 'Your account is banned from chat.') : `<form class="oc-compose" method="post" action="/send" id="oc-compose">
<label for="oc-input" class="oc-sr">Message to everyone</label>
<textarea id="oc-input" name="message" maxlength="500" rows="2" required placeholder="Say something to everyone on OpenVibe"></textarea>
<button type="submit">Send</button>
</form>`)
            : `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=%2F">Sign in with OpenVibe</a> to chat. Anyone can read along.</p>`;
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        // Around the room: the real activity (server/web/home.js, read once a minute), how it works and questions.
        const parts = home.sections(await home.activity());
        const signedIn = actor.kind === 'user';
        await page(req, res, 200, {
            actor, fullTitle: 'OpenVibe.Chat: global chat, servers, rooms and calls', path: '/', active: 'global', robots: 'index, follow', script: true,
            description: 'Chat with everyone on OpenVibe, start a server with text and voice channels, message friends and call them. Free and open source.',
            jsonLd: [...homeJsonLd(config), sharedSeo.jsonLd.faq(home.FAQ)],
            page: { view: 'global', latest: latest_id, signedIn, me: signedIn ? actor.user.username : null },
            body: `<header class="oc-hero"><p class="oc-eyebrow">OpenVibe.Chat</p>
<h1>Chat with everyone on OpenVibe, or start your own server</h1>
<p class="oc-lede">Global chat for the whole network, the chat of every stream on OpenVibe.Live, servers with text and voice channels, rooms, private messages, calls of up to eight people, and AI members that join in. One free account, everywhere.</p>
<p class="oc-hero-actions"><a class="oc-button" href="${signedIn ? '/servers#oc-new-server' : '/auth/login?next=%2Fservers'}">Start a server</a> <a class="oc-button oc-button--quiet" href="/rooms">Rooms</a> <a class="oc-button oc-button--quiet" href="${signedIn ? '/messages' : '/auth/login?next=%2Fmessages'}">Messages</a></p>
${parts.stats}</header>
<section class="oc-room" aria-labelledby="oc-h">
<h2 id="oc-h">Global chat</h2>
<p class="oc-muted">One room for everyone on OpenVibe: streamers, viewers and players, from every site. <span class="oc-live" id="oc-live" hidden>● live</span></p>
${error}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${shown.map(globalMessage).join('\n') || '<li class="oc-empty oc-muted">No messages yet. Say hello.</li>'}</ol>
${composer}
</section>
${parts.streams}
${parts.places}
${whatChatDoes(signedIn)}
${parts.steps}
${parts.faq}
${parts.more}`,
            showcase: true,
        });
    });

    const chatApi = require('../chat/routes');
    router.post('/send', formLimit, sameSite, async (req, res, next) => {
        if (!(await needUser(req, res))) return;
        req.headers.authorization = `Bearer ${req.cookies.ov_token}`;
        return apiBridge(chatApi, '/send', {
            body: (r) => ({ message: String((r.body && r.body.message) || '').slice(0, 6000) }),
            ok: (r, s) => s.redirect(303, '/#oc-compose'),
            fail: (r, s, status, error) => s.redirect(303, `/?error=${encodeURIComponent(error)}#oc-compose`),
        })(req, res, next);
    });

    // ── Direct messages ──
    const dmApi = require('../chat/dm-routes');
    router.get('/messages', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const me = actor.user;
        const convs = await dm.getConversations(me.id);
        const rows = (await Promise.all(convs.map(async (c) => {
            const others = (await dm.getParticipants(c.id)).filter((p) => p.id !== me.id);
            const title = c.name || others.map((p) => p.display_name || p.username).join(', ') || 'Just you';
            const t = hhmm(c.last_message_at);
            return `<li class="oc-conv${c.unread_count ? ' oc-unread' : ''}"><a href="/messages/${c.id}"><strong>${esc(title)}</strong>${c.unread_count ? ` <span class="oc-badge">${c.unread_count} new</span>` : ''}<span class="oc-muted oc-last">${c.last_message ? esc(String(c.last_message).slice(0, 120)) : 'No messages yet'}</span></a>${t.text ? `<time class="oc-time" datetime="${t.iso}">${t.iso.slice(0, 10)}</time>` : ''}</li>`;
        })));
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const done = req.query.unblocked ? notice('ok', 'Unblocked. They can message you again, and you them.') : '';
        const blocked = await dm.getBlockedUsers(me.id);
        const blockedList = blocked.length ? `<details class="oc-blocked"><summary>People you blocked (${blocked.length})</summary><ul class="oc-members">${blocked.map((b) => `<li><strong>${esc(b.display_name || b.username)}</strong> <span class="oc-muted">@${esc(b.username || '')}</span><form class="oc-inline" method="post" action="/messages/unblock/${Number(b.id)}"><button type="submit" class="oc-link">Unblock</button></form></li>`).join('')}</ul></details>` : '';
        const unread = convs.reduce((n, c) => n + (Number(c.unread_count) || 0), 0);
        await page(req, res, 200, {
            actor, title: 'Messages', path: '/messages', active: 'messages', robots: 'noindex, nofollow', script: true,
            page: { view: 'inbox', unread, me: me.id },
            body: `<h1>Messages</h1>${error}${done}
<p class="oc-muted" id="oc-inbox-status" aria-live="polite">${unread ? `${unread} unread` : 'All caught up'}</p>
<form class="oc-new" method="post" action="/messages/new"><label for="oc-to">Message someone</label> <input id="oc-to" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="their username" autocomplete="off"> <button type="submit">Start</button></form>
<ul class="oc-convs" id="oc-convs">${rows.join('\n') || '<li class="oc-muted">No conversations yet.</li>'}</ul>
${blockedList}`,
        });
    });

    router.post('/messages/unblock/:userId', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const id = parseInt(req.params.userId, 10);
        if (Number.isInteger(id) && id > 0) await dm.unblockUser(actor.user.id, id);
        const back = /^\/messages\/\d+$/.test(String(req.body && req.body.back)) ? req.body.back : '/messages?unblocked=1';
        res.redirect(303, back);
    });

    router.post('/messages/new', formLimit, sameSite, async (req, res, next) => {
        const actor = await needUser(req, res); if (!actor) return;
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? await ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.redirect(303, `/messages?error=${encodeURIComponent(`Nobody called ${name.slice(0, 24)} on OpenVibe`)}`);
        req.headers.authorization = `Bearer ${req.cookies.ov_token}`;
        return apiBridge(dmApi, '/conversations', {
            body: () => ({ user_ids: [target.id] }),
            ok: (r, s, p) => { const id = (p.conversation && p.conversation.id) || p.id; return s.redirect(303, id ? `/messages/${Number(id)}` : '/messages'); },
            fail: (r, s, status, error) => s.redirect(303, `/messages?error=${encodeURIComponent(error)}`),
        })(req, res, next);
    });

    router.get('/messages/:id', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const me = actor.user;
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || !await dm.isParticipant(id, me.id)) return await page(req, res, 404, { actor, title: 'Not found', path: req.path, robots: 'noindex', body: '<h1>No such conversation</h1><p><a href="/messages">Back to your messages</a></p>' });
        const others = (await dm.getParticipants(id)).filter((p) => p.id !== me.id);
        const conv = await dm.getConversation(id);
        const title = (conv && conv.name) || others.map((p) => p.display_name || p.username).join(', ') || 'Conversation';
        const msgs = (await dm.getMessages(id, 60)).slice().sort((a, b) => a.id - b.id);
        try { await dm.markRead(id, me.id); } catch { /* best effort */ }
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        // A 1:1 conversation: block or unblock the other person here; a block (either way) closes the composer.
        const other = conv && !conv.is_group && others.length === 1 ? others[0] : null;
        const iBlocked = other ? await dm.hasBlocked(me.id, other.id) : false;
        const closed = other ? await dm.isBlockedEither(me.id, other.id) : false;
        const otherName = other ? esc(other.display_name || other.username) : '';
        let composer = `<form class="oc-compose" method="post" action="/messages/${id}" id="oc-compose"><label for="oc-input" class="oc-sr">Reply</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="Write a message"></textarea><button type="submit">Send</button></form>`;
        if (iBlocked) composer = `${notice('error', `You blocked ${other.display_name || other.username}. Neither of you can message the other.`)}<form class="oc-inline" method="post" action="/messages/unblock/${Number(other.id)}"><input type="hidden" name="back" value="/messages/${id}"><button type="submit">Unblock ${otherName}</button></form>`;
        else if (closed) composer = notice('error', 'You cannot message this person.');
        const tools = other && !iBlocked ? `<form class="oc-inline oc-tools" method="post" action="/messages/${id}/block"><button type="submit" class="oc-link">Block ${otherName}</button></form>` : '';
        // A 1:1 conversation nobody blocked can become a call (POST /messages/:id/call rings the other person).
        const callForm = other && !closed && require('../config').calls.enabled
            ? `<form class="oc-inline oc-dm-call" method="post" action="/messages/${id}/call"><button type="submit" class="oc-button--quiet">Call ${otherName}</button></form>` : '';
        await page(req, res, 200, {
            actor, title, path: `/messages/${id}`, active: 'messages', robots: 'noindex, nofollow', script: true,
            page: { view: 'dm', conversation: id, latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: me.id },
            body: `<p><a href="/messages">← Messages</a></p><div class="oc-dm-head"><h1>${esc(title)}</h1>${callForm}</div>${error}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${msgs.map((m) => dmMessage(m, me)).join('\n') || '<li class="oc-empty oc-muted">No messages yet.</li>'}</ol>
${composer}${tools}`,
        });
    });

    // Ring the other person of a 1:1 conversation through the call-user route (its limits, block check and ring
    // lifecycle), then wait for them on the call's page.
    router.post('/messages/:id/call', formLimit, sameSite, async (req, res, next) => {
        const actor = await needUser(req, res); if (!actor) return;
        const me = actor.user;
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || !await dm.isParticipant(id, me.id)) return res.redirect(303, '/messages');
        const back = (error) => res.redirect(303, `/messages/${id}?error=${encodeURIComponent(error)}`);
        if (!require('../config').calls.enabled) return back('Calls are not available right now.');
        const conv = await dm.getConversation(id);
        const others = (await dm.getParticipants(id)).filter((p) => p.id !== me.id);
        if (!conv || conv.is_group || others.length !== 1) return back('Only a one-to-one conversation has someone to call.');
        const other = others[0];
        req.headers.authorization = `Bearer ${req.cookies.ov_token}`;
        return apiBridge(require('../calls/routes'), '/voice-channels/call-user', {
            body: () => ({ user_id: other.id }),
            ok: (r, s, d) => (d.channel && d.channel.id ? s.redirect(303, `/call/${encodeURIComponent(d.channel.id)}?to=${Number(other.id)}&from=${id}`) : back('The call could not start.')),
            fail: (r, s, status, error) => back(error),
        })(req, res, next);
    });

    router.get('/call/:channel', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const me = actor.user;
        const callServer = require('../calls/call-server');
        const ch = require('../config').calls.enabled ? await callServer.getChannel(String(req.params.channel).slice(0, 80), me) : null;
        const ended = '<h1>This call has ended</h1><p><a href="/messages">Back to your messages</a></p>';
        // Only a person's own call channel is a call page; a room's or a stream's call lives on its own page.
        if (!ch || ch.roomSlug || ch.streamId || ch.permanent) return await page(req, res, 404, { actor, title: 'No such call', path: req.path, robots: 'noindex', body: ended });
        const nameOf = (u) => (u ? u.display_name || u.username : 'Someone');
        const toId = parseInt(req.query.to, 10);
        const ringing = ch.createdBy === me.id && toId > 0 && callServer.hasInvite(ch.id, toId) ? await ctx.getUserById(toId) : null;
        const host = ch.createdBy !== me.id ? await ctx.getUserById(ch.createdBy) : null;
        const title = ringing ? `Calling ${nameOf(ringing)}` : host ? `Call with ${nameOf(host)}` : ch.name;
        const from = parseInt(req.query.from, 10);
        const backLink = Number.isInteger(from) && await dm.isParticipant(from, me.id) ? `/messages/${from}` : '/messages';
        const people = ch.participants.length
            ? ch.participants.map((p) => `<li>${esc(p.displayName || p.username || 'Guest')}</li>`).join('')
            : '<li class="oc-muted">Nobody is in the call yet.</li>';
        await page(req, res, 200, {
            actor, title, path: `/call/${ch.id}`, active: 'messages', robots: 'noindex, nofollow', callScript: true,
            page: { view: 'call', me: me.id, call: { channel: ch.id, join: true, talk: true, auto: true, ring: ringing ? { id: Number(ringing.id), name: nameOf(ringing) } : null } },
            body: `<p><a href="${backLink}">← Back to the conversation</a></p>
<section class="oc-call oc-call-page" aria-labelledby="oc-call-h" id="oc-call">
<h1 id="oc-call-h">${esc(title)} <span class="oc-muted oc-call-count" id="oc-call-count">${ch.participantCount ? `· ${ch.participantCount} in` : ''}</span></h1>
<p class="oc-muted" id="oc-call-how">A voice call, peer to peer: your microphone goes only to the people in it.</p>
<ul class="oc-call-people" id="oc-call-people">${people}</ul>
<p class="oc-call-controls"><button type="button" id="oc-call-join" hidden>Join the call</button> <button type="button" id="oc-call-mute" hidden aria-pressed="false">Mute</button> <button type="button" id="oc-call-leave" hidden>Leave the call</button></p>
<p class="oc-muted oc-call-status" id="oc-call-status" role="status" aria-live="polite"></p>
<noscript><p class="oc-muted">A call needs JavaScript.</p></noscript>
</section>`,
        });
    });

    router.post('/messages/:id/block', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const me = actor.user;
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || !await dm.isParticipant(id, me.id)) return res.redirect(303, '/messages');
        const conv = await dm.getConversation(id);
        const others = (await dm.getParticipants(id)).filter((p) => p.id !== me.id);
        if (!conv || conv.is_group || others.length !== 1) return res.redirect(303, `/messages/${id}?error=${encodeURIComponent('Only a one-to-one conversation has someone to block')}`);
        await dm.blockUser(me.id, others[0].id);
        res.redirect(303, `/messages/${id}`);
    });

    router.post('/messages/:id', formLimit, sameSite, async (req, res, next) => {
        if (!(await needUser(req, res))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.redirect(303, '/messages');
        req.headers.authorization = `Bearer ${req.cookies.ov_token}`;
        return apiBridge(dmApi, `/conversations/${id}/messages`, {
            body: (r) => ({ message: String((r.body && r.body.message) || '').slice(0, 2000) }),
            ok: (r, s) => s.redirect(303, `/messages/${id}#oc-compose`),
            fail: (r, s, status, error) => s.redirect(303, `/messages/${id}?error=${encodeURIComponent(error)}#oc-compose`),
        })(req, res, next);
    });

    // ── Settings: the chat.* user modules (server/prefs/stores.js), the same records Live's chat reads ──
    const TTS_SOURCES = [['native', 'OpenVibe chat'], ['robotstreamer', 'RobotStreamer'], ['kick', 'Kick'], ['youtube', 'YouTube'], ['twitch', 'Twitch']];
    router.get('/settings', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const sid = actor.user.subject_id;
        const [p, tts, dmSet, pres] = await Promise.all([prefsOf(actor), prefStores.settingsOf(prefStores.tts, sid), prefStores.settingsOf(prefStores.dm, sid), prefStores.settingsOf(prefStores.presence, sid)]);
        const src = tts.sources || {};
        const volume = (name, label, v) => `<label>${label} <input type="number" name="${name}" min="0" max="100" step="5" value="${Number.isInteger(v) ? v : 80}"></label>`;
        const size = p.font_scale == null ? 'default' : p.font_scale < 0.95 ? 'small' : p.font_scale > 1.05 ? 'large' : 'default';
        const box = (name, label, on) => `<label class="oc-check"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${label}</label>`;
        const saved = req.query.saved ? notice('ok', 'Saved. These settings follow you to Live chat and every device.') : '';
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        await page(req, res, 200, {
            actor, title: 'Chat settings', path: '/settings', active: 'settings', robots: 'noindex, nofollow',
            body: `<h1>Chat settings</h1>${saved}${error}
<p class="oc-muted">Saved to your OpenVibe account, so they apply here, in Live chat and on every device you sign in to.</p>
<form class="oc-form" method="post" action="/settings">
${box('timestamps', 'Show the time next to each message', p.timestamps === true)}
${box('compact', 'Compact messages', p.compact === true)}
${box('show_badges', 'Show staff and moderator badges', p.show_badges !== false)}
${box('hide_emotes', 'Hide emotes', p.hide_emotes === true)}
<label>Text size <select name="font_size">${['small', 'default', 'large'].map((s) => `<option value="${s}"${s === size ? ' selected' : ''}>${s[0].toUpperCase()}${s.slice(1)}</option>`).join('')}</select></label>
<h2>Messages</h2>
<label>Who can start a conversation with you <select name="new_conversations"><option value="everyone"${dmSet.new_conversations !== 'nobody' ? ' selected' : ''}>Everyone</option><option value="nobody"${dmSet.new_conversations === 'nobody' ? ' selected' : ''}>Nobody (your existing conversations stay open)</option></select></label>
${box('group_invites', 'People can add me to group conversations', dmSet.group_invites !== false)}
${box('previews', 'Show message text in notifications', dmSet.previews !== false)}
<h2>Presence</h2>
${box('show_in_user_list', 'Show my name in chat user lists (when off, you are counted but not named)', pres.show_in_user_list !== false)}
<h2>Text-to-speech and sounds</h2>
${box('tts_send', 'Read my messages aloud where the streamer has text-to-speech on', tts.send !== false)}
${box('tts_send_while_live', 'Also while I am broadcasting', tts.send_while_live !== false)}
${volume('tts_volume', 'Text-to-speech volume', tts.volume)}
${box('tts_sounds', 'Play chat sounds', tts.sounds !== false)}
${volume('tts_sound_volume', 'Chat sound volume', tts.sound_volume)}
<fieldset class="oc-fieldset"><legend>Read messages relayed from</legend>${TTS_SOURCES.map(([k, label]) => box(`tts_src_${k}`, label, src[k] !== false)).join('')}</fieldset>
<p><button type="submit">Save</button></p>
</form>
<h2>Your chat history</h2>
<p>Download every message you have sent that is still visible, in Live chat and here.</p>
<p><a class="oc-button" href="/api/chat/me/export" download>Download (JSON)</a> <a class="oc-button" href="/api/chat/me/export?format=csv" download>Download (CSV)</a></p>
${await aiKeySection(actor)}`,
        });
    });

    // ── Your own AI key (server/ai/credentials.js): AI members you set up can think with your provider and model ──
    const credentials = require('../ai/credentials');
    async function aiKeySection(actor) {
        if (!require('../rooms/ai-members').enabled()) return '';
        let key = null, unreachable = false;
        try { key = await credentials.get(actor.user.subject_id); } catch { unreachable = true; }
        const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
        const spent = key ? `$${key.spent_usd_today.toFixed(2)} of ${key.budget_usd_per_day ? `$${key.budget_usd_per_day.toFixed(2)}` : 'no cap'} used today` : '';
        return `<h2 id="oc-ai-key">Your AI key</h2>
<p class="oc-muted">AI members you add to a room can think with your own provider and model instead of OpenVibe's: OpenAI, Anthropic, or any OpenAI-compatible endpoint (OpenRouter, Groq, Together, your own server). The key is kept encrypted in OpenVibe.AI and never shown again; the room's messages go to your provider when one of those members answers, and its replies count against your daily budget, not the room's limit.</p>
${unreachable ? notice('error', 'OpenVibe.AI did not answer, so your key cannot be shown or changed right now.') : `${key ? `<p><strong>${esc(credentials.label(key))}</strong> <span class="oc-muted">· key ending ${esc(key.key_hint || '····')} · ${esc(spent)}</span></p>` : '<p class="oc-muted">No key yet.</p>'}
<form class="oc-form" method="post" action="/settings/ai-key">
<label>Provider <select name="provider">${opt('openai', 'OpenAI or OpenAI-compatible', key ? key.provider : 'openai')}${opt('anthropic', 'Anthropic', key ? key.provider : '')}</select></label>
<label>Endpoint <input name="base_url" type="url" maxlength="300" inputmode="url" placeholder="https://openrouter.ai/api/v1 (leave empty for OpenAI itself)" value="${esc((key && key.base_url) || '')}"></label>
<label>Model <input name="model" required maxlength="120" placeholder="gpt-4o-mini" value="${esc((key && key.model) || '')}" autocomplete="off" spellcheck="false"></label>
<label>API key <input name="api_key" type="password" maxlength="400" autocomplete="off" spellcheck="false" placeholder="${key ? 'Leave empty to keep the current key' : 'sk-…'}"${key ? '' : ' required'}></label>
<label>Daily budget, US dollars <input name="budget_usd_per_day" type="number" min="0" max="1000" step="0.5" value="${key && key.budget_usd_per_day != null ? key.budget_usd_per_day : 1}"> <span class="oc-muted">0 means no cap</span></label>
<p><button type="submit">${key ? 'Save' : 'Add key'}</button></p>
</form>
${key ? `<form class="oc-inline" method="post" action="/settings/ai-key/delete"><button type="submit" class="oc-link">Remove my key</button> <span class="oc-muted">(AI members that use it go back to OpenVibe's model)</span></form>` : ''}`}`;
    }
    router.post('/settings/ai-key', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        try {
            const key = await credentials.put(actor.user.subject_id, { provider: b.provider, base_url: b.base_url, api_key: b.api_key, model: b.model, budget_usd_per_day: b.budget_usd_per_day });
            await require('../rooms/ai-members').relabelKey(actor.user.subject_id, key, actor.user);
            return res.redirect(303, '/settings?saved=1#oc-ai-key');
        } catch (err) { return res.redirect(303, `/settings?error=${encodeURIComponent(err.message || 'Could not save your key right now')}#oc-ai-key`); }
    });
    router.post('/settings/ai-key/delete', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        try {
            await credentials.remove(actor.user.subject_id);
            await require('../rooms/ai-members').dropKey(actor.user.subject_id);
            return res.redirect(303, '/settings?saved=1#oc-ai-key');
        } catch (err) { return res.redirect(303, `/settings?error=${encodeURIComponent(err.message || 'Could not remove your key right now')}#oc-ai-key`); }
    });

    router.post('/settings', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        const patch = {
            timestamps: b.timestamps === '1' ? true : null,
            compact: b.compact === '1' ? true : null,
            show_badges: b.show_badges === '1' ? null : false,
            hide_emotes: b.hide_emotes === '1' ? true : null,
            font_scale: Object.prototype.hasOwnProperty.call(FONT_SCALES, b.font_size) ? FONT_SCALES[b.font_size] : null,
        };
        const on = (k) => b[k] === '1';
        const pct = (k) => { const n = Math.round(Number(b[k])); return Number.isFinite(n) && n >= 0 && n <= 100 && n !== 80 ? n : null; };
        const sources = Object.fromEntries(TTS_SOURCES.filter(([k]) => !on(`tts_src_${k}`)).map(([k]) => [k, false]));
        const sid = actor.user.subject_id;
        try {
            await prefs.update(sid, patch);
            await prefStores.dm.update(sid, { new_conversations: b.new_conversations === 'nobody' ? 'nobody' : null, group_invites: on('group_invites') ? null : false, previews: on('previews') ? null : false });
            await prefStores.presence.update(sid, { show_in_user_list: on('show_in_user_list') ? null : false });
            await prefStores.tts.update(sid, {
                send: on('tts_send') ? null : false, send_while_live: on('tts_send_while_live') ? null : false, volume: pct('tts_volume'),
                sounds: on('tts_sounds') ? null : false, sound_volume: pct('tts_sound_volume'), sources: Object.keys(sources).length ? sources : null,
            });
            return res.redirect(303, '/settings?saved=1');
        } catch (err) { return res.redirect(303, `/settings?error=${encodeURIComponent(err.message || 'Could not save right now')}`); }
    });

    // ── Rooms (server/rooms/) ──
    const rooms = require('../rooms/rooms');
    const pictures = require('../rooms/pictures');
    const aiMembers = require('../rooms/ai-members');
    // A picture sent from the room's form (server/rooms/pictures.js): one image, kept in memory only until Pics has it.
    const pictureForm = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: (require('../config').pics.maxBytes || 20 * 1024 * 1024), files: 1, fields: 4 } }).single('picture');
    /** The "Add a picture" form under a room's or channel's composer (rooms where the person may post). */
    const pictureComposer = (room, back) => (pictures.enabled() ? `<details class="oc-pic-compose"><summary>Add a picture</summary>
<form class="oc-form oc-pic-form" method="post" action="/r/${esc(room.slug)}/picture" enctype="multipart/form-data" data-room="${esc(room.slug)}">
<input type="hidden" name="back" value="${esc(back)}">
<label>Picture <input type="file" name="picture" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" required></label>
<label>Caption <input name="caption" maxlength="500" placeholder="Say something about it (optional)"></label>
<p class="oc-muted">It goes to <a href="${esc(pictures.publicUrl())}">OpenVibe.Pics</a> as yours (location and camera details removed), where you can delete it, and the room gets its link.</p>
<p><button type="submit">Send picture</button></p></form></details>` : '');
    const roomRoutes = require('../rooms/routes');
    const roomsOrError = (fn) => async (req, res, next) => {
        try { return await fn(req, res, next); } catch (err) {
            if (err instanceof rooms.RoomError) return res.redirect(303, `${req.roomBack || '/rooms'}?error=${encodeURIComponent(err.message)}`);
            return next(err);
        }
    };
    const KIND_LABEL = { community: '', call: 'call', system: 'announcements' };
    const ROLE_LABEL = { owner: 'owner', mod: 'moderator', speaker: 'speaker', participant: 'participant', member: 'member', viewer: 'viewer', blocked: 'blocked' };
    const kindBadge = (r) => (KIND_LABEL[r.kind] ? ` <span class="oc-badge oc-kind-${esc(r.kind)}">${KIND_LABEL[r.kind]}</span>` : '');
    const roomCard = (r) => `<li class="oc-conv${r.unread ? ' oc-unread' : ''}"><a href="/r/${esc(r.slug)}"><strong>${esc(r.name)}</strong>${kindBadge(r)}${r.visibility === 'private' ? ' <span class="oc-badge">private</span>' : ''}${r.unread ? ` <span class="oc-badge">${r.unread} new</span>` : ''}<span class="oc-muted oc-last">${esc(r.topic || `${r.members} member${r.members === 1 ? '' : 's'}`)}</span></a></li>`;
    const roomMessage = (m, can, slug, me) => {
        const t = hhmm(m.created_at);
        const ai = m.ai_member_id != null;
        const del = (can.moderate || (me && !ai && m.user_id === me.id)) ? `<form class="oc-del" method="post" action="/r/${esc(slug)}/delete/${Number(m.id)}"><button type="submit" title="Delete this message" aria-label="Delete this message">×</button></form>` : '';
        const who = ai
            ? `<span class="oc-name oc-ai-name">${esc(m.display_name || 'AI')}</span> <span class="oc-badge oc-ai" title="An AI member of this room">AI</span>`
            : `<a class="oc-name" href="${LIVE}/@${encodeURIComponent(m.username || '')}"${/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '') ? ` style="--nc:${esc(m.profile_color)}"` : ''}>${esc(m.display_name || m.username || 'someone')}</a>${roleBadge(m.user_role)}`;
        return `<li class="oc-msg${ai ? ' oc-msg-ai' : ''}" data-id="${Number(m.id) || 0}" data-user="${Number(m.user_id) || 0}"><time class="oc-time" datetime="${t.iso}">${t.text}</time> ${who} <span class="oc-text">${linkify(m.message)}</span>${ai ? '' : pictures.pageHtml(m.message)}${del}</li>`;
    };
    const applyRoomChange = async (room) => await roomRoutes.applyRoomChange(room);

    router.get('/rooms', async (req, res) => {
        const actor = await viewerOf(req);
        const me = actor.kind === 'user' ? actor.user : null;
        const { public: pub, mine } = await rooms.list(me);
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const staff = !!me && permissions.can(me, 'staff.moderation.chat');
        const create = me ? `<form class="oc-form oc-create" method="post" action="/rooms/new">
<h2>Start a room</h2>
<label>Name <input name="name" required minlength="3" maxlength="40" placeholder="Night Owls"></label>
<label>Topic <input name="topic" maxlength="200" placeholder="What it is about (optional)"></label>
<fieldset class="oc-fieldset"><legend>Kind</legend>
<label class="oc-check"><input type="radio" name="kind" value="community" checked> Chat room: people write to each other</label>
<label class="oc-check"><input type="radio" name="kind" value="call"> Call room: a voice call with a text chat beside it</label>
${staff ? '<label class="oc-check"><input type="radio" name="kind" value="system"> Announcements: only OpenVibe staff post (staff)</label>' : ''}
</fieldset>
<label>In a call room, people who join <select name="join_role"><option value="participant">listen and write (participants)</option><option value="speaker">can talk (speakers)</option><option value="viewer">listen and read (viewers)</option></select></label>
<label class="oc-check"><input type="checkbox" name="private" value="1"> Private: only people you invite can read and post</label>
<p><button type="submit">Create room</button></p>
</form>` : `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=%2Frooms">Sign in with OpenVibe</a> to start or join a room.</p>`;
        await page(req, res, 200, {
            actor, title: 'Rooms', path: '/rooms', active: 'rooms', robots: 'index, follow',
            description: 'Chat and call rooms on OpenVibe: start one about anything, invite people, or join a public room.',
            body: `<h1>Rooms</h1>${error}
${mine.length ? `<h2>Your rooms</h2><ul class="oc-convs">${mine.map(roomCard).join('')}</ul>` : ''}
<h2>Public rooms</h2>${pub.length ? `<ul class="oc-convs">${pub.map(roomCard).join('')}</ul>` : `<div class="oc-rooms-empty">
<p><strong>No public room is open right now: start the first one below.</strong> A room can be about anything, private to the people you invite, a voice call, or a group chat with AI members who know the context.</p>
<p>Meanwhile the conversation is here:</p>
<ul class="oc-goto"><li><a href="/">Global chat</a>: everyone on OpenVibe, readable without an account</li>
<li><a href="/servers">Servers</a>: channels, voice, roles and invite links, Discord-style</li>
<li><a href="/messages">Messages</a>: direct messages with anyone on OpenVibe</li></ul></div>`}
${create}`,
        });
    });

    router.post('/rooms/new', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        const kind = rooms.KINDS.includes(b.kind) ? b.kind : 'community';
        const room = await rooms.create(actor.user, { name: b.name, topic: b.topic, visibility: b.private === '1' ? 'private' : 'public', kind, join_role: kind === 'call' ? b.join_role || null : null });
        res.redirect(303, `/r/${room.slug}`);
    }));

    const loadRoom = async (req, res) => {
        const actor = await viewerOf(req);
        const me = actor.kind === 'user' ? actor.user : null;
        const room = await rooms.bySlug(req.params.slug);
        const can = room ? await rooms.access(room, me) : null;
        if (!room || !can.read) { await page(req, res, 404, { actor, title: 'No such room', path: req.path, robots: 'noindex', body: '<h1>No such room</h1><p><a href="/rooms">All rooms</a></p>' }); return null; }
        req.roomBack = `/r/${room.slug}`;
        return { actor, me, room, can };
    };

    /** A call room's call: who is in, and the button public/web/call.js turns into the call. */
    function callPanel(room, can, me) {
        const call = roomRoutes.callOf(room) || { enabled: false, participants: 0, people: [] };
        if (!call.enabled) return `<section class="oc-call" aria-labelledby="oc-call-h"><h2 id="oc-call-h">Call</h2><p class="oc-muted">Calls are not available right now. The room's chat works as usual.</p></section>`;
        const people = call.people.length
            ? `<ul class="oc-call-people" id="oc-call-people">${call.people.map((p) => `<li>${esc(p.display_name || p.username || 'Guest')}${p.listening ? ' <span class="oc-muted">(listening)</span>' : ''}</li>`).join('')}</ul>`
            : '<ul class="oc-call-people" id="oc-call-people"><li class="oc-muted">Nobody is in the call yet.</li></ul>';
        const how = can.talk ? 'You can talk in this call.' : me ? 'You join listening. The owner or a moderator can make you a speaker.' : 'Anyone can listen. Sign in to be made a speaker.';
        return `<section class="oc-call" aria-labelledby="oc-call-h" id="oc-call">
<h2 id="oc-call-h">Call <span class="oc-muted oc-call-count" id="oc-call-count">${call.participants ? `· ${call.participants} in` : ''}</span></h2>
<p class="oc-muted" id="oc-call-how">${how}</p>
${people}
<p class="oc-call-controls"><button type="button" id="oc-call-join" hidden>${can.talk ? 'Join the call' : 'Listen in'}</button> <button type="button" id="oc-call-mute" hidden aria-pressed="false">Mute</button> <button type="button" id="oc-call-leave" hidden>Leave the call</button></p>
<p class="oc-muted oc-call-status" id="oc-call-status" role="status"></p>
<noscript><p class="oc-muted">The call needs JavaScript; the room's chat works without it.</p></noscript>
</section>`;
    }

    // A server's channel has one page, in its server (server-pages.js).
    const channelUrl = async (room, rest = '') => {
        const s = await require('../rooms/servers').byId(room.server_id);
        return s ? `/s/${s.slug}${rest || `/${room.channel_slug}`}` : '/servers';
    };

    router.get('/r/:slug', async (req, res) => {
        const x = await loadRoom(req, res); if (!x) return;
        const { actor, me, room, can } = x;
        if (room.server_id) return res.redirect(302, await channelUrl(room));
        const msgs = await rooms.history(room, { limit: 60 });
        if (me && can.role) await rooms.markRead(room, me);
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const joinLabel = room.kind === 'system' ? 'Follow these announcements' : 'Join this room';
        let composer;
        if (!me) composer = `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=${encodeURIComponent(`/r/${room.slug}`)}">Sign in with OpenVibe</a> to join the conversation.</p>`;
        else if (can.post) composer = `<form class="oc-compose" method="post" action="/r/${esc(room.slug)}" id="oc-compose"><label for="oc-input" class="oc-sr">Message to ${esc(room.name)}</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="${room.kind === 'system' ? 'Post an announcement' : `Message ${esc(room.name)}`}"></textarea><button type="submit">Send</button></form>${room.kind === 'system' ? '' : pictureComposer(room, `/r/${room.slug}`)}`;
        else if (!can.role) composer = `<form method="post" action="/r/${esc(room.slug)}/join"><button type="submit">${joinLabel}</button></form>`;
        else if (room.kind === 'system') composer = `<p class="oc-muted">Announcements from OpenVibe staff. You will see new ones counted in Rooms.</p>`;
        else if (can.role === 'viewer') composer = `<p class="oc-muted">You can read this room but not write in it (viewer).</p>`;
        else composer = notice('error', 'You cannot post here right now.');
        const tools = me && can.role && can.role !== 'owner' ? `<form class="oc-inline" method="post" action="/r/${esc(room.slug)}/leave"><button type="submit" class="oc-link">Leave room</button></form>` : '';
        const manage = can.moderate ? ` · <a href="/r/${esc(room.slug)}/settings">${can.manage ? 'Room settings' : 'Members'}</a>` : '';
        const YOU_ARE = { owner: 'the owner', mod: 'a moderator', speaker: 'a speaker', participant: 'a participant', member: 'a member', viewer: 'a viewer' };
        const yourRole = me && YOU_ARE[can.role] ? ` · you are ${YOU_ARE[can.role]}` : '';
        const isCall = room.kind === 'call';
        const callReady = isCall && !!require('../config').calls.enabled;
        const ais = aiMembers.enabled() ? (await aiMembers.list(room)).filter((a) => Number(a.enabled)) : [];
        const aiHere = ais.length ? `<p class="oc-ai-here">${ais.map((a) => `<span class="oc-badge oc-ai">AI</span> <strong>${esc(a.name)}</strong> <span class="oc-muted oc-ai-model">(${esc(aiMembers.modelOf(a))})</span>`).join(' · ')} <span class="oc-muted">· write ${ais.map((a) => `<code>@${esc(a.handle)}</code>`).join(' or ')} to ask${ais.length > 1 ? ' one of them' : ''} something</span></p>` : '';
        await page(req, res, 200, {
            actor, title: room.name, path: `/r/${room.slug}`, active: 'rooms', robots: room.visibility === 'public' ? 'index, follow' : 'noindex, nofollow', script: true, callScript: callReady,
            description: room.topic || `${room.name}, a ${isCall ? 'call' : room.kind === 'system' ? 'announcements' : 'chat'} room on OpenVibe.`,
            page: { view: 'room', room: room.slug, kind: room.kind, pics: pictures.enabled() ? pictures.publicUrl() : null, ai: ais.map((a) => a.handle), latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: me ? me.id : null, moderate: can.moderate, post: can.post, role: can.role,
                ...(callReady ? { call: { channel: `room-${room.slug}`, join: can.join, talk: can.talk } } : {}) },
            body: `<p><a href="/rooms">← Rooms</a></p>
<h1>${esc(room.name)}${kindBadge(room)}${room.visibility === 'private' ? ' <span class="oc-badge">private</span>' : ''}</h1>
<p class="oc-muted">${room.topic ? `${esc(room.topic)} · ` : ''}${(await rooms.publicRoom(room)).members} members${room.slow_seconds ? ` · slow mode ${room.slow_seconds}s` : ''}${yourRole}${manage} <span class="oc-live" id="oc-live" hidden>● live</span></p>
${aiHere}${error}
${isCall ? callPanel(room, can, me) : ''}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${msgs.map((m) => roomMessage(m, can, room.slug, me)).join('\n') || `<li class="oc-empty oc-muted">${room.kind === 'system' ? 'No announcements yet.' : 'No messages yet. Say hello.'}</li>`}</ol>
${composer}${tools}`,
        });
    });

    router.post('/r/:slug', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        const message = await rooms.post(room, actor.user, req.body && req.body.message);
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.redirect(303, `/r/${room.slug}#oc-compose`);
    }));

    router.post('/r/:slug/picture', formLimit, sameSite, (req, res, next) => pictureForm(req, res, (err) => {
        if (!err) return next();
        const why = err.code === 'LIMIT_FILE_SIZE' ? `A picture can be up to ${Math.round((require('../config').pics.maxBytes || 20 * 1024 * 1024) / 1024 / 1024)} MB.` : 'That upload did not work.';
        return res.redirect(303, `/r/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(why)}`);
    }), roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        const back = String((req.body && req.body.back) || '');
        req.roomBack = /^\/(r|s)\/[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(back) ? back : `/r/${room.slug}`;
        const f = req.file;
        await roomRoutes.postPicture(room, actor.user, { token: actor.token, buffer: f ? f.buffer : null, contentType: f ? f.mimetype : '', caption: req.body && req.body.caption, ip: req.ip });
        res.redirect(303, `${req.roomBack}#oc-compose`);
    }));

    router.post('/r/:slug/join', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        await rooms.join(room, actor.user);
        await applyRoomChange(room);
        res.redirect(303, `/r/${room.slug}`);
    }));

    router.post('/r/:slug/leave', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        await rooms.leave(room, actor.user);
        require('../chat/chat-server').removeFromRoom(room.id, actor.user.id);
        await applyRoomChange(room);
        res.redirect(303, '/rooms');
    }));

    router.post('/r/:slug/delete/:id', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        const id = await rooms.deleteMessage(room, actor.user, parseInt(req.params.id, 10));
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message_deleted', room: room.slug, id });
        res.redirect(303, `/r/${room.slug}`);
    }));

    router.get('/r/:slug/settings', async (req, res) => {
        const x = await loadRoom(req, res); if (!x) return;
        const { actor, room, can } = x;
        // A server's channel is set up on the server's settings page; only its AI members are set here (server admins).
        if (room.server_id && !can.manage) return res.redirect(302, await channelUrl(room, '/settings'));
        if (!can.moderate) return res.redirect(303, `/r/${room.slug}`);
        const saved = req.query.saved ? notice('ok', 'Saved.') : '';
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const members = await rooms.members(room, { seen: true });
        const kindRoles = rooms.KIND_ROLES[room.kind] || rooms.KIND_ROLES.community;
        const choices = [...kindRoles.filter((r) => r !== 'owner' && (r !== 'mod' || can.manage)), 'none'];
        const roleOption = (r, current) => `<option value="${r}"${r === current ? ' selected' : ''}>${r === 'none' ? 'remove' : ROLE_LABEL[r] || r}</option>`;
        const seen = (m) => { const t = hhmm(m.last_seen_at); return t.iso ? ` <span class="oc-muted">· seen <time datetime="${t.iso}">${t.iso.slice(0, 10)}</time></span>` : ''; };
        const roleForm = (m) => m.role === 'owner' ? '<span class="oc-muted">owner</span>'
            : (m.role === 'mod' && !can.manage) ? '<span class="oc-muted">moderator</span>'
                : `<form class="oc-inline" method="post" action="/r/${esc(room.slug)}/members"><input type="hidden" name="username" value="${esc(m.username || '')}"><select name="role" aria-label="Role for ${esc(m.username || '')}">${choices.map((r) => roleOption(r, m.role)).join('')}</select> <button type="submit">Set</button></form>`;
        const addRole = rooms.joinRoleOf(room);
        const attachments = can.manage ? await rooms.attachments(room) : [];
        const ais = can.manage && room.kind !== 'system' ? await aiMembers.list(room) : [];
        let myKey = null;
        if (can.manage && room.kind !== 'system' && aiMembers.enabled()) { try { myKey = await credentials.get(actor.user.subject_id); } catch { myKey = null; } }
        const engineField = (a) => {
            const cur = a ? (a.engine || 'openvibe') : 'openvibe';
            const ownLabel = a && cur === 'own' ? aiMembers.modelOf(a) : myKey ? `Your own key: ${credentials.label(myKey)}` : 'Your own key (add one in your chat settings first)';
            return `<label>Thinks with <select name="engine"><option value="openvibe"${cur === 'openvibe' ? ' selected' : ''}>OpenVibe's model</option><option value="own"${cur === 'own' ? ' selected' : ''}${cur === 'own' || myKey ? '' : ' disabled'}>${esc(ownLabel)}</option></select></label>
${myKey || cur === 'own' ? '' : '<p class="oc-muted">To give it a different model (yours, from OpenAI, Anthropic or an OpenAI-compatible provider), <a href="/settings#oc-ai-key">add your AI key</a>.</p>'}`;
        };
        const aiForm = (a) => `<form class="oc-form oc-ai-form" method="post" action="/r/${esc(room.slug)}/ai-members${a ? `/${Number(a.id)}` : ''}">
${a ? '' : '<h3>Add an AI member</h3>'}
<label>Name <input name="name" required minlength="2" maxlength="24" value="${a ? esc(a.name) : ''}" placeholder="Pantry"></label>
<label>How it should be <textarea name="persona" rows="2" maxlength="1000" placeholder="A cheerful cook who keeps meals cheap and quick">${a ? esc(a.persona) : ''}</textarea></label>
<label>Notes it always knows <textarea name="memory" rows="3" maxlength="2000" placeholder="Lee is vegetarian. We shop on Saturdays. Budget: $80 a week.">${a ? esc(a.memory) : ''}</textarea></label>
${engineField(a)}
${a ? `<label class="oc-check"><input type="checkbox" name="enabled" value="1"${Number(a.enabled) ? ' checked' : ''}> Answers when someone writes @${esc(a.handle)}</label>` : ''}
<p><button type="submit">${a ? 'Save' : 'Add'}</button></p></form>`;
        const aiSection = can.manage && room.kind !== 'system' ? `<h2 id="oc-ai">AI members</h2>
${aiMembers.enabled() ? '' : notice('error', 'AI members are switched off on this server right now.')}
<p class="oc-muted">An AI member answers when someone writes its name with an @ (for example @${esc(ais[0] ? ais[0].handle : 'pantry')}). It reads the room's recent messages and the notes you give it, through OpenVibe.AI, with OpenVibe's model or with your own key's (several members with different models make a multi-model group chat). It cannot do anything outside the chat. At most ${aiMembers.MAX_PER_ROOM}.</p>
${ais.map((a) => `<section class="oc-ai-member"><h3><span class="oc-badge oc-ai">AI</span> ${esc(a.name)} <span class="oc-muted">@${esc(a.handle)} · ${esc(aiMembers.modelOf(a))}</span>${a.link_service === 'food' ? ' <span class="oc-badge">knows the household\'s pantry (OpenVibe.Food)</span>' : ''}</h3>${aiForm(a)}<form class="oc-inline" method="post" action="/r/${esc(room.slug)}/ai-members/${Number(a.id)}/delete"><button type="submit" class="oc-link">Remove ${esc(a.name)}</button></form></section>`).join('')}
${ais.length < aiMembers.MAX_PER_ROOM ? aiForm(null) : ''}` : '';
        if (room.server_id) {
            return await page(req, res, 200, {
                actor, title: `#${room.name}: AI members`, path: `/r/${room.slug}/settings`, active: 'servers', robots: 'noindex, nofollow',
                body: `<p><a href="${esc(await channelUrl(room, '/settings'))}">← Server settings</a> · <a href="${esc(await channelUrl(room))}">#${esc(room.name)}</a></p><h1>AI members in #${esc(room.name)}</h1>${saved}${error}
${aiSection}`,
            });
        }
        const communityUrl = config.web.communityUrl;
        const attachList = can.manage ? `<h2>Attached to</h2>${attachments.length ? `<ul class="oc-members">${attachments.map((a) => `<li><a href="${esc(a.service === 'community' ? `${communityUrl}/s/${encodeURIComponent(a.resource)}` : '#')}">${esc(a.title || a.resource)}</a> <span class="oc-muted">${esc(a.service === 'community' ? 'OpenVibe.Community space' : a.service)}</span><form class="oc-inline" method="post" action="/r/${esc(room.slug)}/attachments/${encodeURIComponent(a.service)}/${encodeURIComponent(a.resource)}/detach"><button type="submit" class="oc-link">Detach</button></form></li>`).join('')}</ul>` : '<p class="oc-muted">Not attached anywhere. A Community space you own can attach this room from the space\'s page.</p>'}` : '';
        await page(req, res, 200, {
            actor, title: `${room.name}: settings`, path: `/r/${room.slug}/settings`, active: 'rooms', robots: 'noindex, nofollow',
            body: `<p><a href="/r/${esc(room.slug)}">← ${esc(room.name)}</a></p><h1>Room settings</h1>${saved}${error}
${can.manage ? `<form class="oc-form" method="post" action="/r/${esc(room.slug)}/settings">
<label>Name <input name="name" required minlength="3" maxlength="40" value="${esc(room.name)}"></label>
<label>Topic <input name="topic" maxlength="200" value="${esc(room.topic || '')}"></label>
<label>Who can read <select name="visibility"><option value="public"${room.visibility === 'public' ? ' selected' : ''}>Anyone (public)</option><option value="private"${room.visibility === 'private' ? ' selected' : ''}>Members only (private)</option></select></label>
${room.kind === 'call' ? `<label>People who join <select name="join_role">${rooms.JOIN_ROLES_CALL.map((r) => `<option value="${r}"${r === addRole ? ' selected' : ''}>${{ speaker: 'can talk (speakers)', participant: 'listen and write (participants)', viewer: 'listen and read (viewers)' }[r]}</option>`).join('')}</select></label>` : ''}
<label>Slow mode (seconds between messages, 0 = off) <input name="slow_seconds" type="number" min="0" max="600" value="${Number(room.slow_seconds) || 0}"></label>
<p><button type="submit">Save</button></p></form>` : ''}
<h2>Members</h2>
<p class="oc-muted">${esc(roleHelp(room.kind))}</p>
<form class="oc-new" method="post" action="/r/${esc(room.slug)}/members"><label for="oc-invite">Add someone</label> <input id="oc-invite" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="their username"> <select name="role" aria-label="Their role">${choices.filter((r) => r !== 'none' && r !== 'blocked').map((r) => roleOption(r, addRole)).join('')}</select> <button type="submit">Add</button></form>
<ul class="oc-members">${members.map((m) => `<li><strong>${esc(m.display_name || m.username || '?')}</strong> <span class="oc-muted">@${esc(m.username || '')}</span>${seen(m)} ${roleForm(m)}</li>`).join('')}</ul>
${aiSection}
${attachList}`,
        });
    });

    function roleHelp(kind) {
        if (kind === 'call') return 'Speakers, moderators and the owner talk in the call; participants listen and write in the chat; viewers listen and read.';
        if (kind === 'system') return 'Only the owner and moderators post; everyone else reads (viewers).';
        return 'Members write; viewers only read; moderators delete messages and manage members.';
    }

    router.post('/r/:slug/settings', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        const b = req.body || {};
        await rooms.update(room, actor.user, { name: b.name, topic: b.topic, visibility: b.visibility, slow_seconds: b.slow_seconds === undefined ? undefined : Number(b.slow_seconds), join_role: room.kind === 'call' ? b.join_role : undefined });
        await applyRoomChange(room);
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    router.post('/r/:slug/members', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? await ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.redirect(303, `/r/${room.slug}/settings?error=${encodeURIComponent(`Nobody called ${name.slice(0, 24)} on OpenVibe`)}`);
        const role = await rooms.setRole(room, actor.user, target.id, String((req.body && req.body.role) || rooms.joinRoleOf(room)));
        if (role === 'blocked' || (room.visibility === 'private' && role === 'none')) require('../chat/chat-server').removeFromRoom(room.id, target.id);
        await applyRoomChange(room);
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    // ── AI members: add, change, remove (the room's managers; server/rooms/ai-members.js decides) ──
    const aiMemberForm = (fn) => roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        try {
            await fn(room, actor, await rooms.access(room, actor.user), req.body || {}, req);
        } catch (err) {
            if (err instanceof aiMembers.AiMemberError) return res.redirect(303, `/r/${room.slug}/settings?error=${encodeURIComponent(err.message)}#oc-ai`);
            throw err;
        }
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    });
    router.post('/r/:slug/ai-members', formLimit, sameSite, aiMemberForm(async (room, actor, can, b) => { await aiMembers.add(room, actor.user, can, { name: b.name, persona: b.persona, memory: b.memory, engine: b.engine }); }));
    router.post('/r/:slug/ai-members/:id', formLimit, sameSite, aiMemberForm(async (room, actor, can, b, req) => { await aiMembers.update(room, can, req.params.id, { name: b.name, persona: b.persona, memory: b.memory, enabled: b.enabled === '1', engine: b.engine }, actor.user); }));
    router.post('/r/:slug/ai-members/:id/delete', formLimit, sameSite, aiMemberForm(async (room, actor, can, b, req) => { await aiMembers.remove(room, can, req.params.id); }));

    router.post('/r/:slug/attachments/:service/:resource/detach', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        await rooms.detach(room, actor.user, req.params.service, req.params.resource);
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    // ── What shipped, robots, sitemap ──
    // ── Servers (server/rooms/servers.js): text and voice channels, roles, invites ──
    require('./server-pages').mountServerPages(router, { page, needUser, viewerOf, sameSite, formLimit, notice, roomMessage, callPanel, applyRoomChange, pictureComposer, config });

    router.get('/updates', async (req, res) => await page(req, res, 200, {
        title: `What shipped on ${SITE_NAME}`, path: '/updates', robots: 'index, follow', cache: cache.htmlHeaders({ maxAge: 300 }),
        body: frame.updatesBody({ service: 'chat', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }));
    // ── Terms, privacy and DMCA for this site (openvibe-shared/legal): the Frame's footer links them here ──
    { const legal = require('openvibe-shared/legal'); router.get(legal.PATHS, legal.handler({ id: 'chat', service: 'chat', host: 'openvibe.chat', name: SITE_NAME, profile: 'ugc' })); }
    // ── robots.txt, llms.txt, sitemap.xml: server/web/discovery.js, the shared SEO kit ──
    router.use(createDiscoveryRoutes({ config }));

    // ── Nothing here: a browser asking for a page gets the site's 404 page (the browser check found
    // JSON). The API, /internal/, /ws/ and any client not asking for HTML keep the JSON 404 that
    // server/app.js answers after this router.
    router.use(async (req, res, next) => {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || /^\/(api|internal|ws)(\/|$)/.test(req.path) || !/\btext\/html\b/.test(req.get('accept') || '')) return next();
        try {
            await page(req, res, 404, {
                title: 'Page not found', path: req.path, robots: 'noindex',
                body: `<h1>Page not found</h1><p>There is no page at <code>${esc(req.path.slice(0, 200))}</code>. It may have moved, or the link may be wrong.</p><p><a href="/">Global chat</a> · <a href="/rooms">Rooms</a> · <a href="/messages">Messages</a></p>`,
            });
        } catch (err) { next(err); }
    });

    return router;
}

module.exports = { createWebRoutes, apiBridge, globalMessage, linkify, nameFxClass, hatHtml };
