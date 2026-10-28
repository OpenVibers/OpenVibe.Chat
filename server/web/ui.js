'use strict';
/**
 * Pieces every working page on openvibe.chat shares (the owner, 2026-10-28: "icon buttons … so much wasted space … the
 * alignment's kind of bad … not a focus on the real content"): one compact page header with its actions as icons, times
 * people read at a glance, and a person's initials when there is no picture.
 *
 *   head({ title, sub, back, actions })   <header class="oc-page-head">: back icon, title and one muted line, icon actions
 *   when(ts, now)                          { iso, text }: 14:05 today, Yesterday, Mon this week, Oct 20 this year, else 2025-10-20
 *   initials(name)                         a round mark with up to two letters, its colour from the name
 */
const { esc } = require('./layout');
const { ICONS } = require('./icons');

function head({ title, sub = '', back = null, actions = [] }) {
    return `<header class="oc-page-head">
${back ? `<a class="oc-icon-btn oc-back" href="${esc(back.href)}" aria-label="${esc(back.label)}" title="${esc(back.label)}">${ICONS.back}</a>` : ''}<div class="oc-page-id"><h1>${title}</h1>${sub ? `<p class="oc-page-sub">${sub}</p>` : ''}</div>
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

function initials(name) {
    const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return `<span class="oc-av" style="--av:${h}" aria-hidden="true">${esc(letters)}</span>`;
}

module.exports = { head, when, initials };
