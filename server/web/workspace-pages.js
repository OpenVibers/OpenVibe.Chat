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
 *   POST /r/:slug/tasks/:id/report      say how it went (whoever took it)
 */
const rooms = require('../rooms/rooms');
const workspace = require('../rooms/workspace');

const STATE = { queued: 'Waiting', running: 'Working', succeeded: 'Done', failed: 'Stuck', cancelled: 'Cancelled' };
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
        const result = t.status === 'succeeded' && t.result ? `<p class="oc-task-result">${linkify(t.result.length > 280 ? `${t.result.slice(0, 280).replace(/\s+\S*$/, '')}…` : t.result)}</p>` : '';
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
<p class="oc-muted oc-queue-how">Ask <code>@vibe</code> to look into or do something, or add it here. Research and web answers run at once; code and computer work waits for a worker to take it. Results come back into the room.</p>
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

    for (const op of ['cancel', 'claim']) {
        router.post(`/r/:slug/tasks/:id/${op}`, formLimit, sameSite, workOrError(async (req, res) => {
            const actor = await needUser(req, res); if (!actor) return;
            const room = await rooms.bySlug(req.params.slug);
            if (!room) return res.redirect(303, '/rooms');
            const t = await workspace[op](room, actor.user, req.params.id);
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
        let t;
        try { t = await workspace.get(room, me, req.params.id); } catch (err) {
            return page(req, res, 404, { actor, title: 'No such task', path: req.path, robots: 'noindex', body: `<h1>No such task</h1><p><a href="/r/${esc(room.slug)}">Back to ${esc(room.name)}</a></p>` });
        }
        const mine = me && (t.runner === `user:${me.id}` || String(t.runner || '').endsWith(`(for ${me.username || me.id})`));
        const reportForm = t.status === 'running' && !t.quick && (mine || can.moderate) ? `<form class="oc-form" id="oc-report" method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/report">
<h2>Report</h2>
<label>What you did <textarea name="result" rows="6" maxlength="20000" placeholder="What changed, what to check"></textarea></label>
<label>Where it landed (https, optional) <input name="result_url" type="url" placeholder="https://github.com/OpenVibers/…/pull/…"></label>
<fieldset class="oc-fieldset"><legend>How it went</legend><label class="oc-check"><input type="radio" name="status" value="succeeded" checked> Done</label><label class="oc-check"><input type="radio" name="status" value="failed"> Could not finish</label></fieldset>
<label>If it could not be finished, why <input name="error" maxlength="500"></label>
<p><button type="submit">Send the report</button></p></form>` : '';
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        await page(req, res, 200, {
            actor, title: t.title, path: req.path, active: 'rooms', robots: 'noindex, nofollow',
            body: `<p><a href="/r/${esc(room.slug)}">← ${esc(room.name)}</a></p>
<h1>${esc(t.title)}</h1>${error}
<p class="oc-muted"><span class="oc-badge oc-task-${esc(t.status)}">${STATE[t.status] || esc(t.status)}</span> ${KIND[t.kind] || 'task'} · asked by ${esc(t.requested_by.name)}${t.via === 'vibe' ? ' through Vibe' : ''} · ${when(t.created_at)}${t.runner ? ` · ${t.runner === 'actor' ? 'run by OpenVibe.Actor' : `taken by ${esc(t.runner.startsWith('user:') ? 'a member' : t.runner)}`}` : ''}${t.finished_at ? ` · finished ${when(t.finished_at)}` : ''}${t.cost_usd != null ? ` · cost $${t.cost_usd.toFixed(4)}` : ''}</p>
${t.details ? `<h2>Details</h2><p class="oc-task-details">${linkify(t.details)}</p>` : ''}
${t.result ? `<h2>Result</h2><div class="oc-task-full">${t.result.split(/\n{2,}/).map((p) => `<p>${linkify(p)}</p>`).join('')}</div>` : ''}
${t.result_url ? `<p><a class="oc-button" href="${esc(t.result_url)}" rel="noopener nofollow">Open where it landed</a></p>` : ''}
${t.sources.length ? `<h2>Sources</h2><ol class="oc-task-sources">${t.sources.map((u) => `<li>${linkify(u)}</li>`).join('')}</ol>` : ''}
${t.error ? notice('error', t.error) : ''}
${reportForm}
${(t.status === 'queued' || t.status === 'running') && me && (t.requested_by.id === Number(me.id) || can.moderate) ? `<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/cancel"><button type="submit" class="oc-link">Cancel this task</button></form>` : ''}
${t.status === 'queued' && !t.quick && can.post ? `<form method="post" action="/r/${esc(room.slug)}/tasks/${t.id}/claim"><button type="submit">I'll take it</button></form>` : ''}`,
        });
    });

    return { queuePanel };
}

module.exports = { createWorkspacePages, STATE };
