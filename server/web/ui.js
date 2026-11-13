'use strict';
/**
 * Pieces every working page on openvibe.chat shares (the owner, 2026-10-28: "icon buttons … so much wasted space … the
 * alignment's kind of bad … not a focus on the real content"): one compact page header with its actions as icons, times
 * people read at a glance, and a person's initials when there is no picture.
 *
 *   head({ title, sub, back, actions, avatar })  <header class="oc-page-head">: back icon, avatar, title and one muted line, icon actions
 *   when(ts, now)                          { iso, text }: 14:05 today, Yesterday, Mon this week, Oct 20 this year, else 2025-10-20
 *   initials(name, presence)               a round mark with up to two letters, its colour from the name, and the
 *                                          Network presence dot (Shared's .ovp-dot look) when there is a visible state
 *   hueOf(slug) / serverMark(server)       a server's steady hue, and its rounded-square mark in a list row (the same
 *                                          colour as in the server rail, wherever the server is listed)
 */
const { esc } = require('./layout');
const { ICONS } = require('./icons');

function head({ title, sub = '', back = null, actions = [], avatar = '' }) {
    return `<header class="oc-page-head">
${back ? `<a class="oc-icon-btn oc-back" href="${esc(back.href)}" aria-label="${esc(back.label)}" title="${esc(back.label)}">${ICONS.back}</a>` : ''}${avatar}<div class="oc-page-id"><h1>${title}</h1>${sub ? `<p class="oc-page-sub">${sub}</p>` : ''}</div>
${actions.length ? `<div class="oc-page-tools">${actions.join('')}</div>` : ''}
</header>`;
}

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function when(ts, now = Date.now()) {
    const s = String(ts || '');
    const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
    if (!Number.isFinite(t)) return { iso: '', text: '' };
    const d = new Date(t);
    const startToday = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    let text;
    if (t >= startToday) text = d.toISOString().slice(11, 16);
    else if (t >= startToday - DAY) text = 'Yesterday';
    else if (t >= startToday - 6 * DAY) text = WEEKDAYS[d.getUTCDay()];
    else if (d.getUTCFullYear() === new Date(now).getUTCFullYear()) text = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    else text = d.toISOString().slice(0, 10);
    return { iso: d.toISOString(), text };
}

// ── Presence (network.presence@1) ──
// The same look as openvibe-shared/presence.js .ovp-dot: 11 px (14 px in a page header), bottom-right, a 2.5 px
// ring in the surface behind it; online solid, away a crescent, dnd a bar, live solid red. Offline and invisible
// are the absence of a dot: never a grey one on someone else's picture.
const PRESENCE = {
    online: { label: 'Online', a11y: 'online', color: '#22c55e' },
    away: { label: 'Away', a11y: 'away', color: '#f59e0b' },
    dnd: { label: 'Do not disturb', a11y: 'do not disturb', color: '#ef4444' },
    live: { label: 'Live now', a11y: 'live', color: '#ef4444' },
};
/** The state the dot draws, or null when the person is offline/invisible/unknown. */
function presenceState(presence) {
    if (!presence) return null;
    const state = presence.live ? 'live' : String(presence.state || '');
    return PRESENCE[state] ? state : null;
}
/** The dot itself (aria-hidden; the avatar carries the accessible state). */
function presenceDot(presence) {
    const state = presenceState(presence);
    if (!state) return '';
    return `<span class="oc-pdot" data-state="${state}" style="--ovp:${PRESENCE[state].color}" aria-hidden="true"></span>`;
}
/** A member list's order: online and live first, then away/dnd, then everyone else. */
function presenceOrder(presence) {
    const state = presenceState(presence);
    return state === 'online' || state === 'live' ? 0 : state === 'away' || state === 'dnd' ? 1 : 2;
}
/**
 * A channel link never carries a section: openvibe.live/@name#about is the channel page, and the address a live
 * presence link hands over is /@name (ask 285). A relative /@name stays relative; any other link is untouched.
 */
function channelHref(href) {
    if (typeof href !== 'string') return href;
    let u;
    try { u = new URL(href, 'https://openvibe.live'); } catch { return href; }
    if (u.origin !== 'https://openvibe.live' || !/^\/@[A-Za-z0-9_]{3,24}\/?$/.test(u.pathname)) return href;
    const clean = `/@${u.pathname.slice(2).replace(/\/$/, '')}`;
    return /^https:\/\//i.test(href) ? `https://openvibe.live${clean}` : clean;
}

/** "Online", "Live now" and — when there is one — " · their status line". Nothing for offline. */
function presenceLine(presence, { liveHref = null } = {}) {
    const state = presenceState(presence);
    if (!state) return '';
    const label = esc(PRESENCE[state].label);
    const cleaned = channelHref(liveHref);
    const href = typeof cleaned === 'string' && (/^https:\/\//i.test(cleaned) || /^\/(?!\/)/.test(cleaned)) ? cleaned : null;
    const shown = state === 'live' && href ? `<a href="${esc(href)}">${label}</a>` : label;
    return `${shown}${presence.status_text ? ` · ${esc(String(presence.status_text).slice(0, 80))}` : ''}`;
}

function initials(name, presence = null, { large = false, id = '', avatarUrl = '' } = {}) {
    const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    const cls = `oc-av${large ? ' oc-av-lg' : ''}`;
    const idAttr = id ? ` id="${esc(id)}"` : '';
    const state = presenceState(presence);
    let photo = '';
    try { const u = new URL(String(avatarUrl || '')); if (u.protocol === 'https:' && u.hostname.toLowerCase() === 'openvibe.media') photo = `<img src="${esc(u.href)}" alt="" loading="lazy" referrerpolicy="no-referrer">`; } catch { /* initials are the fallback */ }
    const content = photo || esc(letters);
    if (!state) return `<span class="${cls}" style="--av:${h}"${idAttr} aria-hidden="true">${content}</span>`;
    return `<span class="${cls}" style="--av:${h}"${idAttr} role="img" aria-label="${esc(`${String(name || '?')}, ${PRESENCE[state].a11y}`)}">${content}${presenceDot(presence)}</span>`;
}

/** An https address a card may link to; anything else (javascript:, http:, a relative path) is no link. */
function cardHref(value) {
    try {
        const u = new URL(String(value || ''));
        return u.protocol === 'https:' ? u.href : null;
    } catch { return null; }
}
/** A card's picture: only https on openvibe.media, as the resolver also enforces. */
function cardImage(value) {
    try {
        const u = new URL(String(value || ''));
        return u.protocol === 'https:' && !u.port && u.hostname.toLowerCase() === 'openvibe.media' ? u.href : null;
    } catch { return null; }
}
/**
 * A known OpenVibe link's card under its message (server/chat/link-cards.js): the picture when there is one, the
 * title, one line, and the one move as a button. Every string is data: escaped here. Null is no markup.
 */
function linkCard(card) {
    if (!card || typeof card !== 'object') return '';
    const title = typeof card.title === 'string' ? card.title : '';
    if (!title) return '';
    const href = cardHref(card.url);
    const action = card.action && typeof card.action.label === 'string' && card.action.label ? card.action : null;
    const actionHref = action && cardHref(action.href);
    const image = cardImage(card.image);
    const line = typeof card.line === 'string' && card.line ? card.line : '';
    const note = typeof card.note === 'string' && card.note ? card.note : '';
    const head = href
        ? `<a class="oc-card-title" href="${esc(href)}" rel="noopener nofollow" target="_blank">${esc(title)}</a>`
        : `<span class="oc-card-title">${esc(title)}</span>`;
    const pic = image ? `<a class="oc-card-pic" href="${esc(href || image)}" rel="noopener nofollow" target="_blank"><img src="${esc(image)}" alt="" loading="lazy" decoding="async"></a>` : '';
    const go = actionHref ? `<a class="oc-card-go" href="${esc(actionHref)}" rel="noopener nofollow" target="_blank">${esc(action.label)}</a>` : '';
    return `<div class="oc-card" data-kind="${esc(typeof card.kind === 'string' ? card.kind : 'link')}">${pic}<div class="oc-card-body">${head}${line ? `<p class="oc-card-line">${esc(line)}</p>` : ''}${note ? `<p class="oc-card-note">${esc(note)}</p>` : ''}${go}</div></div>`;
}

/**
 * The small × that takes a message's cards back, and the button that puts them back (server/rooms/routes.js).
 * Only the message's author and the room's moderators get them: the page decides who may (server/web/pages.js).
 */
function hideForm(action) {
    if (!action) return '';
    return `<form class="oc-card-hide" method="post" action="${esc(action)}"><input type="hidden" name="hidden" value="1"><button type="submit" class="oc-card-hide-btn" aria-label="Hide the preview" title="Hide the preview">×</button></form>`;
}
function showForm(action) {
    if (!action) return '';
    return `<form class="oc-inline oc-card-show" method="post" action="${esc(action)}"><input type="hidden" name="hidden" value="0"><button type="submit" class="oc-link">Show previews</button></form>`;
}

/**
 * An address preview under a message (server/chat/link-previews.js): the picture when there is one, the address's
 * title as the link, its description, and "by" and LIVE for OpenVibe's own kinds. Every field is data: escaped here.
 */
function embedCard(e, opts) {
    if (!e || typeof e !== 'object' || typeof e.title !== 'string' || !e.title) return '';
    if (e.kind === 'agent-run') {
        const run = String(e.run_url || ''), events = String(e.events_url || '');
        const trusted = /^https:\/\/openvibe\.network\/api\/frame\/(?:codes-runs|agent-runs\/actor)\/tsk_[0-9A-HJKMNP-TV-Z]{26}(?:~[1-9][0-9]*)?$/;
        const href = /^https:\/\/openvibe\.(?:actor\/tasks|codes\/run\/tasks)\/tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(e.url || '')) ? e.url : null;
        if (!trusted.test(run) || events !== `${run}/events`) return '';
        return `<div class="oc-agent-run" data-ov-run-url="${esc(run)}" data-ov-events-url="${esc(events)}" data-ov-run-title="${esc(e.title)}">${href ? `<a href="${esc(href)}" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>`;
    }
    const href = cardHref(e.url);
    const image = cardImage(e.image);
    const kind = ['link', 'video', 'image', 'live', 'picture', 'design', 'post', 'profile', 'game'].includes(e.kind) ? e.kind : 'link';
    const head = href
        ? `<a class="oc-card-title" href="${esc(href)}" rel="noopener nofollow" target="_blank">${esc(e.title)}</a>`
        : `<span class="oc-card-title">${esc(e.title)}</span>`;
    const pic = image ? `<a class="oc-card-pic" href="${esc(href || image)}" rel="noopener nofollow" target="_blank"><img src="${esc(image)}" alt="" loading="lazy" decoding="async"></a>` : '';
    const description = typeof e.description === 'string' && e.description ? `<p class="oc-card-line">${esc(e.description)}</p>` : '';
    const by = typeof e.by === 'string' && e.by ? `<p class="oc-card-line">by ${esc(e.by)}</p>` : '';
    const live = e.live === true ? '<p class="oc-card-note"><span class="oc-badge oc-badge-mod">LIVE</span></p>' : '';
    const hide = opts && opts.hide ? hideForm(opts.hide) : '';
    return `<div class="oc-card" data-kind="${esc(kind)}">${pic}<div class="oc-card-body">${head}${description}${by}${live}</div>${hide}</div>`;
}

/** A message's previews (up to three, in the order the addresses appeared), or its one known-link card when it has none. */
function messageCards(m, opts) {
    if (!m || typeof m !== 'object') return '';
    if (Array.isArray(m.embeds) && m.embeds.length) return m.embeds.slice(0, 3).map((e) => embedCard(e, opts)).filter(Boolean).join('');
    return m.card && m.card.kind === 'agent-run' ? embedCard(m.card) : linkCard(m.card);
}

const hueOf = (slug) => { let h = 0; for (const c of String(slug)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const serverLetters = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const serverMark = (s) => `<span class="oc-srv-icon oc-srv-icon--row" style="--oc-hue:${hueOf(s.slug)}" aria-hidden="true">${esc(serverLetters(s.name))}</span>`;

module.exports = { head, when, initials, presenceState, presenceDot, presenceOrder, presenceLine, hueOf, serverLetters, serverMark, linkCard, embedCard, messageCards, hideForm, showForm };
