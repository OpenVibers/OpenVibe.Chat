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
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');

const SITE_NAME = 'OpenVibe.Chat';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'OpenVibe.Chat: the network-wide chat room and your direct messages, one account across every OpenVibe site.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public', 'web');
const LINKS = [
    { key: 'global', label: 'Global chat', href: '/' },
    { key: 'messages', label: 'Messages', href: '/messages' },
    { key: 'settings', label: 'Settings', href: '/settings' },
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hashes = new Map();
function asset(rel) {
    if (!hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
        hashes.set(rel, v);
    }
    return `/web/${rel}?v=${hashes.get(rel)}`;
}

function navConfig(o, config) {
    return {
        service: 'chat',
        apiBase: NETWORK_URL,
        links: LINKS.map((l) => ({ label: l.label, href: l.href, active: o.active === l.key })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${config.web.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${encodeURIComponent(o.path || '/')}`,
        logoutUrl: '/auth/logout?next={path}',
    };
}

/**
 * o: title, description, path, robots (required), body, active, actor, config, page (JSON for chat.js),
 * prefs (the person's chat preferences: timestamps, compact, font_scale, show_badges)
 */
function renderPage(o) {
    const { config } = o;
    if (!o.robots) throw new TypeError('renderPage needs explicit robots');
    const title = o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME;
    const head = sharedSeo.headTags({
        title, description: o.description || DEFAULT_DESCRIPTION, canonical: `${config.web.baseUrl}${o.path || '/'}`,
        robots: o.robots, siteName: SITE_NAME, type: 'website',
    });
    const actor = o.actor || { kind: 'anonymous' };
    const who = actor.kind === 'user'
        ? `<span>Signed in as ${esc(actor.user.display_name || actor.user.username)}</span> · <a href="/auth/logout?next=${encodeURIComponent(o.path || '/')}">Sign out</a>`
        : `<a href="/auth/login?next=${encodeURIComponent(o.path || '/')}">Sign in with OpenVibe</a>`;
    const p = o.prefs || {};
    const cls = [p.compact ? 'oc-compact' : '', p.timestamps ? 'oc-times' : '', p.show_badges === false ? 'oc-nobadges' : ''].filter(Boolean).join(' ');
    const scale = typeof p.font_scale === 'number' ? ` style="--oc-scale:${Math.min(1.4, Math.max(0.8, p.font_scale))}"` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
${appIcon.headTags({ site: 'network' })}
<link rel="stylesheet" href="${asset('chat.css')}">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
${o.script ? `<script src="${asset('chat.js')}" defer></script>` : ''}
</head>
<body class="${cls}"${scale}>
<a class="oc-skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: SITE_NAME, home: '/', links: LINKS.map(({ label, href }) => ({ label, href })) })}
<header class="oc-bar"><a class="oc-brand" href="/">${SITE_NAME}</a><nav class="oc-tabs" aria-label="Chat">${LINKS.map((l) => `<a href="${l.href}"${o.active === l.key ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}</nav><noscript><span class="oc-account">${who}</span></noscript></header>
<main id="main" class="oc-main">
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
}

module.exports = { renderPage, asset, esc, SITE_NAME, DEFAULT_DESCRIPTION, NETWORK_URL };
