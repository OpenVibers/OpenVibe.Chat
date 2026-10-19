'use strict';
/**
 * openvibe.chat page shell (server/web/). Every page is server-rendered and readable without
 * JavaScript; the OpenVibe Frame (navbar, footer, themes) comes from this site's own /shared/ copy of
 * openvibe-shared, and public/web/chat.js adds the live feed and the composer.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ovServe = require('openvibe-shared/serve');
const sharedSeo = require('openvibe-shared/seo');
const social = require('openvibe-shared/social');
const appIcon = require('openvibe-shared/app-icon');
// A crawlable icon (search engines cannot use the data: favicon) and the installable app's manifest, both the shared set.
const INSTALL_LINKS = [
    `<link rel="apple-touch-icon" href="${require('openvibe-shared/app-icons').url('chat', 192)}">`,
    `<link rel="manifest" href="${ovServe.manifestUrl('chat')}">`,
].join('\n');
const frame = require('openvibe-shared/frame');

const SITE_NAME = 'OpenVibe.Chat';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'OpenVibe.Chat: the network-wide chat room and your direct messages, one account across every OpenVibe site.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public', 'web');
const LINKS = [
    { key: 'global', label: 'Global chat', href: '/' },
    { key: 'rooms', label: 'Rooms', href: '/rooms' },
    { key: 'servers', label: 'Servers', href: '/servers' },
    { key: 'messages', label: 'Messages', href: '/messages' },
    { key: 'settings', label: 'Settings', href: '/settings' },
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hashes = new Map();
/** The content hash in a /web asset's URL: what `?v=` must equal for the bytes to be immutable. */
function assetVersion(rel) {
    if (!hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
        hashes.set(rel, v);
    }
    return hashes.get(rel);
}
function asset(rel) {
    return `/web/${rel}?v=${assetVersion(rel)}`;
}

/** The site's links, with the signed-in person's unread counts (o.counts: { rooms, messages }). */
function links(o) {
    const counts = o.counts || {};
    return LINKS.map((l) => ({ key: l.key, href: l.href, label: counts[l.key] > 0 ? `${l.label} (${counts[l.key] > 99 ? '99+' : counts[l.key]})` : l.label }));
}

function navConfig(o, config) {
    return {
        service: 'chat',
        apiBase: NETWORK_URL,
        links: links(o).map((l) => ({ label: l.label, href: l.href, active: o.active === l.key })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${config.web.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${encodeURIComponent(o.path || '/')}`,
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
}

/**
 * The pages' Content-Security-Policy. Chat renders other people's words live, so injected script is the risk this
 * stops: scripts only from this site (and Cloudflare's analytics beacon), inline ones only with this response's
 * nonce. Styles may be inline (style attributes), pictures and media come from anywhere over https (posted
 * pictures, avatars), and connections go to this site, Network (sign-in, the Frame) and Events (release and
 * notification streams). Checked on production pages with the policy attached before shipping (2026-10-17).
 */
function contentSecurityPolicy(nonce) {
    return [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' wss://openvibe.chat https://openvibe.network wss://openvibe.network https://openvibe.events wss://openvibe.events https://cloudflareinsights.com",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self' https://openvibe.network",
    ].join('; ');
}

/**
 * o: title, description, path, robots (required), body, active, actor, config, page (JSON for chat.js), nonce (the
 * response's CSP nonce: every inline <script> carries it),
 * prefs (the person's chat preferences: timestamps, compact, font_scale, show_badges), counts (unread
 * rooms/messages for the navigation), script / callScript / ringScript (public/web/chat.js, call.js, ring.js: a call
 * coming in, on every page of a signed-in person while calls are on)
 */
function renderPage(o) {
    const { config } = o;
    if (!o.robots) throw new TypeError('renderPage needs explicit robots');
    const title = o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME;
    const head = sharedSeo.headTags({
        title, description: o.description || DEFAULT_DESCRIPTION, canonical: `${config.web.baseUrl}${o.path || '/'}`,
        robots: o.robots, siteName: SITE_NAME, type: 'website', jsonLd: o.jsonLd,
        // Indexable pages share the site's card (openvibe-shared/social); private ones advertise nothing.
        image: /^index/.test(o.robots) ? social.url('chat') : undefined, imageAlt: /^index/.test(o.robots) ? SITE_NAME : undefined,
    });
    const actor = o.actor || { kind: 'anonymous' };
    const who = actor.kind === 'user'
        ? `<span>Signed in as ${esc(actor.user.display_name || actor.user.username)}</span> · <a href="/auth/logout?next=${encodeURIComponent(o.path || '/')}">Sign out</a>`
        : `<a href="/auth/login?next=${encodeURIComponent(o.path || '/')}">Sign in with OpenVibe</a>`;
    const p = o.prefs || {};
    const cls = [p.compact ? 'oc-compact' : '', p.timestamps ? 'oc-times' : '', p.show_badges === false ? 'oc-nobadges' : ''].filter(Boolean).join(' ');
    const scale = typeof p.font_scale === 'number' ? ` style="--oc-scale:${Math.min(1.4, Math.max(0.8, p.font_scale))}"` : '';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
${appIcon.headTags({ site: 'network' })}
${INSTALL_LINKS}
<link rel="stylesheet" href="${asset('chat.css')}">
<link rel="stylesheet" href="${ovServe.url('items.css')}">
${o.showcase ? `<link rel="stylesheet" href="${ovServe.url('showcase.css')}">` : ''}
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
${o.script ? `<script src="${asset('chat.js')}" defer></script>` : ''}
${o.callScript ? `<script src="${asset('call.js')}" defer></script>` : ''}
${o.ringScript ? `<script src="${asset('ring.js')}" defer></script>` : ''}
</head>
<body class="${cls}"${scale}>
<a class="oc-skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: links(o).map(({ label, href }) => ({ label, href })) })}
<main id="main" class="oc-main${o.wide ? ' oc-main--wide' : ''}">
<noscript><p class="oc-account">${who}</p></noscript>
${o.body || ''}
</main>
${frame.footer({ service: 'chat', variant: 'full', updates: '/updates' })}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: navConfig(o, config), footer: { service: 'chat', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' }, chat: o.page || null }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
    return o.nonce ? html.replace(/<script>/g, `<script nonce="${o.nonce}">`) : html;
}

module.exports = { renderPage, contentSecurityPolicy, asset, assetVersion, esc, SITE_NAME, DEFAULT_DESCRIPTION, NETWORK_URL };
