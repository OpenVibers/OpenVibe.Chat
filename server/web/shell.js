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
    { label: 'Servers', href: '/servers', icon: 'fa-globe', page: 'servers' },
    { label: 'Vibe', href: '/vibe', icon: 'fa-wand-magic-sparkles', page: 'vibe' },
    { label: 'Activity', href: '/notifications', icon: 'fa-bell', page: 'notifications' },
    { label: 'You', href: '/settings', icon: 'fa-user', page: 'settings' },
];

/** One icon button: 40 px on a computer, 44 px on a phone (chat-shell.css), never a bare glyph at a random size. */
const iconBtn = (href, label, svg, extra = '') => `<a class="oc-icon-btn" href="${esc(href)}" aria-label="${esc(label)}" title="${esc(label)}"${extra}>${svg}</a>`;

/**
 * The rail: Home, Global chat and Vibe, your servers, then Add a server and Explore.
 * o: { servers: [{ slug, name, unread, active }], dmUnread, home, global, vibe, explore }
 */
function rail(o = {}) {
    const servers = o.servers || [];
    const server = (s) => `<a class="oc-rail-icon${s.active ? ' is-active' : ''}" href="/s/${esc(s.slug)}" title="${esc(s.name)}" style="--oc-hue:${ui.hueOf(s.slug)}"${s.active ? ' aria-current="page"' : ''}><span aria-hidden="true">${esc(ui.serverLetters(s.name))}</span><span class="oc-sr">${esc(s.name)}</span>${s.unread ? `<span class="oc-rail-dot" aria-label="${s.unread} unread">${s.unread > 99 ? '99+' : s.unread}</span>` : ''}</a>`;
    return `<nav class="oc-rail" aria-label="Chat destinations">
<button type="button" class="oc-rail-menu" data-oc-panel="side" aria-label="Open the side column" title="Open the side column">${IC.menu}</button>
<a class="oc-rail-icon oc-rail-home${o.home ? ' is-active' : ''}" href="/messages" title="Home"${o.home ? ' aria-current="page"' : ''}>${IC.chat}<span class="oc-sr">Home</span>${o.dmUnread ? `<span class="oc-rail-dot" aria-label="${o.dmUnread} unread">${o.dmUnread > 99 ? '99+' : o.dmUnread}</span>` : ''}</a>
<a class="oc-rail-icon oc-rail-global${o.global ? ' is-active' : ''}" href="/" title="Global chat"${o.global ? ' aria-current="page"' : ''}>${IC.globe}<span class="oc-sr">Global chat</span></a>
<a class="oc-rail-icon oc-rail-vibe${o.vibe ? ' is-active' : ''}" href="/vibe" title="Vibe"${o.vibe ? ' aria-current="page"' : ''}>${IC.spark}<span class="oc-sr">Vibe</span></a>
<span class="oc-rail-divider" role="separator" aria-hidden="true"></span>
${servers.map(server).join('')}
<a class="oc-rail-icon oc-rail-add" href="/servers#oc-new-server" title="Start a server"><span aria-hidden="true">+</span><span class="oc-sr">Start a server</span></a>
<a class="oc-rail-icon oc-rail-explore${o.explore ? ' is-active' : ''}" href="/servers" title="Explore servers"${o.explore ? ' aria-current="page"' : ''}>${IC.search}<span class="oc-sr">Explore servers</span></a>
</nav>`;
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
<ul class="oc-side-list">${g.people.map((p) => `<li class="oc-row oc-member-row${p.presence ? ' is-online' : ''}"><a href="${p.href || '#'}"${p.id ? ` data-oc-user="${Number(p.id)}"` : ''}>${ui.initials(p.display_name || p.username || '?', p.presence, { avatarUrl: p.avatar_url })}<span class="oc-row-main"><span class="oc-row-top"><strong${p.color ? ` style="--nc:${esc(p.color)}"` : ''}>${esc(p.display_name || p.username || '?')}</strong></span><span class="oc-row-sub">${esc(p.username ? `@${p.username}` : '')}</span></span></a></li>`).join('')}</ul></section>`).join('')}`;
}

/**
 * The channel header: the channel's name and topic, and the buttons that work (the people, the server's menu).
 * o: { name, kind, topic, href, members, active }
 */
function channelHeader(o = {}) {
    const kind = o.kind === 'voice' ? IC.voice : '<span class="oc-chan-hash" aria-hidden="true">#</span>';
    return `<header class="oc-chan-head">
<h2 id="oc-chan-h" class="oc-chan-title">${kind}${esc(o.name || '')}</h2>
${o.topic ? `<span class="oc-muted oc-chan-topic">${esc(o.topic)}</span>` : ''}
<span class="oc-chan-tools">
<button type="button" class="oc-icon-btn oc-members-toggle" data-oc-panel="members" aria-label="Show the people" title="People" aria-pressed="false">${IC.members}</button>
${o.back ? iconBtn(o.back.href, o.back.label, IC.back) : ''}
</span></header>`;
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

module.exports = { APP_BAR, rail, sideHome, sideServer, sideRooms, sideSettings, sideInbox, membersColumn, channelHeader, youBar, shell, personRow };
