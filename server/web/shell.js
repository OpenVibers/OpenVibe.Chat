'use strict';
/**
 * The app shell on every page of openvibe.chat (the plan, 2026-11-09, stage V2: "the rail, the side column (Home's
 * DMs and Friends; a server's channels with categories and voice occupants; the you-bar), the members column, the
 * phone panels with swipe and the Shared appbar as the bottom bar; the channel header; the user popout everywhere;
 * buttons as the plan says").
 *
 * Discord's four columns, our data:
 *
 *   the rail (72 px)      Home (the DMs) and Vibe at the top, then your servers as round icons (their picture, or a
 *                         generated monogram tile in the server's colour), each with its unread dot, then Add a
 *                         server and Explore
 *   the side column      Home: "Find or start a conversation", then Friends, Requests and Vibe, then the DMs
 *                         A server: its banner and name with a menu (Invite, Settings, Notifications, Leave),
 *                         Events, the channel categories (collapsible) with the people in each voice channel, and
 *                         the you-bar at the foot
 *   the middle           the conversation, or the channel's messages
 *   the members column  the people, grouped by role, with their presence
 *
 * On a phone the three columns are panels you swipe between (public/web/chat-shell.js) under Shared's app bar.
 * Everything here is server-rendered: the page reads and works without JavaScript, and the script only adds the
 * gestures, the members toggle and the shared user popout.
 */
const { esc } = require('./layout');
const ui = require('./ui');
const { ICONS: IC } = require('./icons');

/** The five places of the phone's bottom bar: Shared's app bar draws them (appbar.js). */
const APP_BAR = [
    { label: 'Home', href: '/messages', icon: 'fa-comment-dots', page: 'messages' },
    { label: 'Servers', href: '/servers', icon: 'fa-people-group', page: 'servers' },   // not the globe: that is Global chat
    { label: 'Vibe', href: '/vibe', icon: 'fa-wand-magic-sparkles', page: 'vibe' },
    { label: 'Activity', href: '/activity', icon: 'fa-bell', page: 'activity', dot: true },
    { label: 'You', href: '/settings', icon: 'fa-user', page: 'settings' },
];

/** One icon button: 40 px on a computer, 44 px on a phone (chat-shell.css), never a bare glyph at a random size. */
const iconBtn = (href, label, svg, extra = '') => `<a class="oc-icon-btn" href="${esc(href)}" aria-label="${esc(label)}" title="${esc(label)}"${extra}>${svg}</a>`;

/** What the rail and a server's sheet need of each server (servers.list(me).mine). */
const railServers = (mine, active) => (mine || []).map((s) => ({
    slug: s.slug, name: s.name, unread: s.unread, role: s.role || '', members: Number(s.members) || 0,
    private: s.visibility === 'private', official: !!s.official, active: !!active && s.slug === active,
}));

/** A server's facts on the element that opens its sheet (chat-shell.js reads them: hold, right-click, or the open one). */
const serverData = (s) => ` data-oc-server="${esc(s.slug)}" data-oc-name="${esc(s.name)}" data-oc-role="${esc(s.role || '')}" data-oc-members="${Number(s.members) || 0}" data-oc-hue="${ui.hueOf(s.slug)}"${s.private ? ' data-oc-private' : ''}${s.official ? ' data-oc-official' : ''}`;

/**
 * A server's sheet, once a page: what it is, your rank in it, and what you may do with it (open, invite, settings,
 * leave, delete). chat-shell.js fills a copy from the element that was held; without the script a server's own page
 * has the same actions in its side column. It carries only what the person may do in at least one of their servers:
 * someone who runs none is not shown a word about settings.
 */
function serverSheet(servers) {
    const runs = servers.some((s) => ['owner', 'admin', 'mod'].includes(s.role));
    const owns = servers.some((s) => s.role === 'owner' && !s.official);
    const leaves = servers.some((s) => s.role && s.role !== 'owner');
    return `<template id="oc-srv-sheet"><dialog class="oc-ssheet" aria-labelledby="oc-ssheet-name">
<header class="oc-ssheet-head"><span class="oc-srv-icon oc-srv-icon--row" data-s="mark" aria-hidden="true"></span><div class="oc-ssheet-id"><h2 id="oc-ssheet-name"><span data-s="name"></span><span class="oc-badge oc-badge-official" data-s="official">official</span><span class="oc-badge" data-s="private">private</span></h2><p class="oc-muted" data-s="sub"></p></div><button type="button" class="oc-icon-btn oc-ssheet-close" data-s="close" aria-label="Close" title="Close">${IC.close}</button></header>
<nav class="oc-ssheet-list" aria-label="This server">
<a class="oc-pop-item" data-s="open">${IC.enter}<span>Open</span></a>
${runs ? `<a class="oc-pop-item" data-s="invite">${IC.members}<span>Invite people</span></a>
<a class="oc-pop-item" data-s="settings">${IC.gear}<span><b>Server settings</b><small>Its name, channels, roles and members</small></span></a>` : ''}
${leaves ? `<form method="post" data-s="leave"><button type="submit" class="oc-pop-item">${IC.leave}<span>Leave this server</span></button></form>` : ''}
${owns ? `<details class="oc-ssheet-danger" data-s="delete"><summary class="oc-pop-item">${IC.trash}<span>Delete this server</span></summary>
<form method="post" class="oc-ssheet-confirm"><input type="hidden" name="confirm" value="1"><p data-s="delete-line"></p><p class="oc-ssheet-go"><button type="submit" class="oc-danger">Delete it</button><button type="button" class="oc-button--quiet" data-s="keep">Keep it</button></p></form></details>` : ''}
</nav></dialog></template>`;
}

/**
 * The rail: the list button (a phone), Home, Global chat and Vibe, your servers, then New and Explore. Every place
 * carries its name: beside the tile on a phone, where the rail is a strip of chips, and as a label that follows the
 * pointer's tile on a computer (chat-shell.js). On a phone Home, Vibe and Explore are the bottom bar's, so the strip
 * leaves them out while that bar is there (chat-shell.css).
 * o: { servers: railServers(mine, activeSlug), dmUnread, home, global, vibe, explore, list }
 */
function rail(o = {}) {
    const servers = o.servers || [];
    const dot = (n) => (n ? `<span class="oc-rail-dot" aria-label="${n} unread">${n > 99 ? '99+' : n}</span>` : '');
    const place = (cls, href, name, inner, on, extra = '') => `<a class="oc-rail-icon ${cls}${on ? ' is-active' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}><span class="oc-rail-tile" aria-hidden="true">${inner}</span><span class="oc-rail-label">${esc(name)}</span>${extra}</a>`;
    const server = (s) => `<a class="oc-rail-icon oc-rail-server${s.active ? ' is-active' : ''}" href="/s/${esc(s.slug)}" style="--oc-hue:${ui.hueOf(s.slug)}"${s.active ? ' aria-current="page"' : ''}${serverData(s)}><span class="oc-rail-tile" aria-hidden="true">${esc(ui.serverLetters(s.name))}</span><span class="oc-rail-label">${esc(s.name)}</span>${s.active ? `<span class="oc-rail-more" aria-hidden="true">${IC.chevron}</span>` : ''}${dot(s.unread)}</a>`;
    return `<nav class="oc-rail" aria-label="Chat destinations">
${place('oc-rail-home', '/messages', 'Home', IC.chat, o.home, dot(o.dmUnread))}
${place('oc-rail-global', '/', 'Global', IC.globe, o.global)}
${place('oc-rail-vibe', '/vibe', 'Vibe', IC.spark, o.vibe)}
<span class="oc-rail-divider" role="separator" aria-hidden="true"></span>
${servers.map(server).join('')}
${place('oc-rail-add', '/servers#oc-new-server', 'New', IC.plus, false)}
${place('oc-rail-explore', '/servers', 'Explore', IC.search, o.explore)}
${servers.length ? serverSheet(servers) : ''}</nav>`;
}

/** One person in a list: their mark, their name and a muted line under it. */
function personRow(person, { href = '', extra = '', title = '', sub = '' } = {}) {
    const name = person.display_name || person.username || '?';
    const mark = ui.initials(name, person.presence, { avatarUrl: person.avatar_url });
    const body = `<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(name)}</strong>${title}</span>${sub ? `<span class="oc-row-sub">${sub}</span>` : ''}</span>`;
    const inner = href
        ? `<a href="${esc(href)}"${person.id ? ` data-oc-user="${Number(person.id)}"` : ''}>${mark}${body}</a>`
        : `<span>${mark}${body}</span>`;
    return `<li class="oc-row${person.presence ? ' is-online' : ''}">${inner}${extra}</li>`;
}

/**
 * The side column on Home: find or start a conversation, then Friends, Requests and Vibe, then the DMs.
 * o: { dms: [{ id, title, preview, at, unread, presence, avatarUrl }], friends, requests, current }
 */
function sideHome(o = {}) {
    const dms = o.dms || [];
    const dmRow = (d) => `<li class="oc-row${d.unread ? ' oc-unread' : ''}"><a href="/messages/${d.id}"${d.current ? ' aria-current="page"' : ''}>${ui.initials(d.title, d.presence, { avatarUrl: d.avatarUrl })}<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(d.title)}</strong>${d.unread ? `<span class="oc-dot" aria-label="${d.unread} new">${d.unread > 9 ? '9+' : d.unread}</span>` : ''}</span><span class="oc-row-sub">${esc(d.preview || '')}</span></span></a></li>`;
    const friends = o.friends || [];
    const requests = o.requests || [];
    return `<div class="oc-side-top">
<a class="oc-side-find" href="/messages#oc-new">${IC.pencil}<span>Find or start a conversation</span></a>
</div>
<section class="oc-side-sec" aria-labelledby="oc-side-friends"><h2 class="oc-side-group" id="oc-side-friends">Friends <span class="oc-muted">${friends.length}</span></h2>
${friends.length ? `<ul class="oc-side-list">${friends.map((f) => `<li class="oc-row"><form method="post" action="/messages/new"><input type="hidden" name="username" value="${esc(f.username || '')}"><button type="submit" class="oc-side-person">${ui.initials(f.display_name || f.username || '?', f.presence, { avatarUrl: f.avatar_url })}<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(f.display_name || f.username || '?')}</strong></span><span class="oc-row-sub">@${esc(f.username || '')}</span></span></button></form></li>`).join('')}</ul>`
        : `<p class="oc-side-empty oc-muted">No friends yet. Start a conversation and add the people you talk to.</p>`}
<form class="oc-side-add" method="post" action="/messages/contacts"><label class="oc-sr" for="oc-add-friend">Add a friend by username</label><input id="oc-add-friend" name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder="Add a friend by username" autocomplete="off"><button type="submit">Add</button></form>
</section>
<section class="oc-side-sec" aria-labelledby="oc-side-requests"><h2 class="oc-side-group" id="oc-side-requests">Requests <span class="oc-muted">${requests.length}</span></h2>
${requests.length ? `<ul class="oc-side-list">${requests.map((r) => personRow(r, { extra: `<form class="oc-inline" method="post" action="/messages/contacts/${Number(r.id)}/accept"><button type="submit" class="oc-link">Accept</button></form>` })).join('')}</ul>`
        : `<p class="oc-side-empty oc-muted">No requests.</p>`}
</section>
<section class="oc-side-sec" aria-labelledby="oc-side-vibe"><h2 class="oc-side-group" id="oc-side-vibe">Vibe</h2>
<ul class="oc-side-list"><li class="oc-row"><a href="/vibe">${IC.spark}<span class="oc-row-main"><span class="oc-row-top"><strong>Vibe</strong></span><span class="oc-row-sub">OpenVibe's assistant</span></span></a></li></ul>
</section>
<section class="oc-side-sec" aria-labelledby="oc-side-dms"><h2 class="oc-side-group" id="oc-side-dms">Direct messages</h2>
${dms.length ? `<ul class="oc-side-list">${dms.map(dmRow).join('')}</ul>` : `<p class="oc-side-empty oc-muted">No conversations yet.</p>`}
</section>
${youBar(o.you || {})}`;
}

/**
 * A voice channel with the people in it (the plan: "voice channels with who is in them").
 * o: { name, href, occupants: [{ display_name, username }], active }
 */
function voiceRow(o) {
    const occupants = (o.occupants || []).slice(0, 4);
    const names = occupants.map((p) => esc(p.display_name || p.username || '?'));
    return `<li><a class="oc-chan oc-chan-voice${o.active ? ' is-active' : ''}" href="${esc(o.href)}"${o.active ? ' aria-current="page"' : ''}>${IC.voice}<span class="oc-chan-name">${esc(o.name)}</span></a>
${names.length ? `<ul class="oc-voice-people">${names.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}</li>`;
}

/**
 * The side column in a server: its banner and name with a menu, Events, the channel categories with the people in
 * each voice channel, and the you-bar.
 * o: { server, can, me, categories: [{ name, channels: [{ kind, name, href, slug, active, unread }] }], occupants:
 *      { slug: [{ display_name }] }, events, you }
 */
function sideServer(o = {}) {
    const server = o.server || {};
    const can = o.can || {};
    const me = !!o.me;
    const categories = o.categories || [];
    const menu = [];
    if (can.invite) menu.push(`<a class="oc-pop-item" href="/s/${esc(server.slug)}/settings#oc-invites">${IC.members}<span>Invite people</span></a>`);
    if (can.manage || can.moderate) menu.push(`<a class="oc-pop-item" href="/s/${esc(server.slug)}/settings">${IC.gear}<span>Server settings</span></a>`);
    if (can.member && can.role !== 'owner') menu.push(`<form method="post" action="/s/${esc(server.slug)}/leave"><button type="submit" class="oc-pop-item">${IC.leave}<span>Leave server</span></button></form>`);
    const cat = (c) => `<section class="oc-side-sec oc-side-cat"><details open><summary class="oc-side-group">${esc(c.name)}</summary>
<ul class="oc-side-list">${c.channels.map((ch) => (ch.kind === 'voice'
        ? voiceRow({ name: ch.name, href: ch.href, active: ch.active, occupants: (o.occupants || {})[ch.slug] || [] })
        : `<li><a class="oc-chan${ch.active ? ' is-active' : ''}${ch.unread ? ' is-unread' : ''}" href="${esc(ch.href)}"${ch.active ? ' aria-current="page"' : ''}><span class="oc-chan-hash" aria-hidden="true">#</span><span class="oc-chan-name">${esc(ch.name)}</span>${ch.unread ? `<span class="oc-chan-dot" aria-label="${ch.unread} unread">${ch.unread > 99 ? '99+' : ch.unread}</span>` : ''}</a></li>`)).join('')}</ul></details></section>`;
    return `<header class="oc-side-head">
<h1 class="oc-side-name">${esc(server.name || '')}</h1>${server.official ? '<span class="oc-badge oc-badge-official">official</span>' : ''}${server.visibility === 'private' ? `<span class="oc-badge">${IC.lock}<span class="oc-sr">private</span></span>` : ''}
<p class="oc-muted oc-side-meta">${Number(server.member_count) || 0} member${Number(server.member_count) === 1 ? '' : 's'}${can.role ? ` · you are ${esc(can.role)}` : ''}</p>
${server.description ? `<p class="oc-side-desc">${esc(server.description)}</p>` : ''}
${menu.length ? `<details class="oc-more oc-side-more"><summary class="oc-icon-btn" aria-label="Server menu" title="Server menu">${IC.more}</summary><div class="oc-pop">${menu.join('')}</div></details>` : ''}
</header>
<a class="oc-side-event" href="/s/${esc(server.slug || '')}/events">${IC.clock}<span>Events</span></a>
${can.member ? '' : me ? `<form class="oc-side-join" method="post" action="/s/${esc(server.slug || '')}/join"><button type="submit">Join ${esc(server.name || 'this server')}</button></form>` : `<p class="oc-side-join"><a class="oc-button" href="/auth/login?next=${encodeURIComponent(`/s/${server.slug || ''}`)}">Sign in to join</a></p>`}
${categories.map(cat).join('')}
${youBar(o.you || {})}`;
}

/**
 * The side column for the rooms: start one, Global chat, then the rooms you are in and the public ones.
 * o: { mine: [{ slug, name, unread, private, current }], public: [...], you }
 */
function sideRooms(o = {}) {
    const mine = o.mine || [];
    const others = (o.public || []).filter((r) => !mine.some((m) => m.slug === r.slug));
    const row = (r) => `<li><a class="oc-chan${r.current ? ' is-active' : ''}${r.unread ? ' is-unread' : ''}" href="/r/${esc(r.slug)}"${r.current ? ' aria-current="page"' : ''}><span class="oc-chan-hash" aria-hidden="true">#</span><span class="oc-chan-name">${esc(r.name)}</span>${r.private ? `<span class="oc-muted" aria-hidden="true">${IC.lock}</span>` : ''}${r.unread ? `<span class="oc-chan-dot" aria-label="${r.unread} unread">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</a></li>`;
    const section = (id, title, rooms, empty) => `<section class="oc-side-sec" aria-labelledby="${id}"><h2 class="oc-side-group" id="${id}">${title}</h2>
${rooms.length ? `<ul class="oc-side-list">${rooms.map(row).join('')}</ul>` : `<p class="oc-side-empty oc-muted">${empty}</p>`}</section>`;
    return `<div class="oc-side-top">
<a class="oc-side-find" href="/rooms#oc-new-room">${IC.plus}<span>Start a room</span></a>
<a class="oc-side-find" href="/">${IC.globe}<span>Global chat</span></a>
</div>
${section('oc-side-your-rooms', 'Your rooms', mine, 'You are in no rooms yet.')}
${section('oc-side-public-rooms', mine.length ? 'More public rooms' : 'Public rooms', others, 'No public room is open right now.')}
${youBar(o.you || {})}`;
}

/**
 * The side column for your settings: the sections of the page, then the you-bar.
 * o: { items: [{ href, label, active }], you }
 */
function sideSettings(o = {}) {
    const items = o.items || [];
    return `<div class="oc-side-top"><a class="oc-side-find" href="/messages">${IC.back}<span>Back to chat</span></a></div>
<section class="oc-side-sec" aria-labelledby="oc-side-set"><h2 class="oc-side-group" id="oc-side-set">Settings</h2>
<ul class="oc-side-list">${items.map((i) => `<li><a class="oc-chan${i.active ? ' is-active' : ''}" href="${esc(i.href)}"${i.active ? ' aria-current="page"' : ''}><span class="oc-chan-name">${esc(i.label)}</span></a></li>`).join('')}</ul>
</section>
${youBar(o.you || {})}`;
}

/**
 * The side column for the inbox: make one, then the inboxes you answer.
 * o: { inboxes: [{ id, name, color, waiting, open, role, current }], you }
 */
function sideInbox(o = {}) {
    const inboxes = o.inboxes || [];
    const row = (i) => `<li class="oc-row${i.waiting ? ' oc-unread' : ''}"><a href="/inbox/${esc(i.id)}"${i.current ? ' aria-current="page"' : ''}><span class="oc-dot" style="background:${esc(i.color || 'var(--oc-accent)')}" aria-hidden="true"></span><span class="oc-row-main"><span class="oc-row-top"><strong>${esc(i.name)}</strong></span><span class="oc-row-sub">${i.waiting ? `${i.waiting} waiting · ` : ''}${i.open} open · ${i.role === 'owner' ? 'owner' : 'agent'}</span></span></a></li>`;
    return `<div class="oc-side-top"><a class="oc-side-find" href="/inbox#oc-new-inbox">${IC.plus}<span>Make an inbox</span></a></div>
<section class="oc-side-sec" aria-labelledby="oc-side-inboxes"><h2 class="oc-side-group" id="oc-side-inboxes">Your inboxes</h2>
${inboxes.length ? `<ul class="oc-side-list">${inboxes.map(row).join('')}</ul>` : '<p class="oc-side-empty oc-muted">No inboxes yet.</p>'}</section>
${youBar(o.you || {})}`;
}

/**
 * The composer, the same wherever a person writes (Global chat, a conversation, a room, a channel): one box with the
 * text in it, Add on its left where the place takes pictures, Send on its right. What is being added waits in the
 * tray above the text. It posts as a plain form; chat.js sends it over the socket's API instead, and chat-shell.js
 * grows the box with the text and lights Send when there is something to send.
 * o: { action, label, placeholder, max, add: the panel Add opens (pictureComposer's), hint }
 */
function composer(o = {}) {
    const add = o.add || '';
    return `<div class="oc-dock${add ? ' has-add' : ''}"><form class="oc-compose" method="post" action="${esc(o.action || '')}" id="oc-compose"><label for="oc-input" class="oc-sr">${esc(o.label || 'Message')}</label>
<div class="oc-compose-box"><div class="oc-compose-tray" data-oc-tray hidden></div>
<div class="oc-compose-row">${add ? `<button type="button" class="oc-compose-add" data-oc-attach aria-expanded="false" aria-controls="oc-add-panel" aria-label="Add a picture" title="Add a picture">${IC.plus}</button>` : ''}<textarea id="oc-input" name="message" maxlength="${Number(o.max) || 2000}" rows="1" required placeholder="${esc(o.placeholder || 'Write a message')}"></textarea><button type="submit" class="oc-send" aria-label="Send" title="Send">${IC.send}</button></div></div></form>${add}</div>`;
}

/** The you-bar: your mark, your status, mute, deafen and settings (the foot of the side column). */
function youBar(o = {}) {
    if (!o.name) return '';
    return `<div class="oc-you"><a class="oc-you-id" href="/settings">${ui.initials(o.name, o.presence, { avatarUrl: o.avatarUrl })}<span class="oc-you-names"><strong>${esc(o.name)}</strong><span class="oc-muted">${esc(o.status || 'Online')}</span></span></a>
<span class="oc-you-tools"><a class="oc-icon-btn" href="/settings#oc-sound" aria-label="Mute" title="Mute">${IC.alert}</a><a class="oc-icon-btn" href="/settings" aria-label="Settings" title="Settings">${IC.gear}</a></span></div>`;
}

/**
 * The members column: the people, grouped by role, with their presence.
 * o: { groups: [{ role, title, people: [] }], label }
 */
function membersColumn(o = {}) {
    const groups = o.groups || [];
    return `<div class="oc-members-head"><h2 class="oc-side-group">People</h2><button type="button" class="oc-icon-btn oc-members-close" data-oc-panel="main" aria-label="Hide the people" title="Hide the people">${IC.back}</button></div>
${groups.map((g) => `<section class="oc-members-sec"><h3 class="oc-side-group">${esc(g.title)} <span class="oc-muted">${g.people.length}</span></h3>
<ul class="oc-side-list">${g.people.map((p) => `<li class="oc-row oc-member-row${p.presence ? ' is-online' : ''}"><a href="${p.href || '#'}"${p.id ? ` data-oc-user="${Number(p.id)}"` : ''}>${ui.initials(p.display_name || p.username || '?', p.presence, { avatarUrl: p.avatar_url })}<span class="oc-row-main"><span class="oc-row-top"><strong${p.color ? ` style="--nc:${esc(p.color)}"` : ''}>${esc(p.display_name || p.username || '?')}</strong></span><span class="oc-row-sub">${esc([p.username ? `@${p.username}` : '', ...(p.roles || [])].filter(Boolean).join(' · '))}</span></span></a></li>`).join('')}</ul></section>`).join('')}`;
}

/**
 * The channel header: the channel's name and topic, and the buttons that work (the people, the server's menu).
 * o: { name, kind, topic, href, members, active }
 */
/**
 * The way from a conversation to the list (a phone's two levels: the list, then the conversation). It is the first
 * thing in a conversation's head; on a computer the list is beside the conversation and this is not drawn.
 */
const toList = `<button type="button" class="oc-icon-btn oc-tolist" data-oc-panel="side" aria-label="All chats" title="All chats">${IC.back}</button>`;

function channelHeader(o = {}) {
    const kind = o.kind === 'voice' ? IC.voice : '<span class="oc-chan-hash" aria-hidden="true">#</span>';
    return `<header class="oc-chan-head">
${toList}<h2 id="oc-chan-h" class="oc-chan-title">${kind}${esc(o.name || '')}</h2>
${o.topic ? `<span class="oc-muted oc-chan-topic">${esc(o.topic)}</span>` : ''}
<span class="oc-chan-tools">
<button type="button" class="oc-icon-btn oc-members-toggle" data-oc-panel="members" aria-label="Show the people" title="People" aria-pressed="false">${IC.members}</button>
${o.back ? iconBtn(o.back.href, o.back.label, IC.back) : ''}
</span>${o.extra || ''}</header>`;
}

/**
 * The shell itself: the rail, the side column, the middle and the members column. On a phone the columns are
 * panels (public/web/chat-shell.js sets data-oc-panel).
 * o: { rail, side, sideLabel, main, members, membersLabel }
 */
function shell(o = {}) {
    return `<div class="oc-app" data-oc-app data-oc-panel="main">
${o.rail || ''}
${o.side ? `<aside class="oc-side" aria-label="${esc(o.sideLabel || 'Chat')}">${o.side}</aside>` : ''}
<section class="oc-col oc-col-main" aria-label="${esc(o.mainLabel || 'Conversation')}">${o.page ? `<div class="oc-page">${o.main || ''}</div>` : (o.main || '')}</section>
${o.members ? `<aside class="oc-col oc-col-members" aria-label="${esc(o.membersLabel || 'People')}">${o.members}</aside>` : ''}
</div>`;
}

module.exports = { APP_BAR, toList, rail, railServers, serverData, composer, sideHome, sideServer, sideRooms, sideSettings, sideInbox, membersColumn, channelHeader, youBar, shell, personRow };
