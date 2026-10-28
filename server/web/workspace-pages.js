'use strict';
/**
 * A workspace room's work queue on openvibe.chat (server/rooms/workspace.js): the panel beside the conversation on
 * /r/:slug, its task pages and forms. Everything works without JavaScript; with it, the panel refreshes itself when the
 * chat socket says the queue changed (room_task), from /r/:slug/queue.
 *
 *   GET  /r/:slug/queue                 the panel's inner HTML
 *   POST /r/:slug/tasks                 add a task (title, details, kind)
 *   GET  /r/:slug/tasks/:id             one task: details, state, the full result and its sources
 *   POST /r/:slug/tasks/:id/cancel      the person who asked, or a moderator
 *   POST /r/:slug/tasks/:id/claim       take a code, computer or other task
 *   POST /r/:slug/tasks/:id/run         the asker runs their code or computer task on their own computer (Actor, Codes, Run)
 *   POST /r/:slug/tasks/:id/report      say how it went (whoever took it)
 */
const md = require('../../public/web/vibe-md.js');
const rooms = require('../rooms/rooms');
const workspace = require('../rooms/workspace');
const how = require('../rooms/how');
const { ICONS } = require('./icons');

const STATE = { queued: 'Waiting', running: 'Working', succeeded: 'Done', failed: 'Stuck', cancelled: 'Cancelled' };
// A task page's status pill and kind chip: an icon and a word each.
const STATE_ICON = { queued: ICONS.clock, running: ICONS.working, succeeded: ICONS.check, failed: ICONS.alert, cancelled: ICONS.stop };
const KIND_CHIP = {
    answer: [ICONS.chat, 'Answer'], research: [ICONS.search, 'Research'], web: [ICONS.globe, 'Web answer'],
    code: [ICONS.code, 'Code'], computer: [ICONS.computer, 'On a computer'], other: [ICONS.task, 'Task'],
};
// What a status means for the person who asked, under the title.
const STATE_SAYS = {
    queued: 'Waiting for someone to take it, or for you to run it on your own computer.',
    running: 'Being worked on now. This page and the chat update when it is done.',
    failed: 'It could not be finished. What went wrong is below.',
    cancelled: 'Cancelled before it was done.',
};
/** A result's first lines as plain text (the queue's preview): the Markdown marks go, the words stay. */
function plain(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1')
        .replace(/^\s{0,3}(#{1,6}|>|[-*•]|\d+[.)])\s+/gm, '')
        .replace(/(\*\*|__|`)/g, '')
        .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
        .replace(/\s+/g, ' ')
        .trim();
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const atOf = (ts) => { const v = String(ts || ''); const t = Date.parse(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : null; };
/** How long a task took, in plain words, or null before it ends. */
function took(t) {
    const a = atOf(t.started_at || t.created_at), b = atOf(t.finished_at);
    if (a == null || b == null || b < a) return null;
    const s = Math.round((b - a) / 1000);
    if (s < 60) return s < 5 ? 'a few seconds' : `${s} seconds`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const money = (usd) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const KIND = { answer: 'answer', research: 'research', web: 'web', code: 'code', computer: 'computer', other: 'other' };
const KIND_HINT = {
    research: 'a short report with sources (runs now)', web: 'a current answer from the web (runs now)', answer: 'an answer (runs now)',
    code: 'a change to an OpenVibe repository, as a pull request (a worker takes it)', computer: 'something done on a computer (a worker takes it)', other: 'anything else (a worker takes it)',
};

function createWorkspacePages({ router, page, loadRoom, needUser, sameSite, formLimit, esc, linkify, hhmm, notice }) {
    const when = (ts) => { const t = hhmm(ts); return t.iso ? `<time datetime="${t.iso}">${t.iso.slice(0, 10)} ${t.text}</time>` : ''; };
    const workOrError = (fn) => async (req, res, next) => {
        try { return await fn(req, res, next); } catch (err) {
            if (err instanceof workspace.WorkError || err instanceof rooms.RoomError) return res.redirect(303, `/r/${encodeURIComponent(req.params.slug)}${req.params.id ? `/tasks/${encodeURIComponent(req.params.id)}` : ''}?error=${encodeURIComponent(err.message)}`);
            return next(err);
        }
    };

    function taskItem(t, room, can, me) {
        const mine = me && t.requested_by.id === Number(me.id);
        const actions = [];
        if ((t.status === 'queued' || t.status === 'running') && (mine || can.moderate)) actions.push(`<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/cancel"><button type="submit" class="oc-link">Cancel</button></form>`);
        if (t.status === 'queued' && !t.quick && can.post) actions.push(`<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/claim"><button type="submit" class="oc-link">I'll take it</button></form>`);
        if (t.status === 'queued' && mine && (t.kind === 'code' || t.kind === 'computer')) actions.push(`<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/run" title="OpenVibe.Actor does it on your own computer (OpenVibe.Codes for code, through OpenVibe.Run)"><button type="submit" class="oc-link">Run on my computer</button></form>`);
        const flat = t.status === 'succeeded' && t.result ? plain(t.result) : '';
        const result = flat ? `<p class="oc-task-result">${esc(flat.length > 220 ? `${flat.slice(0, 220).replace(/\s+\S*$/, '')}…` : flat)}</p>` : '';
        const err = t.status === 'failed' && t.error ? `<p class="oc-task-error">${esc(t.error)}</p>` : '';
        return `<li class="oc-task oc-task-${esc(t.status)}" data-task="${t.id}">
<a class="oc-task-title" href="${esc(t.url)}"><span class="oc-task-state">${STATE[t.status] || esc(t.status)}</span> ${esc(t.title)}</a>
<span class="oc-task-meta">${KIND[t.kind] || 'task'} · ${esc(t.requested_by.name)}${t.via === 'vibe' ? ' via Vibe' : ''}${t.runner && t.runner !== 'actor' ? ` · ${esc(t.runner.startsWith('user:') ? 'a member' : t.runner)}` : t.runner === 'actor' ? ' · OpenVibe.Actor' : ''} · ${when(t.created_at)}</span>
${result}${err}${actions.length ? `<span class="oc-task-actions">${actions.join('')}</span>` : ''}</li>`;
    }

    /** The panel's inner HTML: counts, the add form, the tasks (open first). */
    function queueInner(room, can, me, tasks) {
        const open = tasks.filter((t) => t.status === 'queued' || t.status === 'running');
        const waiting = open.filter((t) => t.status === 'queued').length;
        const working = open.length - waiting;
        const form = can.post ? `<details class="oc-queue-add"${tasks.length ? '' : ' open'}><summary>Add work to the queue</summary>
<form class="oc-form" method="post" action="/r/${esc(room.slug)}/tasks">
<label>What to do <input name="title" required minlength="3" maxlength="200" placeholder="Find why the Live home loads slowly on phones"></label>
<label>Kind <select name="kind">${Object.keys(KIND_HINT).map((k) => `<option value="${k}">${k}: ${KIND_HINT[k]}</option>`).join('')}</select></label>
<label>Details <textarea name="details" rows="3" maxlength="6000" placeholder="Where, constraints, what done looks like"></textarea></label>
<p><button type="submit">Add to the queue</button></p></form></details>` : '';
        return `<h2 id="oc-queue-h">Work queue <span class="oc-muted">${working ? `· ${working} working` : ''}${waiting ? ` · ${waiting} waiting` : ''}</span></h2>
<p class="oc-muted oc-queue-how">Ask <code>@vibe</code> to look into or do something, or add it here. Research and web answers run at once; code and computer work waits for a worker to take it, or for the person who asked to run it on their own computer. Results come back into the room.</p>
${form}
${tasks.length ? `<ol class="oc-tasks">${tasks.map((t) => taskItem(t, room, can, me)).join('\n')}</ol>` : '<p class="oc-muted">Nothing queued yet.</p>'}`;
    }

    const queuePanel = (room, can, me, tasks) => `<aside class="oc-queue" id="oc-queue" aria-labelledby="oc-queue-h" data-queue="/r/${esc(room.slug)}/queue">${queueInner(room, can, me, tasks)}</aside>`;

    router.get('/r/:slug/queue', async (req, res) => {
        const x = await loadRoom(req, res, { fragment: true }); if (!x) return;
        if (!rooms.isWorkspace(x.room)) return res.status(404).type('text').send('No work queue here');
        const tasks = await workspace.list(x.room, x.me, { limit: 40 });
        res.set('Cache-Control', 'private, no-store').type('html').send(queueInner(x.room, x.can, x.me, tasks));
    });

    router.post('/r/:slug/tasks', formLimit, sameSite, workOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        const b = req.body || {};
        await workspace.add(room, actor.user, { title: b.title, details: b.details, kind: b.kind });
        res.redirect(303, `/r/${room.slug}#oc-queue`);
    }));

    for (const op of ['cancel', 'claim', 'run']) {
        router.post(`/r/:slug/tasks/:id/${op}`, formLimit, sameSite, workOrError(async (req, res) => {
            const actor = await needUser(req, res); if (!actor) return;
            const room = await rooms.bySlug(req.params.slug);
            if (!room) return res.redirect(303, '/rooms');
            const t = await (op === 'run' ? workspace.runOnComputer : workspace[op])(room, actor.user, req.params.id);
            res.redirect(303, op === 'claim' ? `${t.url}#oc-report` : `/r/${room.slug}#oc-queue`);
        }));
    }

    router.post('/r/:slug/tasks/:id/report', formLimit, sameSite, workOrError(async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const room = await rooms.bySlug(req.params.slug);
        if (!room) return res.redirect(303, '/rooms');
        const b = req.body || {};
        const t = await workspace.report(room, actor.user, req.params.id, { status: b.status === 'failed' ? 'failed' : 'succeeded', result: b.result, result_url: b.result_url || null, error: b.error });
        res.redirect(303, t.url);
    }));

    router.get('/r/:slug/tasks/:id', async (req, res) => {
        const x = await loadRoom(req, res); if (!x) return;
        const { actor, me, room, can } = x;
        // A Vibe chat's tasks lead back to the chat in the Vibe app, where the person asked; a room's to the room.
        const vibeChat = Number(room.assistant) === 1;
        const back = vibeChat ? { href: `/vibe/${esc(room.slug)}`, label: 'Back to the chat' } : { href: `/r/${esc(room.slug)}`, label: esc(room.name) };
        let t;
        try { t = await workspace.get(room, me, req.params.id); } catch (err) {
            return page(req, res, 404, { actor, title: 'No such task', path: req.path, robots: 'noindex', footer: 'compact', body: `<div class="oc-tp"><a class="oc-tp-back" href="${back.href}">${ICONS.back}<span>${back.label}</span></a><h1>No such task</h1><p class="oc-muted">It may have been removed with its chat.</p></div>` });
        }
        const mine = me && (t.runner === `user:${me.id}` || String(t.runner || '').endsWith(`(for ${me.username || me.id})`));
        const asker = me && t.requested_by.id === Number(me.id);
        const reportForm = t.status === 'running' && !t.quick && (mine || can.moderate) ? `<section class="oc-tp-card" id="oc-report" aria-labelledby="oc-report-h">
<h2 id="oc-report-h">Report back</h2>
<form class="oc-form oc-tp-form" method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/report">
<label>What you did <textarea name="result" rows="6" maxlength="20000" placeholder="What changed, what to check. Markdown works: **bold**, lists, links."></textarea></label>
<label>Where it landed (https, optional) <input name="result_url" type="url" placeholder="https://github.com/OpenVibers/…/pull/…"></label>
<fieldset class="oc-fieldset"><legend>How it went</legend><label class="oc-check"><input type="radio" name="status" value="succeeded" checked> Done</label><label class="oc-check"><input type="radio" name="status" value="failed"> Could not finish</label></fieldset>
<label>If it could not be finished, why <input name="error" maxlength="500"></label>
<p><button type="submit">Send the report</button></p></form></section>` : '';
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        // What ran it and how (the same facts as "How Vibe did this" under the answer in the chat).
        const info = how.of({ ...t, how: t.how, sources: JSON.stringify(t.sources) }, await how.names().catch(() => new Map()));
        const runBy = t.runner === 'actor' ? 'OpenVibe.Actor' : t.runner ? (t.runner.startsWith('user:') ? 'a member of the room' : t.runner) : null;
        const facts = [
            ['Asked by', `${esc(t.requested_by.name)}${t.via === 'vibe' ? ' <span class="oc-muted">through Vibe</span>' : ''}`],
            runBy ? [t.runner === 'actor' ? 'Done by' : 'Taken by', esc(runBy)] : null,
            ['Asked', when(t.created_at)],
            t.finished_at ? ['Took', esc(took(t) || '—')] : null,
            t.cost_usd != null ? ['Cost', `${money(t.cost_usd)}${t.runner === 'actor' ? ' <span class="oc-muted">of your daily allowance</span>' : ''}`] : null,
        ].filter(Boolean);
        const [kindIcon, kindLabel] = KIND_CHIP[t.kind] || KIND_CHIP.other;
        // The details are shown when they say more than the title.
        const details = t.details && t.details.trim().toLowerCase() !== String(t.title).trim().toLowerCase() ? t.details : '';
        const actions = [
            `<a class="oc-pill" href="${back.href}">${ICONS.chat}<span>${vibeChat ? 'Chat' : 'Room'}</span></a>`,
            t.result_url ? `<a class="oc-pill oc-pill-strong" href="${esc(t.result_url)}" rel="noopener nofollow">${ICONS.open}<span>Open where it landed</span></a>` : '',
            info && info.actor_url ? `<a class="oc-pill" href="${esc(info.actor_url)}" title="Every step the agent took, on OpenVibe.Actor">${ICONS.steps}<span>Every step</span></a>` : '',
            t.kind === 'computer' || t.kind === 'code' ? `<a class="oc-pill" href="https://openvibe.bot/machines" title="Your computers: pair one, see its screen, set what agents may do on it">${ICONS.computer}<span>Your computers</span></a>` : '',
        ].filter(Boolean).join('');
        const checked = info ? info.lines.find((l) => l.startsWith('Checked by')) : null;
        const sources = t.sources.length ? `<section class="oc-tp-card" aria-labelledby="oc-src-h"><h2 id="oc-src-h">Sources <span class="oc-muted">${t.sources.length}</span></h2>
<ol class="oc-tp-sources">${t.sources.map((u) => `<li><a href="${esc(u)}" rel="noopener nofollow ugc" target="_blank"><strong>${esc(hostOf(u))}</strong><span>${esc(u.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/')}</span></a></li>`).join('')}</ol></section>` : '';
        await page(req, res, 200, {
            actor, title: t.title, path: req.path, active: vibeChat ? 'vibe' : 'rooms', robots: 'noindex, nofollow', footer: 'compact', script: true, page: { view: 'task' },
            body: `<article class="oc-tp">
<a class="oc-tp-back" href="${back.href}">${ICONS.back}<span>${back.label}</span></a>
<header class="oc-tp-head">
<p class="oc-tp-chips"><span class="oc-tp-state oc-tp-${esc(t.status)}">${STATE_ICON[t.status] || ''}<span>${STATE[t.status] || esc(t.status)}</span></span><span class="oc-tp-kind">${kindIcon}<span>${kindLabel}</span></span></p>
<h1>${esc(t.title)}</h1>
${STATE_SAYS[t.status] ? `<p class="oc-muted oc-tp-says">${STATE_SAYS[t.status]}</p>` : ''}
<dl class="oc-tp-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
</header>
${error}${t.error ? notice('error', t.error) : ''}
${details ? `<section class="oc-tp-card" aria-labelledby="oc-ask-h"><h2 id="oc-ask-h">What was asked</h2><div class="vb-md">${md.render(details)}</div></section>` : ''}
${t.result ? `<section class="oc-tp-card oc-tp-result" aria-labelledby="oc-res-h"><div class="oc-tp-card-head"><h2 id="oc-res-h">Result</h2><button type="button" class="oc-icon-btn" data-oc-copy="#oc-res" aria-label="Copy the result" title="Copy" hidden>${ICONS.copy}</button></div><div class="vb-md" id="oc-res">${md.render(t.result)}</div>${checked ? `<p class="oc-tp-check">${ICONS.check}<span>${esc(checked)}</span></p>` : ''}</section>` : ''}
${sources}
${actions ? `<nav class="oc-tp-actions" aria-label="Next">${actions}</nav>` : ''}
${reportForm}
${(t.status === 'queued' || t.status === 'running') && me && (asker || can.moderate) ? `<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/cancel" class="oc-tp-cancel"><button type="submit" class="oc-pill oc-pill-danger">${ICONS.stop}<span>Cancel this task</span></button></form>` : ''}
${t.status === 'queued' && !t.quick && can.post ? `<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/claim"><button type="submit">I'll take it</button></form>` : ''}
</article>`,
        });
    });

    return { queuePanel };
}

module.exports = { createWorkspacePages, STATE, plain, took };
