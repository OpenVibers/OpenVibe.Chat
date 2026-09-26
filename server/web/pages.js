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
 *                             POST /messages/:id/block blocks the other person of a 1:1 conversation
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
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const { renderPage, esc, SITE_NAME } = require('./layout');
const { createSessionRoutes } = require('./session');
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
function linkify(text) {
    return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" rel="nofollow ugc noopener" target="_blank">${u}</a>`);
}
/** The author's badge, from the staff map (ADR-022): staff run the site, moderators moderate chat. */
function roleBadge(role) {
    const who = { role: String(role || 'user') };
    if (permissions.can(who, 'staff.site.configure')) return '<span class="oc-badge oc-badge-staff" title="OpenVibe staff">staff</span>';
    if (permissions.can(who, 'staff.moderation.chat')) return '<span class="oc-badge oc-badge-mod" title="Moderator">mod</span>';
    return '';
}
function globalMessage(m) {
    const t = hhmm(m.timestamp);
    const handle = m.core_username || (m.user_id ? m.username : null);
    const name = esc(m.display_name || m.username || m.anon_id || 'someone');
    const who = handle ? `<a class="oc-name" href="${LIVE}/@${encodeURIComponent(handle)}" style="--nc:${esc(/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '') ? m.profile_color : 'inherit')}">${name}</a>` : `<span class="oc-name oc-anon">${name}</span>`;
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
    const viewers = { resolve: async (req) => viewerOf(req) };
    const formLimit = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
    const sameSite = (req, res, next) => {
        const o = req.get('origin');
        if (o && o !== siteOrigin && o !== 'null') return res.status(403).type('text').send('Forms are only accepted from this site.');
        next();
    };
    const countsOf = (actor) => {
        if (actor.kind !== 'user') return {};
        const n = (fn) => { try { return Number(fn()) || 0; } catch { return 0; } };
        return { messages: n(() => dm.getTotalUnread(actor.user.id)), rooms: n(() => require('../rooms/rooms').unreadTotal(actor.user)) };
    };
    const page = async (req, res, status, o) => {
        const actor = o.actor || await viewerOf(req);
        res.status(status).set('Cache-Control', o.cache || 'private, no-store').type('html')
            .send(renderPage({ config, actor, prefs: await prefsOf(actor), counts: countsOf(actor), ...o }));
    };
    const needUser = async (req, res) => {
        const actor = await viewerOf(req);
        if (actor.kind === 'user') return actor;
        res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        return null;
    };

    router.use('/auth', createSessionRoutes({ config: webConfig, viewers }));
    router.use('/shared', ovServe.handler());
    router.use('/web', express.static(PUBLIC_DIR, { maxAge: '365d', immutable: true, index: false }));

    // ── Global chat ──
    router.get('/', async (req, res) => {
        const actor = await viewerOf(req);
        const { messages, latest_id } = historyStore.page('global', { limit: 60 });
        // Not the lines of people this reader blocked on the network (chat/network-blocks.js).
        const hidden = actor.kind === 'user' ? require('../chat/network-blocks').blockedUserIds(actor.user) : new Set();
        const shown = messages.filter((m) => !m.is_deleted && (m.message_type || 'chat') === 'chat' && !(m.user_id && hidden.has(Number(m.user_id))));
        const composer = actor.kind === 'user'
            ? (actor.user.is_banned ? notice('error', 'Your account is banned from chat.') : `<form class="oc-compose" method="post" action="/send" id="oc-compose">
<label for="oc-input" class="oc-sr">Message to everyone</label>
<textarea id="oc-input" name="message" maxlength="500" rows="2" required placeholder="Say something to everyone on OpenVibe"></textarea>
<button type="submit">Send</button>
</form>`)
            : `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=%2F">Sign in with OpenVibe</a> to chat. Anyone can read along.</p>`;
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        await page(req, res, 200, {
            actor, title: 'Global chat', path: '/', active: 'global', robots: 'index, follow', script: true,
            description: 'The network-wide chat room of OpenVibe: everyone on every OpenVibe site, in one conversation.',
            page: { view: 'global', latest: latest_id, signedIn: actor.kind === 'user', me: actor.kind === 'user' ? actor.user.username : null },
            body: `<section class="oc-room" aria-labelledby="oc-h">
<h1 id="oc-h">Global chat</h1>
<p class="oc-muted">One room for everyone on OpenVibe: streamers, viewers and players, from every site. <span class="oc-live" id="oc-live" hidden>● live</span></p>
${error}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${shown.map(globalMessage).join('\n') || '<li class="oc-empty oc-muted">No messages yet. Say hello.</li>'}</ol>
${composer}
</section>`,
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
        const convs = dm.getConversations(me.id);
        const rows = convs.map((c) => {
            const others = dm.getParticipants(c.id).filter((p) => p.id !== me.id);
            const title = c.name || others.map((p) => p.display_name || p.username).join(', ') || 'Just you';
            const t = hhmm(c.last_message_at);
            return `<li class="oc-conv${c.unread_count ? ' oc-unread' : ''}"><a href="/messages/${c.id}"><strong>${esc(title)}</strong>${c.unread_count ? ` <span class="oc-badge">${c.unread_count} new</span>` : ''}<span class="oc-muted oc-last">${c.last_message ? esc(String(c.last_message).slice(0, 120)) : 'No messages yet'}</span></a>${t.text ? `<time class="oc-time" datetime="${t.iso}">${t.iso.slice(0, 10)}</time>` : ''}</li>`;
        });
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const done = req.query.unblocked ? notice('ok', 'Unblocked. They can message you again, and you them.') : '';
        const blocked = dm.getBlockedUsers(me.id);
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
        if (Number.isInteger(id) && id > 0) dm.unblockUser(actor.user.id, id);
        const back = /^\/messages\/\d+$/.test(String(req.body && req.body.back)) ? req.body.back : '/messages?unblocked=1';
        res.redirect(303, back);
    });

    router.post('/messages/new', formLimit, sameSite, async (req, res, next) => {
        const actor = await needUser(req, res); if (!actor) return;
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? ctx.getUserByUsername(name) : null;
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
        if (!Number.isInteger(id) || !dm.isParticipant(id, me.id)) return page(req, res, 404, { actor, title: 'Not found', path: req.path, robots: 'noindex', body: '<h1>No such conversation</h1><p><a href="/messages">Back to your messages</a></p>' });
        const others = dm.getParticipants(id).filter((p) => p.id !== me.id);
        const conv = dm.getConversation(id);
        const title = (conv && conv.name) || others.map((p) => p.display_name || p.username).join(', ') || 'Conversation';
        const msgs = dm.getMessages(id, 60).slice().sort((a, b) => a.id - b.id);
        try { dm.markRead(id, me.id); } catch { /* best effort */ }
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        // A 1:1 conversation: block or unblock the other person here; a block (either way) closes the composer.
        const other = conv && !conv.is_group && others.length === 1 ? others[0] : null;
        const iBlocked = other ? dm.hasBlocked(me.id, other.id) : false;
        const closed = other ? dm.isBlockedEither(me.id, other.id) : false;
        const otherName = other ? esc(other.display_name || other.username) : '';
        let composer = `<form class="oc-compose" method="post" action="/messages/${id}" id="oc-compose"><label for="oc-input" class="oc-sr">Reply</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="Write a message"></textarea><button type="submit">Send</button></form>`;
        if (iBlocked) composer = `${notice('error', `You blocked ${other.display_name || other.username}. Neither of you can message the other.`)}<form class="oc-inline" method="post" action="/messages/unblock/${Number(other.id)}"><input type="hidden" name="back" value="/messages/${id}"><button type="submit">Unblock ${otherName}</button></form>`;
        else if (closed) composer = notice('error', 'You cannot message this person.');
        const tools = other && !iBlocked ? `<form class="oc-inline oc-tools" method="post" action="/messages/${id}/block"><button type="submit" class="oc-link">Block ${otherName}</button></form>` : '';
        await page(req, res, 200, {
            actor, title, path: `/messages/${id}`, active: 'messages', robots: 'noindex, nofollow', script: true,
            page: { view: 'dm', conversation: id, latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: me.id },
            body: `<p><a href="/messages">← Messages</a></p><h1>${esc(title)}</h1>${error}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${msgs.map((m) => dmMessage(m, me)).join('\n') || '<li class="oc-empty oc-muted">No messages yet.</li>'}</ol>
${composer}${tools}`,
        });
    });

    router.post('/messages/:id/block', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const me = actor.user;
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || !dm.isParticipant(id, me.id)) return res.redirect(303, '/messages');
        const conv = dm.getConversation(id);
        const others = dm.getParticipants(id).filter((p) => p.id !== me.id);
        if (!conv || conv.is_group || others.length !== 1) return res.redirect(303, `/messages/${id}?error=${encodeURIComponent('Only a one-to-one conversation has someone to block')}`);
        dm.blockUser(me.id, others[0].id);
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
<p><a class="oc-button" href="/api/chat/me/export" download>Download (JSON)</a> <a class="oc-button" href="/api/chat/me/export?format=csv" download>Download (CSV)</a></p>`,
        });
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
        const del = (can.moderate || (me && m.user_id === me.id)) ? `<form class="oc-del" method="post" action="/r/${esc(slug)}/delete/${Number(m.id)}"><button type="submit" title="Delete this message" aria-label="Delete this message">×</button></form>` : '';
        return `<li class="oc-msg" data-id="${Number(m.id) || 0}" data-user="${Number(m.user_id) || 0}"><time class="oc-time" datetime="${t.iso}">${t.text}</time> <a class="oc-name" href="${LIVE}/@${encodeURIComponent(m.username || '')}"${/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '') ? ` style="--nc:${esc(m.profile_color)}"` : ''}>${esc(m.display_name || m.username || 'someone')}</a>${roleBadge(m.user_role)} <span class="oc-text">${linkify(m.message)}</span>${del}</li>`;
    };
    const applyRoomChange = (room) => roomRoutes.applyRoomChange(room);

    router.get('/rooms', async (req, res) => {
        const actor = await viewerOf(req);
        const me = actor.kind === 'user' ? actor.user : null;
        const { public: pub, mine } = rooms.list(me);
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
<h2>Public rooms</h2><ul class="oc-convs">${pub.map(roomCard).join('') || '<li class="oc-muted">No rooms yet. Start the first one.</li>'}</ul>
${create}`,
        });
    });

    router.post('/rooms/new', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        const kind = rooms.KINDS.includes(b.kind) ? b.kind : 'community';
        const room = rooms.create(actor.user, { name: b.name, topic: b.topic, visibility: b.private === '1' ? 'private' : 'public', kind, join_role: kind === 'call' ? b.join_role || null : null });
        res.redirect(303, `/r/${room.slug}`);
    }));

    const loadRoom = async (req, res) => {
        const actor = await viewerOf(req);
        const me = actor.kind === 'user' ? actor.user : null;
        const room = rooms.bySlug(req.params.slug);
        const can = room ? rooms.access(room, me) : null;
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

    router.get('/r/:slug', async (req, res) => {
        const x = await loadRoom(req, res); if (!x) return;
        const { actor, me, room, can } = x;
        const msgs = rooms.history(room, { limit: 60 });
        if (me && can.role) rooms.markRead(room, me);
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const joinLabel = room.kind === 'system' ? 'Follow these announcements' : 'Join this room';
        let composer;
        if (!me) composer = `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=${encodeURIComponent(`/r/${room.slug}`)}">Sign in with OpenVibe</a> to join the conversation.</p>`;
        else if (can.post) composer = `<form class="oc-compose" method="post" action="/r/${esc(room.slug)}" id="oc-compose"><label for="oc-input" class="oc-sr">Message to ${esc(room.name)}</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="${room.kind === 'system' ? 'Post an announcement' : `Message ${esc(room.name)}`}"></textarea><button type="submit">Send</button></form>`;
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
        await page(req, res, 200, {
            actor, title: room.name, path: `/r/${room.slug}`, active: 'rooms', robots: room.visibility === 'public' ? 'index, follow' : 'noindex, nofollow', script: true, callScript: callReady,
            description: room.topic || `${room.name}, a ${isCall ? 'call' : room.kind === 'system' ? 'announcements' : 'chat'} room on OpenVibe.`,
            page: { view: 'room', room: room.slug, kind: room.kind, latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: me ? me.id : null, moderate: can.moderate, post: can.post, role: can.role,
                ...(callReady ? { call: { channel: `room-${room.slug}`, join: can.join, talk: can.talk } } : {}) },
            body: `<p><a href="/rooms">← Rooms</a></p>
<h1>${esc(room.name)}${kindBadge(room)}${room.visibility === 'private' ? ' <span class="oc-badge">private</span>' : ''}</h1>
<p class="oc-muted">${room.topic ? `${esc(room.topic)} · ` : ''}${rooms.publicRoom(room).members} members${room.slow_seconds ? ` · slow mode ${room.slow_seconds}s` : ''}${yourRole}${manage} <span class="oc-live" id="oc-live" hidden>● live</span></p>
${error}
${isCall ? callPanel(room, can, me) : ''}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${msgs.map((m) => roomMessage(m, can, room.slug, me)).join('\n') || `<li class="oc-empty oc-muted">${room.kind === 'system' ? 'No announcements yet.' : 'No messages yet. Say hello.'}</li>`}</ol>
${composer}${tools}`,
        });
    });

    router.post('/r/:slug', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room || !rooms.access(room, actor.user).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        const message = rooms.post(room, actor.user, req.body && req.body.message);
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.redirect(303, `/r/${room.slug}#oc-compose`);
    }));

    router.post('/r/:slug/join', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room || !rooms.access(room, actor.user).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        rooms.join(room, actor.user);
        applyRoomChange(room);
        res.redirect(303, `/r/${room.slug}`);
    }));

    router.post('/r/:slug/leave', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        rooms.leave(room, actor.user);
        require('../chat/chat-server').removeFromRoom(room.id, actor.user.id);
        applyRoomChange(room);
        res.redirect(303, '/rooms');
    }));

    router.post('/r/:slug/delete/:id', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room || !rooms.access(room, actor.user).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        const id = rooms.deleteMessage(room, actor.user, parseInt(req.params.id, 10));
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message_deleted', room: room.slug, id });
        res.redirect(303, `/r/${room.slug}`);
    }));

    router.get('/r/:slug/settings', async (req, res) => {
        const x = await loadRoom(req, res); if (!x) return;
        const { actor, room, can } = x;
        if (!can.moderate) return res.redirect(303, `/r/${room.slug}`);
        const saved = req.query.saved ? notice('ok', 'Saved.') : '';
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const members = rooms.members(room, { seen: true });
        const kindRoles = rooms.KIND_ROLES[room.kind] || rooms.KIND_ROLES.community;
        const choices = [...kindRoles.filter((r) => r !== 'owner' && (r !== 'mod' || can.manage)), 'none'];
        const roleOption = (r, current) => `<option value="${r}"${r === current ? ' selected' : ''}>${r === 'none' ? 'remove' : ROLE_LABEL[r] || r}</option>`;
        const seen = (m) => { const t = hhmm(m.last_seen_at); return t.iso ? ` <span class="oc-muted">· seen <time datetime="${t.iso}">${t.iso.slice(0, 10)}</time></span>` : ''; };
        const roleForm = (m) => m.role === 'owner' ? '<span class="oc-muted">owner</span>'
            : (m.role === 'mod' && !can.manage) ? '<span class="oc-muted">moderator</span>'
                : `<form class="oc-inline" method="post" action="/r/${esc(room.slug)}/members"><input type="hidden" name="username" value="${esc(m.username || '')}"><select name="role" aria-label="Role for ${esc(m.username || '')}">${choices.map((r) => roleOption(r, m.role)).join('')}</select> <button type="submit">Set</button></form>`;
        const addRole = rooms.joinRoleOf(room);
        const attachments = can.manage ? rooms.attachments(room) : [];
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
        const room = rooms.bySlug(req.params.slug);
        if (!room || !rooms.access(room, actor.user).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        const b = req.body || {};
        rooms.update(room, actor.user, { name: b.name, topic: b.topic, visibility: b.visibility, slow_seconds: b.slow_seconds === undefined ? undefined : Number(b.slow_seconds), join_role: room.kind === 'call' ? b.join_role : undefined });
        applyRoomChange(room);
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    router.post('/r/:slug/members', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room || !rooms.access(room, actor.user).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.redirect(303, `/r/${room.slug}/settings?error=${encodeURIComponent(`Nobody called ${name.slice(0, 24)} on OpenVibe`)}`);
        const role = rooms.setRole(room, actor.user, target.id, String((req.body && req.body.role) || rooms.joinRoleOf(room)));
        if (role === 'blocked' || (room.visibility === 'private' && role === 'none')) require('../chat/chat-server').removeFromRoom(room.id, target.id);
        applyRoomChange(room);
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    router.post('/r/:slug/attachments/:service/:resource/detach', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room || !rooms.access(room, actor.user).read) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        rooms.detach(room, actor.user, req.params.service, req.params.resource);
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    // ── What shipped, robots, sitemap ──
    router.get('/updates', (req, res) => page(req, res, 200, {
        title: `What shipped on ${SITE_NAME}`, path: '/updates', robots: 'index, follow', cache: 'public, max-age=300',
        body: frame.updatesBody({ service: 'chat', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }));
    router.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600')
        .send(`User-agent: *\nAllow: /$\nAllow: /updates\nAllow: /rooms\nAllow: /r/\nDisallow: /r/*/settings\nDisallow: /messages\nDisallow: /settings\nDisallow: /auth/\nDisallow: /api/\nSitemap: ${site}/sitemap.xml\n`));
    router.get('/sitemap.xml', (req, res) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
        .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/rooms', '/updates', ...rooms.list(null, { limit: 100 }).public.map((r) => `/r/${r.slug}`)].map((p) => `<url><loc>${site}${p}</loc></url>`).join('')}</urlset>\n`));

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

module.exports = { createWebRoutes, apiBridge, globalMessage, linkify };
