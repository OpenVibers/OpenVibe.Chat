'use strict';
/**
 * scripts/migrate-chat-preferences.js (server/prefs/from-live.js): Live's user_preferences.chat_settings
 * → the Network user module chat.preferences, through Network with Chat's service token.
 *
 *   - mapping: only choices move (showTimestamps, compactMode, fontSize, showBadges); defaults-only rows,
 *     rows without a Network subject and unreadable rows are counted and skipped
 *   - dry run by default: reads Network, writes nothing
 *   - --apply requires --backup (a new file); the backup is written, 0600, before any write and gets
 *     each creation's revision; writes are create-only (If-Match: 0), so a second run creates nothing
 *   - --rollback deletes what the run created, keeping records changed since
 *   - the command line: refusals exit 2, a dry run through the real script exits 0
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { boot, suite } = require('./helpers');

const t = suite('migrate-preferences');
const NS = 'chat.preferences';
const S = {
    ann: 'usr_01J9ANN0000000000000000AAA', eve: 'usr_01J9EVE0000000000000000AAA', fay: 'usr_01J9FAY0000000000000000AAA',
    gus: 'usr_01J9GVS0000000000000000AAA', gusOld: 'usr_01J9GVS0000000000000000ZZZ', bob: 'usr_01J9B0B0000000000000000AAA',
};
const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-chat-preferences.js');
let h, mig, livePath;
const liveDefaults = { showTimestamps: false, timestampFormat: '12h', fontSize: 'default', showAvatars: true, showBadges: true, compactMode: false, ttsEnabled: true, ttsVolume: 80, ttsSendModeV2: true };
const record = (subject) => h.netModules.records.get(`${NS}|${subject}`) || null;
const puts = () => h.netModules.calls.filter((c) => c.method === 'PUT');
// Async: the stub Network answers from this process, so it must keep running while the script does.
const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: path.join(__dirname, '..'), env: process.env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
});

t('a Live database with every kind of row', async () => {
    h = await boot();
    mig = require('../server/prefs/from-live');
    livePath = path.join(h.tmp, 'live.db');
    const live = new Database(livePath);
    live.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
        CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, service TEXT, service_user_id TEXT, subject_id TEXT);
        CREATE TABLE user_preferences (user_id INTEGER PRIMARY KEY, chat_settings TEXT DEFAULT '{}', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    const add = (id, name, settings, links) => {
        live.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(id, name);
        for (const [service, subject] of links) live.prepare('INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, ?, ?, ?)').run(id, service, `x${id}`, subject);
        live.prepare('INSERT INTO user_preferences (user_id, chat_settings) VALUES (?, ?)').run(id, typeof settings === 'string' ? settings : JSON.stringify(settings));
    };
    add(1, 'ann', { ...liveDefaults, showTimestamps: true, fontSize: 'large', showBadges: false }, [['network', S.ann]]);
    add(2, 'bob', liveDefaults, [['network', S.bob]]);                                          // defaults only
    add(3, 'cat', { ...liveDefaults, compactMode: true }, []);                                   // no subject
    add(4, 'dan', '{not json', [['network', 'usr_01J9DAN0000000000000000AAA']]);               // unreadable
    add(5, 'eve', { ...liveDefaults, compactMode: true, fontSize: 'small' }, [['network', S.eve]]);   // has a record already
    add(6, 'fay', { compactMode: true }, [['network', S.fay]]);                                  // a partial old blob
    add(7, 'gus', { ...liveDefaults, fontSize: 'small' }, [['hobostreamer', S.gusOld], ['network', S.gus]]);   // the network link wins
    live.close();
    for (const s of Object.values(S)) h.netModules.subjects.add(s);
    h.netModules.set(NS, S.eve, { hide_emotes: true });
});

t('the mapping keeps choices only', () => {
    assert.deepStrictEqual(mig.fromLiveChatSettings({ ...liveDefaults, showTimestamps: true, fontSize: 'large', showBadges: false, compactMode: true }),
        { timestamps: true, compact: true, font_scale: 1.18, show_badges: false });
    assert.deepStrictEqual(mig.fromLiveChatSettings(liveDefaults), {});
    assert.deepStrictEqual(mig.fromLiveChatSettings({ fontSize: 'small', showTimestamps: 'yes' }), { font_scale: 0.88 });
    assert.deepStrictEqual(mig.fromLiveChatSettings(null), {});
});

t('plan: counts and targets from Live, read-only', () => {
    const live = new Database(livePath, { readonly: true });
    const p = mig.plan(live);
    live.close();
    assert.deepStrictEqual(p.counts, { live_rows: 7, unreadable: 1, no_subject: 1, defaults_only: 1, invalid: 0, candidates: 4, fields: { timestamps: 1, font_scale: 3, show_badges: 1, compact: 2 } });
    assert.deepStrictEqual(p.rows.map((r) => [r.live_user_id, r.subject]), [[1, S.ann], [5, S.eve], [6, S.fay], [7, S.gus]]);
    assert.deepStrictEqual(p.rows[0].data, { timestamps: true, font_scale: 1.18, show_badges: false });
});

t('the command line refuses unsafe runs (exit 2) and nothing is written', async () => {
    let r = await run(['--live-db', livePath, '--apply']);
    assert.strictEqual(r.status, 2, r.stderr); assert.ok(r.stderr.includes('--backup'));
    const existing = path.join(h.tmp, 'exists.json');
    fs.writeFileSync(existing, '{}');
    r = await run(['--live-db', livePath, '--apply', '--backup', existing]);
    assert.strictEqual(r.status, 2); assert.ok(r.stderr.includes('exists already'));
    r = await run([]);
    assert.strictEqual(r.status, 2);
    r = await run(['--live-db', path.join(h.tmp, 'nope.db')]);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(puts().length, 0);
});

t('dry run through the real script: a report, reads only', async () => {
    const r = await run(['--live-db', livePath]);
    assert.strictEqual(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.strictEqual(report.mode, 'dry-run');
    assert.strictEqual(report.exists, 1, 'eve has one');
    assert.strictEqual(report.would_create, 3);
    assert.strictEqual(puts().length, 0);
    assert.ok(h.tokenRequests.length, 'the script asked Network for a token as chat');
});

t('--apply --backup: backup first (0600), create-only writes, revisions recorded', async () => {
    const backup = path.join(h.tmp, 'prefs-backup-1.json');
    const live = new Database(livePath, { readonly: true });
    const planned = mig.plan(live);
    live.close();
    await assert.rejects(mig.migrate(planned, { apply: true }), /--backup/);
    h.netModules.beforeWrite = () => {
        const doc = JSON.parse(fs.readFileSync(backup, 'utf8'));
        assert.strictEqual(doc.targets.length, 3, 'the backup exists before the first write');
        assert.strictEqual(doc.results, null);
    };
    const report = await mig.migrate(planned, { apply: true, backup, liveDbPath: livePath });
    assert.deepStrictEqual([report.created, report.exists, report.raced, report.refused], [3, 1, 0, 0]);
    assert.ok(puts().every((c) => c.ifMatch === '"0"'), 'create-only');
    assert.deepStrictEqual(record(S.ann).data, { timestamps: true, font_scale: 1.18, show_badges: false });
    assert.strictEqual(record(S.ann).updated_by, 'svc:chat');
    assert.deepStrictEqual(record(S.gus).data, { font_scale: 0.88 });
    assert.deepStrictEqual(record(S.eve).data, { hide_emotes: true }, 'an existing record is never overwritten');
    assert.strictEqual(record(S.gusOld), null, 'the network link is the subject');
    assert.strictEqual(fs.statSync(backup).mode & 0o777, 0o600);
    const doc = JSON.parse(fs.readFileSync(backup, 'utf8'));
    assert.deepStrictEqual(doc.targets.map((x) => [x.subject, x.before]), [[S.ann, null], [S.fay, null], [S.gus, null]]);
    assert.deepStrictEqual(doc.results.map((x) => [x.subject, x.outcome, x.revision]), [[S.ann, 'created', 1], [S.fay, 'created', 1], [S.gus, 'created', 1]]);
});

t('a second run creates nothing', async () => {
    const n = puts().length;
    const r = await run(['--live-db', livePath, '--apply', '--backup', path.join(h.tmp, 'prefs-backup-2.json')]);
    assert.strictEqual(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.deepStrictEqual([report.created, report.exists, report.would_create], [0, 4, 0]);
    assert.strictEqual(puts().length, n);
});

t('--rollback deletes what the run created, keeps what changed since', async () => {
    h.netModules.set(NS, S.fay, { compact: false });           // fay changed hers after the migration
    const backup = path.join(h.tmp, 'prefs-backup-1.json');
    let r = await run(['--rollback', backup]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual((({ would_delete, changed_since, deleted }) => ({ would_delete, changed_since, deleted }))(JSON.parse(r.stdout)), { would_delete: 2, changed_since: 1, deleted: 0 });
    assert.ok(record(S.ann), 'dry run');
    r = await run(['--rollback', backup, '--apply']);
    assert.strictEqual(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.deepStrictEqual([report.deleted, report.changed_since, report.gone], [2, 1, 0]);
    assert.strictEqual(record(S.ann), null); assert.strictEqual(record(S.gus), null);
    assert.deepStrictEqual(record(S.fay).data, { compact: false });
    assert.deepStrictEqual(record(S.eve).data, { hide_emotes: true }, 'never the migration\'s');
    assert.ok(h.netModules.calls.filter((c) => c.method === 'DELETE').every((c) => /^"\d+"$/.test(c.ifMatch)), 'deletes name the revision');
});

t.run(async () => { if (h) await h.close(); });
