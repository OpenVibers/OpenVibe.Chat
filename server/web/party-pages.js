'use strict';
/**
 * openvibe.party, Watch Together's host (Party watch v1, plan R1): Chat serves it beside openvibe.chat, so a party is
 * a Chat room and its chat, socket, clock and remote already exist (server/rooms/parties.js, sync-clock.js,
 * control-lease.js).
 *
 *   GET  /                    "Start a party": one field, paste any OpenVibe link (signed in; sign-in otherwise)
 *   GET  /new?media=&title=   signed in: starts the party and 303s to /p/<slug>?k=<secret>; signed out: sign-in and
 *                             back here. `source_url` (the page it was started from) is optional, as the API's is.
 *   GET  /p/:slug?k=          the party page shell: the Shared Frame, a <main data-party="<slug>"> and the empty
 *                             regions the page's own script fills (server/rooms/parties.js keeps the data), with the
 *                             party view as JSON in #party-data. The link's secret joins the person and is never
 *                             echoed into the page.
 *   /auth/*                   sign-in with OpenVibe.Network: its own host-only session and its own redirect URI on
 *                             Chat's OAuth client (<party base>/auth/callback, in Network's seed)
 *   /shared/*, /web/*         the Frame's scripts and the site's stylesheet, the same files openvibe.chat serves
 *
 * A stranger without the link (or with a wrong secret) gets the missing-room 404, exactly as on openvibe.chat.
 */
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const cache = require('openvibe-shared/cache-policy');
const ovServe = require('openvibe-shared/serve');
const { renderPage, contentSecurityPolicy, esc } = require('./layout');
const { createSessionRoutes } = require('./session');
const { viewerOf } = require('./pages');
const parties = require('../rooms/parties');
const radio = require('../rooms/radio');
const radioSource = (v) => ({ creator: 'Creator upload', creative_commons: 'Creative Commons', public_domain: 'Public domain', ai: 'AI-made music' })[v] || v;
const radioLicence = (v) => v === 'creator_grant' ? 'Creator’s permission to stream' : v === 'public_domain' ? 'Public domain mark' : v;

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public', 'web');
const SITE = Object.freeze({ name: 'OpenVibe.Party', service: 'party', links: [{ key: 'start', label: 'Start a party', href: '/' }] });
const DESCRIPTION = 'Watch together: start a party on any OpenVibe video and everyone watches in step, with the chat beside it.';

const escJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** A title out of the link someone pasted: the last path segment, or the host's name. */
function titleFromMedia(media) {
    try {
        const u = new URL(media);
        const last = decodeURIComponent((u.pathname.split('/').filter(Boolean).pop() || ''));
        const words = last.replace(/[-_]+/g, ' ').replace(/\.(mp4|webm|m3u8|mov|mkv|m4v)$/i, '').replace(/\s+/g, ' ').trim();
        return (words || `${u.hostname} party`).slice(0, 80);
    } catch { return 'Watch party'; }
}

function createPartyRoutes({ config }) {
    const router = express.Router();
    const base = String(config.party.baseUrl).replace(/\/+$/, '');
    const wsOrigin = base.replace(/^http/, 'ws');
    const partyConfig = {
        ...config,
        baseUrl: base,
        web: { ...config.web, baseUrl: base },
        oauth: { ...config.oauth, redirectUri: config.party.redirectUri, scope: config.party.scope },
    };
    const viewers = { resolve: async (req) => await viewerOf(req) };

    const hostOf = (req) => String((req.headers && req.headers.host) || '').toLowerCase().replace(/:\d+$/, '');
    const isPartyHost = (req) => hostOf(req) === config.party.host || hostOf(req) === `www.${config.party.host}`;

    const page = async (req, res, status, o) => {
        const actor = o.actor || await viewerOf(req);
        const nonce = crypto.randomBytes(16).toString('base64');
        res.status(status)
            .set('Cache-Control', cache.htmlHeaders({ private: true }))
            .set('Content-Security-Policy', contentSecurityPolicy(nonce, wsOrigin, !!o.party))
            .type('html')
            .send(renderPage({ config: partyConfig, actor, nonce, site: SITE, ...o }));
    };

    router.use('/auth', createSessionRoutes({ config: partyConfig, viewers }));
    router.use('/shared', ovServe.handler());
    router.use('/web', express.static(PUBLIC_DIR, { index: false, setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=300'); } }));

    const notice = (kind, text) => `<p class="oc-notice oc-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</p>`;

    // ── OpenVibe.Video (MediaHub /api/v1/video/watchable): what a party plays for a watch page, and what to pick ──
    // A person pastes a watch page (openvibe.video/watch?v=…), not a file: Video says which file plays, its title and its
    // picture, for anything anyone with the link may watch (public or unlisted, ready, no content label). The home's
    // grid is Video's latest. Both are read from the server with a short timeout and cached a minute; Video slow or down
    // leaves the grid out and a pasted page unresolved (the person is told), never a broken party.
    // A test names its own stand-in; a test that does not never reaches the real site.
    const videoUrl = () => String(process.env.CHAT_PARTY_VIDEO_URL || (process.env.NODE_ENV === 'test' ? '' : 'https://openvibe.video')).replace(/\/+$/, '');
    const PAGE_HOSTS = new Set(['openvibe.video', 'www.openvibe.video', 'openvibe.live', 'www.openvibe.live']);
    const watchCache = new Map();   // key → { at, value }
    async function fromVideo(what, path) {
        const at = videoUrl();
        if (!at) return null;
        const key = `${at} ${what}`;
        const hit = watchCache.get(key);
        if (hit && Date.now() - hit.at < 60_000) return hit.value;
        let value = null;
        try {
            const r = await fetch(`${at}${path}`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(2500) });
            value = r.ok ? await r.json() : null;
        } catch { value = hit ? hit.value : null; }
        if (watchCache.size > 500) watchCache.clear();
        watchCache.set(key, { at: Date.now(), value });
        return value;
    }
    const httpsOrNull = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{1,2048}$/.test(v) ? v : null);
    /** A watch page's party media: { media, title, source_url, thumbnail_url } — or null when it is not one Video vouches for. */
    async function watchablePage(url) {
        let u;
        try { u = new URL(url); } catch { return null; }
        if (u.protocol !== 'https:' || !PAGE_HOSTS.has(u.hostname.toLowerCase())) return null;
        const item = await fromVideo(`one:${url}`, `/api/v1/video/watchable?url=${encodeURIComponent(url)}`);
        const media = item && httpsOrNull(item.file_url);
        if (!media) return null;
        return { media, title: String(item.title || '').slice(0, 200), source_url: httpsOrNull(item.page_url) || url, thumbnail_url: httpsOrNull(item.thumbnail_url) };
    }
    const isWatchPage = (url) => { try { const u = new URL(url); return PAGE_HOSTS.has(u.hostname.toLowerCase()); } catch { return false; } };
    async function latestWatchable() {
        const doc = await fromVideo('latest', '/api/v1/video/watchable/latest?limit=8');
        return (doc && Array.isArray(doc.items) ? doc.items : [])
            .filter((x) => x && httpsOrNull(x.page_url) && isWatchPage(x.page_url) && typeof x.title === 'string')
            .slice(0, 8);
    }
    /** What a person asked to watch, made playable: a watch page becomes its file; a file stays as it is. */
    async function playable({ media, title, source }) {
        if (!isWatchPage(media)) return { media, title, source, thumb: null };
        const page = await watchablePage(media);
        if (!page) return null;
        return { media: page.media, title: title || page.title, source: page.source_url, thumb: page.thumbnail_url };
    }
    const sized = (thumb, w) => {
        if (!thumb) return null;
        try { return new URL(thumb).hostname === 'openvibe.media' ? `${thumb}${thumb.includes('?') ? '&' : '?'}w=${w}&fmt=webp` : thumb; } catch { return null; }
    };
    const duration = (sec) => {
        const n = Number(sec);
        if (!(n > 0)) return '';
        const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = Math.floor(n % 60);
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
    };

    router.get('/', async (req, res) => {
        const actor = await viewerOf(req);
        const signedIn = actor.kind === 'user';
        const error = req.query.error ? notice('error', String(req.query.error).slice(0, 200)) : '';
        const [picks, tracks] = await Promise.all([latestWatchable(), radio.catalogue()]);
        const mine = signedIn ? await parties.mine(actor.user, { limit: 6 }).catch(() => []) : [];
        const since = (iso) => {
            const days = Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
            return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
        };
        const yours = mine.length ? `<section class="pty-mine" aria-labelledby="pty-mine-h">
<h2 id="pty-mine-h">Your parties</h2>
<ul class="pty-mine-list">${mine.map((x) => `<li><a href="/p/${encodeURIComponent(x.id)}"><strong>${esc(x.title)}</strong><span>${x.hosting ? 'You started it' : 'You joined'} · ${esc(since(x.started_at))}</span></a></li>`).join('')}</ul>
</section>` : '';
        const startHref = (x) => `/new?media=${encodeURIComponent(x.page_url)}&title=${encodeURIComponent(x.title)}`;
        // Two plain choices, not a dropdown (Opus's design pass): where the shared computer runs.
        const desktopStart = signedIn ? `<form class="pty-desktop-start" method="get" action="/new">
<h2 class="pty-start-h">Start a shared computer</h2>
<div class="pty-host-choice">
<button type="submit" name="desktop" value="link" class="pty-host"><strong>On my computer</strong><span>Free. Runs in the Link app on your computer.</span></button>
<button type="submit" name="desktop" value="openvibe" class="pty-host" disabled aria-describedby="pty-openvibe-availability"><strong>On OpenVibe</strong><span id="pty-openvibe-availability">No OpenVibe machine is free right now.</span></button>
</div>
</form>` : `<p class="pty-cta"><a class="oc-button" href="/auth/login?next=%2F">Sign in to start a shared computer</a></p>`;
        const start = signedIn
            ? `<form class="pty-paste" method="get" action="/new">
<label for="party-media">Paste a video link</label>
<div class="pty-paste-row"><input id="party-media" name="media" type="url" inputmode="url" autocomplete="off" required placeholder="https://openvibe.video/watch?v=…"><button type="submit" class="oc-button">Start a party</button></div>
<p class="pty-hint">A recording, a clip or an upload on OpenVibe.Video, or a video file on OpenVibe.</p>
</form>`
            : '';
        const grid = picks.length ? `<section class="pty-pick" aria-labelledby="pty-pick-h">
<h2 id="pty-pick-h">Pick something to watch</h2>
<ul class="pty-grid">${picks.map((x) => `<li class="pty-card"><a href="${esc(startHref(x))}">
<span class="pty-thumb">${sized(x.thumbnail_url, 480) ? `<img src="${esc(sized(x.thumbnail_url, 480))}" alt="" loading="lazy" decoding="async">` : '<span class="pty-thumb-none" aria-hidden="true"></span>'}${duration(x.duration_s) ? `<span class="pty-dur">${esc(duration(x.duration_s))}</span>` : ''}<span class="pty-go" aria-hidden="true">Watch together</span></span>
<span class="pty-title">${esc(x.title)}</span>
${x.channel ? `<span class="pty-by">@${esc(String(x.channel).slice(0, 40))}</span>` : ''}
</a></li>`).join('')}</ul>
<p class="pty-more"><a href="https://openvibe.video/">More on OpenVibe.Video</a>: every watch page has a Watch together button.</p>
</section>` : '';
        await page(req, res, 200, {
            actor, title: 'Watch together', path: '/', robots: 'index, follow', footer: 'full', partyHome: true,
            description: DESCRIPTION,
            body: `<header class="pty-hero">
<p class="pty-eyebrow">OpenVibe.Party</p>
<h1>Share a computer with friends</h1>
<p class="oc-lede">Open a browser or music service together. Everyone sees and hears the same desktop, with one remote and a chat.</p>
${error}
${desktopStart}
</header>
${yours}
<section class="pty-other" aria-labelledby="pty-other-h"><h2 id="pty-other-h">Other ways to watch</h2>${start}</section>
<section class="pty-radio" aria-labelledby="pty-radio-h"><h2 id="pty-radio-h">OpenVibe Radio</h2><p>Listen together using music its creator has shared for streaming. Every track shows its source and licence.</p>
${tracks.length ? `<ul class="pty-radio-list">${tracks.slice(0, 12).map((t) => `<li><div><strong>${esc(t.title)}</strong><span>${esc(t.artist)}${t.ai_made ? ' · AI-made music' : ''}</span><small>Source: ${esc(radioSource(t.source))} · <a href="${esc(t.licence_url)}">${esc(radioLicence(t.licence))}</a>${t.source_url ? ` · <a href="${esc(t.source_url)}">Original source</a>` : ''}</small></div><a class="oc-button" href="/new?radio=${encodeURIComponent(t.id)}">Listen together</a></li>`).join('')}</ul>` : '<p>No Radio tracks are published yet. Creators can mark their own audio uploads as music on OpenVibe.Download.</p>'}
<p>To listen to Spotify or YouTube Music together, start a shared computer and open the service inside it.</p></section>
${grid}
<section class="pty-how" aria-labelledby="pty-how-h">
<h2 id="pty-how-h">How it works</h2>
<ol>
<li><strong>Pick a video</strong><span>Any recording, clip or upload on OpenVibe.Video.</span></li>
<li><strong>Send the invite</strong><span>The link lets your friends in. Nobody else finds the party.</span></li>
<li><strong>Watch in step</strong><span>Whoever holds the remote plays, pauses and skips for everyone.</span></li>
</ol>
</section>`,
        });
    });

    // GET /new asks before it starts anything: a link (Watch together on a video page, or one pasted anywhere) must never
    // start a party in a signed-in person's name on its own. The page names what will play; Start is a same-origin POST.
    router.get('/new', async (req, res) => {
        const actor = await viewerOf(req);
        if (actor.kind !== 'user') return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (req.query.desktop) {
            const hosting = String(req.query.desktop);
            if (hosting !== 'link' && hosting !== 'openvibe') return res.redirect(303, '/');
            if (hosting === 'openvibe') return page(req, res, 503, { actor, title: 'No OpenVibe computer is free', path: '/new', robots: 'noindex, nofollow', footer: 'compact', partyHome: true,
                body: '<section class="oc-party-confirm pty-confirm"><h1>No OpenVibe machine is free right now</h1><p>You can host this party on your own computer with Link.</p><p><a class="oc-button" href="/new?desktop=link">Host it on my computer</a></p></section>' });
            return page(req, res, 200, { actor, title: 'Start a shared computer', path: '/new', robots: 'noindex, nofollow', footer: 'compact', partyHome: true,
                body: `<section class="oc-party-confirm pty-confirm"><h1>Start a shared computer?</h1><p>Link runs a temporary browser in a container on your computer. People you invite can watch, and you can pass the remote.</p><p class="oc-muted">It needs the OpenVibe Link app on this computer. <a href="https://openvibe.link">Get Link</a></p><form method="post" action="/new"><input type="hidden" name="desktop_hosting" value="link"><button class="oc-button" type="submit">Start the party</button> <a href="/" class="oc-muted">Not now</a></form></section>` });
        }
        if (req.query.radio) {
            let chosen;
            try { chosen = await radio.track(String(req.query.radio)); } catch { return res.redirect(303, '/?error=That%20Radio%20track%20is%20not%20available'); }
            return page(req, res, 200, { actor, title: 'Start a listening party', path: '/new', robots: 'noindex, nofollow', footer: 'compact', partyHome: true,
                body: `<section class="oc-party-confirm pty-confirm"><h1>Start a listening party?</h1><p class="oc-lede"><strong>${esc(chosen.title)}</strong> by ${esc(chosen.artist)}</p><p>Source: ${esc(radioSource(chosen.source))} · <a href="${esc(chosen.licence_url)}">${esc(radioLicence(chosen.licence))}</a>${chosen.ai_made ? ' · AI-made music' : ''}</p><p>Everyone hears the track at the party’s position. You control the queue and can allow everyone to add and skip.</p><form method="post" action="/new"><input type="hidden" name="radio_track_id" value="${esc(chosen.id)}"><button class="oc-button" type="submit">Start listening</button></form></section>` });
        }
        const asked = String(req.query.media || '').trim();
        if (!asked) return res.redirect(303, `/?error=${encodeURIComponent('Paste an OpenVibe link to start a party')}`);
        const want = await playable({ media: asked, title: String(req.query.title || '').replace(/\s+/g, ' ').trim().slice(0, 200), source: req.query.source_url ? String(req.query.source_url).slice(0, 2048) : '' });
        if (!want) return res.redirect(303, `/?error=${encodeURIComponent('That link is not a video anyone can watch together: it may be private, still processing, or not on OpenVibe.')}`);
        const media = want.media;
        const title = want.title || titleFromMedia(media);
        const source = want.source || '';
        let host = '';
        try { host = new URL(source || media).hostname; } catch { host = ''; }
        await page(req, res, 200, {
            actor, title: 'Start a party', path: '/new', robots: 'noindex, nofollow', footer: 'compact',
            partyHome: true,
            body: `<section class="oc-party-confirm pty-confirm">
<h1>Start a watch party?</h1>
${want.thumb && sized(want.thumb, 640) ? `<img class="pty-confirm-thumb" src="${esc(sized(want.thumb, 640))}" alt="" decoding="async">` : ''}
<p class="oc-lede"><strong>${esc(title)}</strong>${host ? ` <span class="oc-muted">from ${esc(host)}</span>` : ''}</p>
<p class="oc-muted">Everyone you invite watches the same moment, with a chat beside it. You hold the remote, and you can pass it on.</p>
<form method="post" action="/new">
<input type="hidden" name="media" value="${esc(media)}">
<input type="hidden" name="title" value="${esc(title)}">
${source ? `<input type="hidden" name="source_url" value="${esc(source)}">` : ''}
<button type="submit" class="oc-button">Start the party</button> <a href="/" class="oc-muted">Not now</a>
</form>
</section>`,
        });
    });

    router.post('/new', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
        const actor = await viewerOf(req);
        if (actor.kind !== 'user') return res.redirect(303, '/auth/login?next=%2F');
        // Started from this site only: a cookie-carrying POST from anywhere else is refused.
        const origin = String(req.get('origin') || '');
        const fetchSite = String(req.get('sec-fetch-site') || '');
        if ((origin && origin !== base) || (fetchSite && fetchSite !== 'same-origin')) return res.status(403).type('text/plain').send('Start a party from openvibe.party itself.');
        if (req.body && req.body.desktop_hosting) {
            try {
                const out = await parties.createDesktop(actor.user, { desktop_hosting: String(req.body.desktop_hosting), title: 'Shared computer' });
                return res.redirect(303, `/p/${encodeURIComponent(out.party.id)}?k=${encodeURIComponent(out.join_secret)}`);
            } catch (err) {
                return res.redirect(303, `/?error=${encodeURIComponent(err instanceof parties.PartyError ? err.message : 'The shared computer could not be started')}`);
            }
        }
        if (req.body && req.body.radio_track_id) {
            try {
                const out = await radio.start(actor.user, { radio_track_id: String(req.body.radio_track_id) });
                return res.redirect(303, `/p/${encodeURIComponent(out.party.id)}?k=${encodeURIComponent(out.join_secret)}`);
            } catch (err) {
                return res.redirect(303, `/?error=${encodeURIComponent(err instanceof parties.PartyError ? err.message : 'That listening party could not be started')}`);
            }
        }
        const asked = String((req.body && req.body.media) || '').trim();
        if (!asked) return res.redirect(303, `/?error=${encodeURIComponent('Paste an OpenVibe link to start a party')}`);
        // A watch page posted here directly (not through the confirmation) is made playable the same way.
        const want = await playable({ media: asked, title: String((req.body && req.body.title) || '').replace(/\s+/g, ' ').trim().slice(0, 200), source: (req.body && req.body.source_url) || '' });
        if (!want) return res.redirect(303, `/?error=${encodeURIComponent('That link is not a video anyone can watch together: it may be private, still processing, or not on OpenVibe.')}`);
        const media = want.media;
        const title = want.title || titleFromMedia(media);
        try {
            const out = await parties.create(actor.user, { media, source_url: want.source || null, title });
            return res.redirect(303, `/p/${encodeURIComponent(out.party.id)}?k=${encodeURIComponent(out.join_secret)}`);
        } catch (err) {
            const message = err instanceof parties.PartyError ? err.message : 'That party could not be started';
            return res.redirect(303, `/?error=${encodeURIComponent(message)}`);
        }
    });

    const notFound = async (req, res) => page(req, res, 404, {
        title: 'Page not found', path: req.path, robots: 'noindex, nofollow', footer: 'compact',
        body: `<h1>This party is not here</h1><p class="oc-muted">The link may be wrong, or the party may have ended.</p><p><a class="oc-button" href="/">Start a party</a></p>`,
    });

    router.get('/p/:slug', async (req, res, next) => {
        try {
            const actor = await viewerOf(req);
            const user = actor.kind === 'user' ? actor.user : null;
            const row = await parties.bySlug(req.params.slug);
            const party = parties.partyOf(row);
            const key = req.query.k;
            // The link's secret is the invitation: joining it here is the same path the API's join uses. A person who
            // is already a member is simply let in. An ended party (or a banned account) still shows its page.
            if (row && party && user && parties.keyMatches(party, key)) {
                try { await parties.joinWithLink(row, party, user, key); } catch (err) {
                    if (!(err instanceof parties.PartyError)) throw err;
                    if (err.status === 404) return await notFound(req, res);
                }
            }
            const out = row && party ? await parties.detail(row, party, { user, key }) : null;
            if (!out) return await notFound(req, res);
            await page(req, res, 200, {
                actor, title: out.title, path: `/p/${out.id}`, robots: 'noindex, nofollow', footer: 'compact',
                description: 'Watch together on OpenVibe.',
                mainAttrs: `data-party="${esc(out.id)}"`, party: true, wide: true,
                body: `<article class="oc-party${out.kind === 'radio' ? ' is-radio' : ''}">
<header class="oc-party-head"><h1>${esc(out.title)}</h1><p class="oc-muted">Started by ${esc(out.host_name || 'someone')}</p></header>
<div class="oc-party-stage" data-party-stage aria-label="${out.kind === 'radio' ? 'The music stage' : 'The video'}"></div>
<div class="oc-party-people" data-party-people aria-label="People here"></div>
<div class="oc-party-chat" data-party-chat aria-label="Chat"></div>
<div class="oc-party-remote" data-party-remote aria-label="The remote"></div>
<div class="oc-party-invite" data-party-invite aria-label="Invite"></div>
</article>
<script type="application/json" id="party-data">${escJson({ party: out, server_time_ms: Date.now() })}</script>`,
            });
        } catch (err) { next(err); }
    });

    // The party host's own 404 for a browser (the same words as Chat's), and the JSON 404 for anything else.
    router.use((req, res, next) => {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || /^\/(api|internal|ws|auth|shared|web)(\/|$)/.test(req.path)) return next();
        return page(req, res, 404, {
            title: 'Page not found', path: req.path, robots: 'noindex, nofollow', footer: 'compact',
            body: `<h1>Page not found</h1><p><a href="/">Start a party</a></p>`,
        }).catch(next);
    });

    return { router, isPartyHost };
}

module.exports = { createPartyRoutes, titleFromMedia, SITE };
