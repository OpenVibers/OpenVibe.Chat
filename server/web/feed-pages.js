'use strict';
/**
 * Feeds on openvibe.chat (server/feeds/feeds.js, docs/platform.md):
 *
 *   GET  /embed/feed/:id        a feed's card for any site's iframe (public/web/feed-view.js; frame-ancestors any site),
 *                               OpenVibe.Live's channel chat among them; ?theme=light|dark, else the visitor's own
 *   GET  /feeds                 a person's feeds, and a form to make one
 *   GET  /feeds/:id             where it shows, what viewers see, the delay; how to publish (Claude Code's hooks, the
 *                               API), the key (made again on request), the embed tag, a live preview
 *   POST /feeds · /feeds/:id/settings · /feeds/:id/key · /feeds/:id/delete   forms; making a feed or a key answers with
 *                               the page that shows the key, once (it is never stored)
 */
const feeds = require('../feeds/feeds');
const ctx = require('../live-context');
const db = require('../db/database');
const { esc, asset } = require('./layout');
const ui = require('./ui');
const { ICONS } = require('./icons');

const THEMES = {
    light: '--oc-bg:#ffffff;--oc-panel:#ffffff;--oc-line:#e3e7ef;--oc-text:#101828;--oc-muted:#5b6577;--oc-accent:#2563eb;--oc-ok:#16a34a;color-scheme:light',
    dark: '--oc-bg:#0b1020;--oc-panel:#121a2c;--oc-line:#223049;--oc-text:#e8edf6;--oc-muted:#98a6bd;--oc-accent:#60a5fa;--oc-ok:#22c55e;color-scheme:dark',
};

function embedHtml(feed, theme) {
    const pick = THEMES[theme] ? `:root{${THEMES[theme]}}` : `:root{${THEMES.light}}@media (prefers-color-scheme: dark){:root{${THEMES.dark}}}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(feed.title)}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="${asset('feed-view.css')}">
<style>${pick}html,body{margin:0;background:transparent}body{color:var(--oc-text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style>
<script src="${asset('feed-view.js')}" defer></script>
</head>
<body><div class="fv" data-feed="${esc(feed.id)}"></div></body>
</html>`;
}

const hookFor = (base, id) => ({ type: 'http', url: `${base}/api/chat/feeds/${id}/hooks/claude-code`, headers: { Authorization: 'Bearer $OPENVIBE_FEED_KEY' }, allowedEnvVars: ['OPENVIBE_FEED_KEY'], timeout: 5 });
/**
 * The block for .claude/settings.json: the events a viewer may see, sent as they happen; never blocks Claude Code. One
 * line per event (the same hook each time), so it reads at a glance and pastes as valid JSON.
 */
function claudeCodeSnippet(base, id) {
    const h = JSON.stringify([hookFor(base, id)]);
    const events = [['SessionStart', `[{ "hooks": ${h} }]`], ['UserPromptSubmit', `[{ "hooks": ${h} }]`], ['PostToolUse', `[{ "matcher": "*", "hooks": ${h} }]`],
        ['Stop', `[{ "hooks": ${h} }]`], ['SessionEnd', `[{ "hooks": ${h} }]`]];
    return `{\n  "hooks": {\n${events.map(([e, v]) => `    "${e}": ${v}`).join(',\n')}\n  }\n}`;
}
const curlSnippet = (base, id) => `curl -X POST ${base}/api/chat/feeds/${id}/events \\
  -H "Authorization: Bearer $OPENVIBE_FEED_KEY" -H "Content-Type: application/json" \\
  -d '{"eventType": "prompt", "text": "Add a dark mode to the settings page"}'`;
const iframeSnippet = (base, id) => `<iframe src="${base}/embed/feed/${id}" title="Vibe coding, live" style="width:100%;height:320px;border:0" loading="lazy"></iframe>`;

function mountFeedPages(router, { page, needUser, sameSite, formLimit, notice, config }) {
    const base = config.web.baseUrl;

    router.get('/embed/feed/:id', async (req, res) => {
        const feed = await feeds.get(req.params.id);
        if (!feed) return res.status(404).set('Cache-Control', 'no-store').type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Feed not found</title><p style="font-family:system-ui;padding:16px">This feed is not available.</p>');
        res.set('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
            `connect-src 'self' ${base.replace(/^http/, 'ws')}`, 'frame-ancestors *', "base-uri 'self'", "form-action 'none'", "object-src 'none'",
        ].join('; ')).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(embedHtml(feed, String(req.query.theme || '')));
    });

    async function places(user) {
        const roomList = await db.all('SELECT id, slug, name FROM rooms WHERE owner_id = ? AND archived_at IS NULL AND assistant = 0 AND server_id IS NULL ORDER BY lower(name) LIMIT 100', [user.id]);
        const slots = await ctx.getManagedStreamsByUserId(user.id).catch(() => []);
        return { roomList, slots };
    }
    function placeFields({ roomList, slots }, feed = {}) {
        const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
        return `<label>Show it in a room <select name="room">${opt('', 'No room', !feed.room_id)}${roomList.map((r) => opt(r.id, r.name, Number(feed.room_id) === Number(r.id))).join('')}</select></label>
<label>Show it on your Live channel while live <select name="slot">${opt('', 'Not on Live', !feed.managed_stream_id)}${slots.map((s) => opt(s.id, s.title || s.slug || `Slot ${s.id}`, Number(feed.managed_stream_id) === Number(s.id))).join('')}</select></label>`;
    }
    function keyPanel(feed, key) {
        return `${notice('ok', 'Here is the feed\'s key. Copy it now: it is shown only this once.')}
<pre class="ib-snippet fd-key" tabindex="0"><code>${esc(key)}</code></pre>
<p class="oc-muted">Put it where your tools read it, for example <code>export OPENVIBE_FEED_KEY=${esc(key.slice(0, 8))}…</code> in your shell profile. Anyone with the key can post to this feed; make a new one any time.</p>
<p><a class="oc-button" href="/feeds/${esc(feed.id)}">Set up publishing</a></p>`;
    }

    router.get('/feeds', async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const mine = await feeds.mine(actor.user);
        const where = (f) => [f.room_id ? 'in a room' : '', f.managed_stream_id ? 'on Live' : ''].filter(Boolean).join(' · ');
        const list = mine.length
            ? `<ul class="oc-list">${mine.map((f) => { const t = ui.when(f.last_event_at); const on = f.settings.enabled && !f.settings.paused; return `<li class="oc-row"><a href="/feeds/${esc(f.id)}"><span class="oc-av oc-av-feed${on ? ' is-on' : ''}" aria-hidden="true">${ICONS.code}</span><span class="oc-row-main"><span class="oc-row-top"><strong>${esc(f.title)}</strong>${t.text ? `<time datetime="${t.iso}">${esc(t.text)}</time>` : ''}</span><span class="oc-row-sub">${on ? '' : f.settings.paused ? 'Paused · ' : 'Hidden · '}${f.last_event_at ? 'last step published' : 'nothing published yet'}${where(f) ? ` · ${where(f)}` : ''}</span></span></a></li>`; }).join('')}</ul>`
            : '';
        await page(req, res, 200, {
            actor, title: 'Feeds', path: '/feeds', active: 'rooms', robots: 'noindex, nofollow', footer: 'compact',
            body: `${ui.head({ title: 'Feeds', sub: 'Your coding session, live: in a room, on your Live channel, or on your site' })}
${req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : ''}
${list}
<details class="oc-card oc-make"${mine.length ? '' : ' open'}><summary>${ICONS.plus}<span>New feed</span></summary>
<p class="oc-muted oc-make-how">Claude Code, Copilot or any tool sends each step (a prompt, a command, a file edited, the answer), and your viewers follow along in a card. You decide what they see; secrets and home folders are wiped before anything is shown.</p>
<form class="oc-form oc-grid-form" method="post" action="/feeds">
<label>Title <input name="title" required minlength="2" maxlength="80" value="Vibe coding"></label>
${placeFields(await places(actor.user))}
<p><button type="submit">Make the feed</button></p></form></details>`,
        });
    });

    router.post('/feeds', formLimit, sameSite, async (req, res) => {
        const actor = await needUser(req, res); if (!actor) return;
        const b = req.body || {};
        try {
            const { feed, key } = await feeds.create(actor.user, { title: b.title, room: b.room || null, slot: b.slot || null });
            await page(req, res, 201, { actor, title: `${feed.title}: key`, path: `/feeds/${feed.id}`, active: 'rooms', robots: 'noindex, nofollow', footer: 'compact', body: `${ui.head({ title: esc(feed.title), sub: 'Its key, shown this once', back: { href: `/feeds/${feed.id}`, label: 'The feed' } })}${keyPanel(feed, key)}` });
        } catch (err) { res.redirect(303, `/feeds?error=${encodeURIComponent(err.message || 'That did not work')}`); }
    });

    async function ownFeed(req, res) {
        const actor = await needUser(req, res); if (!actor) return null;
        const feed = await feeds.get(req.params.id);
        if (!feed || feed.owner_id !== Number(actor.user.id)) { await page(req, res, 404, { actor, title: 'Feed not found', path: '/feeds', robots: 'noindex, nofollow', body: '<h1>Feed not found</h1><p><a href="/feeds">Your feeds</a></p>' }); return null; }
        return { actor, feed };
    }

    router.get('/feeds/:id', async (req, res) => {
        const a = await ownFeed(req, res); if (!a) return;
        const { actor, feed } = a;
        const s = feed.settings;
        const check = (name, label) => `<label class="oc-check"><input type="checkbox" name="${name}" value="1"${s[name] ? ' checked' : ''}> ${label}</label>`;
        const t = ui.when(feed.last_event_at);
        const on = s.enabled && !s.paused;
        const where = [feed.room_id ? 'in a room' : '', feed.managed_stream_id ? 'on Live while you stream' : ''].filter(Boolean).join(' · ');
        // How to connect: one tool at a time, folded; the first one open while nothing has been published.
        const snip = (id, text) => `<div class="oc-snip"><button type="button" class="oc-icon-btn" data-oc-copy="#${id}" aria-label="Copy" title="Copy" hidden>${ICONS.copy}</button><pre class="ib-snippet" tabindex="0" id="${id}"><code>${esc(text)}</code></pre></div>`;
        const connect = (id, label, inner, open) => `<details class="oc-card oc-fold" id="${id}"${open ? ' open' : ''}><summary><span>${label}</span>${ICONS.chevron}</summary>${inner}</details>`;
        await page(req, res, 200, {
            actor, title: `${feed.title}: feed`, path: `/feeds/${feed.id}`, active: 'rooms', robots: 'noindex, nofollow', feedView: true, footer: 'compact', script: true, page: { view: 'feed' },
            body: `${ui.head({
                title: esc(feed.title),
                sub: `${on ? 'Visible' : s.paused ? 'Paused' : 'Hidden'}${t.text ? ` · last step ${esc(t.text)}` : ' · nothing published yet'}${where ? ` · ${where}` : ''}`,
                back: { href: '/feeds', label: 'All feeds' },
                actions: [`<a class="oc-icon-btn" href="#oc-feed-settings" aria-label="Where it shows and what viewers see" title="Settings">${ICONS.gear}</a>`],
            })}
${req.query.saved ? notice('ok', 'Saved.') : ''}${req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : ''}
<div class="fv fd-preview" data-feed="${esc(feed.id)}"></div>
<h2 class="oc-list-head">Connect</h2>
${connect('oc-connect-claude', 'Claude Code', `<p>Add this to <code>.claude/settings.json</code> in a project (or <code>~/.claude/settings.json</code> for every project), and set <code>OPENVIBE_FEED_KEY</code> in the shell you start Claude Code from. Each prompt, tool used and answer becomes a step; nothing is read from your files or transcript.</p>
${snip('oc-snip-claude', claudeCodeSnippet(base, feed.id))}`, !feed.last_event_at)}
${connect('oc-connect-api', 'Any other tool (the API)', `<p>Send events with the key; <code>eventType</code> is one of ${feeds.TYPES.map((x) => `<code>${x}</code>`).join(', ')} (up to 50 at once as <code>{ "events": [...] }</code>). The OpenVibe Copilot companion speaks the same events.</p>
${snip('oc-snip-api', curlSnippet(base, feed.id))}`, false)}
${connect('oc-connect-embed', 'Show it on your site', snip('oc-snip-embed', iframeSnippet(base, feed.id)), false)}
<div class="oc-keyrow"><span class="oc-muted">${ICONS.key} Key ending in <code>${esc(feed.key_hint || '????')}</code></span><form method="post" action="/feeds/${esc(feed.id)}/key" class="oc-inline"><button type="submit" class="oc-pill">${ICONS.retry}<span>New key</span></button></form></div>
<details class="oc-card oc-fold" id="oc-feed-settings"${req.query.saved || req.query.error ? ' open' : ''}><summary><span>Where it shows and what viewers see</span>${ICONS.chevron}</summary>
<form class="oc-form oc-grid-form" method="post" action="/feeds/${esc(feed.id)}/settings">
<label>Title <input name="title" required minlength="2" maxlength="80" value="${esc(feed.title)}"></label>
${placeFields(await places(actor.user), feed)}
<fieldset class="oc-fieldset"><legend>Showing</legend>
${check('enabled', 'Viewers see this feed')}
${check('paused', 'Paused (steps are kept, nobody sees them until you unpause)')}
</fieldset>
<fieldset class="oc-fieldset"><legend>What viewers see</legend>
${check('show_prompts', 'Prompts')}${check('show_responses', 'Answers')}${check('show_tool_calls', 'Tools used')}${check('show_tool_arguments', 'What the tools were given (commands, searches)')}
${check('show_file_events', 'Files changed')}${check('redact_file_paths', 'File names only, not their folders')}${check('show_thinking', 'Thinking, when the tool sends it')}
</fieldset>
<label>Detail <select name="viewer_depth">${[['headline', 'Headlines'], ['standard', 'Standard'], ['deep', 'More text']].map(([v, l]) => `<option value="${v}"${s.viewer_depth === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
<label>Delay before viewers see a step <select name="delay_ms">${[[0, 'None'], [10000, '10 seconds'], [30000, '30 seconds'], [60000, '1 minute'], [120000, '2 minutes']].map(([v, l]) => `<option value="${v}"${s.delay_ms === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
<p><button type="submit">Save</button></p></form>
<form method="post" action="/feeds/${esc(feed.id)}/delete" class="oc-inline oc-danger-row"><button type="submit" class="oc-pill oc-pill-danger">${ICONS.trash}<span>Delete this feed and its history</span></button></form>
</details>`,
        });
    });

    router.post('/feeds/:id/settings', formLimit, sameSite, async (req, res) => {
        const a = await ownFeed(req, res); if (!a) return;
        const b = req.body || {};
        const flags = ['enabled', 'paused', 'show_prompts', 'show_responses', 'show_tool_calls', 'show_tool_arguments', 'show_file_events', 'redact_file_paths', 'show_thinking'];
        const settings = { viewer_depth: b.viewer_depth, delay_ms: b.delay_ms };
        for (const f of flags) settings[f] = b[f] === '1' ? 1 : 0;
        try {
            await feeds.update(a.feed, a.actor.user, { title: b.title, room: b.room || null, slot: b.slot || null, settings });
            res.redirect(303, `/feeds/${a.feed.id}?saved=1`);
        } catch (err) { res.redirect(303, `/feeds/${a.feed.id}?error=${encodeURIComponent(err.message || 'That did not save')}`); }
    });
    router.post('/feeds/:id/key', formLimit, sameSite, async (req, res) => {
        const a = await ownFeed(req, res); if (!a) return;
        const key = await feeds.rotateKey(a.feed);
        await page(req, res, 200, { actor: a.actor, title: `${a.feed.title}: key`, path: `/feeds/${a.feed.id}`, active: 'rooms', robots: 'noindex, nofollow', footer: 'compact', body: `${ui.head({ title: esc(a.feed.title), sub: 'Its new key, shown this once', back: { href: `/feeds/${a.feed.id}`, label: 'The feed' } })}${keyPanel(a.feed, key)}` });
    });
    router.post('/feeds/:id/delete', formLimit, sameSite, async (req, res) => {
        const a = await ownFeed(req, res); if (!a) return;
        await feeds.remove(a.feed);
        res.redirect(303, '/feeds');
    });
}

module.exports = { mountFeedPages, embedHtml, claudeCodeSnippet };
