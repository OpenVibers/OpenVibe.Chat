'use strict';
/**
 * Crawl and machine-readability artifacts for openvibe.chat (plan T11): robots.txt, llms.txt,
 * llms-full.txt and sitemap.xml, built from openvibe-shared/seo — the same toolkit the other
 * OpenVibe sites use.
 *
 * Every answer comes from public data only and never from the viewer: the global chat's last public
 * message, the rooms that are public and unarchived, and the site's own fixed pages. Direct
 * messages, your conversations, room settings, sign-in and the API are in no artifact. llms-full.txt
 * and the sitemap read the same public page catalogue.
 *
 * lastmod is the data's own timestamp (the newest public message, the room's last_message_at or its
 * created_at) — never "today", which would tell crawlers the whole site changed on every fetch.
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const historyStore = require('../chat/history-store');
const rooms = require('../rooms/rooms');

// The date /.well-known/security.txt must be refreshed by: one year on, a person re-reads and re-commits it.
const SECURITY_EXPIRES = '2027-10-29T00:00:00.000Z';

/** A SQLite `DATETIME` ("YYYY-MM-DD HH:MM:SS", UTC) or ISO string as YYYY-MM-DD; null when unusable. */
function dayOf(ts) {
    const s = String(ts == null ? '' : ts);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

/**
 * Public, indexable pages: the fixed ones plus every public room, each with a real lastmod.
 * This is the one page catalogue: /sitemap.xml takes its paths and /llms-full.txt takes its titles
 * and descriptions, so the two can never describe different sites.
 */
async function publicPages() {
    const pages = (await rooms.list(null, { limit: 100 })).public;
    const out = [
        { path: '/', title: 'Global chat', text: 'The whole-network public chat: read the newest messages without an account and without JavaScript; signed-in people post here.', changefreq: 'hourly', priority: 1.0, lastmod: async () => await newestGlobalMessage() },
        { path: '/vibe', title: 'Vibe, OpenVibe\'s assistant', text: 'Chat with Vibe: it searches the web and OpenVibe, reads pages and pictures, remembers what it is asked to and sets up recurring work; each conversation is private to its person.', changefreq: 'weekly', priority: 0.9 },
        { path: '/rooms', title: 'Public rooms', text: 'Every public room without a server, with its topic and activity; anyone can read a public room.', changefreq: 'daily', priority: 0.8, lastmod: () => newestRoomActivity(pages) },
        { path: '/servers', title: 'Public servers', text: 'Public servers: groups with text and voice channels, roles and invites; anyone can read, signed-in people join.', changefreq: 'daily', priority: 0.8 },
        { path: '/updates', title: 'What shipped on OpenVibe.Chat', text: 'The shared changelog for OpenVibe.Chat, newest first.', changefreq: 'daily', priority: 0.5 },
        { path: '/developers', title: 'Developers', text: 'Add a support inbox or a room to any website with one tag, use the visitor API, openvibe-sdk/chat, feeds from Claude Code and signed webhooks; the limits are stated here.', changefreq: 'weekly', priority: 0.6 },
    ];
    for (const r of pages) {
        out.push({
            path: `/r/${r.slug}`,
            title: `${r.name} — public room`,
            text: `Public room${r.topic ? ` about ${r.topic}` : ''}; ${r.kind === 'call' ? 'a voice and video call in the page' : 'a text room'} with ${r.message_count || 0} messages. Anyone can read it.`,
            changefreq: 'daily', priority: 0.6, lastmod: () => dayOf(r.last_message_at || r.created_at),
        });
    }
    // Public servers (server/rooms/servers.js): their front page, the first text channel.
    for (const sv of (await require('../rooms/servers').list(null, { limit: 100 })).public) {
        out.push({
            path: `/s/${sv.slug}`,
            title: `${sv.name} — public server`,
            text: `Public server${sv.description ? `: ${sv.description}` : ''}, with ${sv.members || 0} members and its text and voice channels. Anyone can read it.`,
            changefreq: 'daily', priority: 0.6, lastmod: () => dayOf(sv.created_at),
        });
    }
    return out;
}

/** The legal pages every OpenVibe site serves, named from the shared kit rather than retyped here. */
function legalPages() {
    const labels = { '/terms': 'Terms of use', '/privacy': 'Privacy policy', '/dmca': 'DMCA and takedown policy' };
    return require('openvibe-shared/legal').PATHS.map((path) => ({
        path, title: labels[path] || path.slice(1), text: `The ${(labels[path] || path.slice(1)).toLowerCase()} for OpenVibe.Chat, served by the site itself.`,
    }));
}

async function newestGlobalMessage() {
    try {
        const row = (await historyStore.page('global', { limit: 1 })).messages[0];
        return row ? dayOf(row.timestamp) : null;
    } catch { return null; }
}

function newestRoomActivity(pages) {
    const days = pages.map((r) => dayOf(r.last_message_at || r.created_at)).filter(Boolean).sort();
    return days.length ? days[days.length - 1] : null;
}

/**
 * The home page's JSON-LD: the site as a WebSite, the chat itself as the site's primary type (the
 * shared kit's WebApplication) and the page that carries it. Nothing about the reader or their
 * messages: the same three nodes for every crawler.
 */
function homeJsonLd(config) {
    const site = String(config.web.baseUrl).replace(/\/+$/, '');
    const name = 'OpenVibe.Chat';
    const description = 'Chat with everyone on OpenVibe, start a server with text and voice channels, message friends and call them. Free and open source.';
    return [
        seo.jsonLd.website({ name, url: site, description }),
        seo.jsonLd.softwareApp({
            name, url: site, description, category: 'SocialNetworkingApplication',
            keywords: 'AI assistant, chat, chat rooms, community servers, voice channels, video calls, direct messages, AI chat members, openvibe',
        }),
        seo.jsonLd.webPage({ name: 'Global chat', url: `${site}/`, description, siteUrl: site }),
    ];
}

function createDiscoveryRoutes({ config }) {
    const router = express.Router();
    const site = String(config.web.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;

    router.get('/robots.txt', (req, res) => {
        // The same rules as before, plus the search and AI crawlers the shared kit names by name and
        // the sitemap. Every previous Disallow is kept.
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.robotsTxt({
            sitemaps: [abs('/sitemap.xml')],
            allow: ['/', '/vibe', '/updates', '/developers', '/rooms', '/r/', '/servers', '/s/'],
            // A person's own Vibe chats and memory (/vibe/…) are theirs: never crawled. /vibe itself is the app's front.
            disallow: ['/r/*/settings', '/s/*/settings', '/join/', '/messages', '/settings', '/auth/', '/api/', '/vibe/'],
        }) + `# Agent manifest: ${abs('/.well-known/agent.json')}\n`);
    });

    router.get('/llms.txt', (req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsTxt({
            name: 'OpenVibe.Chat',
            summary: 'OpenVibe.Chat: Vibe, OpenVibe\'s free assistant, global chat for the whole OpenVibe network, the chat of every stream on OpenVibe.Live, servers with text and voice channels, rooms, direct messages, calls and AI members.',
            details: 'One OpenVibe account works here and on every other OpenVibe site. Anyone can read the global chat and the public rooms without an account; posting needs a signed-in person. The global chat and the public room pages are readable as plain HTML without JavaScript and update live over the site\'s own WebSocket. Direct messages, room settings and the API are per-person and are never listed here.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Vibe', url: abs('/vibe'), note: 'OpenVibe\'s assistant: searches the web and OpenVibe, reads pages and pictures, remembers what it is asked to, sets up recurring work; chats are private to the signed-in person' },
                    { title: 'Global chat', url: abs('/'), note: 'one room for everyone on OpenVibe, newest messages at the end' },
                    { title: 'Rooms', url: abs('/rooms'), note: 'every public room, with its topic and activity' },
                    { title: 'Servers', url: abs('/servers'), note: 'public servers: groups with text and voice channels, roles and invites' },
                    { title: 'What shipped on OpenVibe.Chat', url: abs('/updates') },
                ] },
                { title: 'Build with it', links: [
                    { title: 'Developers', url: abs('/developers'), note: 'a support inbox or a room on any website with one tag, the visitor API, openvibe-sdk/chat, feeds from Claude Code, signed webhooks, the limits' },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml'), note: 'the public pages above' },
                    { title: 'robots.txt', url: abs('/robots.txt') },
                ] },
            ],
        }));
    });

    // The full AI map: the llms.txt header, then every public page with what it is. The page list comes
    // from publicPages() — the same catalogue the sitemap uses — plus the shared legal routes, so a page
    // cannot be added to one artifact and forgotten in the other.
    router.get('/llms-full.txt', async (req, res) => {
        const pages = [...(await publicPages()), ...legalPages()].map((p) => ({ url: abs(p.path), title: p.title, text: p.text }));
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsFull({
            site: 'OpenVibe.Chat',
            summary: 'OpenVibe.Chat: the global chat for the whole OpenVibe network, public rooms and servers with text and voice channels, Vibe the assistant, direct messages and calls.',
            base: site,
            maxBytes: 512 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    router.get('/sitemap.xml', async (req, res) => {
        const urls = [];
        for (const p of await publicPages()) {
            const lastmod = p.lastmod ? await p.lastmod() : null;
            urls.push({ loc: abs(p.path), ...(lastmod ? { lastmod } : {}), changefreq: p.changefreq, priority: p.priority });
        }
        res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.sitemapXml(urls));
    });

    // RFC 9116 (SEO-30). Contact, Expires and Canonical are required; Canonical is this site's own, from
    // the config, never a constant. Policy is listed only while https://openvibe.network/security answers
    // 200 (checked 2026-10-29). Expires is the date the file must be refreshed by: one year on, a person
    // re-reads and re-commits it.
    router.get('/.well-known/security.txt', (_req, res) => {
        res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=86400').send([
            'Contact: mailto:security@openvibe.network',
            `Expires: ${SECURITY_EXPIRES}`,
            'Preferred-Languages: en',
            `Canonical: ${abs('/.well-known/security.txt')}`,
            'Policy: https://openvibe.network/security',
            '',
        ].join('\n'));
    });

    return router;
}

module.exports = { createDiscoveryRoutes, publicPages, dayOf, homeJsonLd };
