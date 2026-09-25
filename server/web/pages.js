'use strict';
/**
 * openvibe.chat, the site (roadmap WS-I task 8): the network-wide chat room, your direct messages and
 * your chat settings, served by OpenVibe.Chat itself, so it keeps working while OpenVibe.Live is down.
 *
 *   GET  /                    global chat: the last messages server-rendered (readable without
 *                             JavaScript); public/web/chat.js adds the live feed over /ws/chat
 *   POST /send                the composer without JavaScript (the same handler as POST /api/chat/send)
 *   GET  /messages            your conversations; POST /messages/new starts one by username
 *   GET  /messages/:id        one conversation (participants only); POST /messages/:id replies
 *   GET  /settings            your portable chat settings (Network module chat.preferences); POST saves
 *   GET  /updates             what shipped on openvibe.chat (the shared changelog)
 *   GET  /robots.txt, /sitemap.xml
 *   /auth/*                   sign in with OpenVibe.Network (./session.js), cookies host-only
 *
 * Forms go through the same API handlers the JavaScript client calls (apiBridge), so rate limits,
 * bans, blocks, spam checks and DM participation are enforced in one place. Posts must come from this
 * site (Origin check; the session cookie is SameSite=Lax).
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
    const page = async (req, res, status, o) => {
        const actor = o.actor || await viewerOf(req);
        res.status(status).set('Cache-Control', o.cache || 'private, no-store').type('html')
            .send(renderPage({ config, actor, prefs: await prefsOf(actor), ...o }));
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
        const shown = messages.filter((m) => !m.is_deleted && (m.message_type || 'chat') === 'chat');
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
        await page(req, res, 200, {
            actor, title: 'Messages', path: '/messages', active: 'messages', robots: 'noindex, nofollow',
            body: `<h1>Messages</h1>${error}
<form class="oc-new" method="post" action="/messages/new"><label for="oc-to">Message someone</label> <input id="oc-to" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="their username" autocomplete="off"> <button type="submit">Start</button></form>
<ul class="oc-convs">${rows.join('\n') || '<li class="oc-muted">No conversations yet.</li>'}</ul>`,
        });
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
        await page(req, res, 200, {
            actor, title, path: `/messages/${id}`, active: 'messages', robots: 'noindex, nofollow', script: true,
            page: { view: 'dm', conversation: id, latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: me.id },
            body: `<p><a href="/messages">← Messages</a></p><h1>${esc(title)}</h1>${error}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${msgs.map((m) => dmMessage(m, me)).join('\n') || '<li class="oc-empty oc-muted">No messages yet.</li>'}</ol>
<form class="oc-compose" method="post" action="/messages/${id}" id="oc-compose"><label for="oc-input" class="oc-sr">Reply</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="Write a message"></textarea><button type="submit">Send</button></form>`,
        });
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
    const roomsOrError = (fn) => async (req, res, next) => {
        try { return await fn(req, res, next); } catch (err) {
            if (err instanceof rooms.RoomError) return res.redirect(303, `${req.roomBack || '/rooms'}?error=${encodeURIComponent(err.message)}`);
            return next(err);
        }
    };
    const roomCard = (r) => `<li class="oc-conv${r.unread ? ' oc-unread' : ''}"><a href="/r/${esc(r.slug)}"><strong>${esc(r.name)}</strong>${r.visibility === 'private' ? ' <span class="oc-badge">private</span>' : ''}${r.unread ? ` <span class="oc-badge">${r.unread} new</span>` : ''}<span class="oc-muted oc-last">${esc(r.topic || `${r.members} member${r.members === 1 ? '' : 's'}`)}</span></a></li>`;
    const roomMessage = (m, can, slug, me) => {
        const t = hhmm(m.created_at);
        const del = (can.moderate || (me && m.user_id === me.id)) ? `<form class="oc-del" method="post" action="/r/${esc(slug)}/delete/${Number(m.id)}"><button type="submit" title="Delete this message" aria-label="Delete this message">×</button></form>` : '';
        return `<li class="oc-msg" data-id="${Number(m.id) || 0}" data-user="${Number(m.user_id) || 0}"><time class="oc-time" datetime="${t.iso}">${t.text}</time> <a class="oc-name" href="${LIVE}/@${encodeURIComponent(m.username || '')}"${/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '') ? ` style="--nc:${/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '') ? esc(m.profile_color) : 'inherit'}"` : ''}>${esc(m.display_name || m.username || 'someone')}</a>${roleBadge(m.user_role)} <span class="oc-text">${linkify(m.message)}</span>${del}</li>`;
    };

    router.get('/rooms', async (req, res) => {
        const actor = await viewerOf(req);
        const me = actor.kind === 'user' ? actor.user : null;
        const { public: pub, mine } = rooms.list(me);
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const create = me ? `<form class="oc-form oc-create" method="post" action="/rooms/new">
<h2>Start a room</h2>
<label>Name <input name="name" required minlength="3" maxlength="40" placeholder="Night Owls"></label>
<label>Topic <input name="topic" maxlength="200" placeholder="What it is about (optional)"></label>
<label class="oc-check"><input type="checkbox" name="private" value="1"> Private: only people you invite can read and post</label>
<p><button type="submit">Create room</button></p>
</form>` : `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=%2Frooms">Sign in with OpenVibe</a> to start or join a room.</p>`;
        await page(req, res, 200, {
            actor, title: 'Rooms', path: '/rooms', active: 'rooms', robots: 'index, follow',
            description: 'Chat rooms on OpenVibe: start one about anything, invite people, or join a public room.',
            body: `<h1>Rooms</h1>${error}
${mine.length ? `<h2>Your rooms</h2><ul class="oc-convs">${mine.map(roomCard).join('')}</ul>` : ''}
<h2>Public rooms</h2><ul class="oc-convs">${pub.map(roomCard).join('') || '<li class="oc-muted">No rooms yet. Start the first one.</li>'}</ul>
${create}`,
        });
    });

    router.post('/rooms/new', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        const room = rooms.create(actor.user, { name: b.name, topic: b.topic, visibility: b.private === '1' ? 'private' : 'public' });
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

    router.get('/r/:slug', async (req, res) => {
        const x = await loadRoom(req, res); if (!x) return;
        const { actor, me, room, can } = x;
        const msgs = rooms.history(room, { limit: 60 });
        if (me && can.role) rooms.markRead(room, me);
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        let composer;
        if (!me) composer = `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=${encodeURIComponent(`/r/${room.slug}`)}">Sign in with OpenVibe</a> to join the conversation.</p>`;
        else if (can.post) composer = `<form class="oc-compose" method="post" action="/r/${esc(room.slug)}" id="oc-compose"><label for="oc-input" class="oc-sr">Message to ${esc(room.name)}</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="Message ${esc(room.name)}"></textarea><button type="submit">Send</button></form>`;
        else if (!can.role) composer = `<form method="post" action="/r/${esc(room.slug)}/join"><button type="submit">Join this room</button></form>`;
        else composer = notice('error', 'You cannot post here right now.');
        const tools = me && can.role && can.role !== 'owner' ? `<form class="oc-inline" method="post" action="/r/${esc(room.slug)}/leave"><button type="submit" class="oc-link">Leave room</button></form>` : '';
        const manage = can.moderate ? ` · <a href="/r/${esc(room.slug)}/settings">${can.manage ? 'Room settings' : 'Members'}</a>` : '';
        await page(req, res, 200, {
            actor, title: room.name, path: `/r/${room.slug}`, active: 'rooms', robots: room.visibility === 'public' ? 'index, follow' : 'noindex, nofollow', script: true,
            description: room.topic || `${room.name}, a chat room on OpenVibe.`,
            page: { view: 'room', room: room.slug, latest: msgs.length ? msgs[msgs.length - 1].id : 0, me: me ? me.id : null, moderate: can.moderate },
            body: `<p><a href="/rooms">← Rooms</a></p>
<h1>${esc(room.name)}${room.visibility === 'private' ? ' <span class="oc-badge">private</span>' : ''}</h1>
<p class="oc-muted">${room.topic ? `${esc(room.topic)} · ` : ''}${rooms.publicRoom(room).members} members${room.slow_seconds ? ` · slow mode ${room.slow_seconds}s` : ''}${manage} <span class="oc-live" id="oc-live" hidden>● live</span></p>
${error}
<ol class="oc-feed" id="oc-feed" aria-live="polite" aria-label="Messages">${msgs.map((m) => roomMessage(m, can, room.slug, me)).join('\n') || '<li class="oc-empty oc-muted">No messages yet. Say hello.</li>'}</ol>
${composer}${tools}`,
        });
    });

    router.post('/r/:slug', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        const message = rooms.post(room, actor.user, req.body && req.body.message);
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.redirect(303, `/r/${room.slug}#oc-compose`);
    }));

    router.post('/r/:slug/join', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        rooms.join(room, actor.user);
        res.redirect(303, `/r/${room.slug}`);
    }));

    router.post('/r/:slug/leave', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}`;
        rooms.leave(room, actor.user);
        require('../chat/chat-server').removeFromRoom(room.id, actor.user.id);
        res.redirect(303, '/rooms');
    }));

    router.post('/r/:slug/delete/:id', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
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
        const members = rooms.members(room);
        const roleForm = (m) => m.role === 'owner' ? '<span class="oc-muted">owner</span>' : `<form class="oc-inline" method="post" action="/r/${esc(room.slug)}/members"><input type="hidden" name="username" value="${esc(m.username || '')}"><select name="role" aria-label="Role for ${esc(m.username || '')}">${[...(can.manage ? ['mod'] : []), 'member', 'blocked', 'none'].map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r === 'none' ? 'remove' : r}</option>`).join('')}</select> <button type="submit">Set</button></form>`;
        await page(req, res, 200, {
            actor, title: `${room.name}: settings`, path: `/r/${room.slug}/settings`, active: 'rooms', robots: 'noindex, nofollow',
            body: `<p><a href="/r/${esc(room.slug)}">← ${esc(room.name)}</a></p><h1>Room settings</h1>${saved}${error}
${can.manage ? `<form class="oc-form" method="post" action="/r/${esc(room.slug)}/settings">
<label>Name <input name="name" required minlength="3" maxlength="40" value="${esc(room.name)}"></label>
<label>Topic <input name="topic" maxlength="200" value="${esc(room.topic || '')}"></label>
<label>Who can read <select name="visibility"><option value="public"${room.visibility === 'public' ? ' selected' : ''}>Anyone (public)</option><option value="private"${room.visibility === 'private' ? ' selected' : ''}>Members only (private)</option></select></label>
<label>Slow mode (seconds between messages, 0 = off) <input name="slow_seconds" type="number" min="0" max="600" value="${Number(room.slow_seconds) || 0}"></label>
<p><button type="submit">Save</button></p></form>` : ''}
<h2>Members</h2>
<form class="oc-new" method="post" action="/r/${esc(room.slug)}/members"><label for="oc-invite">Add someone</label> <input id="oc-invite" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="their username"><input type="hidden" name="role" value="member"> <button type="submit">Add</button></form>
<ul class="oc-members">${members.map((m) => `<li><strong>${esc(m.display_name || m.username || '?')}</strong> <span class="oc-muted">@${esc(m.username || '')}</span> ${roleForm(m)}</li>`).join('')}</ul>`,
        });
    });

    router.post('/r/:slug/settings', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        const b = req.body || {};
        rooms.update(room, actor.user, { name: b.name, topic: b.topic, visibility: b.visibility, slow_seconds: b.slow_seconds === undefined ? undefined : Number(b.slow_seconds) });
        res.redirect(303, `/r/${room.slug}/settings?saved=1`);
    }));

    router.post('/r/:slug/members', formLimit, sameSite, roomsOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        req.roomBack = `/r/${room.slug}/settings`;
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.redirect(303, `/r/${room.slug}/settings?error=${encodeURIComponent(`Nobody called ${name.slice(0, 24)} on OpenVibe`)}`);
        const role = rooms.setRole(room, actor.user, target.id, String((req.body && req.body.role) || 'member'));
        if (role === 'blocked' || role === 'none') require('../chat/chat-server').removeFromRoom(room.id, target.id);
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

    return router;
}

module.exports = { createWebRoutes, apiBridge, globalMessage, linkify };
