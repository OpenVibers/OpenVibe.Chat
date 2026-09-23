#!/usr/bin/env node
/**
 * Compare what Live and Chat answer for the same chat reads (cutover rehearsal and flip checks).
 *
 *   node scripts/parity-check.js --live https://openvibe.live --chat http://127.0.0.1:4401 \
 *        [--before "2026-09-22 10:00:00"] [--stream 123]... [--channel 45]... [--token <jwt>]
 *
 * --before pins history pages to messages older than the snapshot, so rows written since do not
 * count as differences. --token (a Network JWT of a test account) adds the DM routes. Prints one
 * line per path (same / DIFFERENT with the first differing keys) and exits 1 on any difference.
 * Fields that legitimately move between two reads (latest_id of a room that grew, request ids)
 * are ignored.
 */
'use strict';

function parseArgs(argv) {
    const o = { streams: [], channels: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], v = argv[i + 1];
        if (a === '--live') { o.live = v; i++; } else if (a === '--chat') { o.chat = v; i++; } else if (a === '--before') { o.before = v; i++; } else if (a === '--stream') { o.streams.push(v); i++; } else if (a === '--channel') { o.channels.push(v); i++; } else if (a === '--token') { o.token = v; i++; } else throw new Error(`unknown argument ${a}`);
    }
    if (!o.live || !o.chat) throw new Error('--live and --chat are required');
    return o;
}

const IGNORE = new Set(['request_id', 'trace_id', 'latest_id']);
function diff(a, b, at = '', out = []) {
    if (out.length > 5) return out;
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) { out.push(`${at || '/'}: ${JSON.stringify(a)?.slice(0, 60)} ≠ ${JSON.stringify(b)?.slice(0, 60)}`); return out; }
    if (Array.isArray(a)) {
        if (a.length !== b.length) out.push(`${at}: length ${a.length} ≠ ${b.length}`);
        for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out);
        return out;
    }
    if (a && typeof a === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (!IGNORE.has(k)) diff(a[k], b[k], `${at}.${k}`, out); }
        return out;
    }
    if (a !== b) out.push(`${at}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
}

async function get(base, p, token) {
    const res = await fetch(`${base.replace(/\/+$/, '')}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let body = null; try { body = await res.json(); } catch { /* */ }
    return { status: res.status, body };
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const before = o.before ? `&before=${encodeURIComponent(o.before)}` : '';
    const paths = [
        `/api/chat/global/history?limit=200${before}`,
        '/api/chat/filters/friendly',
        '/api/chat/gif/providers',
        '/api/tts/settings',
        '/api/tts/voices',
        ...o.streams.map((s) => `/api/chat/${s}/history?limit=200${before}`),
        ...o.streams.map((s) => `/api/sounds/all/${s}`),
        ...o.channels.map((c) => `/api/chat/channel/${c}/history?limit=200${before}`),
        ...o.channels.map((c) => `/api/sounds/channel/${c}`),
    ];
    const authed = o.token ? ['/api/dm/conversations', '/api/dm/unread', '/api/dm/blocks'] : [];
    let bad = 0;
    for (const p of [...paths, ...authed]) {
        const tok = authed.includes(p) ? o.token : null;
        const [a, b] = await Promise.all([get(o.live, p, tok), get(o.chat, p, tok)]);
        const d = a.status !== b.status ? [`status ${a.status} ≠ ${b.status}`] : diff(a.body, b.body);
        if (d.length) { bad++; console.log(`DIFFERENT ${p}\n    ${d.join('\n    ')}`); } else console.log(`same      ${p}`);
    }
    console.log(bad ? `\n${bad} path(s) differ` : '\nall paths answer the same');
    process.exit(bad ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
