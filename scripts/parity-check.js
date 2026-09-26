#!/usr/bin/env node
/**
 * Compare what Live and Chat answer for the same chat reads (cutover rehearsal and flip checks).
 *
 *   node scripts/parity-check.js --live https://openvibe.live --chat http://127.0.0.1:4401 \
 *        [--before "2026-09-22 10:00:00"] [--stream 123]... [--channel 45]... [--token <jwt>]
 *
 *   node scripts/parity-check.js --tables --live-db <live.db copy> --chat-db <chat.db or a copy> \
 *        [--table emotes]...
 *
 * --tables compares the staged tables (C-04, docs/staged-tables-cutover.md) row for row: per table
 * the row count and a sha256 over every row (the columns both copies have, ordered by key — the hash
 * Chat's dual read uses, database.js sliceHash), and on a difference the first keys that are only in
 * one copy or differ. Both files are opened read-only. Exit 1 on any difference.
 *
 * --before pins history pages to messages older than the snapshot, so rows written since do not
 * count as differences. --token (a Network JWT of a test account) adds the DM routes. Prints one
 * line per path (same / DIFFERENT with the first differing keys) and exits 1 on any difference.
 * Fields that legitimately move between two reads (latest_id of a room that grew, request ids)
 * are ignored.
 */
'use strict';

function parseArgs(argv) {
    const o = { streams: [], channels: [], only: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], v = argv[i + 1];
        if (a === '--live') { o.live = v; i++; } else if (a === '--chat') { o.chat = v; i++; } else if (a === '--before') { o.before = v; i++; } else if (a === '--stream') { o.streams.push(v); i++; } else if (a === '--channel') { o.channels.push(v); i++; } else if (a === '--token') { o.token = v; i++; } else if (a === '--tables') { o.tables = true; } else if (a === '--live-db') { o.liveDb = v; i++; } else if (a === '--chat-db') { o.chatDb = v; i++; } else if (a === '--table') { o.only.push(v); i++; } else throw new Error(`unknown argument ${a}`);
    }
    if (o.tables) { if (!o.liveDb || !o.chatDb) throw new Error('--tables needs --live-db and --chat-db'); } else if (!o.live || !o.chat) throw new Error('--live and --chat are required');
    return o;
}

/** --tables: the staged tables of two database files, row for row. → number of tables that differ */
function tableParity(o, log = console.log) {
    const path = require('path');
    const Database = require('better-sqlite3');
    const { STAGED_KEYS, sliceHash } = require('../server/db/database');
    const live = new Database(path.resolve(o.liveDb), { readonly: true, fileMustExist: true });
    const chat = new Database(path.resolve(o.chatDb), { readonly: true, fileMustExist: true });
    const colsOf = (conn, t) => conn.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    let authority = {};
    try { authority = Object.fromEntries(chat.prepare('SELECT table_name, authority FROM table_authority').all().map((r) => [r.table_name, r.authority])); } catch { /* an old copy */ }
    let bad = 0;
    for (const [t, pk] of Object.entries(STAGED_KEYS)) {
        if (o.only.length && !o.only.includes(t)) continue;
        const lc = colsOf(live, t), cc = colsOf(chat, t);
        if (!lc.length || !cc.length) { bad++; log(`MISSING   ${t}: ${!lc.length ? 'not in the Live copy' : 'not in the Chat copy'}`); continue; }
        const cols = lc.filter((c) => cc.includes(c)).sort();
        const q = `SELECT ${cols.join(', ')} FROM ${t} ORDER BY ${pk.join(', ')}`;
        const a = live.prepare(q).all(), b = chat.prepare(q).all();
        const ha = sliceHash(cols, a), hb = sliceHash(cols, b);
        const label = `${t.padEnd(28)} (${authority[t] || '?'})`;
        if (a.length === b.length && ha === hb) { log(`same      ${label} rows ${a.length}  sha256 ${ha.slice(0, 16)}`); continue; }
        bad++;
        const keyOf = (r) => JSON.stringify(pk.map((k) => r[k]));
        const rowOf = (r) => JSON.stringify(cols.map((c) => (r[c] === undefined ? null : r[c])));
        const ma = new Map(a.map((r) => [keyOf(r), rowOf(r)])), mb = new Map(b.map((r) => [keyOf(r), rowOf(r)]));
        const onlyLive = [...ma.keys()].filter((k) => !mb.has(k));
        const onlyChat = [...mb.keys()].filter((k) => !ma.has(k));
        const differ = [...ma.keys()].filter((k) => mb.has(k) && mb.get(k) !== ma.get(k));
        log(`DIFFERENT ${label} rows ${a.length} ≠ ${b.length}  sha256 ${ha.slice(0, 16)} ≠ ${hb.slice(0, 16)}`);
        const show = (name, list) => { if (list.length) log(`    ${name} (${list.length}): ${list.slice(0, 5).join(' ')}${list.length > 5 ? ' …' : ''}`); };
        show('only in Live', onlyLive); show('only in Chat', onlyChat); show('differ', differ);
    }
    live.close(); chat.close();
    log(bad ? `\n${bad} table(s) differ` : '\nall staged tables are the same');
    return bad;
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
    if (o.tables) process.exit(tableParity(o) ? 1 : 0);
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

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(2); });

module.exports = { parseArgs, tableParity };
