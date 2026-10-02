'use strict';
/**
 * Crawl and machine-readability artifacts for openvibe.chat (plan T11): robots.txt, llms.txt and
 * sitemap.xml, built from openvibe-shared/seo — the same toolkit the other OpenVibe sites use.
 *
 * Every answer comes from public data only and never from the viewer: the global chat's last public
 * message, the rooms that are public and unarchived, and the site's own fixed pages. Direct
 * messages, your conversations, room settings, sign-in and the API are in no artifact.
 *
 * lastmod is the data's own timestamp (the newest public message, the room's last_message_at or its
 * created_at) — never "today", which would tell crawlers the whole site changed on every fetch.
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const historyStore = require('../chat/history-store');
const rooms = require('../rooms/rooms');

/** A SQLite `DATETIME` ("YYYY-MM-DD HH:MM:SS", UTC) or ISO string as YYYY-MM-DD; null when unusable. */
function dayOf(ts) {
    const s = String(ts == null ? '' : ts);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

/** Public, indexable pages: the fixed ones plus every public room, each with a real lastmod. */
async function publicPages() {
    const pages = (await rooms.list(null, { limit: 100 })).public;
    const out = [
        { path: '/', changefreq: 'hourly', priority: 1.0, lastmod: async () => await newestGlobalMessage() },
        { path: '/rooms', changefreq: 'daily', priority: 0.8, lastmod: () => newestRoomActivity(pages) },
        { path: '/updates', changefreq: 'daily', priority: 0.5 },
    ];
    for (const r of pages) {
        out.push({ path: `/r/${r.slug}`, changefreq: 'daily', priority: 0.6, lastmod: () => dayOf(r.last_message_at || r.created_at) });
    }
    return out;
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
    const description = 'The network-wide chat room of OpenVibe: everyone on every OpenVibe site, in one conversation, with rooms and direct messages.';
    return [
        seo.jsonLd.website({ name, url: site, description }),
        seo.jsonLd.softwareApp({
            name, url: site, description, category: 'SocialNetworkingApplication',
            keywords: 'chat, rooms, direct messages, openvibe',
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
            allow: ['/', '/updates', '/rooms', '/r/'],
            disallow: ['/r/*/settings', '/messages', '/settings', '/auth/', '/api/'],
        }));
    });

    router.get('/llms.txt', (req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsTxt({
            name: 'OpenVibe.Chat',
            summary: 'OpenVibe.Chat: the network-wide chat room of OpenVibe, plus its rooms and the direct messages of its members.',
            details: 'One OpenVibe account works here and on every other OpenVibe site. Anyone can read the global chat and the public rooms without an account; posting needs a signed-in person. The global chat and the public room pages are readable as plain HTML without JavaScript and update live over the site\'s own WebSocket. Direct messages, room settings and the API are per-person and are never listed here.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Global chat', url: abs('/'), note: 'one room for everyone on OpenVibe, newest messages at the end' },
                    { title: 'Rooms', url: abs('/rooms'), note: 'every public room, with its topic and activity' },
                    { title: 'What shipped on OpenVibe.Chat', url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml'), note: 'the public pages above' },
                    { title: 'robots.txt', url: abs('/robots.txt') },
                ] },
            ],
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

    return router;
}

module.exports = { createDiscoveryRoutes, publicPages, dayOf, homeJsonLd };
