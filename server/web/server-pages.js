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
const rooms = require('../rooms/rooms');
const servers = require('../rooms/servers');
const ctx = require('../live-context');

const LIVE = 'https://openvibe.live';
const RANK_TITLE = { owner: 'Owner', admin: 'Admins', mod: 'Moderators', member: 'Members' };
const ROLE_NAME = { owner: 'owner', admin: 'admin', mod: 'moderator', member: 'member', blocked: 'banned' };
const YOU_ARE = { owner: 'the owner', admin: 'an admin', mod: 'a moderator', member: 'a member' };
const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8"/></svg>';
const VOICE_ICON = '<svg class="oc-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
/** A steady hue per server, so its icon is recognisable in the rail. */
const hueOf = (slug) => { let h = 0; for (const c of String(slug)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

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
    const serverCard = (s) => `<li class="oc-srv-card"><a href="/s/${esc(s.slug)}"><span class="oc-srv-icon oc-srv-icon--card" style="--oc-hue:${hueOf(s.slug)}" aria-hidden="true">${esc(initials(s.name))}</span><span class="oc-srv-card-text"><span class="oc-srv-card-title"><strong>${esc(s.name)}</strong>${s.visibility === 'private' ? '<span class="oc-badge">private</span>' : ''}${s.unread ? `<span class="oc-badge oc-badge-new">${s.unread} new</span>` : ''}</span><span class="oc-muted">${esc(s.description || `${s.members} member${s.members === 1 ? '' : 's'}`)}</span></span></a></li>`;

    // ── The directory ──
    router.get('/servers', async (req, res) => {
        const actor = await viewerOf(req);
        const me = userOf(actor);
        const { public: pub, mine } = await servers.list(me);
        const create = me ? `<form class="oc-form oc-create" id="oc-new-server" method="post" action="/servers/new">
<h2>Start a server</h2>
<p class="oc-muted">A server is a place for a group: text channels to write in and voice channels to talk in, one membership and one set of roles for all of them. It starts with #general and a voice Lounge.</p>
<label>Name <input name="name" required minlength="2" maxlength="40" placeholder="Saturday Raiders"></label>
<label>Description <input name="description" maxlength="300" placeholder="What it is for (optional)"></label>
<label class="oc-check"><input type="checkbox" name="private" value="1"> Private: only people with an invite can find, read or join it</label>
<p><button type="submit">Create server</button></p>
</form>` : `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=%2Fservers">Sign in with OpenVibe</a> to start or join a server.</p>`;
        await page(req, res, 200, {
            actor, title: 'Servers', path: '/servers', active: 'servers', robots: 'index, follow',
            description: 'Servers on OpenVibe.Chat: a place for a group, with text and voice channels, roles and invites.',
            body: `<h1>Servers</h1>${errorOf(req)}
${mine.length ? `<h2>Your servers</h2><ul class="oc-srv-cards">${mine.map(serverCard).join('')}</ul>` : ''}
<h2>Public servers</h2><ul class="oc-srv-cards">${pub.map(serverCard).join('') || '<li class="oc-muted">No public servers yet. Start the first one.</li>'}</ul>
${create}`,
        });
    });

    router.post('/servers/new', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        const s = await servers.create(actor.user, { name: b.name, description: b.description, visibility: b.private === '1' ? 'private' : 'public' });
        res.redirect(303, `/s/${s.slug}`);
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
        const msgs = await rooms.history(room, { limit: 60 });
        if (me && rcan.role) await rooms.markRead(room, me);
        const mine = me ? (await servers.list(me)).mine : [];
        const people = await servers.members(server, { limit: 300 });
        const isVoice = room.kind === 'call';
        const callReady = isVoice && !!require('../config').calls.enabled;
        const callOf = (c) => { try { return require('../rooms/routes').callOf({ kind: 'call', slug: c.room }) || null; } catch { return null; } };
        const chanLink = (c) => {
            const here = c.slug === pick.slug;
            const unread = !here && c.unread ? `<span class="oc-chan-dot" aria-label="${c.unread} unread">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
            const inCall = c.kind === 'voice' ? (callOf(c) || {}).participants : 0;
            return `<li><a class="oc-chan${c.kind === 'voice' ? ' oc-chan-voice' : ''}${here ? ' is-active' : ''}${unread ? ' is-unread' : ''}" href="/s/${esc(server.slug)}/${esc(c.slug)}"${here ? ' aria-current="page"' : ''}>${c.kind === 'voice' ? VOICE_ICON : '<span class="oc-chan-hash" aria-hidden="true">#</span>'}<span class="oc-chan-name">${esc(c.name)}</span>${inCall ? `<span class="oc-muted oc-chan-in">${inCall} in</span>` : ''}${unread}</a></li>`;
        };
        const texts = chans.filter((c) => c.kind === 'text');
        const voices = chans.filter((c) => c.kind === 'voice');
        let composer;
        const back = `/s/${server.slug}/${pick.slug}`;
        if (!me) composer = `<p class="oc-signin"><a class="oc-button" href="/auth/login?next=${encodeURIComponent(back)}">Sign in with OpenVibe</a> to join the conversation.</p>`;
        else if (rcan.post) composer = `<form class="oc-compose" method="post" action="${esc(back)}" id="oc-compose"><label for="oc-input" class="oc-sr">Message ${isVoice ? '' : '#'}${esc(room.name)}</label><textarea id="oc-input" name="message" maxlength="2000" rows="2" required placeholder="Message ${isVoice ? '' : '#'}${esc(room.name)}"></textarea><button type="submit">Send</button></form>${pictureComposer ? pictureComposer(room, back) : ''}`;
        else if (!can.member) composer = `<form method="post" action="/s/${esc(server.slug)}/join"><button type="submit">Join ${esc(server.name)}</button></form>`;
        else composer = notice('error', 'You cannot write here right now.');
        const ais = require('../rooms/ai-members').enabled() ? (await require('../rooms/ai-members').list(room)).filter((a) => Number(a.enabled)) : [];
        const aiHere = ais.length ? `<p class="oc-ai-here">${ais.map((a) => `<span class="oc-badge oc-ai">AI</span> <strong>${esc(a.name)}</strong> <span class="oc-muted oc-ai-model">(${esc(require('../rooms/ai-members').modelOf(a))})</span>`).join(' · ')} <span class="oc-muted">· write ${ais.map((a) => `<code>@${esc(a.handle)}</code>`).join(' or ')} to ask</span></p>` : '';
        const byRank = {};
        for (const p of people) (byRank[p.role] = byRank[p.role] || []).push(p);
        const person = (p) => `<li><a class="oc-name" href="${LIVE}/@${encodeURIComponent(p.username || '')}"${/^#[0-9a-f]{3,8}$/i.test(p.profile_color || '') ? ` style="--nc:${esc(p.profile_color)}"` : ''}>${esc(p.display_name || p.username || '?')}</a></li>`;
        const peopleHtml = ['owner', 'admin', 'mod', 'member'].filter((r) => byRank[r]).map((r) => `<h3 class="oc-srv-group">${RANK_TITLE[r]} <span class="oc-muted">${byRank[r].length}</span></h3><ul class="oc-srv-people-list">${byRank[r].map(person).join('')}</ul>`).join('');
        const tools = [
            can.moderate ? `<a href="/s/${esc(server.slug)}/settings">${can.manage ? 'Server settings' : 'Members and invites'}</a>` : '',
            can.member && can.role !== 'owner' ? `<form class="oc-inline" method="post" action="/s/${esc(server.slug)}/leave"><button type="submit" class="oc-link">Leave server</button></form>` : '',
        ].filter(Boolean).join(' · ');
        const canInvite = can.manage || (can.moderate && server.visibility === 'public');
        await page(req, res, 200, {
            actor, wide: true, title: `${isVoice ? '' : '#'}${room.name} · ${server.name}`, path: back, active: 'servers',
            robots: server.visibility === 'public' ? 'index, follow' : 'noindex, nofollow', script: true, callScript: callReady,
            description: server.description || `${server.name}, a server on OpenVibe.Chat with ${server.member_count} member${Number(server.member_count) === 1 ? '' : 's'}.`,
            page: {
                view: 'room', room: room.slug, back: `/s/${server.slug}`, kind: room.kind, pics: require('../rooms/pictures').enabled() ? require('../rooms/pictures').publicUrl() : null, ai: ais.map((a) => a.handle), latest: msgs.length ? msgs[msgs.length - 1].id : 0,
                me: me ? me.id : null, moderate: rcan.moderate, post: rcan.post, role: rcan.role,
                ...(callReady ? { call: { channel: `room-${room.slug}`, join: rcan.join, talk: rcan.talk } } : {}),
            },
            body: `<div class="oc-srv">
<nav class="oc-srv-rail" aria-label="Your servers">${mine.map((s) => icon(s, s.slug === server.slug)).join('')}${mine.some((s) => s.slug === server.slug) ? '' : icon(servers.publicServer(server), true)}
<a class="oc-srv-icon oc-srv-add" href="/servers#oc-new-server" title="Start a server"><span aria-hidden="true">+</span><span class="oc-sr">Start a server</span></a>
<a class="oc-srv-icon oc-srv-explore" href="/servers" title="Find servers">${SEARCH_ICON}<span class="oc-sr">Find servers</span></a></nav>
<aside class="oc-srv-side" aria-label="${esc(server.name)}">
<header class="oc-srv-head"><h1 class="oc-srv-name">${esc(server.name)}</h1>${server.visibility === 'private' ? '<span class="oc-badge">private</span>' : ''}
<p class="oc-muted oc-srv-meta">${Number(server.member_count) || 0} member${Number(server.member_count) === 1 ? '' : 's'}${YOU_ARE[can.role] ? ` · you are ${YOU_ARE[can.role]}` : ''}</p>
${server.description ? `<p class="oc-srv-desc">${esc(server.description)}</p>` : ''}</header>
<details class="oc-srv-channels" open><summary>Channels</summary>
<h2 class="oc-srv-group">Text channels</h2><ul class="oc-srv-list">${texts.map(chanLink).join('')}</ul>
${voices.length ? `<h2 class="oc-srv-group">Voice channels</h2><ul class="oc-srv-list">${voices.map(chanLink).join('')}</ul>` : ''}
</details>
${!can.member && me ? `<form class="oc-srv-join" method="post" action="/s/${esc(server.slug)}/join"><button type="submit">Join ${esc(server.name)}</button></form>` : ''}
${canInvite ? `<p class="oc-srv-invite"><a class="oc-button oc-button--quiet" href="/s/${esc(server.slug)}/settings#oc-invites">Invite people</a></p>` : ''}
${tools ? `<p class="oc-srv-tools">${tools}</p>` : ''}
</aside>
<section class="oc-srv-main" aria-labelledby="oc-chan-h">
<header class="oc-chan-head"><h2 id="oc-chan-h">${isVoice ? VOICE_ICON : '<span class="oc-chan-hash" aria-hidden="true">#</span>'}${esc(room.name)}</h2>${room.topic ? `<span class="oc-muted oc-chan-topic">${esc(room.topic)}</span>` : ''}<span class="oc-live" id="oc-live" hidden>● live</span></header>
${aiHere}${errorOf(req)}
${isVoice ? callPanel(room, rcan, me) : ''}
<ol class="oc-feed oc-srv-feed" id="oc-feed" aria-live="polite" aria-label="Messages in ${esc(room.name)}">${msgs.map((m) => roomMessage(m, rcan, room.slug, me)).join('\n') || `<li class="oc-empty oc-muted">${isVoice ? 'The voice channel\'s chat is empty.' : `This is the start of #${esc(room.name)}.`}</li>`}</ol>
${composer}
</section>
<aside class="oc-srv-people" aria-label="People in ${esc(server.name)}"><details open><summary>People <span class="oc-muted">${Number(server.member_count) || 0}</span></summary>${peopleHtml}${people.length >= 300 ? '<p class="oc-muted">And more.</p>' : ''}</details></aside>
</div>`,
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
        res.redirect(303, `/s/${server.slug}`);
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
        const myRank = can.staff ? -1 : servers.RANK[can.role];
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
        const chanRow = (c) => `<li><span>${c.kind === 'voice' ? VOICE_ICON : '#'} <strong>${esc(c.name)}</strong>${c.topic ? ` <span class="oc-muted">${esc(c.topic)}</span>` : ''}</span>
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
            actor, title: `${server.name}: settings`, path: `/s/${server.slug}/settings`, active: 'servers', robots: 'noindex, nofollow',
            body: `<p><a href="/s/${esc(server.slug)}">← ${esc(server.name)}</a></p><h1>Server settings</h1>${saved}${errorOf(req)}
${can.manage ? `<h2>Overview</h2><form class="oc-form" method="post" action="/s/${esc(server.slug)}/settings">
<label>Name <input name="name" required minlength="2" maxlength="40" value="${esc(server.name)}"></label>
<label>Description <input name="description" maxlength="300" value="${esc(server.description || '')}"></label>
<label>Who can find and read it <select name="visibility"><option value="public"${server.visibility === 'public' ? ' selected' : ''}>Anyone: listed, and signed-in people join (public)</option><option value="private"${server.visibility === 'private' ? ' selected' : ''}>Only people with an invite (private)</option></select></label>
<p><button type="submit">Save</button></p></form>
<h2>Channels</h2><ul class="oc-members oc-chan-rows">${chans.map(chanRow).join('')}</ul>
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/channels"><label for="oc-chan-new">Add a channel</label> <input id="oc-chan-new" name="name" required maxlength="40" placeholder="announcements"> <select name="kind" aria-label="Kind of channel"><option value="text">Text</option><option value="voice">Voice</option></select> <button type="submit">Add</button></form>` : ''}
${canInvite ? `<h2 id="oc-invites">Invites</h2><p class="oc-muted">${server.visibility === 'private' ? 'A private server is joined only through an invite.' : 'Anyone can join a public server; an invite link is a handy way to bring people straight to it.'}</p>
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/invites"><label for="oc-inv-uses">New invite</label> <select id="oc-inv-uses" name="max_uses" aria-label="How many times it can be used"><option value="">any number of uses</option><option value="1">1 use</option><option value="10">10 uses</option><option value="100">100 uses</option></select> <select name="expires_hours" aria-label="When it expires"><option value="168">for 7 days</option><option value="24">for 1 day</option><option value="720">for 30 days</option><option value="">forever</option></select> <button type="submit">Make an invite</button></form>
<ul class="oc-members">${invites.map(inviteRow).join('') || '<li class="oc-muted">No invites yet.</li>'}</ul>` : ''}
<h2>Members <span class="oc-muted">${active.length}</span></h2>
<p class="oc-muted">Admins manage channels, invites and members; moderators delete messages and remove or ban members. The owner appoints admins, admins appoint moderators.</p>
<ul class="oc-members">${active.map((p) => `<li><strong>${esc(p.display_name || p.username || '?')}</strong> <span class="oc-muted">@${esc(p.username || '')}</span> ${roleForm(p)}</li>`).join('')}</ul>
${banned.length ? `<details class="oc-blocked"><summary>Banned (${banned.length})</summary><ul class="oc-members">${banned.map((p) => `<li><strong>${esc(p.display_name || p.username || '?')}</strong> <span class="oc-muted">@${esc(p.username || '')}</span><form class="oc-inline" method="post" action="/s/${esc(server.slug)}/members"><input type="hidden" name="username" value="${esc(p.username || '')}"><input type="hidden" name="role" value="none"><button type="submit" class="oc-link">Lift the ban</button></form></li>`).join('')}</ul></details>` : ''}
<form class="oc-new" method="post" action="/s/${esc(server.slug)}/members"><label for="oc-ban">Ban someone</label> <input id="oc-ban" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="their username"><input type="hidden" name="role" value="blocked"> <button type="submit">Ban</button></form>
${can.owner || can.staff ? `<h2>Delete the server</h2><form class="oc-form" method="post" action="/s/${esc(server.slug)}/delete"><label class="oc-check"><input type="checkbox" name="confirm" value="1" required> Delete ${esc(server.name)} and all its channels</label><p><button type="submit" class="oc-danger">Delete server</button></p></form>` : ''}`,
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
        const room = await servers.createChannel(server, user, { name: b.name, kind: b.kind === 'voice' ? 'voice' : 'text' });
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
        res.redirect(303, `/s/${found.server.slug}`);
    }));

    // A channel's page and its no-JavaScript message form (after the fixed /s/:slug/… routes above).
    router.get('/s/:slug/:channel', serverPage);
    router.post('/s/:slug/:channel', formLimit, sameSite, orError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const server = await servers.bySlug(req.params.slug);
        const room = server ? await servers.channelBySlug(server, req.params.channel) : null;
        if (!room || !(await rooms.access(room, actor.user)).read) return res.redirect(303, '/servers');
        req.back = `/s/${server.slug}/${room.channel_slug}`;
        const message = await rooms.post(room, actor.user, req.body && req.body.message);
        require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        res.redirect(303, `/s/${server.slug}/${room.channel_slug}#oc-compose`);
    }));
}

module.exports = { mountServerPages };
