'use strict';
/**
 * Known OpenVibe links in a message get a card with the one move that link is for (plan HO, one account across every
 * site: a pasted video, party invite, shared voice or skill shows what it is and one button).
 *
 *   openvibe.video /watch?v=, /v/<n>, /c/<n>   MediaHub /api/v1/video/watchable → a card: "Watch together"
 *   openvibe.party /p/<slug>?k=…               Chat's own party (the link's secret must match) → "Join the party"
 *   openvibe.actor /voices/<id>                GET /voices/<id>.json → "Borrow this agent"
 *   openvibe.actor /skills/<slug>              GET /skills/<slug>.json → "Install", unless the scan failed
 *
 * Only exact hosts and path shapes are known, and the pasted URL is never fetched: it is a query parameter for
 * Video's own resolver (https://openvibe.video/api/v1/video/watchable?url=), a database key for a party, and a path
 * under Actor's fixed origin for the other two. A 404 (a private video, a stopped voice, no such skill), a party
 * without its k=, an unknown host or an unreachable service is no card. Every request refuses redirects, gives up
 * after 2.5 s, and is cached a minute per URL; a failed lookup caches its nothing for that minute too.
 *
 * One card per message: the first *known* link. The card's text is data: escaped where HTML is drawn (server/web/ui.js
 * and public/web/chat.js), cut to size here, and a picture is only ever https on openvibe.media. The card is stored on
 * the row as JSON when the message is sent; a read resolves a stored card again only once it is older than a day.
 */
const db = require('../db/database');

const CACHE_MS = 60_000;
const FRESH_MS = 86_400_000;
const MAX_TITLE = 120;
const MAX_LINE = 200;
const MAX_NOTE = 160;
const KINDS = ['video', 'party', 'voice', 'skill'];

// A test names its own stand-in; a test that does not never reaches the real site (the same rule as party-pages.js).
const baseOf = (value, production) => {
    const raw = String(value || (process.env.NODE_ENV === 'test' ? '' : production)).replace(/\/+$/, '');
    if (!raw) return '';
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' || u.protocol === 'http:' ? raw : '';
    } catch { return ''; }
};
const videoBase = () => baseOf(process.env.CHAT_LINK_VIDEO_URL, 'https://openvibe.video');
const actorBase = () => baseOf(process.env.CHAT_LINK_ACTOR_URL, 'https://openvibe.actor');
const partyBase = () => String(process.env.CHAT_PARTY_URL || 'https://openvibe.party').replace(/\/+$/, '');

const cache = new Map(); // key → { at, value }

/** One lookup, cached a minute. A failed lookup keeps the previous answer if there was one, else null. */
async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value = null;
    try { value = await fn(); } catch { value = hit ? hit.value : null; }
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
}

/** A JSON read from a fixed origin and path: no redirects, 2.5 s, null on anything but a 200. */
async function readJson(base, path) {
    if (!base) return null;
    return await cached(`${base}${path}`, async () => {
        const r = await fetch(`${base}${path}`, {
            headers: { accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(2500),
        });
        return r.ok ? await r.json() : null;
    });
}

/** Plain card text: control characters gone, whitespace collapsed, cut to size (by character, so an emoji survives). */
function textOf(value, max) {
    const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(text).slice(0, max).join('');
}

/** A card's picture: https on openvibe.media, nothing else (a title cannot point the browser elsewhere). */
function imageOf(value) {
    if (typeof value !== 'string') return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
        return u.hostname.toLowerCase() === 'openvibe.media' ? u.href : null;
    } catch { return null; }
}

const duration = (sec) => {
    const n = Number(sec);
    if (!(n > 0)) return '';
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = Math.floor(n % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

/** A URL on one of Video's watch-page shapes: /watch?v=<11 chars>, /v/<n> or /c/<n> (the recording and clip pages). */
function videoLink(u) {
    if (u.hostname.toLowerCase().replace(/^www\./, '') !== 'openvibe.video') return null;
    if (u.pathname === '/watch') {
        return /^[A-Za-z0-9_-]{11}$/.test(String(u.searchParams.get('v') || '')) ? { kind: 'video', page: u.href } : null;
    }
    if (/^\/[vc]\/[0-9]{1,12}$/.test(u.pathname)) return { kind: 'video', page: u.href };
    return null;
}

/** A party's invite: /p/<slug>, with its secret in k=. Without k= there is no card (the page would 404 anyway). */
function partyLink(u) {
    if (u.hostname.toLowerCase().replace(/^www\./, '') !== 'openvibe.party') return null;
    const m = /^\/p\/([A-Za-z0-9][A-Za-z0-9-]{0,63})$/.exec(u.pathname);
    const key = String(u.searchParams.get('k') || '');
    if (!m || !key || key.length > 200) return null;
    return { kind: 'party', page: u.href, slug: m[1], key };
}

/** Actor's public pages: a shared voice (/voices/shv_…) and a skill (/skills/<slug>). */
function actorLink(u) {
    if (u.hostname.toLowerCase().replace(/^www\./, '') !== 'openvibe.actor') return null;
    const voice = /^\/voices\/(shv_[0-9A-HJKMNP-TV-Z]{26})$/.exec(u.pathname);
    if (voice) return { kind: 'voice', page: u.href, id: voice[1] };
    const skill = /^\/skills\/([a-z0-9][a-z0-9-]{0,63})$/.exec(u.pathname);
    if (skill) return { kind: 'skill', page: u.href, slug: skill[1] };
    return null;
}

function known(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return videoLink(u) || partyLink(u) || actorLink(u);
}

/** The message's first *known* link, if it has one. Trailing punctuation a sentence leaves on a URL is dropped. */
function firstLink(text) {
    const urls = String(text || '').match(/https?:\/\/[^\s<>"']+/g) || [];
    for (const raw of urls) {
        if (raw.length > 2048) continue;
        const link = known(raw.replace(/[.,;:!?]+$/, '').replace(/\)+$/, ''));
        if (link) return link;
    }
    return null;
}

const SCAN_WORDS = {
    passed: 'The scan found nothing to worry about.',
    flagged: 'The scan found something to read before you install this.',
    failed: 'The scan found something that stops this skill from being installed.',
    pending: 'This skill has not been scanned yet.',
};

async function videoCard(link) {
    const base = videoBase();
    if (!base) return null;
    const item = await readJson(base, `/api/v1/video/watchable?url=${encodeURIComponent(link.page)}`);
    if (!item || typeof item !== 'object') return null;
    const title = textOf(item.title, MAX_TITLE);
    if (!title) return null;
    const line = [duration(item.duration_s), textOf(item.channel, 60)].filter(Boolean).join(' \u00b7 ');
    return {
        kind: 'video',
        url: link.page,
        title,
        line: line || 'A video on OpenVibe.Video',
        image: imageOf(item.thumbnail_url),
        action: { label: 'Watch together', href: `${partyBase()}/new?media=${encodeURIComponent(link.page)}` },
    };
}

async function partyCard(link) {
    const found = await cached(`party:${link.slug}:${link.key}`, async () => {
        const parties = require('../rooms/parties');
        const row = await parties.bySlug(link.slug);
        const party = parties.partyOf(row);
        if (!row || !party || party.ended_at || !parties.keyMatches(party, link.key)) return null;
        const host = await db.get('SELECT username, display_name FROM ctx_users WHERE subject_id = ? LIMIT 1', [party.host_subject]);
        return { title: row.name, host: host ? (host.display_name || host.username) : null };
    });
    if (!found) return null;
    return {
        kind: 'party',
        url: link.page,
        title: textOf(found.title, MAX_TITLE) || 'A watch party',
        line: found.host ? `Started by ${textOf(found.host, 60)}` : 'A watch party on OpenVibe',
        image: null,
        action: { label: 'Join the party', href: link.page },
    };
}

async function voiceCard(link) {
    const base = actorBase();
    if (!base) return null;
    const voice = await readJson(base, `/voices/${link.id}.json`);
    if (!voice || typeof voice !== 'object') return null;
    const title = textOf(voice.name, MAX_TITLE);
    if (!title) return null;
    return {
        kind: 'voice',
        url: link.page,
        title,
        line: textOf(voice.bio, MAX_LINE) || 'A shared agent on OpenVibe.Actor',
        image: null,
        action: { label: 'Borrow this agent', href: link.page },
    };
}

async function skillCard(link) {
    const base = actorBase();
    if (!base) return null;
    const listing = await readJson(base, `/skills/${link.slug}.json`);
    const skill = listing && listing.skill;
    if (!skill || typeof skill !== 'object') return null;
    const title = textOf(skill.name, MAX_TITLE);
    if (!title) return null;
    const state = String((listing.scan && listing.scan.state) || '');
    return {
        kind: 'skill',
        url: link.page,
        title,
        line: textOf(skill.description, MAX_LINE) || 'A skill for OpenVibe.Actor',
        note: textOf(SCAN_WORDS[state] || SCAN_WORDS.pending, MAX_NOTE),
        image: null,
        // A failed scan never installs: no button. A flagged one installs on Actor's page after the person reads it.
        action: state === 'failed' ? null : { label: 'Install', href: link.page },
    };
}

/** The card for a message body: null unless it carries one of the known kinds, stamped with when it was resolved. */
async function resolve(text) {
    try {
        const link = firstLink(text);
        if (!link) return null;
        const card = link.kind === 'video' ? await videoCard(link)
            : link.kind === 'party' ? await partyCard(link)
                : link.kind === 'voice' ? await voiceCard(link)
                    : await skillCard(link);
        if (!card || !KINDS.includes(card.kind) || !card.title) return null;
        return { ...card, at: Date.now() };
    } catch { return null; }
}

/** The stored card as an object. Anything else (null, bad JSON, an old shape) is no card. */
function parse(value) {
    if (!value) return null;
    let card = value;
    if (typeof card === 'string') {
        try { card = JSON.parse(card); } catch { return null; }
    }
    if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
    return KINDS.includes(card.kind) && typeof card.title === 'string' && card.title ? card : null;
}

/**
 * The card to show for a row: the stored one while it is under a day old; older than that, the link resolved again
 * (the title may have changed, the party may have ended, the video become private — then there is no card).
 */
async function onRead(text, stored) {
    const card = parse(stored);
    if (!card) return null;
    if (Date.now() - (Number(card.at) || 0) < FRESH_MS) return card;
    return await resolve(text);
}

/** Fill `row.card` on message rows (chat_messages/dm_messages: message; inbox_messages: body). */
async function hydrate(rows) {
    if (!Array.isArray(rows)) return rows;
    await Promise.all(rows.map(async (row) => {
        if (!row) return;
        row.card = await onRead(row.message != null ? row.message : row.body, row.card);
    }));
    return rows;
}

/** The JSON stored on the row at send time (null for no card). */
const toJson = (card) => (card ? JSON.stringify(card) : null);

module.exports = {
    resolve, parse, onRead, hydrate, toJson, firstLink, known, imageOf,
    MAX_TITLE, MAX_LINE, MAX_NOTE, FRESH_MS,
};
