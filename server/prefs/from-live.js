/**
 * One-off migration of the chat preferences Live kept server-side into the Network user module
 * chat.preferences (scripts/migrate-chat-preferences.js is the command line).
 *
 * Source: Live's user_preferences.chat_settings — the browser's whole chatSettings object, synced by
 * public/js/chat.js through PUT /api/auth/preferences — and the person's Network subject from Live's
 * linked_accounts (as scripts/import-from-live.js does). Live's database is opened read-only.
 *
 * What moves (chat.preferences v1 has five fields; the rest of chatSettings has no field yet):
 *   showTimestamps true      → timestamps: true
 *   compactMode true         → compact: true
 *   fontSize small | large   → font_scale 0.88 | 1.18 (Live's .chat-msg 0.75rem / 1rem over its 0.85rem)
 *   showBadges false         → show_badges: false
 * Only choices move: a value equal to Live's default (CHAT_SETTINGS_DEFAULTS) is not written, and a
 * person with nothing but defaults gets no record.
 *
 * Writes go through Network with Chat's service token (never into Network's database), create-only
 * (If-Match: 0): a person who already has a record keeps it, so a second run changes nothing. Before
 * writing, the backup file records what each target looked like (always "no record" for what gets
 * created) and what will be written; after, the revision each creation got. rollback() deletes the
 * records a run created, only while each is still at that revision (If-Match).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { modules } = require('openvibe-contracts');
const client = require('./network-modules');

const NAMESPACE = 'chat.preferences';
const FONT_SCALE = Object.freeze({ small: 0.88, large: 1.18 });
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Live's chatSettings → chat.preferences data (choices only). */
function fromLiveChatSettings(settings) {
    const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    const out = {};
    if (s.showTimestamps === true) out.timestamps = true;
    if (s.compactMode === true) out.compact = true;
    if (Object.prototype.hasOwnProperty.call(FONT_SCALE, s.fontSize)) out.font_scale = FONT_SCALE[s.fontSize];
    if (s.showBadges === false) out.show_badges = false;
    return out;
}

/** Read Live's rows and decide what each becomes. Returns { rows: [...], counts }. No network. */
function plan(liveDb) {
    const has = (t) => !!liveDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('user_preferences')) throw new Error('Live database has no user_preferences table');
    const laCols = has('linked_accounts') ? liveDb.prepare('PRAGMA table_info(linked_accounts)').all().map((c) => c.name) : [];
    const subjectSql = laCols.includes('subject_id')
        ? `(SELECT la.subject_id FROM linked_accounts la WHERE la.user_id = up.user_id AND la.subject_id IS NOT NULL
             ORDER BY (la.service = 'network') DESC, la.id LIMIT 1)`
        : 'NULL';
    const rows = liveDb.prepare(`SELECT up.user_id, up.chat_settings, up.updated_at, ${subjectSql} AS subject_id
                                 FROM user_preferences up ORDER BY up.user_id`).all();
    const counts = { live_rows: rows.length, unreadable: 0, no_subject: 0, defaults_only: 0, invalid: 0, candidates: 0, fields: {} };
    const out = [];
    for (const r of rows) {
        let settings;
        try { settings = JSON.parse(r.chat_settings || '{}'); } catch { counts.unreadable++; continue; }
        if (!USER_SUBJECT.test(String(r.subject_id || ''))) { counts.no_subject++; continue; }
        const data = fromLiveChatSettings(settings);
        if (!Object.keys(data).length) { counts.defaults_only++; continue; }
        if (!modules.validateData(NAMESPACE, data).valid) { counts.invalid++; continue; }
        for (const k of Object.keys(data)) counts.fields[k] = (counts.fields[k] || 0) + 1;
        counts.candidates++;
        out.push({ live_user_id: r.user_id, subject: r.subject_id, live_updated_at: r.updated_at || null, data });
    }
    return { rows: out, counts };
}

/** The current record of each candidate on Network: null (none), the record, or throws when unreachable. */
async function current(subject) {
    const r = await client.request('GET', NAMESPACE, subject);
    if (r.status === 200 && r.body) return { revision: r.body.revision, data: r.body.data, updated_by: r.body.updated_by || null };
    if (r.status === 404 && r.body && r.body.code === 'modules.not_found') return null;
    throw new Error(`reading ${subject} on Network: ${r.status}${r.error ? ` ${r.error}` : ''}${r.body && r.body.code ? ` ${r.body.code}` : ''}`);
}

function writeJsonAtomic(file, value) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
}

/**
 * Check every candidate against Network; with apply, write the backup first, then create the records.
 * Returns the report. `backup` must name a file that does not exist yet (required with apply).
 */
async function migrate(planned, { apply = false, backup = null, liveDbPath = null, log = () => {} } = {}) {
    if (apply && !backup) throw new Error('--apply needs --backup <file>');
    const report = { mode: apply ? 'apply' : 'dry-run', ...planned.counts, exists: 0, would_create: 0, created: 0, raced: 0, refused: 0 };
    const targets = [];
    for (const row of planned.rows) {
        const before = await current(row.subject);
        if (before) { report.exists++; continue; }
        targets.push({ ...row, before: null });
    }
    report.would_create = targets.length;
    if (!apply) return report;

    const file = path.resolve(backup);
    if (fs.existsSync(file)) throw new Error(`${file} exists already; pick a new backup file`);
    const doc = { kind: 'openvibe-chat/chat-preferences-migration', version: 1, namespace: NAMESPACE, created_at: new Date().toISOString(),
        live_db: liveDbPath, targets: targets.map((t) => ({ live_user_id: t.live_user_id, subject: t.subject, before: null, data: t.data })), results: null };
    writeJsonAtomic(file, doc);
    const check = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!check || !Array.isArray(check.targets) || check.targets.length !== targets.length) throw new Error(`backup ${file} did not read back; nothing written`);
    log(`backup written: ${file} (${targets.length} target(s))`);

    const results = [];
    for (const t of targets) {
        const r = await client.request('PUT', NAMESPACE, t.subject, { data: t.data, revision: 0 });
        if (r.status === 201 && r.body) { report.created++; results.push({ subject: t.subject, outcome: 'created', revision: r.body.revision }); }
        else if (r.status === 412) { report.raced++; results.push({ subject: t.subject, outcome: 'exists' }); }
        else if (r.status === 0) {
            doc.results = results; writeJsonAtomic(file, doc);
            throw new Error(`Network became unreachable after ${results.length} write(s): ${r.error}; the backup lists what was done, re-run to continue`);
        } else { report.refused++; results.push({ subject: t.subject, outcome: 'refused', status: r.status, code: (r.body && r.body.code) || null }); }
    }
    doc.results = results;
    doc.finished_at = new Date().toISOString();
    writeJsonAtomic(file, doc);
    return report;
}

/**
 * Undo a run from its backup: delete each record it created, only while still at the revision it got
 * (for a run that stopped before recording results: only while the data is exactly what it wrote).
 */
async function rollback(file, { apply = false } = {}) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || doc.kind !== 'openvibe-chat/chat-preferences-migration' || !Array.isArray(doc.targets)) throw new Error(`${file} is not a chat-preferences migration backup`);
    const byResult = new Map((doc.results || []).map((r) => [r.subject, r]));
    const report = { mode: apply ? 'apply' : 'dry-run', targets: doc.targets.length, deleted: 0, would_delete: 0, gone: 0, changed_since: 0, not_created: 0 };
    for (const t of doc.targets) {
        const res = byResult.get(t.subject);
        if (res && res.outcome !== 'created') { report.not_created++; continue; }
        const cur = await current(t.subject);
        if (!cur) { report.gone++; continue; }
        const ours = res ? cur.revision === res.revision : JSON.stringify(cur.data) === JSON.stringify(t.data) && cur.updated_by === 'svc:chat';
        if (!ours) { report.changed_since++; continue; }
        if (!apply) { report.would_delete++; continue; }
        const r = await client.request('DELETE', NAMESPACE, t.subject, { revision: cur.revision });
        if (r.status === 204) report.deleted++;
        else if (r.status === 412 || r.status === 404) report.changed_since++;
        else throw new Error(`deleting ${t.subject}: Network answered ${r.status}${r.error ? ` ${r.error}` : ''}`);
    }
    return report;
}

module.exports = { NAMESPACE, FONT_SCALE, fromLiveChatSettings, plan, migrate, rollback };
