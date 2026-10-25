#!/usr/bin/env node
/**
 * OpenVibe.Live's vibe coding feed → Chat's feeds (server/feeds/feeds.js, docs/platform.md step 2). One-off: copy,
 * verify, then Live drops its tables (convert-verify-delete).
 *
 *   node scripts/import-live-feeds.js --file <export.jsonl>            # dry run: what would be copied
 *   node scripts/import-live-feeds.js --file <export.jsonl> --apply    # copy, then verify
 *
 * The file is JSON lines exported from Live's database, one object per row, `kind` saying which:
 *   { kind: 'slot', managed_stream_id, user_id, title, settings }       managed_streams.broadcast_settings.vibe_coding
 *   { kind: 'session', managed_stream_id, session_key, publisher, status, created_at, last_event_at, ended_at }
 *   { kind: 'event', managed_stream_id, session_key, event_id, seq, type, summary, payload, created_at }
 *
 * Each slot becomes one feed of its owner (legacy_source 'live:managed_stream:<id>', so a second run adds nothing),
 * shown on that slot, with Live's settings, and no key: the owner makes one on the feed's page. A feed keeps its
 * newest 5,000 events (feeds.KEEP_EVENTS), so only those are copied; every copied event is scrubbed as new ones are.
 * Verified: each feed holds exactly the newest min(5,000, its events) event ids of the file.
 *
 * Exit codes: 0 done (or dry run), 2 refused (bad options or file), 1 failed or did not verify.
 */
'use strict';

const fs = require('fs');

const USAGE = 'usage: node scripts/import-live-feeds.js --file <export.jsonl> [--apply]';

function parseArgs(argv) {
    const out = { apply: false, file: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--file') { out.file = argv[++i]; if (!out.file || out.file.startsWith('--')) throw new Error('--file needs a value'); }
        else if (a === '-h' || a === '--help') out.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (!out.help && !out.file) throw new Error('--file is required');
    return out;
}

const json = (v, d) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || 'null') || d; } catch { return d; } };
const ms = (t) => { const n = Date.parse(String(t || '').includes('T') ? t : `${String(t || '').replace(' ', 'T')}Z`); return Number.isFinite(n) ? n : 0; };

/** The file read into slots, each with its sessions and newest events (oldest first). */
function readExport(text, keep) {
    const slots = new Map();
    const slot = (id) => { if (!slots.has(id)) slots.set(id, { id, user_id: null, title: null, settings: {}, sessions: [], events: [] }); return slots.get(id); };
    let lines = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        lines++;
        const r = JSON.parse(line);
        const id = Number(r.managed_stream_id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`line ${lines}: no managed_stream_id`);
        if (r.kind === 'slot') Object.assign(slot(id), { user_id: Number(r.user_id), title: r.title || null, settings: json(r.settings, {}) });
        else if (r.kind === 'session') slot(id).sessions.push(r);
        else if (r.kind === 'event') slot(id).events.push(r);
        else throw new Error(`line ${lines}: unknown kind ${r.kind}`);
    }
    for (const s of slots.values()) {
        s.total = s.events.length;
        s.events = s.events.sort((a, b) => ms(a.created_at) - ms(b.created_at) || Number(a.seq) - Number(b.seq)).slice(-keep);
    }
    return { slots: [...slots.values()], lines };
}

async function main(argv, log = (m) => console.log(m)) {
    let args;
    try { args = parseArgs(argv); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    const feeds = require('../server/feeds/feeds');
    let data;
    try { data = readExport(fs.readFileSync(args.file, 'utf8'), feeds.KEEP_EVENTS); } catch (e) { log(`cannot read ${args.file}: ${e.message}`); return 2; }
    const orphans = data.slots.filter((s) => !s.user_id);
    if (orphans.length) { log(`slots without a slot row (owner unknown): ${orphans.map((s) => s.id).join(', ')}`); return 2; }
    for (const s of data.slots) log(`slot ${s.id} (owner ${s.user_id}): ${s.sessions.length} session(s), ${s.total} event(s), copying the newest ${s.events.length}`);
    if (!args.apply) { log('dry run: nothing written (add --apply to copy)'); return 0; }

    const db = require('../server/db/database');
    await db.initDb();
    let bad = 0;
    for (const s of data.slots) {
        const source = `live:managed_stream:${s.id}`;
        const subject = await db.subjectFor(s.user_id).catch(() => null);
        const settings = feeds.normalizeSettings(s.settings);
        const title = String(s.settings.widget_title || s.title || 'Vibe coding').slice(0, 80);
        const id = `fed_${require('crypto').randomBytes(26).reduce((a, b) => a + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[b % 32], '')}`;
        await db.run(`INSERT INTO feeds (id, owner_id, owner_subject, title, managed_stream_id, settings, legacy_source) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (legacy_source) WHERE legacy_source IS NOT NULL DO NOTHING`, [id, s.user_id, subject, title.length >= 2 ? title : 'Vibe coding', s.id, JSON.stringify(settings), source]);
        const feed = await db.get('SELECT id FROM feeds WHERE legacy_source = ?', [source]);
        for (const x of s.sessions) {
            await db.run(`INSERT INTO feed_sessions (feed_id, session_key, publisher, status, created_at, last_event_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (feed_id, session_key) DO NOTHING`, [feed.id, String(x.session_key || 'default'), JSON.stringify(json(x.publisher, {})),
                x.status === 'ended' ? 'ended' : 'active', x.created_at || null, x.last_event_at || null, x.ended_at || null]);
        }
        for (const e of s.events) {
            const payload = feeds.scrub(json(e.payload, {}));
            await db.run(`INSERT INTO feed_events (feed_id, session_key, event_id, seq, type, summary, payload, received_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (feed_id, event_id) DO NOTHING`, [feed.id, e.session_key || null, String(e.event_id), Number(e.seq) || 0, String(e.type),
                feeds.scrubText(e.summary || '').slice(0, 2000), JSON.stringify(payload), ms(e.created_at), e.created_at || null]);
        }
        const last = s.events.length ? s.events[s.events.length - 1].created_at : null;
        if (last) await db.run('UPDATE feeds SET last_event_at = ? WHERE id = ? AND (last_event_at IS NULL OR last_event_at < ?)', [last, feed.id, last]);
        // Verify: exactly the newest event ids of the file, no more, no fewer.
        const have = new Set((await db.all('SELECT event_id FROM feed_events WHERE feed_id = ?', [feed.id])).map((r) => r.event_id));
        const want = new Set(s.events.map((e) => String(e.event_id)));
        const missing = [...want].filter((x) => !have.has(x)).length;
        const extra = [...have].filter((x) => !want.has(x)).length;
        log(`feed ${feed.id} ← slot ${s.id}: ${have.size} event(s) held, ${missing} missing, ${extra} not from the file`);
        if (missing || extra) bad++;
    }
    if (bad) { log(`${bad} feed(s) did not verify`); return 1; }
    log('verified: every feed holds exactly the events copied');
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`import-live-feeds failed: ${err.message}`); process.exit(1); });
}

module.exports = { main, parseArgs, readExport };
