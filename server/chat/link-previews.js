'use strict';
/**
 * Address previews in a message (plan "embeds", part 1): a message with one or more https addresses gets up to three
 * previews, fetched by a background job after the message is stored — never by the request that sent it, and never
 * for an address the egress module refuses.
 *
 *   { url, site_name, title, description, image, kind: 'link' | 'video' | 'image', width, height }
 *
 * The job reads the page through openvibe-shared/egress: public addresses only (DNS is checked again at connect, so
 * a name that answers a private address is refused), https only, at most two redirects each checked on its own,
 * 4 s and 512 KiB per request, no cookies, a plain user agent. YouTube and Vimeo are read from their oEmbed endpoint
 * on a fixed origin instead of their page. A picture is never hot-linked: a page's own image is brought into
 * OpenVibe.Media first (server/chat/media-import.js), and the card shows the Media address; a picture that cannot
 * be brought in is left off the card.
 *
 * Previews live apart from the message (link_previews) and are cached by address for a day (link_preview_cache), so
 * sending, and every later send of the same address, never waits on another site. The fields are data, never markup:
 * control characters are gone, whitespace folded, sizes capped, and the API/renderer escape them as text.
 *
 * The room wiring (server/rooms/rooms.js) attaches the rows on every read as `embeds` ([] before the job is done),
 * and the job announces `room_message_embeds` when it has something.
 */
const { assertPublicUrl, safeLookup } = require('openvibe-shared/egress');
const db = require('../db/database');
const mediaImport = require('./media-import');

const MAX_URLS = 3;
const MAX_URL = 2048;
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 2;
const CACHE_MS = 86_400_000;       // a found preview is reused a day
const MISS_MS = 10 * 60_000;       // a miss is retried after ten minutes, not hammered
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 300;
const MAX_SITE = 80;
const MAX_JOBS = 2;
const MAX_QUEUE = 200;
const KINDS = ['link', 'video', 'image', 'live', 'picture', 'design', 'post', 'profile', 'game'];
const USER_AGENT = 'OpenVibe-Chat-LinkPreview/1 (+https://openvibe.chat)';
const PREVIEWS_ON = String(process.env.CHAT_LINK_PREVIEWS || '').toLowerCase() !== 'off';

const cache = new Map();           // url → { at, value } (in-process fast path in front of the table)
let _request = null;               // tests: (url) => { status, headers, body }
let _lookup = null;                // tests: dns.lookup stand-in for the egress check
const queue = [];
let running = 0;
let idleWaiters = [];

// ── addresses ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** An https address as a normalized href, or null (http, credentials, a fragment or a very long address is no preview). */
function normalizeUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    u.hash = '';
    const href = u.href;
    return href.length > MAX_URL ? null : href;
}

/**
 * The https addresses in a message body, in order, at most MAX_URLS: trailing sentence punctuation a writer leaves
 * on a URL is not part of it, and the same address twice is one preview.
 */
function addresses(text) {
    const out = [];
    const seen = new Set();
    const re = /https:\/\/[^\s<>"']+/g;
    let m;
    while ((m = re.exec(String(text || ''))) && out.length < MAX_URLS) {
        const href = normalizeUrl(m[0].replace(/[.,;:!?]+$/, '').replace(/\)+$/, ''));
        if (!href || seen.has(href)) continue;
        seen.add(href);
        out.push(href);
    }
    return out;
}

// ── text from a page ─────────────────────────────────────────────────────────────────────────────────────────────

/** Plain text from a page field: controls gone, whitespace folded, a known entity decoded, cut to size. */
function textOf(value, max) {
    const text = String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return Array.from(text).slice(0, max).join('');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
function decodeEntities(value) {
    return String(value == null ? '' : value)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
        .replace(/&([a-z]+|#39);/gi, (all, name) => (Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : all));
}

/** A meta tag's attributes as an object, names lower-cased. */
function attributesOf(tag) {
    const out = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] != null ? m[3] : m[4] != null ? m[4] : m[5]);
    return out;
}

/** The Open Graph and Twitter fields a page states, plus its <title>. Only the first answer of each name counts. */
function pageFields(html) {
    const fields = {};
    const metas = String(html || '').match(/<meta\b[^>]*>/gi) || [];
    for (const tag of metas) {
        const a = attributesOf(tag);
        const key = String(a.property || a.name || '').toLowerCase();
        if (!key || a.content == null) continue;
        if (key.startsWith('og:') || key.startsWith('twitter:')) {
            if (fields[key] == null) fields[key] = a.content;
        }
    }
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
    const docTitle = title ? decodeEntities(title[1]) : '';
    fields['html:title'] = docTitle;
    return fields;
}

/** A picture is kept only when it is already on OpenVibe.Media (https): never a page's own hot-linked image. */
function imageOf(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
        return u.hostname.toLowerCase() === 'openvibe.media' ? u.href : null;
    } catch { return null; }
}

/**
 * A page's own picture address (https only): the one the job may bring into Media, so that a card shows a
 * picture from our own host and never a hot-linked one.
 */
function httpsAddress(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return u.href;
    } catch { return null; }
}

const intOf = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 && n <= 100000 ? n : 0;
};
const siteOf = (url, fields) => textOf(fields['og:site_name'] || fields['twitter:site'] || url.hostname.replace(/^www\./, ''), MAX_SITE);

/** An oEmbed answer as a preview, or null when it has no title. */
function previewFromOembed(url, item) {
    if (!item || typeof item !== 'object') return null;
    const title = textOf(item.title, MAX_TITLE);
    if (!title) return null;
    const author = textOf(item.author_name, 80);
    return {
        url,
        site_name: textOf(item.provider_name, MAX_SITE) || siteOf(new URL(url), {}),
        title,
        description: author ? `Video by ${author}` : '',
        image: imageOf(item.thumbnail_url),
        kind: 'video',
        width: intOf(item.width || item.thumbnail_width),
        height: intOf(item.height || item.thumbnail_height),
    };
}

/** The preview a page states, or null when the response is not a page/picture we can preview. */
function previewFromResponse(url, res) {
    const type = String((res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '').toLowerCase();
    if (type.startsWith('image/')) {
        let name = '';
        try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* host */ }
        return { url, site_name: siteOf(new URL(url), {}), title: textOf(name, MAX_TITLE) || siteOf(new URL(url), {}), description: '', image: null, kind: 'image', width: 0, height: 0 };
    }
    if (type && !type.includes('html')) return null;
    const html = String(res.body || '');
    const f = pageFields(html);
    const title = textOf(f['og:title'] || f['twitter:title'] || f['html:title'], MAX_TITLE);
    const description = textOf(f['og:description'] || f['twitter:description'], MAX_DESCRIPTION);
    const raw = String(f['og:image'] || f['og:image:url'] || f['twitter:image'] || '').trim();
    const image = imageOf(raw);
    // The page's own picture: the job brings it into Media (server/chat/media-import.js) and keeps the Media
    // address. A picture that is already on Media is kept as it is; one that cannot be brought in is left off.
    const source_image = image ? null : httpsAddress(raw);
    const ogType = String(f['og:type'] || '').toLowerCase();
    const card = String(f['twitter:card'] || '').toLowerCase();
    const kind = ogType.startsWith('video') || card === 'player' ? 'video' : ogType.startsWith('image') ? 'image' : 'link';
    const host = siteOf(new URL(url), f);
    return {
        url,
        site_name: host,
        title: title || host,
        description,
        image,
        kind,
        width: intOf(f['og:image:width'] || f['twitter:image:width']),
        height: intOf(f['og:image:height'] || f['twitter:image:height']),
        ...(source_image ? { source_image } : {}),
    };
}

// ── the guarded fetch ───────────────────────────────────────────────────────────────────────────────────────────

/** A fixed oEmbed endpoint for the addresses on the short allow-list, or null. */
function oembedFor(url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const target = encodeURIComponent(url.href);
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
        return `https://www.youtube.com/oembed?format=json&url=${target}`;
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') return `https://vimeo.com/api/oembed.json?url=${target}`;
    return null;
}

/**
 * OpenVibe's own sites are first-class kinds and are never page-fetched: an address there is resolved through that
 * service's public API, or its oEmbed where it has one. Windows whose service has no resolver yet return null (and
 * are not page-fetched either): that is the list of kinds a later part adds.
 */
const OWN_HOSTS = new Map([
    ['openvibe.live', 'live'], ['openvibe.video', 'video'], ['openvibe.pics', 'picture'],
    ['openvibe.design', 'design'], ['openvibe.community', 'post'], ['openvibe.network', 'profile'],
    ['openvibe.games', 'game'],
]);

function baseOf(value, production) {
    const raw = String(value || (process.env.NODE_ENV === 'test' ? '' : production)).replace(/\/+$/, '');
    if (!raw) return '';
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' || u.protocol === 'http:' ? raw : '';
    } catch { return ''; }
}
const baseFor = (name, production) => () => baseOf(process.env[name], production);
const liveBase = baseFor('CHAT_LINK_LIVE_URL', 'https://openvibe.live');
const videoBase = baseFor('CHAT_LINK_VIDEO_URL', 'https://openvibe.video');
const picsBase = baseFor('CHAT_LINK_PICS_URL', 'https://openvibe.pics');
const communityBase = baseFor('CHAT_LINK_COMMUNITY_URL', 'https://openvibe.community');
const networkBase = baseFor('CHAT_LINK_NETWORK_URL', 'https://openvibe.network');
const gamesBase = baseFor('CHAT_LINK_GAMES_URL', 'https://openvibe.games');

/** What an address on one of our sites asks that site for, or null for host/path shapes we do not know. */
function ownLink(u) {
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!OWN_HOSTS.has(host)) return null;
    const site = OWN_HOSTS.get(host);
    if (site === 'live') {
        const m = /^\/@([A-Za-z0-9_]{3,24})(?:\/[^/]+)?\/?$/.exec(u.pathname);
        return m ? { site, username: m[1] } : { site };
    }
    if (site === 'video') {
        if (u.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(String(u.searchParams.get('v') || ''))) return { site, page: u.href };
        if (/^\/[vc]\/[0-9]{1,12}$/.test(u.pathname)) return { site, page: u.href };
        return { site };
    }
    if (site === 'picture') {
        const m = /^\/i\/([2-9a-km-zA-HJ-NP-Z]{8})(?:\.[A-Za-z0-9]+)?\/?$/.exec(u.pathname);
        return m ? { site, slug: m[1] } : { site };
    }
    if (site === 'post') {
        const m = /^\/s\/([^/]{1,80})\/t\/([^/]{1,200})\/?$/.exec(u.pathname);
        return m ? { site, space: decodeURIComponent(m[1]), thread: decodeURIComponent(m[2]) } : { site };
    }
    if (site === 'profile') {
        const m = /^\/@([A-Za-z0-9_.-]{1,40})\/?$/.exec(u.pathname);
        return m ? { site, username: m[1] } : { site };
    }
    if (site === 'game') {
        const m = /^\/worlds\/(w[0-9a-z]{10})\/?$/.exec(u.pathname);
        return m ? { site, world: m[1] } : { site };
    }
    return { site };
}

async function readJsonUrl(url) {
    const res = await fetchFollowing(url);
    if (!res) return null;
    try { return JSON.parse(String(res.body || '')); } catch { return null; }
}

/** A live channel (/@name, no page fetch): Live's public channel API says who and whether they are live now. */
async function livePreview(url, username) {
    const base = liveBase();
    if (!base) return null;
    const item = await readJsonUrl(`${base}/api/streams/channel/${encodeURIComponent(username)}?pollOnly=1`);
    const channel = item && item.channel;
    if (!channel || typeof channel !== 'object') return null;
    const title = textOf(channel.display_name || channel.username || username, MAX_TITLE);
    if (!title) return null;
    return {
        url,
        site_name: 'OpenVibe.Live',
        title,
        description: textOf(channel.bio, MAX_DESCRIPTION),
        image: imageOf(channel.avatar_url),
        kind: 'live',
        width: 0,
        height: 0,
        by: textOf(channel.username || username, 80),
        live: Array.isArray(item.streams) ? item.streams.length > 0 : !!item.stream,
    };
}

/** A Video watch page (no page fetch): Video's own watchable resolver. */
async function videoPreview(url, page) {
    const base = videoBase();
    if (!base) return null;
    const item = await readJsonUrl(`${base}/api/v1/video/watchable?url=${encodeURIComponent(page)}`);
    if (!item || typeof item !== 'object') return null;
    const title = textOf(item.title, MAX_TITLE);
    if (!title) return null;
    return {
        url,
        site_name: 'OpenVibe.Video',
        title,
        description: '',
        image: imageOf(item.thumbnail_url),
        kind: 'video',
        width: 0,
        height: 0,
        by: textOf(item.channel, 80),
        live: false,
    };
}

/** A Pics picture (/i/<slug>, no page fetch): Pics' public image read. Its file lives on openvibe.pics, not Media,
 *  so the picture itself is left out (a page's image is never hot-linked); the title and size still make a card. */
async function picturePreview(url, slug) {
    const base = picsBase();
    if (!base) return null;
    const item = await readJsonUrl(`${base}/api/v1/images/${encodeURIComponent(slug)}`);
    if (!item || typeof item !== 'object' || item.state === 'removed') return null;
    const title = textOf(item.title || item.alt || 'A picture on OpenVibe.Pics', MAX_TITLE);
    if (!title) return null;
    return {
        url,
        site_name: 'OpenVibe.Pics',
        title,
        description: textOf(item.description || item.alt, MAX_DESCRIPTION),
        image: imageOf(item.links && item.links.direct),
        kind: 'picture',
        width: intOf(item.width),
        height: intOf(item.height),
    };
}

/** A Community thread (/s/<space>/t/<slug>, no page fetch): Community's public thread read, with its first post. */
async function communityPreview(url, space, thread) {
    const base = communityBase();
    if (!base) return null;
    const item = await readJsonUrl(`${base}/api/v1/spaces/${encodeURIComponent(space)}/threads/${encodeURIComponent(thread)}`);
    const found = item && item.thread;
    if (!found || typeof found !== 'object') return null;
    const title = textOf(found.title, MAX_TITLE);
    if (!title) return null;
    const first = Array.isArray(item.posts) && item.posts[0] ? item.posts[0] : null;
    const attachments = first && Array.isArray(first.attachments) ? first.attachments : [];
    const media = attachments.map((a) => imageOf(a && a.url)).find(Boolean) || null;
    const author = found.author || {};
    const by = textOf(author.username || author.display_name, 80);
    const preview = {
        url,
        site_name: 'OpenVibe.Community',
        title,
        description: textOf(first && first.body_markdown, MAX_DESCRIPTION),
        image: media,
        kind: 'post',
        width: 0,
        height: 0,
    };
    if (by) preview.by = by;
    return preview;
}

/** A Network profile (/@name, no page fetch): Network's public profile read. Its avatar is served by Network, not
 *  Media, so it is left out; the name and bio still make a card. */
async function profilePreview(url, username) {
    const base = networkBase();
    if (!base) return null;
    const item = await readJsonUrl(`${base}/api/v1/profiles/${encodeURIComponent(username)}`);
    const profile = item && item.profile;
    if (!profile || typeof profile !== 'object') return null;
    const title = textOf(profile.display_name || profile.username || username, MAX_TITLE);
    if (!title) return null;
    const preview = {
        url,
        site_name: 'OpenVibe.Network',
        title,
        description: textOf(profile.bio, MAX_DESCRIPTION),
        image: imageOf(profile.avatar_url),
        kind: 'profile',
        width: 0,
        height: 0,
    };
    const by = textOf(profile.username || username, 80);
    if (by) preview.by = by;
    return preview;
}

/** A Games creator world (/worlds/<id>, no page fetch): Games' public world read. The built-in Play titles have no
 *  public game read of their own, so a /play address stays unpreviewed rather than read as a page. */
async function gamePreview(url, world) {
    const base = gamesBase();
    if (!base) return null;
    const item = await readJsonUrl(`${base}/api/worlds/${encodeURIComponent(world)}`);
    if (!item || typeof item !== 'object') return null;
    const title = textOf(item.title, MAX_TITLE);
    if (!title) return null;
    const preview = {
        url,
        site_name: 'OpenVibe.Games',
        title,
        description: textOf(item.summary, MAX_DESCRIPTION),
        image: null,
        kind: 'game',
        width: 0,
        height: 0,
    };
    const by = textOf(item.owner, 80);
    if (by) preview.by = by;
    return preview;
}

/** One GET, https only, through the egress lookup, no redirects followed here, at most FETCH_TIMEOUT_MS and MAX_BYTES. */
function requestOnce(url) {
    if (_request) return Promise.resolve(_request(url));
    return new Promise((resolve, reject) => {
        const https = require('https');
        let settled = false;
        const done = (err, value) => {
            if (settled) return;
            settled = true;
            if (err) reject(err); else resolve(value);
        };
        const req = https.request(url, {
            method: 'GET',
            lookup: safeLookup,
            timeout: FETCH_TIMEOUT_MS,
            headers: {
                accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
                'accept-language': 'en',
                'user-agent': USER_AGENT,
            },
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                const room = MAX_BYTES - size;
                if (room <= 0) { res.destroy(); done(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); return; }
                chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
                size += Math.min(chunk.length, room);
                if (size >= MAX_BYTES) { res.destroy(); done(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); }
            });
            res.on('end', () => done(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', (err) => done(err));
        });
        req.on('timeout', () => { req.destroy(new Error('link-previews: timed out')); });
        req.on('error', (err) => done(err));
        req.end();
    });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A URL through its redirects (at most MAX_REDIRECTS, each hop checked public and https), then one response. */
async function fetchFollowing(url) {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (current.protocol !== 'https:' || current.username || current.password) return null;
        await assertPublicUrl(current, { protocols: ['https:'], ...(_lookup ? { lookup: _lookup } : {}) });
        const res = await requestOnce(current.href);
        if (!res) return null;
        const location = res.headers && (res.headers.location || res.headers.Location);
        if (REDIRECTS.has(Number(res.status)) && location) {
            try { current = new URL(String(location), current); } catch { return null; }
            continue;
        }
        return res.status === 200 ? res : null;
    }
    return null;
}

/** Read one address: oEmbed when it is on the short allow-list, the page otherwise. A failure is no preview. */
async function readUrl(url) {
    const own = ownLink(new URL(url));
    if (own) {
        if (own.site === 'live' && own.username) return await livePreview(url, own.username);
        if (own.site === 'video' && own.page) return await videoPreview(url, own.page);
        if (own.site === 'picture' && own.slug) return await picturePreview(url, own.slug);
        if (own.site === 'post' && own.space && own.thread) return await communityPreview(url, own.space, own.thread);
        if (own.site === 'profile' && own.username) return await profilePreview(url, own.username);
        if (own.site === 'game' && own.world) return await gamePreview(url, own.world);
        return null;
    }
    const oembed = oembedFor(new URL(url));
    if (oembed) {
        try {
            const res = await fetchFollowing(oembed);
            if (res) {
                const item = JSON.parse(String(res.body || ''));
                const preview = previewFromOembed(url, item);
                if (preview) return preview;
            }
        } catch { /* fall through to the page */ }
    }
    const res = await fetchFollowing(url);
    return res ? previewFromResponse(url, res) : null;
}

// ── cache and storage ─────────────────────────────────────────────────────────────────────────────────────────

function parsePreview(value) {
    let p = value;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return null; } }
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (!KINDS.includes(p.kind) || typeof p.title !== 'string' || !p.title || typeof p.url !== 'string') return null;
    const preview = {
        url: p.url,
        site_name: textOf(p.site_name, MAX_SITE),
        title: textOf(p.title, MAX_TITLE),
        description: textOf(p.description, MAX_DESCRIPTION),
        image: imageOf(p.image),
        kind: p.kind,
        width: intOf(p.width),
        height: intOf(p.height),
    };
    if (p.by != null) preview.by = textOf(p.by, 80);
    if (p.live === true || p.live === false) preview.live = p.live;
    return preview;
}

async function cached(value) {
    const url = normalizeUrl(value);
    if (!url) return { hit: true, value: null };
    const mem = cache.get(url);
    if (mem && Date.now() - mem.at < (mem.value ? CACHE_MS : MISS_MS)) return { hit: true, value: mem.value };
    let row;
    try { row = await db.get('SELECT data, fetched_at FROM link_preview_cache WHERE url = ?', [url]); } catch { return { hit: false, value: null }; }
    if (!row) return { hit: false, value: null };
    const age = Date.now() - Number(row.fetched_at || 0);
    if (!(age >= 0 && age < (row.data ? CACHE_MS : MISS_MS))) return { hit: false, value: null };
    const preview = row.data ? parsePreview(row.data) : null;
    cache.set(url, { at: Date.now(), value: preview });
    return { hit: true, value: preview };
}

async function remember(url, preview) {
    cache.set(url, { at: Date.now(), value: preview });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    try {
        await db.run(`INSERT INTO link_preview_cache (url, data, fetched_at) VALUES (?, ?, ?)
                      ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, fetched_at = EXCLUDED.fetched_at`,
            [url, preview ? JSON.stringify(preview) : null, Date.now()]);
    } catch { /* the cache is an optimization; the preview still shows */ }
}

/** The preview for an address, from the cache or once through the guarded fetch. */
async function previewOf(value) {
    const url = normalizeUrl(value);
    if (!url) return null;
    const hit = await cached(url);
    if (hit.hit) return hit.value;
    let preview = null;
    try { preview = await readUrl(url); } catch { preview = null; }
    // The page's own picture is brought into Media before the preview is kept: a card shows a picture from our
    // own host, never a hot-linked one. A picture that cannot be brought in is left off the card.
    if (preview && preview.source_image && !preview.image) {
        const brought = await mediaImport.importPicture(preview.source_image).catch(() => null);
        if (brought) preview = { ...preview, image: brought };
    }
    const checked = preview ? parsePreview({ ...preview, url }) : null;
    await remember(url, checked);
    return checked;
}

// ── the background job ───────────────────────────────────────────────────────────────────────────────────────

function idle() {
    if (!running && !queue.length) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
}
function settled() {
    if (running || queue.length) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const done of waiters) done();
}

async function store(job, position, preview) {
    // Nothing found is nothing written (a retry never leaves a stale preview); a removed row is a tombstone the job
    // must not overwrite, so a preview removed while its job was still running never comes back.
    if (!preview) return;
    const table = job.scope === 'room' ? 'room_messages' : job.scope === 'dm' ? 'dm_messages' : 'chat_messages';
    const current = await db.get(`SELECT message FROM ${table} WHERE id = ?`, [job.messageId]);
    if (!current || addresses(current.message)[position] !== job.urls[position]) return;
    await db.run(`INSERT INTO link_previews (message_scope, message_id, position, url, data) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT (message_scope, message_id, position)
                  DO UPDATE SET url = EXCLUDED.url, data = EXCLUDED.data
                  WHERE link_previews.removed_at IS NULL`,
        [job.scope, job.messageId, position, preview.url, JSON.stringify(preview)]);
}

async function replaceForEdit(scope, messageId) {
    if (!['room', 'dm', 'chat'].includes(scope)) return;
    await db.run('DELETE FROM link_previews WHERE message_scope = ? AND message_id = ?', [scope, Number(messageId)]);
}

async function announce(job) {
    const embeds = await embedsOf(job.scope, job.messageId);
    if (typeof job.onReady === 'function') {
        try { await job.onReady(embeds); } catch { /* the line is already out */ }
    }
    if (!embeds.length || !job.room) return;
    try {
        const chatServer = require('./chat-server');
        chatServer.broadcastToRoom(job.room.id, { type: 'room_message_embeds', room: job.room.slug, id: job.messageId, embeds });
    } catch { /* a preview that lands after everyone left needs no event */ }
}

async function run(job) {
    for (let i = 0; i < job.urls.length; i++) {
        let preview = null;
        try { preview = await previewOf(job.urls[i]); } catch { preview = null; }
        await store(job, i, preview).catch(() => {});
    }
    await announce(job).catch(() => {});
}

function pump() {
    while (running < MAX_JOBS && queue.length) {
        const job = queue.shift();
        running++;
        run(job).catch(() => {}).finally(() => { running--; setImmediate(pump); });
    }
    settled();
}

/**
 * Queue a message for previews, after it is stored and its response is out. Returns the job (tests await idle()), or
 * null when there is nothing to do. Never awaited by the request.
 */
function schedule({ scope = 'room', messageId, text, room = null, onReady = null } = {}) {
    if (!PREVIEWS_ON) return null;
    // A test that does not stub the network never makes one (the suite's messages carry all sorts of addresses).
    if (process.env.NODE_ENV === 'test' && !_request) return null;
    const id = Number(messageId);
    if (!(id > 0) || (scope !== 'room' && scope !== 'dm' && scope !== 'chat')) return null;
    const urls = addresses(text);
    if (!urls.length) return null;
    if (queue.length >= MAX_QUEUE) queue.shift();
    const job = { scope, messageId: id, urls, room, onReady: typeof onReady === 'function' ? onReady : null };
    queue.push(job);
    setImmediate(pump);
    return job;
}

/**
 * Take a preview back: one address (position) or all of them on the message. The author or a room moderator decides
 * that in the route; the row stays as a tombstone so a running job cannot restore it. Returns the previews left.
 */
async function remove(scope, messageId, position = null, userId = null) {
    const params = [userId || null, scope, Number(messageId) || 0];
    let sql = 'UPDATE link_previews SET removed_at = ov_now(), removed_by = ? WHERE message_scope = ? AND message_id = ? AND removed_at IS NULL';
    if (position != null) { sql += ' AND position = ?'; params.push(Number(position)); }
    await db.run(sql, params);
    return await embedsOf(scope, messageId);
}

/** The stored previews for one message, in the order their addresses appeared. */
async function embedsOf(scope, messageId) {
    const rows = await db.all('SELECT data FROM link_previews WHERE message_scope = ? AND message_id = ? AND removed_at IS NULL ORDER BY position', [scope, Number(messageId) || 0]).catch(() => []);
    return rows.map((r) => parsePreview(r.data)).filter(Boolean);
}

/** Put `embeds` on every row ([] when there are none yet), for the read the client makes. */
async function attach(rows, scope = 'room', { enabled = true } = {}) {
    if (!Array.isArray(rows)) return rows;
    const list = rows.filter(Boolean);
    for (const row of list) row.embeds = [];
    if (!enabled || !list.length) return rows;
    const ids = [...new Set(list.map((r) => Number(r.id)).filter((n) => n > 0))];
    if (!ids.length) return rows;
    const marks = ids.map(() => '?').join(',');
    const records = await db.all(`SELECT message_id, data FROM link_previews WHERE message_scope = ? AND message_id IN (${marks}) AND removed_at IS NULL ORDER BY message_id, position`,
        [scope, ...ids]).catch(() => []);
    const byId = new Map();
    for (const rec of records) {
        const preview = parsePreview(rec.data);
        if (!preview) continue;
        const key = Number(rec.message_id);
        if (!byId.has(key)) byId.set(key, []);
        byId.get(key).push(preview);
    }
    for (const row of list) {
        // Cards that were taken back are not sent on a read, even when the rows are still there.
        if (isHidden(row)) continue;
        row.embeds = byId.get(Number(row.id)) || [];
    }
    return rows;
}

/** A message whose cards were taken back (room_messages.embeds_hidden). */
function isHidden(row) {
    const v = row && row.embeds_hidden;
    return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/**
 * Take a message's cards back, or put them back. The flag lives on the message, so the cards can come back;
 * the preview rows stay in the table (they are not deleted), so a job that is still running cannot change the
 * answer. The author or a room moderator decides; the route checks that.
 */
async function hide(scope, messageId, hidden) {
    const id = Number(messageId) || 0;
    if (scope === 'room') await db.run('UPDATE room_messages SET embeds_hidden = ? WHERE id = ?', [hidden ? true : false, id]);
    return { hidden: !!hidden, embeds: hidden ? [] : await embedsOf(scope, id) };
}

module.exports = {
    addresses, normalizeUrl, textOf, decodeEntities, pageFields, previewFromResponse, previewFromOembed, imageOf, httpsAddress,
    previewOf, schedule, embedsOf, attach, remove, hide, isHidden, replaceForEdit, idle, ownLink,
    CACHE_MS, MISS_MS, MAX_URLS, MAX_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS, PREVIEWS_ON,
    _setRequest(fn) { _request = fn || null; },
    _setLookup(fn) { _lookup = fn || null; },
    _reset() { _request = null; _lookup = null; cache.clear(); },
};
