#!/usr/bin/env node
/**
 * Chat's own DM blocks (dm_blocks) → platform blocks on OpenVibe.Network (roadmap WS-E task 5). One-off.
 *
 * Network has no service API that writes blocks (a block is the person's own act), so this does not call
 * Network: it writes the blocks as a JSON file of subject pairs for an operator to import there with
 * Network's scripts/import-blocks.js, which inserts each pair Network has never seen and emits
 * network.block.changed for it. Chat keeps dm_blocks as they are (DMs honour both).
 *
 *   node scripts/migrate-dm-blocks-to-network.js                          # dry run: counts only, nothing written
 *   node scripts/migrate-dm-blocks-to-network.js --apply --out <file>     # write the pairs file (0600, new file)
 *
 * Options:
 *   --out <file>   required with --apply; must not exist
 *   --resolve      first ask Live (live-context, as Chat does at runtime) for people missing from ctx_users
 *   --db <path>    Chat's database (default CHAT_DB_PATH, else ./data/chat.db)
 *
 * People are Live ids here; each is mapped to its Network subject the way Chat records it: the blocker's
 * dm_blocks.blocker_subject_id (written when they blocked), else ctx_users.subject_id; the blocked person's
 * ctx_users.subject_id. A Live account without a Network subject has no platform identity to block with,
 * so its rows are skipped and counted. Then, on Network (as the service user):
 *
 *   node scripts/import-blocks.js --file <file>            # dry run
 *   node scripts/import-blocks.js --file <file> --apply
 *
 * Exit codes: 0 done (or dry run), 2 refused (bad options), 1 failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = 'usage: node scripts/migrate-dm-blocks-to-network.js [--db <chat.db>] [--resolve] [--apply --out <file>]';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function parseArgs(argv) {
    const out = { apply: false, out: null, resolve: false, db: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
        if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--resolve') out.resolve = true;
        else if (a === '--out') out.out = value();
        else if (a === '--db') out.db = value();
        else if (a === '-h' || a === '--help') out.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (out.apply && !out.out) throw new Error('--apply needs --out <file>');
    if (out.out && fs.existsSync(out.out)) throw new Error(`${out.out} exists already; pick a new file`);
    return out;
}

/** dm_blocks → { pairs: [{ blocker_subject, blocked_subject }], rows, skipped: { reason: n }, unmapped_ids } */
function plan(db) {
    const rows = db.all(`SELECT b.id, b.blocker_id, b.blocked_id, b.blocker_subject_id, a.subject_id AS blocker_ctx, c.subject_id AS blocked_ctx
        FROM dm_blocks b LEFT JOIN ctx_users a ON a.id = b.blocker_id LEFT JOIN ctx_users c ON c.id = b.blocked_id ORDER BY b.id`);
    const ok = (s) => (SUBJECT_RE.test(String(s || '')) ? String(s) : null);
    const pairs = [];
    const skipped = {};
    const unmapped = new Set();
    const seen = new Set();
    const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
    for (const r of rows) {
        const blocker = ok(r.blocker_subject_id) || ok(r.blocker_ctx);
        const blocked = ok(r.blocked_ctx);
        if (!blocker) { skip('blocker-without-subject'); unmapped.add(r.blocker_id); continue; }
        if (!blocked) { skip('blocked-without-subject'); unmapped.add(r.blocked_id); continue; }
        if (blocker === blocked) { skip('same-person'); continue; }
        const key = `${blocker}>${blocked}`;
        if (seen.has(key)) { skip('duplicate'); continue; }
        seen.add(key);
        pairs.push({ blocker_subject: blocker, blocked_subject: blocked });
    }
    return { rows: rows.length, pairs, skipped, unmapped_ids: [...unmapped].sort((x, y) => x - y) };
}

async function main(argv, log = (m) => console.log(m)) {
    let args;
    try { args = parseArgs(argv); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    if (args.db) {
        if (!fs.existsSync(args.db)) { log(`no Chat database at ${args.db}`); return 2; }
        process.env.CHAT_DB_PATH = path.resolve(args.db);
    }
    const db = require('../server/db/database');
    if (args.resolve) {
        const missing = db.all(`SELECT DISTINCT id FROM (SELECT blocker_id AS id FROM dm_blocks UNION SELECT blocked_id FROM dm_blocks)
            WHERE id NOT IN (SELECT id FROM ctx_users)`).map((r) => r.id);
        if (missing.length) {
            const ctx = require('../server/live-context');
            for (let i = 0; i < missing.length; i += 500) await ctx.ensureUsers(missing.slice(i, i + 500));
        }
        log(`asked Live for ${missing.length} person(s) missing from ctx_users`);
    }
    const p = plan(db);
    const why = Object.entries(p.skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    log(`dm_blocks ${p.rows}; pairs for Network ${p.pairs.length}; skipped: ${why}`);
    if (p.unmapped_ids.length) log(`Live ids without a Network subject: ${p.unmapped_ids.slice(0, 50).join(', ')}${p.unmapped_ids.length > 50 ? ` (+${p.unmapped_ids.length - 50} more)` : ''}`);
    if (!args.apply) { log('dry run: nothing written (add --apply --out <file> to write the pairs file)'); return 0; }
    const body = { exported_at: new Date().toISOString(), source: 'openvibe.chat dm_blocks', pairs: p.pairs, skipped: p.skipped };
    const umask = process.umask(0o077);
    try { fs.writeFileSync(args.out, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); } finally { process.umask(umask); }
    log(`wrote ${p.pairs.length} pair(s) to ${args.out}; import on Network: node scripts/import-blocks.js --file <that file> [--apply]`);
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`migrate-dm-blocks-to-network failed: ${err.message}`); process.exit(1); });
}

module.exports = { main, plan, parseArgs };
