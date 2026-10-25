'use strict';
/**
 * openvibe.chat/vibe — the app for chatting with Vibe, OpenVibe's assistant (server/rooms/vibe.js), laid out the way
 * people already know from ChatGPT, Claude and Gemini: the chats down the left, the conversation in the middle, one
 * composer at the bottom. Server-rendered and usable without JavaScript (forms post, the page shows Vibe's answer once
 * it is written); public/web/vibe.js makes it live over the room socket and keeps the draft through a sign-in.
 *
 *   GET  /vibe                  a new chat (signed out: the same page, sending asks to sign in)
 *   GET  /vibe/:slug            one of the person's chats
 *   POST /vibe                  form: start a chat with its first message
 *   POST /vibe/:slug            form: a message in the chat
 *   POST /vibe/:slug/rename     form: { name }
 *   POST /vibe/:slug/delete     form: the chat and its messages go
 *   POST /vibe/:slug/retry      form: "Try again" on Vibe's last answer (rooms/vibe.js retry)
 *   GET  /vibe/memory           what Vibe remembers about the person (server/rooms/vibe-memory.js), with forms to add a
 *                               note (POST /vibe/memory), delete one (POST /vibe/memory/:id/delete), forget everything
 *                               (POST /vibe/memory/clear) and switch the memory off or on (POST /vibe/memory/switch)
 */
const md = require('../../public/web/vibe-md.js');
const pictures = require('../rooms/pictures');
const rooms = require('../rooms/rooms');
const vibe = require('../rooms/vibe');
const how = require('../rooms/how');
const memory = require('../rooms/vibe-memory');
const { esc } = require('./layout');

const SUGGESTIONS = [
    { title: 'Catch me up', text: 'on today\'s tech news', prompt: 'What happened in tech news today? Give me the highlights with links.' },
    { title: 'Find a deal', text: 'on a mechanical keyboard', prompt: 'Find me a good deal on a mechanical keyboard on OpenVibe Deals.' },
    { title: 'Look for jobs', text: 'remote video editing work', prompt: 'Find remote video editing jobs posted recently.' },
    { title: 'Explain a page', text: 'how browser go-live works', prompt: 'Read https://openvibe.live/docs/go-live-in-your-browser and explain how going live from a browser works, in plain words.' },
];

const DAY = 86_400_000;
const atOf = (ts) => { const s = String(ts || ''); const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : 0; };
/** The rail's groups, newest first: Today, Yesterday, Previous 7 days, Previous 30 days, then by month. */
function groupChats(chats, now = Date.now()) {
    const startToday = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const groups = [];
    for (const c of chats) {
        const at = atOf(c.last_message_at);
        const label = at >= startToday ? 'Today' : at >= startToday - DAY ? 'Yesterday' : at >= startToday - 7 * DAY ? 'Previous 7 days'
            : at >= startToday - 30 * DAY ? 'Previous 30 days' : new Date(at).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, chats: [] });
        groups[groups.length - 1].chats.push(c);
    }
    return groups;
}

const ICON = {
    new: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    attach: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    messages: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4Z"/></svg>',
    rooms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 8 1 8 5"/></svg>',
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/></svg>',
    computer: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    team: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9h6M7 13h10"/></svg>',
    agents: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    memory: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4Z"/></svg>',
};

/** A search hit's message, cut to about 90 characters around the first match, with the match marked. */
function snippet(text, q) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    const at = flat.toLowerCase().indexOf(String(q).toLowerCase());
    if (at < 0) return esc(flat.slice(0, 90));
    const from = Math.max(0, at - 36);
    const to = Math.min(flat.length, at + q.length + 54);
    return `${from > 0 ? '…' : ''}${esc(flat.slice(from, at))}<mark>${esc(flat.slice(at, at + q.length))}</mark>${esc(flat.slice(at + q.length, to))}${to < flat.length ? '…' : ''}`;
}

/** The mark Vibe signs its answers with (the network's V, in the accent). */
const MARK = '<span class="vb-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 5l7 14 7-14"/></svg></span>';

function rail({ chats, current, signedIn, allowance, query = '', here = null }) {
    const groups = groupChats(chats);
    // The search's own words are never written back into the page (a link could carry anyone's words): the box gets
    // them from the address in the browser, and the results say only what matched in the person's own chats.
    const found = query
        ? (chats.length
            ? `<p class="vb-group">Chats that match</p><ul class="vb-chats">${chats.map((c) => `<li><a class="vb-chat vb-hit" href="/vibe/${esc(c.slug)}"${c.slug === current ? ' aria-current="page"' : ''}><span>${esc(c.name)}</span>${c.hit ? `<small>${snippet(c.hit, query)}</small>` : ''}</a></li>`).join('')}</ul>`
            : '<p class="vb-rail-note">No chat matches your search.</p>') + '<p class="vb-rail-note"><a href="/vibe">All your chats</a></p>'
        : null;
    const list = !signedIn
        ? '<p class="vb-rail-note">Sign in to keep your chats. They are private to you.</p>'
        : found || (groups.length
            ? groups.map((g) => `<p class="vb-group">${esc(g.label)}</p><ul class="vb-chats">${g.chats.map((c) => `<li><a class="vb-chat" href="/vibe/${esc(c.slug)}"${c.slug === current ? ' aria-current="page"' : ''}>${esc(c.name)}</a></li>`).join('')}</ul>`).join('')
            : '<p class="vb-rail-note">Your chats with Vibe show up here.</p>');
    const left = allowance ? Math.max(0, allowance.per_day - allowance.used_today) : null;
    return `<aside class="vb-rail" id="vb-rail" aria-label="Your chats with Vibe">
<div class="vb-rail-top">
<a class="vb-new" href="/vibe">${ICON.new}<span>New chat</span></a>
<button class="vb-icon vb-rail-close" type="button" data-vb-close aria-label="Close the chat list">${ICON.close}</button>
</div>
${signedIn ? `<form class="vb-search" action="/vibe" method="get" role="search">${ICON.search}<label class="oc-sr" for="vb-q">Search your chats</label><input id="vb-q" name="q" type="search" maxlength="${vibe.SEARCH_MAX}" placeholder="Search chats" autocomplete="off" enterkeyhint="search"></form>` : ''}
<nav class="vb-rail-list" aria-label="Chats with Vibe">${list}</nav>
<nav class="vb-rail-more" aria-label="More of OpenVibe.Chat">
<a href="https://openvibe.actor/tasks" title="Every task you gave an agent, one-off or recurring, with what it cost">${ICON.tasks}<span>Tasks</span></a>
<a href="https://openvibe.actor/me/agents" title="Recurring work in plain words: an agent with standing instructions, a memory you can edit, a schedule and quiet hours">${ICON.agents}<span>Your agents</span></a>
${signedIn ? `<a href="/vibe/memory" title="What Vibe remembers about you across your chats: see, add or delete each note"${here === 'memory' ? ' aria-current="page"' : ''}>${ICON.memory}<span>Memory</span></a>` : ''}
<a href="https://openvibe.bot/machines" title="Your computers and robots: pair one, see its screen, set what agents may do on it">${ICON.computer}<span>Computers &amp; robots</span></a>
<a href="/work" title="A room where your team and Vibe work together: a work queue, alerts and a shared screen">${ICON.team}<span>Work together</span></a>
<a href="/messages">${ICON.messages}<span>Messages</span></a>
<a href="/rooms">${ICON.rooms}<span>Rooms and servers</span></a>
<a href="/">${ICON.globe}<span>Global chat</span></a>
</nav>
${left != null ? `<p class="vb-allow" id="vb-allow">${left} of ${allowance.per_day} answers left today</p>` : ''}
</aside>`;
}

/**
 * Under each answer: Copy (shown by vibe.js; it needs the clipboard) and, under the answer to the person's last message,
 * Try again (a form, so it works without JavaScript too).
 */
function acts(slug) {
    return `<div class="vb-acts"><button type="button" class="vb-act" data-vb-copy hidden>Copy</button>${slug ? `<form method="post" action="/vibe/${esc(slug)}/retry" class="vb-retry"><button type="submit" class="vb-act">Try again</button></form>` : ''}</div>`;
}

function turn(m, me, hows = new Map(), retrySlug = null) {
    const ai = !!m.ai_member_id;
    if (ai) return `<li class="vb-turn vb-ai" data-id="${Number(m.id) || 0}">${MARK}<div class="vb-body"><p class="oc-sr">Vibe said:</p><div class="vb-md">${md.render(m.message)}</div>${how.html(hows.get(Number(m.id)))}${acts(retrySlug)}</div></li>`;
    const mine = me && Number(m.user_id) === Number(me.id);
    return `<li class="vb-turn vb-me" data-id="${Number(m.id) || 0}"><div class="vb-bubble"><p class="oc-sr">${mine ? 'You said:' : `${esc(m.display_name || m.username)} said:`}</p>${esc(m.message).replace(/\n/g, '<br>')}${pictures.pageHtml(m.message)}</div></li>`;
}

// The composer's modes (plan track K): Chat answers here and now; the others are agent tasks that answer here when done.
const MODES = [
    ['chat', 'Chat', 'Talk it through: Vibe answers here and now', 'Message Vibe'],
    ['research', 'Research', 'An agent researches it and answers here with its sources', 'What should I research?'],
    ['agent', 'Agent', 'An agent does it on your own computer (OpenVibe.Node), at the level you set there', 'What should I do on your computer?'],
    ['code', 'Code', 'OpenVibe.Codes writes it on your computer and opens a pull request', 'What should I build or fix? Name the repository'],
];

// The text files the attach button takes (read in the browser, vibe.js readText).
const TEXT_FILES = 'text/plain,text/markdown,text/csv,application/json,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.toml,.ini,.html,.css,.js,.mjs,.ts,.py,.go,.rs,.java,.c,.h,.cpp,.rb,.php,.sh,.sql';

function composer({ slug, signedIn, enabled, prefill = '' }) {
    const action = !signedIn ? `/auth/login` : slug ? `/vibe/${esc(slug)}` : '/vibe';
    // A picture (public/web/vibe.js): it goes to OpenVibe.Pics as the person, and Vibe sees it with the question. A text
    // file (notes, a CSV, code) is read in the browser and goes into the message itself.
    const pics = pictures.enabled();
    const label = pics ? 'Add a picture or a text file' : 'Add a text file';
    const attach = signedIn && enabled
        ? `<input type="file" id="vb-file" accept="${pics ? 'image/jpeg,image/png,image/gif,image/webp,image/avif,' : ''}${TEXT_FILES}" hidden><button class="vb-icon vb-attach" type="button" data-vb-attach aria-label="${label}" title="${label}">${ICON.attach}</button>`
        : '';
    return `<div class="vb-preview" id="vb-preview" hidden></div>
<form class="vb-composer" id="vb-composer" method="${signedIn ? 'post' : 'get'}" action="${action}"${signedIn ? '' : ' data-signin="1"'}>
${signedIn ? '' : `<input type="hidden" name="next" value="${slug ? `/vibe/${esc(slug)}` : (prefill ? `/vibe?ask=${encodeURIComponent(prefill)}` : '/vibe')}">`}
${attach}
<label class="oc-sr" for="vb-input">Message Vibe</label>
<textarea id="vb-input" name="message" rows="${prefill ? 3 : 1}" maxlength="12000" placeholder="${signedIn ? 'Message Vibe' : 'Message Vibe (you will sign in first)'}"${enabled ? '' : ' disabled'}${prefill ? ' autofocus' : ''} required>${esc(prefill)}</textarea>
<button class="vb-send" type="submit" aria-label="Send"${enabled ? '' : ' disabled'}>${ICON.send}</button>
<fieldset class="vb-modes" aria-label="What Vibe does with it">${MODES.map(([value, label, hint, placeholder], i) => `<label title="${esc(hint)}"><input type="radio" name="mode" value="${value}" data-placeholder="${esc(placeholder)}"${i ? '' : ' checked'}><span>${label}</span></label>`).join('')}</fieldset>
</form>
<p class="vb-fine">${enabled ? 'Vibe can get things wrong. Check what matters.' : 'Vibe is resting right now. Try again later.'}</p>`;
}

function mountVibePages(router, { page, viewerOf, needUser, sameSite, formLimit, notice }) {
    const allowanceOf = async (user) => ({ per_day: require('../config').ai.vibeRepliesPerDay, used_today: await vibe.repliesToday(user) });

    /**
     * "Ask Vibe" from any OpenVibe site (the shared navbar): ?ask=<the text they selected> and ?from=<the page's https
     * address> fill a new chat's box, never send it. Only the text and an https address of an OpenVibe site are taken.
     */
    function prefillOf(q) {
        const ask = String(q.ask || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1200);
        let from = '';
        try {
            const u = new URL(String(q.from || ''));
            if (u.protocol === 'https:' && /(^|\.)(openvibe\.[a-z]+|openre\.stream)$/.test(u.hostname)) from = `${u.origin}${u.pathname}${u.search}`.slice(0, 400);
        } catch { /* not an address */ }
        if (!ask && !from) return '';
        return [ask ? (from ? `About this, on ${from}:\n\n${ask}` : ask) : `About this page: ${from}\n\n`].join('').slice(0, 2000);
    }

    async function render(req, res, { room = null, status = 200, error = null } = {}) {
        const actor = await viewerOf(req);
        const user = actor.kind === 'user' ? actor.user : null;
        // ?q= from the rail's search box: the person's chats whose name or messages hold it (2 characters or more).
        const query = room ? '' : String((req.query && req.query.q) || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, vibe.SEARCH_MAX);
        const searching = !!user && query.length >= 2;
        const chats = user ? (searching ? await vibe.search(user, query) : await vibe.list(user)) : [];
        const allowance = user ? await allowanceOf(user) : null;
        const messages = room ? await rooms.history(room, { limit: 200 }) : [];
        const hows = room ? await how.forRoom(room) : new Map();   // "How Vibe did this" under agent tasks' answers
        const enabled = vibe.enabled();
        const title = room ? room.name : 'Vibe';
        const waiting = room && messages.length && !messages[messages.length - 1].ai_member_id;
        // Try again goes under the last answer when it answers the person's last message.
        const retryable = room && messages.length > 1 && !!messages[messages.length - 1].ai_member_id && !messages[messages.length - 2].ai_member_id && user && Number(messages[messages.length - 2].user_id) === Number(user.id);
        const hello = `<div class="vb-hello">
${MARK}
<h1>${user ? `What can I help with${user.display_name || user.username ? `, ${esc(String(user.display_name || user.username).split(' ')[0])}` : ''}?` : 'Hi, I\'m Vibe. What can I help with?'}</h1>
<p class="vb-sub">OpenVibe's assistant. I search the web and all of OpenVibe (news, deals, jobs, rentals, videos), read the pages and pictures you share, remember what you ask me to, and set up work that runs every day for you.</p>
<ul class="vb-suggest">${SUGGESTIONS.map((s) => `<li><button type="button" class="vb-chip" data-prompt="${esc(s.prompt)}"><b>${esc(s.title)}</b><span>${esc(s.text)}</span></button></li>`).join('')}</ul>
</div>`;
        const thread = room
            ? `<ol class="vb-thread" id="vb-thread">${messages.map((m, i) => turn(m, user, hows, i === messages.length - 1 && retryable ? room.slug : null)).join('')}${waiting ? `<li class="vb-turn vb-ai vb-wait" id="vb-wait">${MARK}<div class="vb-body"><span class="vb-dots" aria-label="Vibe is writing"><i></i><i></i><i></i></span><noscript><a href="/vibe/${esc(room.slug)}">Refresh to see Vibe's answer</a></noscript></div></li>` : ''}</ol>`
            : '';
        const head = `<header class="vb-head">
<button class="vb-icon vb-menu" type="button" data-vb-open aria-controls="vb-rail" aria-expanded="false" aria-label="Show your chats">${ICON.menu}</button>
${room ? `<h1 class="vb-title" id="vb-title">${esc(title)}</h1>` : `<p class="vb-title" id="vb-title">${esc(title)}</p>`}
${room ? `<details class="vb-actions"><summary class="vb-icon" aria-label="Chat options">${ICON.more}</summary><div class="vb-pop">
<form method="post" action="/vibe/${esc(room.slug)}/rename" class="vb-rename"><label for="vb-name">Name</label><input id="vb-name" name="name" maxlength="${vibe.TITLE_MAX}" value="${esc(room.name)}" required><button type="submit">Rename</button></form>
<form method="post" action="/vibe/${esc(room.slug)}/delete" data-vb-delete><button type="submit" class="vb-danger">Delete this chat</button></form>
</div></details>` : `<a class="vb-icon vb-head-new" href="/vibe" aria-label="New chat">${ICON.new}</a>`}
</header>`;
        const body = `<div class="vb${room ? '' : ' vb-empty'}" id="vb">
${rail({ chats, current: room && room.slug, signedIn: !!user, allowance, query: searching ? query : '' })}
<div class="vb-scrim" data-vb-close hidden></div>
<section class="vb-main" aria-label="${room ? 'Your chat with Vibe' : 'A new chat with Vibe'}">
${head}
<div class="vb-scroll" id="vb-scroll">
${error ? notice('error', error) : ''}
${room ? thread : hello}
</div>
<div class="vb-dock">${composer({ slug: room && room.slug, signedIn: !!user, enabled, prefill: room ? '' : prefillOf(req.query || {}) })}</div>
</section>
</div>`;
        await page(req, res, status, {
            actor, app: true, active: 'vibe', path: room ? `/vibe/${room.slug}` : '/vibe',
            title: room ? `${room.name} · Vibe` : 'Vibe, OpenVibe\'s assistant',
            fullTitle: room ? undefined : 'Vibe: chat with OpenVibe\'s assistant · OpenVibe.Chat',
            description: 'Chat with Vibe, OpenVibe\'s free assistant: it searches news, deals, jobs, rentals and videos across OpenVibe, reads pages you link and helps you think.',
            robots: room ? 'noindex, nofollow' : 'index, follow',
            body,
            page: {
                view: 'vibe', room: room ? room.slug : null, me: user ? user.id : null, latest: messages.length ? messages[messages.length - 1].id : 0,
                waiting: !!waiting, enabled, signedIn: !!user,
            },
        });
    }

    router.get('/vibe', async (req, res) => { await render(req, res); });

    // ── Memory: what Vibe remembers about the person across their chats ──
    const dayOf = (ts) => { const at = atOf(ts); return at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
    async function renderMemory(req, res, actor, { status = 200, error = null, draft = '' } = {}) {
        const user = actor.user;
        const [notes, on, chats, allowance] = await Promise.all([memory.list(user), memory.isOn(user), vibe.list(user), allowanceOf(user)]);
        const body = `<div class="vb" id="vb">
${rail({ chats, current: null, signedIn: true, allowance, here: 'memory' })}
<div class="vb-scrim" data-vb-close hidden></div>
<section class="vb-main" aria-label="What Vibe remembers about you">
<header class="vb-head">
<button class="vb-icon vb-menu" type="button" data-vb-open aria-controls="vb-rail" aria-expanded="false" aria-label="Show your chats">${ICON.menu}</button>
<p class="vb-title" id="vb-title">Memory</p>
<a class="vb-icon vb-head-new" href="/vibe" aria-label="New chat">${ICON.new}</a>
</header>
<div class="vb-scroll" id="vb-scroll">
${error ? notice('error', error) : ''}
<div class="vb-page">
<h1>What Vibe remembers about you</h1>
<p class="vb-sub">Short notes Vibe keeps across your chats with it: what you asked it to remember, or a preference you told it. Only your own chats with Vibe read them, never a room it was added to. It never keeps passwords, keys or card numbers.</p>
<form class="vb-mem-switch" method="post" action="/vibe/memory/switch">
<p><b>${on ? 'Memory is on.' : 'Memory is off.'}</b> ${on ? 'Vibe reads these notes in your chats and can add to them.' : 'Vibe neither reads nor saves notes. The ones below stay until you delete them.'}</p>
<input type="hidden" name="on" value="${on ? '0' : '1'}"><button type="submit" class="vb-btn">${on ? 'Turn memory off' : 'Turn memory on'}</button>
</form>
<form class="vb-mem-add" method="post" action="/vibe/memory">
<label for="vb-note">Add a note</label>
<input id="vb-note" name="text" maxlength="${memory.TEXT_MAX}" placeholder="I am vegetarian. Use kilometres." value="${esc(draft)}" required>
<button type="submit" class="vb-btn vb-btn-primary">Add</button>
</form>
${notes.length ? `<h2 class="vb-group">${notes.length} of ${memory.MAX_NOTES} notes</h2>
<ul class="vb-notes">${notes.map((n) => `<li><p>${esc(n.text)}</p><small>${n.source === 'you' ? 'Added by you' : 'Saved by Vibe'} · ${esc(dayOf(n.created_at))}</small>
<form method="post" action="/vibe/memory/${n.id}/delete"><button type="submit" class="vb-btn vb-btn-quiet" aria-label="Delete the note: ${esc(n.text.slice(0, 60))}">Delete</button></form></li>`).join('')}</ul>
<form method="post" action="/vibe/memory/clear" data-vb-confirm="Delete every note? Vibe forgets them all."><button type="submit" class="vb-btn vb-danger">Forget everything</button></form>`
        : '<p class="vb-rail-note">Nothing yet. Tell Vibe “remember that I…” in a chat, or add a note above.</p>'}
</div>
</div>
</section>
</div>`;
        await page(req, res, status, {
            actor, app: true, active: 'vibe', path: '/vibe/memory', title: 'Memory · Vibe', robots: 'noindex, nofollow', body,
            page: { view: 'vibe', memory: true, room: null, me: user.id, latest: 0, waiting: false, enabled: vibe.enabled(), signedIn: true },
        });
    }

    router.get('/vibe/memory', async (req, res) => {
        const actor = await viewerOf(req);
        if (actor.kind !== 'user') return res.redirect(303, `/auth/login?next=${encodeURIComponent('/vibe/memory')}`);
        await renderMemory(req, res, actor);
    });

    router.post('/vibe/memory', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const text = String((req.body && req.body.text) || '');
        const out = await memory.add(actor.user, text, { source: 'you' });
        if (out.error) return renderMemory(req, res, actor, { status: 422, error: out.error, draft: text.slice(0, memory.TEXT_MAX) });
        res.redirect(303, '/vibe/memory');
    });

    router.post('/vibe/memory/switch', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        await memory.setOn(actor.user, String((req.body && req.body.on) || '') === '1');
        res.redirect(303, '/vibe/memory');
    });

    router.post('/vibe/memory/clear', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        await memory.clear(actor.user);
        res.redirect(303, '/vibe/memory');
    });

    router.post('/vibe/memory/:id/delete', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        await memory.remove(actor.user, req.params.id);
        res.redirect(303, '/vibe/memory');
    });

    router.get('/vibe/:slug', async (req, res) => {
        const actor = await viewerOf(req);
        if (actor.kind !== 'user') return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (!room) return render(req, res, { status: 404, error: 'That chat is not here: it may have been deleted. Start a new one below.' });
        await render(req, res, { room });
    });

    router.post('/vibe', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        try {
            const b = req.body || {};
            const out = b.mode && b.mode !== 'chat' ? await vibe.startWork(actor.user, b.message, b.mode) : await vibe.start(actor.user, b.message);
            res.redirect(303, `/vibe/${out.room.slug}`);
        } catch (err) {
            await render(req, res, { status: err.status || 500, error: err.status ? err.message : 'Something went wrong. Try again.' });
        }
    });

    router.post('/vibe/:slug', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (!room) return res.redirect(303, '/vibe');
        try {
            const b = req.body || {};
            if (b.mode && b.mode !== 'chat') await vibe.work(room, actor.user, b.message, b.mode);
            else {
                const message = await rooms.post(room, actor.user, b.message);
                require('../chat/chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
            }
            res.redirect(303, `/vibe/${room.slug}`);
        } catch (err) {
            await render(req, res, { room, status: err.status || 500, error: err.status ? err.message : 'Your message could not be sent.' });
        }
    });

    router.post('/vibe/:slug/rename', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (!room) return res.redirect(303, '/vibe');
        try { await vibe.rename(room, actor.user, req.body && req.body.name); res.redirect(303, `/vibe/${room.slug}`); } catch (err) { await render(req, res, { room, status: err.status || 500, error: err.message }); }
    });

    router.post('/vibe/:slug/retry', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (!room) return res.redirect(303, '/vibe');
        try { await vibe.retry(room, actor.user); res.redirect(303, `/vibe/${room.slug}`); } catch (err) { await render(req, res, { room, status: err.status || 500, error: err.status ? err.message : 'That did not work. Try again in a minute.' }); }
    });

    router.post('/vibe/:slug/delete', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (room) await vibe.remove(room, actor.user);
        res.redirect(303, '/vibe');
    });
}

module.exports = { mountVibePages, groupChats, SUGGESTIONS };
