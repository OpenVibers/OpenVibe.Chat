'use strict';
/**
 * A room's AI insight, plain markup behind a button in the room's head (plan 2026-11-10).
 * Server-rendered, so it reads and opens without JavaScript (<details>); the look is the designer's.
 * Kit classes only: the popover, muted text, the icon button. Used by the Global page (server/web/pages.js)
 * and by a server's channel page (server/web/server-pages.js).
 */
const { esc } = require('./layout');
const ui = require('./ui');
const { ICONS: IC } = require('./icons');

function insightBlock(insight) {
    const o = (insight && insight.overview) || {};
    const topics = (o.topics || []).slice(0, 8);
    const events = ((insight && insight.timeline) || []).slice(0, 6);
    const ready = insight && insight.state === 'ready' && !!o.text;
    const off = insight && insight.state === 'off';
    const when = o.updated_at ? ui.when(o.updated_at) : null;
    const meta = [o.people ? `${o.people} ${o.people === 1 ? 'person' : 'people'}` : '', o.messages ? `${o.messages} messages` : '', when && when.text ? `updated ${when.text}` : ''].filter(Boolean);
    return `<details class="oc-more oc-insight"><summary class="oc-icon-btn" aria-label="AI overview of this room" title="AI overview">${IC.steps}</summary><div class="oc-pop oc-insight-pop">`
        + (ready ? `<p>${esc(o.text)}</p>` : `<p class="oc-muted">${off ? 'AI insight is off for this room.' : 'Quiet right now: there is nothing new to summarise.'}</p>`)
        + (topics.length ? `<ul class="oc-insight-topics">${topics.map((t) => `<li>${esc(t.label)} <span class="oc-muted">${Number(t.count) || 0}</span></li>`).join('')}</ul>` : '')
        + (events.length ? `<ol class="oc-insight-timeline">${events.map((e) => `<li><time>${esc(ui.when(e.at).text || '')}</time> <strong>${esc(e.title)}</strong>${e.text ? ` <span class="oc-muted">${esc(e.text)}</span>` : ''}</li>`).join('')}</ol>` : '')
        + (meta.length ? `<p class="oc-muted oc-insight-meta">${esc(meta.join(' · '))}</p>` : '')
        + '</div></details>';
}

module.exports = { insightBlock };
