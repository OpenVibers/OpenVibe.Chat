'use strict';
/**
 * Servers on openvibe.chat (server/rooms/servers.js), mounted by pages.js:
 *
 *   GET  /servers                    your servers, public servers, and the form to start one
 *   GET  /s/:slug[/:channel]         the server: your servers down the side, its channels, the channel (a text channel's
 *                                    messages, or a voice channel's call and its chat), and its people by rank
 *   GET  /s/:slug/settings           overview, channels, invites, members and bans, delete (by what the role may do)
 *   GET  /join/:code                 an invite: the server it opens, and the button to join
 *   POST /servers/new, /s/:slug/join | /leave | /settings | /channels | /channels/:channel | /invites | /invites/:code/revoke
 *        /s/:slug/members | /delete, /s/:slug/:channel (a message), /join/:code
 *
 * Like every page here it reads and posts without JavaScript; chat.js adds live messages in a channel exactly as in a
 * room (a channel is a room), and call.js the voice channel's call.
 */
const { esc } = require('./layout');
const ui = require('./ui');
const { ICONS: IC } = require('./icons');
const rooms = require('../rooms/rooms');
const shell = require('./shell');
const servers = require('../rooms/servers');
const ctx = require('../live-context');

const LIVE = 'https://openvibe.live';
const RANK_TITLE = { owner: 'Owner', admin: 'Admins', mod: 'Moderators', member: 'Members' };
const ROLE_NAME = { owner: 'owner', admin: 'admin', mod: 'moderator', member: 'member', blocked: 'banned' };
const YOURS = { owner: 'You own it', admin: 'You are an admin', mod: 'You moderate it', member: 'You are in it' };
const YOU_ARE = { owner: 'the owner', admin: 'an admin', mod: 'a moderator', member: 'a member' };
const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8"/></svg>';
const VOICE_ICON = '<svg class="oc-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';

const initials = ui.serverLetters;
/** A steady hue per server, so its icon is recognisable in the rail (and in every list: ui.serverMark). */
const hueOf = ui.hueOf;

function mountServerPages(router, h) {
    const { page, needUser, viewerOf, sameSite, formLimit, notice, roomMessage, callPanel, applyRoomChange, pictureComposer, config } = h;
    const site = config.web.baseUrl;
    const serverRoutes = () => require('../rooms/server-routes');
    const orError = (fn) => async (req, res, next) => {
        try { return await fn(req, res, next); } catch (err) {
            if (err instanceof rooms.RoomError) return res.redirect(303, `${req.back || '/servers'}?error=${encodeURIComponent(err.message)}`);
            return next(err);
        }
    };
    const userOf = (actor) => (actor.kind === 'user' ? actor.user : null);
    const errorOf = (req) => (req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '');

    const icon = (s, active) => `<a class="oc-srv-icon${active ? ' is-active' : ''}" href="/s/${esc(s.slug)}" title="${esc(s.name)}" style="--oc-hue:${hueOf(s.slug)}"${active ? ' aria-current="page"' : ''}><span aria-hidden="true">${esc(initials(s.name))}</span><span class="oc-sr">${esc(s.name)}</span>${s.unread ? `<span class="oc-srv-dot" aria-label="${s.unread} unread">${s.unread > 99 ? '99+' : s.unread}</span>` : ''}</a>`;
    // One server in the directory: its mark, the name with its badges, the description or members under it.
    const serverRow = (s) => `<li class="oc-row${s.unread ? ' oc-unread' : ''}"><a href="/s/${esc(s.slug)}">${ui.serverMark(s)}<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(s.name)}</strong>${s.official ? '<span class="oc-badge oc-badge-official">official</span>' : ''}${s.visibility === 'private' ? `<span class="oc-row-lock" title="Private">${IC.lock}<span class="oc-sr">private</span></span>` : ''}</span>`
        + `<span class="oc-row-sub">${esc(s.description || `${s.members} member${s.members === 1 ? '' : 's'}`)}${s.unread ? `<span class="oc-dot" aria-label="${s.unread} new">${s.unread > 9 ? '9+' : s.unread}</span>` : ''}</span></span></a></li>`;

    // ── Explore: the servers on OpenVibe, and the sheet that starts one ──
    router.get('/servers', async (req, res) => {
        const actor = await viewerOf(req);
        const me = userOf(actor);
        const { public: pub, mine } = await servers.list(me);
        const featuredServers = await servers.featured();
        const templates = require('../rooms/server-templates');
        const q = String(req.query.q || '').trim().toLowerCase();
        const cat = String(req.query.category || '');
        // Every server the person may see: the ones they are in, then the public ones (the official server is
        // always first). "No other public server yet." is never shown: the official server and Start a server
        // are always there.
        const yours = new Set(mine.map((s) => s.slug));
        const all = [...mine, ...pub.filter((s) => !yours.has(s.slug))];
        const listed = all.filter((s) => (!q || `${s.name} ${s.description || ''}`.toLowerCase().includes(q))
            && (!cat || s.category === cat));
        // How many of each server's people are here now (Network's presence, one read, cached 30 s).
        const online = {};
        if (me && listed.length) {
            const ids = listed.map((s) => Number(s.id)).filter((n) => Number.isInteger(n));
            const rows = ids.length ? await require('../db/database').all(`SELECT s.slug AS slug, u.subject_id AS subject FROM chat_servers s
                JOIN chat_server_members m ON m.server_id = s.id AND m.role != 'blocked'
                JOIN ctx_users u ON u.id = m.user_id WHERE s.id IN (${ids.map(() => '?').join(',')})`, ids) : [];
            const people = rows.map((r) => ({ slug: r.slug, subject_id: r.subject }));
            await require('../presence').attachTo(me.subject_id, people);
            for (const p of people) if (p.presence) online[p.slug] = (online[p.slug] || 0) + 1;
        }
        const chip = (name, href) => `<a class="oc-chip${name === cat ? ' is-active' : ''}" href="${esc(href)}">${esc(name || 'All')}</a>`;
        // Chat never writes ?q= back into a page (test/security-private.test.js): the chips do not carry it.
        const chips = `<nav class="oc-chips" aria-label="Categories">${chip('', '/servers')}${templates.CATEGORIES.map((c) => chip(c, `/servers?category=${encodeURIComponent(c)}`)).join('')}</nav>`;
        // One server as a card: its banner, its icon, its name, one line about it, its people, and a way in.
        const card = (sv) => {
            const isMember = yours.has(sv.slug);
            const join = isMember
                ? `<p class="oc-card-go"><a class="oc-button oc-button--quiet" href="/s/${esc(sv.slug)}">Open</a><a class="oc-icon-btn oc-card-more" href="/s/${esc(sv.slug)}" aria-label="More about ${esc(sv.name)}" title="More"${shell.serverData(shell.railServers([sv])[0])}>${IC.more}</a></p>`
                : (me ? `<form method="post" action="/s/${esc(sv.slug)}/join"><button type="submit">Join</button></form>`
                    : `<a class="oc-button" href="/auth/login?next=${encodeURIComponent(`/s/${sv.slug}`)}">Sign in to join</a>`);
            return `<article class="oc-card oc-server-card">
<div class="oc-card-banner" style="--oc-hue:${hueOf(sv.slug)}" aria-hidden="true"></div>
<span class="oc-srv-icon oc-srv-icon--row" style="--oc-hue:${hueOf(sv.slug)}" aria-hidden="true">${esc(initials(sv.name))}</span>
<h3>${esc(sv.name)}${sv.official ? ' <span class="oc-badge oc-badge-official">official</span>' : ''}${sv.category ? ` <span class="oc-badge">${esc(sv.category)}</span>` : ''}</h3>
<p class="oc-card-line">${esc(sv.description || 'A server on OpenVibe.Chat.')}</p>
<p class="oc-muted oc-card-meta">${isMember && YOURS[sv.role] ? `<span class="oc-card-yours">${YOURS[sv.role]}</span> · ` : ''}${Number(sv.members) || 0} member${Number(sv.members) === 1 ? '' : 's'}${online[sv.slug] ? ` · ${online[sv.slug]} online` : ''}</p>
${join}</article>`;
        };
        const startCard = `<article class="oc-card oc-server-card oc-server-card--new"><h3>Start a server</h3><p class="oc-card-line">A template, a name and a picture: under ten seconds.</p><a class="oc-button" href="#oc-new-server">Start a server</a></article>`;
        // Staff feature a few servers above the categories. With none featured the row is left out entirely.
        const featuredRow = featuredServers.length ? `<section class="oc-featured" aria-labelledby="oc-featured-h"><h2 class="oc-list-head" id="oc-featured-h">Featured</h2><div class="oc-cards oc-featured-cards">${featuredServers.map(card).join('')}</div></section>` : '';
        // The sheet: a template first, then a name and a picture, then public or private.
        const sheet = me ? `<details class="oc-sheet" id="oc-new-server"><summary class="oc-button">Start a server</summary>
<form class="oc-form oc-sheet-form" method="post" action="/servers/new" data-picture-upload-form>
<h2>Start a server</h2>
<fieldset class="oc-sheet-step"><legend>1. What is it for?</legend>
<div class="oc-templates">${templates.TEMPLATES.map((t, i) => `<label class="oc-template"><input type="radio" name="template" value="${esc(t.id)}"${i === 0 ? ' checked' : ''}><span class="oc-template-body"><strong>${esc(t.name)}</strong><span class="oc-muted">${esc(t.description)}</span><span class="oc-template-channels">${t.channels.map((c) => esc(c.kind === 'voice' ? '🔊 ' : '# ') + esc(c.name)).join(' · ')}</span></span></label>`).join('')}</div>
</fieldset>
<fieldset class="oc-sheet-step"><legend>2. Its name and picture</legend>
<div class="oc-sheet-fields">
<label class="oc-field"><span>Name</span><input name="name" required minlength="2" maxlength="40" placeholder="Saturday Raiders"></label>
<label class="oc-field"><span>Category</span><select name="category"><option value="">No category</option>${templates.CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></label>
<label class="oc-field oc-field--wide"><span>Description</span><input name="description" maxlength="300" placeholder="What it is for (optional)"></label>
<div class="oc-field oc-field--wide"><span>Picture</span>
<div data-picture-upload data-accept="image/png,image/jpeg,image/webp"></div>
<small class="oc-muted">PNG, JPEG or WebP. Without one, its initials on its colour.</small>
<p class="oc-muted" data-picture-status role="status" aria-live="polite"></p>
<div data-picture-progress hidden></div>
</div>
</div>
</fieldset>
<fieldset class="oc-sheet-step"><legend>3. Who may find it?</legend>
<div class="oc-seg" role="radiogroup"><label><input type="radio" name="visibility" value="public" checked><span>Public</span></label><label><input type="radio" name="visibility" value="private"><span>Private</span></label></div>
<p class="oc-muted oc-small">A public server is listed in Explore and anyone may join it. A private one is joined through an invite.</p>
</fieldset>
<p><button type="submit">Create server</button></p>
</form></details>` : `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=%2Fservers">Sign in with OpenVibe</a> to start or join a server.</p>`;
        const side = `<div class="oc-side-top"><a class="oc-side-find" href="#oc-new-server">${IC.plus}<span>Start a server</span></a></div>
<section class="oc-side-sec"><h2 class="oc-side-group">Your servers</h2>
${mine.length ? `<ul class="oc-side-list">${mine.map((sv) => `<li class="oc-row"><a href="/s/${esc(sv.slug)}">${ui.serverMark(sv)}<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(sv.name)}</strong></span><span class="oc-row-sub">${Number(sv.members) || 0} member${Number(sv.members) === 1 ? '' : 's'}</span></span></a></li>`).join('')}</ul>` : `<p class="oc-side-empty oc-muted">You are in no servers yet.</p>`}
</section>`;
        await page(req, res, 200, {
            actor, shell: true, title: 'Explore servers', path: '/servers', active: 'servers', robots: 'index, follow', footer: 'none', upload: require('../rooms/pictures').enabled(), scripts: require('../rooms/pictures').enabled() ? ['picture-upload.js'] : [],
            description: 'Servers on OpenVibe.Chat: a place for a group, with text and voice channels, roles and invites.',
            body: shell.shell({
                rail: shell.rail({ explore: true, dmUnread: me ? await require('../chat/dm').getTotalUnread(me.id) : 0, servers: shell.railServers(mine) }),
                side, sideLabel: 'Your servers',
                main: `${ui.head({ title: 'Explore servers', sub: `${listed.length} server${listed.length === 1 ? '' : 's'}` })}
<form class="oc-find" method="get" action="/servers" role="search">${IC.search}<label for="oc-server-q" class="oc-sr">Find a server</label><input id="oc-server-q" name="q" value="" placeholder="Find a server" autocomplete="off"><button type="submit" class="oc-send" aria-label="Find" title="Find">${IC.search}</button></form>
${featuredRow}
${chips}
<div class="oc-cards">${listed.map(card).join('')}${startCard}</div>
${sheet}`,
                mainLabel: 'Explore servers',
                page: true,
            }),
        });
    });

    // The Start sheet's picture (multipart; the other fields are ordinary form fields).
    const serverPicture = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 12 } }).single('picture');

    router.post('/servers/new', serverPicture, formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        // A picture, when one was sent: OpenVibe.Pics, as the person (server/rooms/pictures.js).
        let picture = null;
        try {
            const pics = require('../rooms/pictures');
            if (pics.enabled() && req.file && req.file.buffer) {
                const up = await pics.upload({ token: req.cookies && req.cookies.ov_token, buffer: req.file.buffer, contentType: req.file.mimetype, title: `Server: ${String(b.name || '').slice(0, 40)}`, ip: req.ip });
                if (up && up.url) picture = up.url;
            }
        } catch { /* no picture: the monogram tile is the icon */ }
        const s = await servers.create(actor.user, {
            name: b.name, description: b.description,
            // The sheet sends visibility; the older form sent private=1.
            visibility: (b.visibility === 'private' || b.private === '1') ? 'private' : 'public',
            category: b.category, picture_url: picture, template: b.template,
        });
        // The invite link shows at the end, with Copy and Share (the sheet's last step).
        const invite = await servers.createInvite(s, actor.user, { max_uses: null, expires_hours: null }).catch(() => null);
        res.redirect(303, `/s/${s.slug}${invite && invite.code ? `?invite=${encodeURIComponent(invite.code)}` : ''}`);
    }));

    /** The server behind :slug for this viewer (404 page when they may not read it). */
    async function loadServer(req, res) {
        const actor = await viewerOf(req);
        const me = userOf(actor);
        const server = await servers.bySlug(req.params.slug);
        const can = server ? await servers.access(server, me) : null;
        if (!server || !can.read) {
            await page(req, res, 404, { actor, title: 'No such server', path: req.path, robots: 'noindex', body: '<h1>No such server</h1><p><a href="/servers">All servers</a></p>' });
            return null;
        }
        return { actor, me, server, can };
    }

    // ── A server and one of its channels ──
    async function serverPage(req, res) {
        const x = await loadServer(req, res); if (!x) return;
        const { actor, me, server, can } = x;
        const chans = await servers.channels(server, can.member ? me : null);
        const pick = req.params.channel ? chans.find((c) => c.slug === String(req.params.channel).toLowerCase()) : chans.find((c) => c.kind === 'text') || chans[0];
        if (!pick) return page(req, res, 404, { actor, title: 'No such channel', path: req.path, robots: 'noindex', body: `<h1>No such channel</h1><p><a href="/s/${esc(server.slug)}">${esc(server.name)}</a></p>` });
        const room = await rooms.bySlug(pick.room);
        const rcan = await rooms.access(room, me);
        if (room.forum_space) {
            const forum = require('../rooms/community-forum');
            const bearer = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
            const token = bearer ? bearer[1].trim() : req.cookies && req.cookies.ov_token || null;
            try {
                const data = req.query.post
                    ? await forum.thread(room.forum_space, req.query.post, token, { page: req.query.page })
                    : await forum.list(room.forum_space, token, req.query);
                const mine = me ? (await servers.list(me)).mine : [];
                const dmUnread = me ? await require('../chat/dm').getTotalUnread(me.id) : 0;
                const categories = data.categories || [];
                const post = data.thread || null;
                const itemHref = (slug) => `/s/${server.slug}/${pick.slug}?post=${encodeURIComponent(slug)}`;
                const sortLinks = `<nav aria-label="Forum order"><a href="?sort=active">Latest activity</a> · <a href="?sort=new">Newest</a></nav>`;
                const tags = categories.length ? `<nav aria-label="Tags"><a href="?sort=active">All tags</a>${categories.map((tag) => ` · <a href="?category=${encodeURIComponent(tag.slug)}">${esc(tag.name)}</a>`).join('')}</nav>` : '';
                const searchHref = `${require('../config').community.publicUrl}/search?type=thread&q=${encodeURIComponent(data.space && data.space.name || '')}`;
                const listMarkup = (data.threads || []).map((t) => `<article><h3><a href="${itemHref(t.slug)}">${esc(t.title)}</a></h3><p>${esc(t.author && (t.author.display_name || t.author.username) || 'Member')} · ${Number(t.reply_count) || 0} replies · ${esc(t.last_activity_at || t.created_at || '')}${t.pinned ? ' · Pinned' : ''}${t.locked ? ' · Locked' : ''}</p>${t.category ? `<p>Tag: ${esc(t.category.name)}</p>` : ''}</article>`).join('') || '<p>No posts yet.</p>';
                const postMarkup = post ? `<article><h2>${esc(post.title)}</h2><p>${esc(post.author && (post.author.display_name || post.author.username) || 'Member')} · ${esc(post.last_activity_at || post.created_at || '')}${post.pinned ? ' · Pinned' : ''}${post.locked ? ' · Locked' : ''}</p>${(data.posts || []).map((p) => `<section><p>${esc(p.author && (p.author.display_name || p.author.username) || 'Member')} · ${esc(p.created_at || '')}</p><div>${p.body_html || ''}</div></section>`).join('')}<p><a href="${esc(`${require('../config').community.publicUrl}/s/${encodeURIComponent(room.forum_space)}/t/${encodeURIComponent(post.slug)}`)}">Reply or edit in Community</a></p></article>` : `<section aria-label="Forum posts">${listMarkup}</section>`;
                const forumForm = me && !post ? `<form class="oc-form" method="post" action="/s/${esc(server.slug)}/${esc(pick.slug)}/forum"><h3>Start a post</h3><label>Title <input name="title" maxlength="200" required></label><label>Post <textarea name="body" maxlength="40000" rows="5" required></textarea></label>${categories.length ? `<label>Tag <select name="category"><option value="">No tag</option>${categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select></label>` : ''}<button class="ovk-btn ovk-btn--primary" type="submit">Post</button></form>` : '';
                const replyForm = me && post && data.viewer && data.viewer.can_reply ? `<form class="oc-form" method="post" action="/s/${esc(server.slug)}/${esc(pick.slug)}/forum/${esc(post.slug)}/replies"><label>Reply <textarea name="body" maxlength="40000" rows="4" required></textarea></label><button class="ovk-btn ovk-btn--primary" type="submit">Reply</button></form>` : '';
                const modForm = me && post && data.viewer && data.viewer.can_moderate ? `<form class="oc-form" method="post" action="/s/${esc(server.slug)}/${esc(pick.slug)}/forum/${esc(post.slug)}/state"><label><input type="checkbox" name="pinned" value="true"${post.pinned ? ' checked' : ''}> Pinned</label><label><input type="checkbox" name="locked" value="true"${post.locked ? ' checked' : ''}> Locked</label><button class="ovk-btn ovk-btn--quiet" type="submit">Save moderation</button></form>` : '';
                const shellBody = shell.shell({
                    rail: shell.rail({ servers: shell.railServers(mine, server.slug), dmUnread }),
                    side: shell.sideServer({ server: { ...server, official: server.slug === servers.OFFICIAL_SLUG }, can, me: !!me,
                        categories: [{ name: 'Forum channels', channels: chans.filter((c) => c.kind === 'forum').map((c) => ({ kind: c.kind, name: c.name, slug: c.slug, href: `/s/${server.slug}/${c.slug}` })) },
                            { name: 'Other channels', channels: chans.filter((c) => c.kind !== 'forum').map((c) => ({ kind: c.kind, name: c.name, slug: c.slug, href: `/s/${server.slug}/${c.slug}` })) }], occupants: {},
                        you: me ? { name: me.display_name || me.username, status: 'Online', avatarUrl: me.avatar_url || '' } : {} }),
                    sideLabel: server.name,
                    main: `${shell.channelHeader({ name: room.name, kind: 'forum', topic: room.topic || data.space && data.space.description, members: true })}<h2>${esc(data.space && data.space.name || 'Forum')}</h2>${sortLinks}${tags}<p><a href="${esc(searchHref)}">Search posts</a></p>${postMarkup}${forumForm}${replyForm}${modForm}`,
                    mainLabel: `Forum: ${room.name}`,
                    members: shell.membersColumn({ groups: [] }), membersLabel: `People in ${server.name}`,
                });
                return await page(req, res, 200, { actor, shell: true, footer: 'none', title: `${post ? post.title : 'Forum'} · ${server.name}`, path: req.path, active: 'servers', robots: 'noindex,follow', script: true, description: server.description || `${server.name} forum on OpenVibe.Chat.`, body: shellBody });
            } catch (err) {
                return await page(req, res, err.status || 503, { actor, shell: true, title: 'Forum unavailable', path: req.path, active: 'servers', robots: 'noindex', body: `<h1>Forum unavailable</h1><p>${esc(err.message)}</p><p><a href="/s/${esc(server.slug)}">${esc(server.name)}</a></p>` });
            }
        }
        const roomPage = await rooms.historyPage(room, { limit: 50 });
        const msgs = roomPage.messages.slice().reverse();
        if (me && rcan.role) await rooms.markRead(room, me);
        const mine = me ? (await servers.list(me)).mine : [];
        const dmUnread = me ? await require('../chat/dm').getTotalUnread(me.id) : 0;
        const people = await servers.members(server, { limit: 300 });
        // The people's presence (Network, cached 30 s) and their mark.
        await require('../presence').attachTo(me ? me.subject_id : null, people.map((p) => ({ ...p, id: p.user_id })));
        const isVoice = room.kind === 'call';
        const isStage = !!room.stage_channel;
        const callReady = isVoice && !!require('../config').calls.enabled;
        const callOf = (c) => { try { return require('../rooms/routes').callOf({ kind: 'call', slug: c.room }) || null; } catch { return null; } };
        // The people in each voice channel (the plan: "voice channels with who is in them").
        const occupants = {};
        for (const c of chans) if (c.kind === 'voice' || c.kind === 'stage') occupants[c.slug] = ((callOf(c) || {}).people || []).map((p) => ({ username: p.username, display_name: p.display_name }));
        // The channel categories: a channel's own category, or the kind's default.
        const categories = [];
        const byCat = new Map();
        for (const c of chans) {
            const name = c.category || (c.kind === 'stage' ? 'Stage channels' : c.kind === 'voice' ? 'Voice channels' : 'Text channels');
            if (!byCat.has(name)) { byCat.set(name, []); categories.push({ name, channels: byCat.get(name) }); }
            byCat.get(name).push(c);
        }
        let composer;
        const back = `/s/${server.slug}/${pick.slug}`;
        if (!me) composer = `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=${encodeURIComponent(back)}">Sign in with OpenVibe</a> to join the conversation.</p>`;
        else if (rcan.post) composer = shell.composer({ action: back, label: `Message ${isVoice ? '' : '#'}${room.name}`, placeholder: `Message ${isVoice ? '' : '#'}${room.name}`, add: pictureComposer ? pictureComposer(room, back) : '' });
        else if (!can.member) composer = `<form method="post" action="/s/${esc(server.slug)}/join"><button type="submit">Join ${esc(server.name)}</button></form>`;
        else composer = notice('error', 'You cannot write here right now.');
        const ais = require('../rooms/ai-members').enabled() ? (await require('../rooms/ai-members').list(room)).filter((a) => Number(a.enabled)) : [];
        const aiHere = ais.length ? `<p class="oc-ai-here">${ais.map((a) => `<span class="oc-badge oc-ai">AI</span> <strong>${esc(a.name)}</strong> <span class="oc-muted oc-ai-model">(${esc(require('../rooms/ai-members').modelOf(a))})</span>`).join(' · ')} <span class="oc-muted">· write ${ais.map((a) => `<code>@${esc(a.handle)}</code>`).join(' or ')} to ask</span></p>` : '';
        // The people, grouped by their role (the members column).
        const byRank = {};
        for (const p of people) (byRank[p.role] = byRank[p.role] || []).push(p);
        const roleGroups = ['owner', 'admin', 'mod', 'member'].filter((r) => byRank[r]).map((r) => ({
            role: r, title: RANK_TITLE[r],
            people: byRank[r].map((p) => ({
                id: p.user_id, username: p.username || '', display_name: p.display_name || p.username || '',
                avatar_url: p.avatar_url || null, presence: p.presence || null,
                color: /^#[0-9a-f]{3,8}$/i.test(p.profile_color || '') ? p.profile_color : '',
                roles: p.roles || [],
                href: `${LIVE}/@${encodeURIComponent(p.username || '')}`,
            })),
        }));
        const canInvite = can.manage || (can.moderate && server.visibility === 'public');
        // The sheet's last step: the invite link, with Copy and Share (a fresh server comes with one).
        const inviteCode = String(req.query.invite || '').toLowerCase();
        const invite = inviteCode && /^[a-z0-9]{6,16}$/.test(inviteCode) ? await servers.inviteByCode(inviteCode).catch(() => null) : null;
        const invitePanel = invite && invite.invite ? `<section class="oc-invite-new" aria-label="Your invite link">
<h2>Your invite link</h2><p class="oc-muted">Anyone with this link can join ${esc(server.name)}.</p>
<code class="oc-invite-url" id="oc-invite-url">${esc(`${site}/join/${invite.invite.code}`)}</code>
<p class="oc-invite-tools"><button type="button" class="oc-button" id="oc-invite-copy" data-oc-copy="${esc(`${site}/join/${invite.invite.code}`)}">Copy</button>
<a class="oc-button oc-button--quiet" href="/s/${esc(server.slug)}/settings#oc-invites">More invites</a></p>
</section>` : '';
        // The canonical URL is the one served and listed in the sitemap: /s/<server> without a channel in the
        // request, and the channel's own URL when the request named it. `back` stays the channel URL the composer
        // and the sign-in link post to (POST /s/:slug/:channel).
        const canonicalPath = req.params.channel ? back : `/s/${server.slug}`;
        await page(req, res, 200, {
            actor, shell: true, footer: 'none', title: `${isVoice ? (isStage ? 'Stage · ' : '') : '#'}${room.name} · ${server.name}`, path: canonicalPath, active: 'servers', upload: require('../rooms/pictures').enabled(), scripts: require('../rooms/pictures').enabled() ? ['picture-upload.js'] : [],
            robots: server.visibility === 'public' ? 'index, follow' : 'noindex, nofollow', script: true, callScript: callReady,
            description: server.description || `${server.name}, a server on OpenVibe.Chat with ${server.member_count} member${Number(server.member_count) === 1 ? '' : 's'}.`,
            page: {
                view: 'room', room: room.slug, back: `/s/${server.slug}`, kind: room.kind, pics: require('../rooms/pictures').enabled() ? require('../rooms/pictures').publicUrl() : null, ai: ais.map((a) => a.handle), latest: msgs.length ? msgs[msgs.length - 1].id : 0, historyMore: roomPage.more,
                me: me ? me.id : null, moderate: rcan.moderate, post: rcan.post, role: rcan.role,
                ...(callReady ? { call: { channel: `room-${room.slug}`, join: rcan.join, talk: rcan.talk } } : {}),
            },
            body: shell.shell({
                rail: shell.rail({
                    servers: shell.railServers(mine, server.slug),
                    dmUnread,
                }),
                side: shell.sideServer({
                    server: { ...server, official: server.slug === servers.OFFICIAL_SLUG }, can: { ...can, invite: canInvite }, me: !!me,
                    categories: categories.map((c) => ({
                        name: c.name,
                        channels: c.channels.map((ch) => ({
                            kind: ch.kind, name: ch.name, slug: ch.slug, unread: ch.unread,
                            href: `/s/${server.slug}/${ch.slug}`, active: ch.slug === pick.slug,
                        })),
                    })),
                    occupants,
                    you: me ? { name: me.display_name || me.username, status: 'Online', avatarUrl: me.avatar_url || '' } : {},
                }),
                sideLabel: server.name,
                main: `${shell.channelHeader({ name: room.name, kind: isStage ? 'stage' : isVoice ? 'voice' : 'text', topic: room.topic, members: true })}
${invitePanel}
<span class="oc-live" id="oc-live" hidden>● live</span>
${isStage ? `<section class="oc-stage" aria-label="Stage"><h2>${esc(room.topic || 'Stage')}</h2><p>Stage audio uses this server voice channel. Audience members join muted.</p><div id="oc-stage-speakers">Speakers and raised hands load when the stage is live.</div></section>` : ''}
${aiHere}${errorOf(req)}
${isVoice ? callPanel(room, rcan, me) : ''}
<ol class="oc-feed oc-srv-feed" id="oc-feed" aria-live="polite" aria-label="Messages in ${esc(room.name)}"><li id="oc-history-state" class="oc-muted" hidden aria-live="polite"></li>${msgs.map((m) => roomMessage(m, rcan, room.slug, me)).join('\n') || `<li class="oc-empty oc-muted">${isVoice ? 'The voice channel\'s chat is empty.' : `This is the start of #${esc(room.name)}.`}</li>`}</ol>
${composer}`,
                mainLabel: `${isVoice ? (isStage ? 'Stage: ' : '') : '#'}${room.name}`,
                members: shell.membersColumn({ groups: roleGroups }),
                membersLabel: `People in ${server.name}`,
            }),
        });
    }
    router.get('/s/:slug', serverPage);

    router.post('/s/:slug/join', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}`;
        await servers.join(server, actor.user);
        await serverRoutes().applyServerChange(server);
        // Onboarding: the server's rules, then the roles they may pick (the plan, stage V3).
        res.redirect(303, servers.hasOnboarding(server) ? `/s/${server.slug}/welcome` : `/s/${server.slug}`);
    }));

    router.post('/s/:slug/leave', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}`;
        await servers.leave(server, actor.user);
        await serverRoutes().applyServerChange(server);
        res.redirect(303, '/servers');
    }));

    // ── Onboarding when joining (the plan, 2026-11-09, stage V3): the server's rules, then the roles they may pick ──
    /** The shell's side column for a server: its channels and the people in its voice channels. */
    async function serverSide(server, can, me, chans) {
        const categories = [];
        const byCat = new Map();
        for (const c of chans) {
            const name = c.category || (c.kind === 'stage' ? 'Stage channels' : c.kind === 'voice' ? 'Voice channels' : 'Text channels');
            if (!byCat.has(name)) { byCat.set(name, []); categories.push({ name, channels: byCat.get(name) }); }
            byCat.get(name).push(c);
        }
        const occupants = {};
        for (const c of chans) {
            if (!['voice', 'stage'].includes(c.kind)) continue;
            try { occupants[c.slug] = ((require('../rooms/routes').callOf({ kind: 'call', slug: c.room }) || {}).people || []).map((p) => ({ username: p.username, display_name: p.display_name })); } catch { occupants[c.slug] = []; }
        }
        const mine = me ? (await servers.list(me)).mine : [];
        const dmUnread = me ? await require('../chat/dm').getTotalUnread(me.id) : 0;
        return shell.sideServer({
            server: { ...server, official: server.slug === servers.OFFICIAL_SLUG }, can, me: !!me,
            categories: categories.map((c) => ({ name: c.name, channels: c.channels.map((ch) => ({ kind: ch.kind, name: ch.name, slug: ch.slug, href: `/s/${server.slug}/${ch.slug}` })) })),
            occupants,
            you: me ? { name: me.display_name || me.username, status: 'Online', avatarUrl: me.avatar_url || '' } : {},
        });
    }
    async function serverRail(me, activeSlug) {
        const mine = me ? (await servers.list(me)).mine : [];
        const dmUnread = me ? await require('../chat/dm').getTotalUnread(me.id) : 0;
        return shell.rail({ dmUnread, servers: shell.railServers(mine, activeSlug) });
    }

    router.get('/s/:slug/welcome', async (req, res) => {
        const x = await loadServer(req, res); if (!x) return;
        const { actor, me, server, can } = x;
        if (!me) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/s/${server.slug}/welcome`)}`);
        if (!can.member) return res.redirect(303, `/s/${server.slug}`);
        const roles = servers.selfRolesOf(server);
        const picked = await servers.memberRoles(server, me.id);
        const chans = await servers.channels(server);
        const rules = typeof server.rules === 'string' ? server.rules.trim() : '';
        const roleList = roles.map((r) => `<label class="oc-role-pick"${r.color ? ` style="--oc-role:${esc(r.color)}"` : ''}><input type="checkbox" name="roles" value="${esc(r.name)}"${picked.includes(r.name) ? ' checked' : ''}><span><i aria-hidden="true"></i>${esc(r.name)}</span></label>`).join('\n');
        // One rule a line (a leading "-", "*", "•" or "1." is the owner's own numbering and goes); a single line stays prose.
        const ruleLines = rules.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*\u2022]|\d{1,2}[.)])\s+/, '').trim()).filter(Boolean);
        const rulesHtml = ruleLines.length > 1 ? `<ol class="oc-rules">${ruleLines.map((l) => `<li>${esc(l)}</li>`).join('\n')}</ol>` : `<p class="oc-rules-text">${esc(rules)}</p>`;
        await page(req, res, 200, {
            actor, shell: true, footer: 'none', title: `Welcome to ${server.name}`, path: `/s/${server.slug}/welcome`, active: 'servers', robots: 'noindex, nofollow',
            body: shell.shell({
                rail: await serverRail(me, server.slug),
                side: await serverSide(server, can, me, chans),
                sideLabel: server.name,
                main: `<div class="oc-welcome">
<header class="oc-welcome-head"><span class="oc-srv-icon oc-srv-icon--big" style="--oc-hue:${hueOf(server.slug)}" aria-hidden="true">${esc(initials(server.name))}</span>
<div><p class="oc-welcome-kicker">Welcome to</p><h1>${esc(server.name)}</h1><p class="oc-muted">${rules && roles.length ? 'Read the rules and pick your roles, then you are in.' : rules ? 'Read the rules, then you are in.' : 'Pick your roles, then you are in.'}</p></div></header>
<form method="post" action="/s/${esc(server.slug)}/welcome" class="oc-welcome-form">
${rules ? `<section class="oc-set" aria-labelledby="oc-onboard-rules"><h2 id="oc-onboard-rules">The rules</h2>${rulesHtml}</section>` : ''}
${roles.length ? `<fieldset class="oc-set oc-role-set"><legend id="oc-onboard-roles">Pick your roles</legend>
<p class="oc-set-note">Optional. You can change them any time in the server's menu.</p>
<div class="oc-role-picks">${roleList}</div></fieldset>` : ''}
<div class="oc-welcome-go"><button type="submit">${roles.length ? 'Continue' : `Continue to ${esc(server.name)}`}</button>${roles.length ? `<a class="oc-welcome-skip" href="/s/${esc(server.slug)}">Skip for now</a>` : ''}</div>
</form></div>`,
                mainLabel: `Welcome to ${server.name}`,
                page: true,
            }),
        });
    });
    router.post('/s/:slug/welcome', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        await servers.setMemberRoles(server, actor.user, [].concat((req.body && req.body.roles) || []));
        res.redirect(303, `/s/${server.slug}`);
    }));

    // The owner edits the rules and the roles members may pick, here in the server's settings.
    router.post('/s/:slug/onboarding', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/settings`;
        await servers.update(server, actor.user, { rules: (req.body && req.body.rules) || '' });
        res.redirect(303, `/s/${server.slug}/settings?saved=1#oc-onboarding`);
    }));
    router.post('/s/:slug/roles', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/settings`;
        const b = req.body || {};
        const roles = servers.selfRolesOf(server);
        if (roles.length >= servers.MAX_SELF_ROLES) return res.redirect(303, `/s/${server.slug}/settings?error=${encodeURIComponent(`A server offers up to ${servers.MAX_SELF_ROLES} roles`)}#oc-onboarding`);
        await servers.update(server, actor.user, { self_roles: [...roles, { name: b.name, color: b.color }] });
        res.redirect(303, `/s/${server.slug}/settings?saved=1#oc-onboarding`);
    }));
    router.post('/s/:slug/roles/delete', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/settings`;
        const name = String((req.body && req.body.name) || '');
        await servers.update(server, actor.user, { self_roles: servers.selfRolesOf(server).filter((r) => r.name !== name) });
        res.redirect(303, `/s/${server.slug}/settings?saved=1#oc-onboarding`);
    }));
    // Explore's featured row (the plan, stage V3): OpenVibe staff mark a public server featured, or take it down.
    router.post('/s/:slug/featured', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/settings`;
        await servers.setFeatured(server, actor.user, (req.body && req.body.featured) === '1');
        res.redirect(303, `/s/${server.slug}/settings?saved=1#oc-featured`);
    }));


    // ── Settings: what each rank may do (overview and channels: owner/admins; invites: owner/admins, and mods in a
    // public server; members: owner/admins/mods; delete: the owner) ──
    router.get('/s/:slug/settings', async (req, res) => {
        const x = await loadServer(req, res); if (!x) return;
        const { actor, me, server, can } = x;
        if (!can.moderate) return res.redirect(303, `/s/${server.slug}`);
        const saved = req.query.saved ? notice('ok', 'Saved.') : '';
        const chans = await servers.channels(server);
        const people = await servers.members(server, { blocked: true, limit: 2000 });
        const canInvite = can.manage || server.visibility === 'public';
        const invites = canInvite ? await servers.invites(server) : [];
        const selfRoles = servers.selfRolesOf(server);
        const myRank = can.staff ? -1 : servers.RANK[can.role];
        // The side column: the server's channels, with the people in its voice channels, and the you-bar.
        const categories = [];
        const byCat = new Map();
        for (const c of chans) {
            const name = c.category || (c.kind === 'voice' ? 'Voice channels' : 'Text channels');
            if (!byCat.has(name)) { byCat.set(name, []); categories.push({ name, channels: byCat.get(name) }); }
            byCat.get(name).push(c);
        }
        const occupants = {};
        for (const c of chans) {
            if (c.kind !== 'voice') continue;
            try { occupants[c.slug] = ((require('../rooms/routes').callOf({ kind: 'call', slug: c.room }) || {}).people || []).map((p) => ({ username: p.username, display_name: p.display_name })); } catch { occupants[c.slug] = []; }
        }
        const railServers = me ? (await servers.list(me)).mine : [];
        const dmUnread = me ? await require('../chat/dm').getTotalUnread(me.id) : 0;
        const choices = (target) => {
            const list = [];
            if (myRank <= servers.RANK.owner) list.push('admin');
            if (myRank <= servers.RANK.admin) list.push('mod');
            list.push('member', 'blocked', 'none');
            if (target && target.role !== 'member' && target.role !== 'blocked' && myRank >= servers.RANK[target.role]) return null;
            return list;
        };
        const roleForm = (p) => {
            if (p.role === 'owner') return '<span class="oc-muted">owner</span>';
            const opts = choices(p);
            if (!opts || Number(p.user_id) === Number(me.id)) return `<span class="oc-muted">${ROLE_NAME[p.role]}</span>`;
            return `<form class="oc-inline" method="post" action="/s/${esc(server.slug)}/members"><input type="hidden" name="username" value="${esc(p.username || '')}"><select name="role" aria-label="Role for ${esc(p.username || '')}">${opts.map((r) => `<option value="${r}"${r === p.role ? ' selected' : ''}>${r === 'none' ? 'remove from the server' : r === 'blocked' ? 'ban' : ROLE_NAME[r]}</option>`).join('')}</select> <button type="submit">Set</button></form>`;
        };
        const active = people.filter((p) => p.role !== 'blocked');
        const banned = people.filter((p) => p.role === 'blocked');
        const chanRow = (c) => `<li><span>${c.kind === 'forum' ? '▤' : c.kind === 'stage' ? '◉' : c.kind === 'voice' ? VOICE_ICON : '#'} <strong>${esc(c.name)}</strong>${c.topic ? ` <span class="oc-muted">${esc(c.topic)}</span>` : ''}</span>
<form class="oc-inline oc-moves" method="post" action="/s/${esc(server.slug)}/channels/${esc(c.slug)}"><button type="submit" name="move" value="up" class="oc-move" aria-label="Move ${esc(c.name)} up" title="Move up">↑</button><button type="submit" name="move" value="down" class="oc-move" aria-label="Move ${esc(c.name)} down" title="Move down">↓</button></form>
<details class="oc-chan-edit"><summary>Edit</summary><form class="oc-form" method="post" action="/s/${esc(server.slug)}/channels/${esc(c.slug)}">
<label>Name <input name="name" required maxlength="40" value="${esc(c.name)}"></label>
<label>Topic <input name="topic" maxlength="200" value="${esc(c.topic || '')}"></label>
${c.kind === 'voice' ? `<label>Members in the call <select name="join_role"><option value="speaker"${c.join_role === 'speaker' ? ' selected' : ''}>can talk</option><option value="participant"${c.join_role === 'participant' ? ' selected' : ''}>listen and write (moderators talk)</option></select></label>` : ''}
<p><button type="submit">Save</button> <button type="submit" name="delete" value="1" class="oc-link oc-danger-link">Delete this channel</button></p></form>
${can.manage && c.kind !== 'voice' && require('../rooms/ai-members').enabled() ? `<p><a href="/r/${esc(c.room)}/settings#oc-ai">AI members in #${esc(c.name)}</a> <span class="oc-muted">(they answer when someone writes their @name, with OpenVibe's model or your own key's)</span></p>` : ''}</details></li>`;
        const inviteRow = (i) => `<li><code class="oc-invite-url">${esc(`${site}/join/${i.code}`)}</code> <span class="oc-muted">${i.uses} use${i.uses === 1 ? '' : 's'}${i.max_uses != null ? ` of ${i.max_uses}` : ''}${i.expires_at ? ` · until <time datetime="${esc(i.expires_at)}">${esc(i.expires_at.slice(0, 16).replace('T', ' '))} UTC</time>` : ' · never expires'}</span>
<form class="oc-inline" method="post" action="/s/${esc(server.slug)}/invites/${esc(i.code)}/revoke"><button type="submit" class="oc-link">Revoke</button></form></li>`;
        await page(req, res, 200, {
            actor, title: `${server.name}: settings`, path: `/s/${server.slug}/settings`, active: 'servers', robots: 'noindex, nofollow', shell: true, footer: 'none',
            body: shell.shell({
                rail: shell.rail({ dmUnread, servers: railServers.map((sv) => ({ slug: sv.slug, name: sv.name, unread: sv.unread, active: sv.slug === server.slug })) }),
                side: shell.sideServer({
                    server: { ...server, official: server.slug === servers.OFFICIAL_SLUG }, can: { ...can, invite: canInvite }, me: !!me,
                    categories: categories.map((c) => ({ name: c.name, channels: c.channels.map((ch) => ({ kind: ch.kind, name: ch.name, slug: ch.slug, href: `/s/${server.slug}/${ch.slug}` })) })),
                    occupants,
                    you: me ? { name: me.display_name || me.username, status: 'Online', avatarUrl: me.avatar_url || '' } : {},
                }),
                sideLabel: server.name,
                main: `<p><a href="/s/${esc(server.slug)}">← ${esc(server.name)}</a></p><h1>Server settings</h1>${saved}${errorOf(req)}
${can.manage ? `<h2>Overview</h2><form class="oc-form" method="post" action="/s/${esc(server.slug)}/settings">
<label>Name <input name="name" required minlength="2" maxlength="40" value="${esc(server.name)}"></label>
<label>Description <input name="description" maxlength="300" value="${esc(server.description || '')}"></label>
<label>Who can find and read it <select name="visibility"><option value="public"${server.visibility === 'public' ? ' selected' : ''}>Anyone: listed, and signed-in people join (public)</option><option value="private"${server.visibility === 'private' ? ' selected' : ''}>Only people with an invite (private)</option></select></label>
<p><button type="submit">Save</button></p></form>
<h2>Channels</h2><ul class="oc-members oc-chan-rows">${chans.map(chanRow).join('')}</ul>
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/channels"><label for="oc-chan-new">Add a channel</label> <input id="oc-chan-new" name="name" required maxlength="40" placeholder="announcements"> <select name="kind" aria-label="Kind of channel"><option value="text">Text</option><option value="voice">Voice</option>${require('../settings').value('forum_channels_enabled', null, false) === true ? '<option value="forum">Forum</option>' : ''}${require('../settings').value('stage_channels_enabled', null, false) === true ? '<option value="stage">Stage</option>' : ''}</select>${require('../settings').value('forum_channels_enabled', null, false) === true ? '<label>Community forum slug <input name="community_space" maxlength="40" placeholder="my-forum"></label>' : ''} <button type="submit">Add</button></form>
<section class="oc-set" id="oc-onboarding" aria-labelledby="oc-onb-h"><h2 id="oc-onb-h">Onboarding</h2>
<p class="oc-muted">People who join read the rules, if there are any, then pick their roles.</p>
<form class="oc-form" method="post" action="/s/${esc(server.slug)}/onboarding">
<label>Rules <textarea name="rules" rows="6" maxlength="${servers.MAX_RULES}" placeholder="Be kind. No spam. Keep it on topic.">${esc(server.rules || '')}</textarea></label>
<p><button type="submit">Save the rules</button></p></form>
<h3>Roles people may pick</h3>
${selfRoles.length ? `<ul class="oc-members">${selfRoles.map((r) => `<li>${r.color ? `<span class="oc-dot" style="background:${esc(r.color)}" aria-hidden="true"></span> ` : ''}<strong>${esc(r.name)}</strong> <form class="oc-inline" method="post" action="/s/${esc(server.slug)}/roles/delete"><input type="hidden" name="name" value="${esc(r.name)}"><button type="submit" class="oc-link">Remove</button></form></li>`).join('')}</ul>` : '<p class="oc-muted">No roles yet.</p>'}
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/roles"><label for="oc-role-new">Add a role</label> <input id="oc-role-new" name="name" required maxlength="24" placeholder="Raider"> <input name="color" type="color" value="#5865f2" aria-label="Its colour"> <button type="submit">Add</button></form>
</section>` : ''}
${can.staff ? `<section class="oc-set" id="oc-featured" aria-labelledby="oc-feat-h"><h2 id="oc-feat-h">Explore</h2>
<p class="oc-muted">Featured servers sit above the categories on Explore, for people who have not joined them.</p>
<form method="post" action="/s/${esc(server.slug)}/featured"><input type="hidden" name="featured" value="${server.featured_at ? '0' : '1'}"><button type="submit">${server.featured_at ? 'Remove from featured' : 'Feature on Explore'}</button></form>
</section>` : ''}
${canInvite ? `<h2 id="oc-invites">Invites</h2><p class="oc-muted">${server.visibility === 'private' ? 'A private server is joined only through an invite.' : 'Anyone can join a public server; an invite link is a handy way to bring people straight to it.'}</p>
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/invites"><label for="oc-inv-uses">New invite</label> <select id="oc-inv-uses" name="max_uses" aria-label="How many times it can be used"><option value="">any number of uses</option><option value="1">1 use</option><option value="10">10 uses</option><option value="100">100 uses</option></select> <select name="expires_hours" aria-label="When it expires"><option value="168">for 7 days</option><option value="24">for 1 day</option><option value="720">for 30 days</option><option value="">forever</option></select> <button type="submit">Make an invite</button></form>
<ul class="oc-members">${invites.map(inviteRow).join('') || '<li class="oc-muted">No invites yet.</li>'}</ul>` : ''}
<h2>Members <span class="oc-muted">${active.length}</span></h2>
<p class="oc-muted">Admins manage channels, invites and members; moderators delete messages and remove or ban members. The owner appoints admins, admins appoint moderators.</p>
<ul class="oc-members">${active.map((p) => `<li><strong>${esc(p.display_name || p.username || '?')}</strong> <span class="oc-muted">@${esc(p.username || '')}</span> ${roleForm(p)}</li>`).join('')}</ul>
${banned.length ? `<details class="oc-blocked"><summary>Banned (${banned.length})</summary><ul class="oc-members">${banned.map((p) => `<li><strong>${esc(p.display_name || p.username || '?')}</strong> <span class="oc-muted">@${esc(p.username || '')}</span><form class="oc-inline" method="post" action="/s/${esc(server.slug)}/members"><input type="hidden" name="username" value="${esc(p.username || '')}"><input type="hidden" name="role" value="none"><button type="submit" class="oc-link">Lift the ban</button></form></li>`).join('')}</ul></details>` : ''}
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/members"><label for="oc-ban">Ban someone</label> <input id="oc-ban" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="their username"><input type="hidden" name="role" value="blocked"> <button type="submit">Ban</button></form>
${can.owner || can.staff ? `<h2>Delete the server</h2><form class="oc-form" method="post" action="/s/${esc(server.slug)}/delete"><label class="oc-check"><input type="checkbox" name="confirm" value="1" required> Delete ${esc(server.name)} and all its channels</label><p><button type="submit" class="oc-danger">Delete server</button></p></form>` : ''}`,
                mainLabel: 'Server settings',
                page: true,
            }),
        });
    });

    const settingsAction = (fn) => [formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        if (!server || !(await servers.access(server, actor.user)).read) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/settings`;
        await fn(req, res, server, actor.user);
    })];

    router.post('/s/:slug/settings', ...settingsAction(async (req, res, server, user) => {
        const b = req.body || {};
        const out = await servers.update(server, user, { name: b.name, description: b.description, visibility: b.visibility });
        await serverRoutes().applyServerChange(out);
        res.redirect(303, `/s/${server.slug}/settings?saved=1`);
    }));
    router.post('/s/:slug/channels', ...settingsAction(async (req, res, server, user) => {
        const b = req.body || {};
        if (b.kind === 'forum' && require('../settings').value('forum_channels_enabled', null, false) !== true) throw Object.assign(new Error('Forum channels are not enabled'), { status: 403 });
        if (b.kind === 'forum' && !(await servers.access(server, user)).manage) throw Object.assign(new Error('Only the server owner and admins add channels'), { status: 403 });
        if (b.kind === 'forum') await require('../rooms/community-forum').verifyManage(b.community_space, req.cookies && req.cookies.ov_token);
        const room = await servers.createChannel(server, user, { name: b.name, kind: ['voice', 'forum', 'stage'].includes(b.kind) ? b.kind : 'text', community_space: b.community_space });
        res.redirect(303, `/s/${server.slug}/${room.channel_slug}`);
    }));
    router.post('/s/:slug/channels/:channel', ...settingsAction(async (req, res, server, user) => {
        const room = await servers.channelBySlug(server, req.params.channel);
        if (!room) return res.redirect(303, `/s/${server.slug}/settings?error=${encodeURIComponent('No such channel')}`);
        const b = req.body || {};
        if (b.delete === '1') await servers.deleteChannel(server, user, room);
        else {
            const out = await servers.updateChannel(server, user, room, { name: b.name, topic: b.topic, join_role: room.kind === 'call' ? b.join_role : undefined, move: b.move });
            await applyRoomChange(out);
        }
        res.redirect(303, `/s/${server.slug}/settings?saved=1`);
    }));
    router.post('/s/:slug/invites', ...settingsAction(async (req, res, server, user) => {
        const b = req.body || {};
        await servers.createInvite(server, user, { max_uses: b.max_uses || null, expires_hours: b.expires_hours || null });
        res.redirect(303, `/s/${server.slug}/settings?saved=1#oc-invites`);
    }));
    router.post('/s/:slug/invites/:code/revoke', ...settingsAction(async (req, res, server, user) => {
        await servers.revokeInvite(server, user, req.params.code);
        res.redirect(303, `/s/${server.slug}/settings?saved=1#oc-invites`);
    }));
    router.post('/s/:slug/members', ...settingsAction(async (req, res, server, user) => {
        const name = String((req.body && req.body.username) || '').trim();
        let target = /^[A-Za-z0-9_]{3,24}$/.test(name) ? await ctx.getUserByUsername(name) : null;
        if (!target && /^[A-Za-z0-9_]{3,24}$/.test(name)) target = await ctx.ensureUserByUsername(name).catch(() => null);
        if (!target) return res.redirect(303, `/s/${server.slug}/settings?error=${encodeURIComponent(`Nobody called ${name.slice(0, 24)} on OpenVibe`)}`);
        const role = await servers.setRole(server, user, target.id, String((req.body && req.body.role) || 'member'));
        if (role === 'blocked' || role == null) {
            for (const r of await require('../db/database').all('SELECT id FROM rooms WHERE server_id = ?', [server.id])) require('../chat/chat-server').removeFromRoom(r.id, target.id);
        }
        await serverRoutes().applyServerChange(server);
        res.redirect(303, `/s/${server.slug}/settings?saved=1`);
    }));
    router.post('/s/:slug/delete', ...settingsAction(async (req, res, server, user) => {
        if ((req.body || {}).confirm !== '1') return res.redirect(303, `/s/${server.slug}/settings`);
        await servers.archive(server, user);
        await serverRoutes().applyServerChange(server);
        res.redirect(303, '/servers');
    }));

    // ── An invite ──
    router.get('/join/:code', async (req, res) => {
        const actor = await viewerOf(req);
        const me = userOf(actor);
        const found = await servers.inviteByCode(req.params.code);
        if (!found) return page(req, res, 404, { actor, title: 'Invite not valid', path: req.path, robots: 'noindex, nofollow', body: '<h1>This invite is not valid</h1><p class="oc-muted">It has expired, was used up, or was revoked. Ask whoever sent it for a new one.</p><p><a href="/servers">Find servers</a></p>' });
        const { server } = found;
        const role = me ? await servers.roleIn(server.id, me.id) : null;
        const action = !me ? `<p><a class="oc-button" href="/auth/login?next=${encodeURIComponent(req.path)}">Sign in with OpenVibe to join</a></p>`
            : role === 'blocked' ? notice('error', 'You are banned from this server.')
                : role ? `<p><a class="oc-button" href="/s/${esc(server.slug)}">Open ${esc(server.name)}</a> <span class="oc-muted">You are already in it.</span></p>`
                    : `<form method="post" action="/join/${esc(found.invite.code)}"><button type="submit">Join ${esc(server.name)}</button></form>`;
        await page(req, res, 200, {
            actor, title: `Join ${server.name}`, path: req.path, robots: 'noindex, nofollow',
            body: `<section class="oc-invite-card"><span class="oc-srv-icon oc-srv-icon--big" style="--oc-hue:${hueOf(server.slug)}" aria-hidden="true">${esc(initials(server.name))}</span>
<p class="oc-muted">You are invited to</p><h1>${esc(server.name)}</h1>${server.description ? `<p>${esc(server.description)}</p>` : ''}
<p class="oc-muted">${Number(server.member_count) || 0} member${Number(server.member_count) === 1 ? '' : 's'}${server.visibility === 'private' ? ' · private server' : ''}</p>
${errorOf(req)}${action}</section>`,
        });
    });
    router.post('/join/:code', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        req.back = `/join/${encodeURIComponent(req.params.code)}`;
        const found = await servers.inviteByCode(req.params.code);
        if (!found) return res.redirect(303, req.back);
        await servers.join(found.server, actor.user, { invite: found.invite.code });
        await serverRoutes().applyServerChange(found.server);
        res.redirect(303, servers.hasOnboarding(found.server) ? `/s/${found.server.slug}/welcome` : `/s/${found.server.slug}`);
    }));

    // A channel's page and its no-JavaScript message form (after the fixed /s/:slug/… routes above).
    router.get('/s/:slug/:channel', serverPage);
    router.post('/s/:slug/:channel/forum', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        const room = server ? await servers.channelBySlug(server, req.params.channel) : null;
        if (!room || !room.forum_space || !(await servers.access(server, actor.user)).read) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/${room.channel_slug}`;
        if (req.body && req.body.category) req.body.category = String(req.body.category);
        const token = req.cookies && req.cookies.ov_token;
        const out = await require('../rooms/community-forum').create(room.forum_space, token, req.body || {});
        res.redirect(303, `${req.back}?post=${encodeURIComponent(out.thread.slug)}`);
    }));
    router.post('/s/:slug/:channel/forum/:thread/replies', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        const room = server ? await servers.channelBySlug(server, req.params.channel) : null;
        if (!room || !room.forum_space || !(await servers.access(server, actor.user)).read) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/${room.channel_slug}?post=${encodeURIComponent(req.params.thread)}`;
        await require('../rooms/community-forum').reply(room.forum_space, req.params.thread, req.cookies && req.cookies.ov_token, req.body || {});
        res.redirect(303, req.back);
    }));
    router.post('/s/:slug/:channel/forum/:thread/state', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        const room = server ? await servers.channelBySlug(server, req.params.channel) : null;
        if (!room || !room.forum_space || !(await servers.access(server, actor.user)).read) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/${room.channel_slug}?post=${encodeURIComponent(req.params.thread)}`;
        await require('../rooms/community-forum').moderate(room.forum_space, req.params.thread, req.cookies && req.cookies.ov_token,
            { pinned: req.body && req.body.pinned === 'true', locked: req.body && req.body.locked === 'true' });
        res.redirect(303, req.back);
    }));
    router.post('/s/:slug/:channel', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        const room = server ? await servers.channelBySlug(server, req.params.channel) : null;
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/servers');
        if (room.forum_space) return res.redirect(303, `/s/${server.slug}/${room.channel_slug}`);
        req.back = `/s/${server.slug}/${room.channel_slug}`;
        const message = await rooms.post(room, actor.user, req.body && req.body.message);
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.redirect(303, `/s/${server.slug}/${room.channel_slug}#oc-compose`);
    }));
}

module.exports = { mountServerPages };
