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
const compare = require('../rooms/vibe-compare');
const workspace = require('../rooms/workspace');
const how = require('../rooms/how');
const memory = require('../rooms/vibe-memory');
const { esc } = require('./layout');
const kit = require('openvibe-shared/kit');
const thread = require('openvibe-shared/thread');

const SUGGESTIONS = [
    { title: 'Explain a concept', prompt: 'Explain a concept I am curious about in plain English.' },
    { title: 'Help me write', prompt: 'Help me write a clear, friendly message.' },
    { title: 'Compare ideas', prompt: 'Give me two ways to approach this idea and their tradeoffs.' },
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
    // The network's one sidebar (openvibe-shared kit.sidebar, plan L35; the conversation kit's, L55 C4): New chat, the
    // search, Vibe's places as rows, then the chats by when they last moved. A drawer on a phone (kit-web.js).
    // The search's own words are never written back into the page (a link could carry anyone's words): the box gets
    // them from the address in the browser, and the results say only which of the person's own chats matched.
    const item = (c) => ({ href: `/vibe/${c.slug}`, label: c.name, here: c.slug === current });
    let sections;
    if (!signedIn) sections = [{ title: '', items: [], empty: 'Sign in to keep your chats. They are private to you.' }];
    else if (query) {
        sections = chats.length ? [{ title: 'Chats that match', items: chats.map(item) }] : [{ title: '', items: [], empty: 'No chat matches your search.' }];
        sections.push({ title: '', items: [{ href: '/vibe', label: 'All your chats' }] });
    } else {
        const groups = groupChats(chats);
        sections = groups.length ? groups.map((g) => ({ title: g.label, items: g.chats.map(item) })) : [{ title: '', items: [], empty: 'Your chats with Vibe show up here.' }];
    }
    const left = allowance ? Math.max(0, allowance.per_day - allowance.used_today) : null;
    const own = allowance && allowance.engine && allowance.engine.own ? allowance.engine : null;   // Vibe on their own model
    const allow = own ? `<p class="vb-allow" id="vb-allow" data-own="1">No daily limit: Vibe thinks with ${esc(own.you)}</p>`
        : left != null ? `<p class="vb-allow" id="vb-allow">${left} of ${allowance.per_day} answers left today</p>` : '';
    // Chat's other places, quietly at the foot (the network's navbar reaches them too).
    const more = [['https://openvibe.link/machines', 'Computers & robots'], ['/work', 'Work together'], ['/messages', 'Messages'], ['/rooms', 'Rooms and servers'], ['/', 'Global chat']];
    const html = kit.sidebar({
        id: 'vb-rail', label: 'Your chats with Vibe',
        action: { href: '/vibe', label: 'New chat', icon: 'pencil' },
        find: signedIn ? { action: '/vibe', name: 'q', placeholder: 'Search chats', label: 'Search your chats' } : null,
        nav: [
            { href: 'https://openvibe.actor/tasks', label: 'Tasks', icon: 'list' },
            { href: 'https://openvibe.actor/me/agents', label: 'Your agents', icon: 'robot' },
            ...(signedIn ? [{ href: '/vibe/memory', label: 'Memory', icon: 'book', here: here === 'memory' }] : []),
        ],
        sections,
        foot: `<p class="ovt-side-foot">${more.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join('')}</p>${allow}`,
    });
    if (!query) return html;
    // A search: under each chat that matched, where it matched (the person's own words or Vibe's), the match marked.
    return chats.reduce((out, c) => (c.hit ? out.replace(
        new RegExp(`<a class="ovk-sidebar-item( is-here)?" href="/vibe/${c.slug}"([^>]*)><span class="ovk-sidebar-t">([^<]*)</span>`),
        (m, here, rest, name) => `<a class="ovk-sidebar-item vb-hit${here || ''}" href="/vibe/${c.slug}"${rest}><span class="ovk-sidebar-t">${name}</span><small class="vb-hit-s">${snippet(c.hit, query)}</small>`,
    ) : out), html);
}

/**
 * Under each answer: Copy (shown by ov-thread.js where the clipboard works) and, under the answer to the person's last
 * message, Try again (a form, so it works without JavaScript too).
 */
function acts(slug) {
    return `<div class="ovt-meta"><span class="ovt-acts"><button type="button" class="ovt-act" data-ovt-copy hidden>${thread.icon('copy')}<span>Copy</span></button>${slug ? `<form method="post" action="/vibe/${esc(slug)}/retry" class="vb-retry"><button type="submit" class="ovt-act">Try again</button></form>` : ''}</span></div>`;
}

const RES_ICON = {
    reminder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    timer: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>',
};
/**
 * What Vibe did in this answer (plan L48 V2; Chat's results on the message, rooms/vibe-results.js): a chip for each
 * reminder or timer it set or stopped. Undo is a plain form (it works without JavaScript) for a day; Open goes to
 * the person's reminders on Today. An undone one says "stopped" and offers nothing more.
 */
function resultChips(m, slug) {
    const list = require('../rooms/vibe-results').list(m.results);
    if (!list.length) return '';
    const young = Date.now() - atOf(m.created_at) < DAY;
    return `<div class="vb-res">${list.slice(0, 4).map((r, i) => {
        if (r.kind !== 'reminder' && r.kind !== 'timer') return '';
        const set = r.action === 'set';
        const what = r.kind === 'timer' ? (set ? 'Timer' : 'Timer stopped') : (set ? 'Reminder set' : 'Reminder stopped');
        const undo = set && young && slug ? `<form method="post" action="/vibe/${esc(slug)}/undo"><input type="hidden" name="message_id" value="${Number(m.id) || 0}"><input type="hidden" name="index" value="${i}"><button type="submit" class="vb-act">Undo</button></form>` : '';
        const open = r.url && /^https:\/\//.test(r.url) ? `<a class="vb-act" href="${esc(r.url)}">Open</a>` : '';
        return `<div class="vb-res-c${set ? '' : ' is-stopped'}">${RES_ICON[r.kind]}<div class="vb-res-t"><b>${what}:</b> ${esc(r.title || '')}${r.when && set ? `<small>${esc(r.when)}</small>` : ''}</div>${undo || open ? `<div class="vb-res-a">${undo}${open}</div>` : ''}</div>`;
    }).join('')}</div>`;
}

/** What the person said, for their bubble: their words (the bubble keeps line breaks) and any picture. */
function youOf(m, me) {
    const mine = me && Number(m.user_id) === Number(me.id);
    return { html: `<span class="oc-sr">${mine ? 'You said:' : `${esc(m.display_name || m.username)} said:`}</span>${esc(m.message)}${pictures.pageHtml(m.message)}` };
}
/** Vibe's answer: the rendered Markdown, what it did (reminders, timers), its sources and how, then Copy and Try again. */
function answerOf(m, hows, retrySlug, slug) {
    const info = hows.get(Number(m.id));
    return `<p class="oc-sr">Vibe said:</p>${m.vibe_model ? `<p class="vb-import-model">${esc(m.vibe_model)}</p>` : ''}${thread.answer({ html: md.render(m.message), copy: false })}${resultChips(m, slug)}${how.chips(info, m.id)}${how.html(info, m.id)}${acts(retrySlug)}`;
}
function compareOf(asked, answers) {
    return `<div class="vb-compare" data-vb-question="${Number(asked.id)}"><div class="vb-compare-tabs" role="tablist" aria-label="Models">${answers.map((a, i) => `<button type="button" role="tab" class="vb-compare-tab${i ? '' : ' is-active'}" data-vb-tab="${i}" aria-selected="${i ? 'false' : 'true'}">${esc(a.model)} <span aria-hidden="true">${a.status === 'finished' ? '●' : '○'}</span></button>`).join('')}</div><div class="vb-compare-grid">${answers.map((a, i) => `<section class="vb-compare-answer${i ? '' : ' is-active'}" data-vb-answer="${i}"><header><strong>${esc(a.model)}</strong><small>${a.provider ? `${esc(a.provider)} · ` : ''}${a.cost_usd == null ? '' : `$${Number(a.cost_usd).toFixed(4)} · `}${a.ms == null ? '' : `${(Number(a.ms) / 1000).toFixed(1)}s`}</small></header><div class="vb-compare-text" data-vb-text>${a.status === 'writing' ? '<span class="vb-pulse" aria-hidden="true"></span>Writing…' : a.status === 'failed' ? esc(a.error || 'Could not answer') : md.render(a.text)}</div><div class="vb-compare-actions"><button type="button" data-vb-copy="${i}">Copy</button><button type="button" data-vb-pick="${esc(a.model)}" data-vb-message="${Number(asked.id)}">Continue with this one</button><button type="button" data-vb-prefer="${esc(a.model)}" data-vb-message="${Number(asked.id)}">This one was better</button></div></section>`).join('')}</div></div>`;
}
/** Vibe writing: the live line, open (ov-thread.js and vibe.js follow it). */
const WRITING = thread.work({ open: true, live: 'Vibe is writing' });
/**
 * The chat as turns: each message of the person's with the answer that follows it. data-me / data-ai carry the two
 * message ids, so a message that arrives over the socket is never drawn twice.
 */
function turnsOf(messages, me, hows, { retrySlug = null, slug = null, waiting = false } = {}) {
    const specs = [];
    for (const [i, m] of messages.entries()) {
        const last = i === messages.length - 1;
        if (m.ai_member_id) {
            const reply = answerOf(m, hows, last ? retrySlug : null, slug);
            const open = specs[specs.length - 1];
            if (open && open.reply == null) { open.reply = reply; open.ai = m.id; }
            else specs.push({ reply, ai: m.id });
        } else specs.push({ you: youOf(m, me), me: m.id, reply: m.compareAnswers ? compareOf(m, m.compareAnswers) : null });
    }
    const tail = specs[specs.length - 1];
    if (waiting && tail && tail.reply == null) { tail.reply = WRITING; tail.open = true; }
    return specs.map((t) => thread.turn({ you: t.you || {}, reply: t.reply, open: !!t.open, attrs: { 'data-me': t.me, 'data-ai': t.ai } }));
}

// The composer's modes (plan track K): Chat answers here and now; the others are agent tasks that answer here when done.
const MODES = [
    ['chat', 'Chat', 'Talk it through: Vibe answers here and now', 'Message Vibe'],
    ['research', 'Research', 'An agent researches it and answers here with its sources', 'What should I research?'],
    ['agent', 'Agent', 'An agent does it on your own computer (OpenVibe Link), at the level you set there', 'What should I do on your computer?'],
    ['code', 'Code', 'OpenVibe.Codes writes it on your computer and opens a pull request', 'What should I build or fix? Name the repository'],
];

// The text files the attach button takes (read in the browser, vibe.js readText).
const TEXT_FILES = 'text/plain,text/markdown,text/csv,application/json,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.toml,.ini,.html,.css,.js,.mjs,.ts,.py,.go,.rs,.java,.c,.h,.cpp,.rb,.php,.sh,.sql';

function composer({ slug, signedIn, enabled, prefill = '', engine = null, models = [] }) {
    const action = !signedIn ? `/auth/login` : slug ? `/vibe/${esc(slug)}` : '/vibe';
    // A picture (public/web/vibe.js): it goes to OpenVibe.Pics as the person, and Vibe sees it with the question. A text
    // file (notes, a CSV, code) is read in the browser and goes into the message itself.
    const pics = pictures.enabled();
    const label = pics ? 'Add a picture or a text file' : 'Add a text file';
    const attach = signedIn && enabled
        ? `<button class="ovt-btn vb-attach" type="button" data-vb-attach aria-label="${label}" title="${label}">${ICON.attach}</button>
<dialog class="ovk-sheet vb-upload" data-vb-upload-dialog aria-labelledby="vb-upload-h"><div class="ovk-sheet-head" data-ov-sheet-head><h2 id="vb-upload-h">${pics ? 'Add a picture or a text file' : 'Add a text file'}</h2><button type="button" class="ovk-icon-btn" data-vb-upload-close aria-label="Close">${thread.icon('close')}</button></div><div class="ovk-sheet-body"><div data-vb-upload data-accept="${pics ? 'image/jpeg,image/png,image/gif,image/webp,image/avif,' : ''}${TEXT_FILES}"></div></div></dialog>`
        : '';
    const offeredModes = require('../config').ai.vibeDoIt ? MODES : MODES.slice(0, 1);
    const modes = `<fieldset class="vb-modes" aria-label="What Vibe does with it">${offeredModes.map(([value, label, hint, placeholder], i) => `<label title="${esc(hint)}"><input type="radio" name="mode" value="${value}" data-placeholder="${esc(placeholder)}"${i ? '' : ' checked'}><span>${label}</span></label>`).join('')}</fieldset>`;
    const fine = !enabled ? 'Vibe is resting right now. Try again later.' : engine && engine.own ? `Vibe thinks with ${esc(engine.you)} (<a href="/settings#oc-ai-key">change</a>). It can get things wrong: check what matters.` : 'Vibe can get things wrong. Check what matters.';
    let html = thread.composer({
        action, method: signedIn ? 'post' : 'get', name: 'message', id: 'vb-composer', attrs: signedIn ? {} : { 'data-signin': '1' },
        label: 'Message Vibe', placeholder: signedIn ? 'Message Vibe' : 'Message Vibe (you will sign in first)', value: prefill, maxlength: 12000,
        hidden: signedIn ? {} : { next: slug ? `/vibe/${slug}` : (prefill ? `/vibe?ask=${encodeURIComponent(prefill)}` : '/vibe') },
        top: `<div class="vb-model-picker"><button type="button" class="vb-model-chip" id="vb-model-chip" aria-haspopup="dialog" aria-expanded="false">${models.length > 1 ? `${models.length} models` : models[0] ? esc(models[0]) : 'Auto'} ▾</button><div class="vb-model-sheet" id="vb-model-sheet" role="dialog" aria-label="Choose models" hidden><div class="vb-model-sheet-head"><strong>Choose a model</strong><button type="button" id="vb-model-close" aria-label="Close model list">✕</button></div><label class="vb-model-compare"><input type="checkbox" id="vb-model-compare"> Compare models</label><div id="vb-model-list"><p>Loading models…</p></div><details><summary>Settings</summary><label>System prompt<textarea id="vb-system-prompt" maxlength="4000"></textarea></label><label>Temperature<input id="vb-temperature" type="number" min="0" max="2" step="0.1" value="1"></label></details><p class="vb-model-floor">The floor holds on every model: <a href="https://openvibe.network/rules">the rules</a></p></div></div><div class="vb-preview" id="vb-preview" hidden></div><div class="vb-progress" data-vb-progress hidden></div>`, tools: attach + modes,
        // Stop is drawn hidden: vibe.js shows it while Vibe writes, and it keeps what was written so far.
        stopAction: signedIn ? '' : null,
        foot: `<p class="vb-fine">${fine}</p>`,
    });
    // A box filled from "Ask Vibe" is where the cursor goes, script or not.
    if (prefill) html = html.replace('data-ovt-text', 'data-ovt-text autofocus');
    if (!enabled) html = html.replace('data-ovt-text', 'data-ovt-text disabled').replace('data-ovt-send aria-label', 'data-ovt-send disabled aria-label');
    return html;
}

function mountVibePages(router, { page, viewerOf, needUser, sameSite, formLimit, notice }) {
    const allowanceOf = async (user) => {
        // Which model Vibe thinks with: the person's own key or computer when they chose it (no daily limit then).
        let engine = null;
        try { engine = await vibe.engineOf(user); } catch { engine = null; }
        return { per_day: require('../config').ai.vibeRepliesPerDay, used_today: await vibe.repliesToday(user), engine };
    };

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
        const compareAnswers = room ? await compare.answers(room, messages.filter((m) => !m.ai_member_id).map((m) => Number(m.id))) : new Map();
        for (const m of messages) if (compareAnswers.has(Number(m.id))) m.compareAnswers = compareAnswers.get(Number(m.id));
        const modelSettings = room ? await compare.settings(room) : { models: [] };
        const hows = room ? await how.forRoom(room) : new Map();   // "How Vibe did this" under agent tasks' answers
        // The agent's canvas beside the chat (plan HO9): only when the newest task in the chat is Actor's, because
        // that task's thread is the conversation the panel belongs to. The browser reads the document itself with
        // the person's own token (OpenVibe.Actor allows that one read from openvibe.chat), so a signed-out or refused
        // read simply draws nothing.
        const canvas = room && user ? await workspace.newestActor(room, user) : null;
        const enabled = vibe.enabled();
        const title = room ? room.name : 'Vibe';
        const waiting = room && messages.length && !messages[messages.length - 1].ai_member_id && !messages[messages.length - 1].compareAnswers;
        // Try again goes under the last answer when it answers the person's last message.
        const retryable = room && messages.length > 1 && !!messages[messages.length - 1].ai_member_id && !messages[messages.length - 2].ai_member_id && user && Number(messages[messages.length - 2].user_id) === Number(user.id);
        const hello = `<div class="vb-hello">
${user ? '<div class="vb-import" id="vb-import" hidden></div>' : ''}
${MARK}
<h1>Ask anything</h1>
<p class="vb-sub">One model, or up to three side by side</p>
<ul class="vb-suggest">${SUGGESTIONS.map((s) => `<li><button type="button" class="vb-chip" data-prompt="${esc(s.prompt)}"><b>${esc(s.title)}</b></button></li>`).join('')}</ul>
</div>`;
        const head = thread.head({
            title: room ? title : '', sidebar: 'vb-rail', sidebarLabel: 'Show your chats',
            actions: room ? `<details class="vb-actions"><summary class="ovt-btn" aria-label="Chat options">${ICON.more}</summary><div class="vb-pop">
<form method="post" action="/vibe/${esc(room.slug)}/rename" class="vb-rename"><label for="vb-name">Name</label><input id="vb-name" name="name" maxlength="${vibe.TITLE_MAX}" value="${esc(room.name)}" required><button type="submit">Rename</button></form>
<form method="post" action="/vibe/${esc(room.slug)}/delete" data-vb-delete><button type="submit" class="vb-danger">Delete this chat</button></form>
</div></details>` : '',
        });
        const turns = room ? turnsOf(messages, user, hows, { retrySlug: retryable ? room.slug : null, slug: room.slug, waiting: !!waiting }) : [];
        const problem = error ? notice('error', error) : '';
        const body = `<div class="vbk" id="vb">${thread.page({
            sidebar: rail({ chats, current: room && room.slug, signedIn: !!user, allowance, query: searching ? query : '' }),
            head,
            turns: problem && room ? [thread.turn({ avatar: false, reply: problem }), ...turns] : turns,
            empty: problem + hello,
            composer: composer({ slug: room && room.slug, signedIn: !!user, enabled, prefill: room ? '' : prefillOf(req.query || {}), engine: allowance && allowance.engine, models: modelSettings.models }),
            center: !room, label: room ? 'Your chat with Vibe' : 'A new chat with Vibe',
        })}</div>`;
        await page(req, res, status, {
            actor, app: true, kit: true, upload: true, canvas: !!room, active: 'vibe', path: room ? `/vibe/${room.slug}` : '/vibe',
            title: room ? `${room.name} · Vibe` : 'Vibe, OpenVibe\'s assistant',
            fullTitle: room ? undefined : 'Vibe: chat with OpenVibe\'s assistant · OpenVibe.Chat',
            description: 'Chat with Vibe, OpenVibe\'s free assistant: it searches news, deals, jobs, rentals and videos across OpenVibe, reads pages you link and helps you think.',
            robots: room ? 'noindex, nofollow' : 'index, follow',
            body,
            page: {
                view: 'vibe', room: room ? room.slug : null, me: user ? user.id : null, latest: messages.length ? messages[messages.length - 1].id : 0,
                waiting: !!waiting, enabled, signedIn: !!user, models: modelSettings.models,
                system_prompt: modelSettings.system_prompt, temperature: modelSettings.temperature,
                canvas: canvas ? { thread: canvas.thread, task: canvas.id, status: canvas.status } : null,
            },
        });
    }

    router.get('/vibe', async (req, res) => { await render(req, res); });

    // ── Memory: what Vibe remembers about the person across their chats ──
    const dayOf = (ts) => { const at = atOf(ts); return at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
    async function renderMemory(req, res, actor, { status = 200, error = null, draft = '' } = {}) {
        const user = actor.user;
        const [notes, on, chats, allowance] = await Promise.all([memory.list(user), memory.isOn(user), vibe.list(user), allowanceOf(user)]);
        const body = `<div class="vbk" id="vb">${thread.page({
            sidebar: rail({ chats, current: null, signedIn: true, allowance, here: 'memory' }),
            head: thread.head({ title: '', sidebar: 'vb-rail', sidebarLabel: 'Show your chats', newHref: '/vibe' }),
            label: 'What Vibe remembers about you', cls: 'is-page',
            main: `${error ? notice('error', error) : ''}<div class="vb-page">
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
</div>`,
        })}</div>`;
        await page(req, res, status, {
            actor, app: true, kit: true, active: 'vibe', path: '/vibe/memory', title: 'Memory · Vibe', robots: 'noindex, nofollow', body,
            page: { view: 'vibe', memory: true, room: null, me: user.id, latest: 0, waiting: false, enabled: vibe.enabled(), signedIn: true },
        });
    }

    router.get('/vibe/memory', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
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
        const actor = await needUser(req, res); if (!actor) return;
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

    // Undo what Vibe did (a reminder or a timer it set), from the chip under its answer: the person's own chat only, a
    // day at most (rooms/vibe-results.js undo checks both, and that it was not undone already).
    router.post('/vibe/:slug/undo', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (!room) return res.redirect(303, '/vibe');
        const b = req.body || {};
        try {
            await require('../rooms/vibe-results').undo({ messageId: Number(b.message_id), index: Number(b.index), user: actor.user });
            res.redirect(303, `/vibe/${room.slug}`);
        } catch (err) {
            await render(req, res, { room, status: err.status || 500, error: err.status ? err.message : 'That could not be undone. Try again in a moment.' });
        }
    });

    router.post('/vibe/:slug/delete', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await vibe.ownChat(req.params.slug, actor.user);
        if (room) await vibe.remove(room, actor.user);
        res.redirect(303, '/vibe');
    });
}

module.exports = { mountVibePages, groupChats, SUGGESTIONS };
