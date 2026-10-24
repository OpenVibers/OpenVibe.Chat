'use strict';
/**
 * Pictures in rooms and channels (the owner's ask for Chat: "files and pics", through OpenVibe.Pics). A person sends a
 * picture; Chat hands it to OpenVibe.Pics as that person — their own Network token, through MediaHub on this host
 * (CHAT_PICS_INTERNAL_URL, Host: openvibe.pics) — so the picture is theirs on Pics (re-encoded without its metadata,
 * reportable, deletable from their Pics page, inside their Pics limits), and the room gets a message with its link.
 *
 * A message holding OpenVibe.Pics direct links (https://openvibe.pics/i/<slug>.<ext>) shows them inline as thumbnails in
 * rooms and channels (pageHtml here, chat.js in the browser): only that host's pictures, at most four a message, linked
 * to the picture's page where it can be reported. Global and stream chat stay text.
 *
 *   enabled()                         CHAT_PICS_INTERNAL_URL is set
 *   upload({ token, buffer, contentType, title, ip }) → { ok, status, picture: { slug, direct, page } } | { ok: false, … }
 *   linksIn(text) → [{ slug, ext }]   the Pics pictures a message links
 *   forModel({ slug, ext })  → a data: URL of the picture for an AI member to see (fetched from Pics on this host, at
 *                              most MODEL_MAX_BYTES), or null
 */
const http = require('http');
const https = require('https');
const config = require('../config');

const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const MAX_INLINE = 4;
const MODEL_MAX_BYTES = 4 * 1024 * 1024;
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cfg = () => config.pics || {};
const enabled = () => Boolean(cfg().internalUrl);
const publicUrl = () => cfg().publicUrl || 'https://openvibe.pics';
const picsHost = () => { try { return new URL(publicUrl()).host; } catch { return 'openvibe.pics'; } };

function linkPattern() {
    const base = publicUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${base}/i/([2-9a-km-zA-HJ-NP-Z]{8})\\.(jpg|png|gif|webp|avif)(?![\\w/.-])`, 'g');
}

function linksIn(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(linkPattern())) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push({ slug: m[1], ext: m[2] });
        if (out.length >= MAX_INLINE) break;
    }
    return out;
}

/** The inline thumbnails for a message, as HTML (empty when it links no Pics picture). */
function pageHtml(text) {
    const pics = linksIn(text);
    if (!pics.length) return '';
    return `<span class="oc-pics">${pics.map((p) => `<a class="oc-pic" href="${esc(publicUrl())}/i/${esc(p.slug)}" target="_blank" rel="noopener"><img src="${esc(publicUrl())}/i/${esc(p.slug)}/thumb.webp" alt="A picture on OpenVibe.Pics" loading="lazy" decoding="async"></a>`).join('')}</span>`;
}

/** Send the picture to OpenVibe.Pics as the person. Never throws for a refusal. */
function upload({ token, buffer, contentType, title = '', ip = null }) {
    return new Promise((resolve) => {
        if (!enabled()) return resolve({ ok: false, status: 503, code: 'pictures.off', detail: 'Pictures are not available in chat right now.' });
        const type = String(contentType || '').split(';')[0].trim().toLowerCase();
        if (!TYPES.has(type)) return resolve({ ok: false, status: 415, code: 'pictures.type', detail: 'Send a JPEG, PNG, GIF, WebP or AVIF picture.' });
        if (!buffer || !buffer.length) return resolve({ ok: false, status: 422, code: 'pictures.empty', detail: 'Choose a picture first.' });
        if (buffer.length > (cfg().maxBytes || 20 * 1024 * 1024)) return resolve({ ok: false, status: 413, code: 'pictures.too_large', detail: `A picture can be up to ${Math.round((cfg().maxBytes || 20 * 1024 * 1024) / 1024 / 1024)} MB.` });
        if (!token) return resolve({ ok: false, status: 401, code: 'pictures.sign_in', detail: 'Sign in with OpenVibe to send pictures.' });
        let u;
        try { u = new URL('/api/v1/images', cfg().internalUrl); } catch { return resolve({ ok: false, status: 503, code: 'pictures.off', detail: 'Pictures are not available in chat right now.' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST',
            headers: {
                Host: picsHost(), Authorization: `Bearer ${token}`, 'Content-Type': type, 'Content-Length': buffer.length, Accept: 'application/json',
                ...(title ? { 'X-Title': encodeURIComponent(String(title).slice(0, 120)) } : {}),
                // MediaHub on loopback reads the person's address from here (one trusted hop), for its own limits.
                ...(ip ? { 'X-Forwarded-For': String(ip) } : {}),
            },
            timeout: 60_000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
                if (res.statusCode === 201 && body && body.slug && body.links) {
                    return resolve({ ok: true, status: 201, picture: { slug: body.slug, direct: body.links.direct, page: body.links.page } });
                }
                const p = (body && (body.problem || body)) || {};
                resolve({ ok: false, status: res.statusCode >= 500 ? 502 : res.statusCode, code: p.code || 'pictures.refused', detail: p.detail || 'OpenVibe.Pics did not take the picture.' });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve({ ok: false, status: 502, code: 'pictures.unreachable', detail: 'OpenVibe.Pics did not answer. Try again in a minute.' }));
        req.end(buffer);
    });
}

/** A picture for an AI member to see: GET it from OpenVibe.Pics on this host (as the public would), as a data: URL. */
function forModel({ slug, ext }) {
    return new Promise((resolve) => {
        if (!enabled() || !/^[2-9a-km-zA-HJ-NP-Z]{8}$/.test(String(slug)) || !MIME[ext]) return resolve(null);
        let u;
        try { u = new URL(`/i/${slug}.${ext}`, cfg().internalUrl); } catch { return resolve(null); }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'GET', headers: { Host: picsHost(), Accept: 'image/*' }, timeout: 15_000 }, (res) => {
            const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (res.statusCode !== 200 || !TYPES.has(type)) { res.resume(); return resolve(null); }
            const chunks = []; let n = 0;
            res.on('data', (c) => { n += c.length; if (n > MODEL_MAX_BYTES) { req.destroy(); resolve(null); } else chunks.push(c); });
            res.on('end', () => { if (n <= MODEL_MAX_BYTES) resolve(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve(null));
        req.end();
    });
}

module.exports = { enabled, upload, linksIn, pageHtml, publicUrl, forModel, TYPES, MAX_INLINE, MODEL_MAX_BYTES };
