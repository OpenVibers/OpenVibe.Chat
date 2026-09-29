'use strict';
/**
 * Account export and deletion → Chat (roadmap WS-B task 7, ADR-033; Contracts 0.71.0). Both arrive at POST
 * /internal/events and are applied once per export or deletion (account_data_events); the delivery is answered after
 * Network took the part or the confirmation, so a failure is redelivered without erasing twice. Chat keys people by
 * subject and by Live user id (ctx_users maps the two).
 *
 *   network.account.export_requested  Chat's part (POST /internal/account-exports/:id/parts with a service token):
 *                                     their chat, room and direct messages, conversations and rooms, calls, blocks,
 *                                     emotes and sounds, and the moderation actions taken on them.
 *   network.account.deleted           what the subject (and the accounts merged into it) wrote or set up goes:
 *                                     - chat, room and direct messages they sent, their DM memberships (a
 *                                       conversation left with nobody goes), room memberships and attachments;
 *                                     - rooms they own go when nobody else is in them, and otherwise stay without an
 *                                       owner; calls they made or took, and blocks both ways;
 *                                     - their channel's emotes, sounds, moderators, first-chat stats and audio
 *                                       requests, their tags, and the AI summaries and timeline about them;
 *                                     - the channel, stream and user mirrors of their Live account (the user mirror
 *                                       stays as a tombstone).
 *                                     Moderation actions stay as recorded. Chat owns the six chat tables
 *                                     (channel_moderators, channel_moderation_settings, emotes, user_tags,
 *                                     chat_ai_summaries, chat_timeline_events, C-04 done) and erases them all here.
 *                                     Chat then confirms with counts.
 */
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXPORT_RE = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELETION_RE = /^del_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOPICS = ['network.account.export_requested', 'network.account.deleted'];
const ROW_LIMIT = 5000;

const cols = (d, t) => { try { return d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); } catch { return []; } };
const has = (d, t, c) => cols(d, t).includes(c);
const inList = (xs) => `(${xs.map(() => '?').join(',')})`;

function ensureSchema(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS account_data_events (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        subject    TEXT NOT NULL,
        outcome    TEXT,
        sent_at    TEXT,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
}

/** The Live user ids of these subjects (Chat's ctx_users mirror). */
function liveIds(d, subjects) {
    return d.prepare(`SELECT id FROM ctx_users WHERE subject_id IN ${inList(subjects)}`).all(...subjects).map((r) => r.id);
}

/** WHERE for a table: its subject column(s) IN subjects, or its Live user column(s) IN ids. → [sql, params] | null. */
function whereFor(d, table, subjectCols, idCols, subjects, ids) {
    const parts = []; const params = [];
    for (const c of subjectCols) if (has(d, table, c)) { parts.push(`${c} IN ${inList(subjects)}`); params.push(...subjects); }
    if (ids.length) for (const c of idCols) if (has(d, table, c)) { parts.push(`${c} IN ${inList(ids)}`); params.push(...ids); }
    return parts.length ? [parts.join(' OR '), params] : null;
}

// ── Export ─────────────────────────────────────────────────────

const EXPORTS = [
    ['chat_messages.json', 'chat_messages', ['subject_id'], ['user_id']],
    ['room_messages.json', 'room_messages', ['subject_id'], ['user_id']],
    ['direct_messages.json', 'dm_messages', ['sender_subject_id'], ['sender_id']],
    ['conversations.json', 'dm_participants', ['subject_id'], ['user_id']],
    ['rooms_owned.json', 'rooms', ['owner_subject'], ['owner_id']],
    ['calls.json', 'calls', ['created_by_subject', 'target_subject'], ['created_by', 'target_user_id']],
    ['blocks.json', 'network_blocks', ['blocker_subject'], []],
    ['dm_blocks.json', 'dm_blocks', ['blocker_subject_id'], ['blocker_id']],
    ['emotes.json', 'emotes', [], ['user_id']],
    ['sounds.json', 'channel_sounds', ['created_by_subject_id'], ['created_by']],
    ['moderation_on_you.json', 'moderation_actions', [], ['target_user_id']],
];

function exportPart(d, subject) {
    const ids = liveIds(d, [subject]);
    const files = []; const truncated = [];
    for (const [name, table, sc, ic] of EXPORTS) {
        const w = whereFor(d, table, sc, ic, [subject], ids);
        if (!w) continue;
        let rows = d.prepare(`SELECT * FROM ${table} WHERE ${w[0]} ORDER BY rowid DESC LIMIT ${ROW_LIMIT + 1}`).all(...w[1]);
        if (table === 'moderation_actions') rows = rows.map(({ actor_user_id, actor_subject_id, ...r }) => r);   // who acted is staff's, not theirs
        if (!rows.length) continue;
        if (rows.length > ROW_LIMIT) truncated.push(name);
        files.push({ name, content: rows.slice(0, ROW_LIMIT) });
    }
    return { files, truncated };
}

// ── Deletion ───────────────────────────────────────────────────

function erase(d, subjects) {
    const ids = liveIds(d, subjects);
    const erased = {}; const retained = {};
    const add = (o, k, n) => { if (n) o[k] = (o[k] || 0) + n; };
    const del = (key, table, sc, ic) => {
        const w = whereFor(d, table, sc, ic, subjects, ids);
        if (!w) return;
        add(erased, key, d.prepare(`DELETE FROM ${table} WHERE ${w[0]}`).run(...w[1]).changes);
    };
    d.transaction(() => {
        del('messages', 'chat_messages', ['subject_id'], ['user_id']);
        del('room_messages', 'room_messages', ['subject_id'], ['user_id']);
        del('direct_messages', 'dm_messages', ['sender_subject_id'], ['sender_id']);
        del('conversations_left', 'dm_participants', ['subject_id'], ['user_id']);
        if (has(d, 'dm_conversations', 'id')) add(erased, 'conversations', d.prepare('DELETE FROM dm_conversations WHERE id NOT IN (SELECT conversation_id FROM dm_participants)').run().changes);
        del('room_memberships', 'room_members', [], ['user_id']);
        del('room_attachments', 'room_attachments', ['attached_by_subject'], []);
        const owned = whereFor(d, 'rooms', ['owner_subject'], ['owner_id'], subjects, ids);
        if (owned) {
            for (const r of d.prepare(`SELECT id FROM rooms WHERE ${owned[0]}`).all(...owned[1])) {
                const others = has(d, 'room_members', 'room_id') && d.prepare('SELECT 1 FROM room_members WHERE room_id = ? LIMIT 1').get(r.id);
                if (others) { d.prepare('UPDATE rooms SET owner_subject = NULL WHERE id = ?').run(r.id); add(retained, 'rooms_without_owner', 1); }
                else {
                    if (has(d, 'room_messages', 'room_id')) d.prepare('DELETE FROM room_messages WHERE room_id = ?').run(r.id);
                    d.prepare('DELETE FROM rooms WHERE id = ?').run(r.id);
                    add(erased, 'rooms', 1);
                }
            }
        }
        del('calls', 'calls', ['created_by_subject', 'target_subject'], ['created_by', 'target_user_id']);
        del('blocks', 'network_blocks', ['blocker_subject', 'blocked_subject'], []);
        del('blocks', 'dm_blocks', ['blocker_subject_id'], ['blocker_id', 'blocked_id']);
        del('ai_summaries', 'chat_ai_summaries', ['subject_id'], []);
        del('timeline', 'chat_timeline_events', ['subject_id'], []);
        del('tags', 'user_tags', [], ['user_id']);
        del('moderator_roles', 'channel_moderators', [], ['user_id']);
        del('pending_messages', 'pending_ip_messages', [], ['user_id']);
        if (ids.length) {
            // Their channel: emotes, sounds, moderators, stats, audio requests, then the Live mirrors.
            const channels = has(d, 'ctx_channels', 'user_id') ? d.prepare(`SELECT id FROM ctx_channels WHERE user_id IN ${inList(ids)}`).all(...ids).map((r) => r.id) : [];
            if (channels.length && has(d, 'channel_moderators', 'channel_id')) add(erased, 'moderator_roles', d.prepare(`DELETE FROM channel_moderators WHERE channel_id IN ${inList(channels)}`).run(...channels).changes);
            if (channels.length && has(d, 'channel_moderation_settings', 'channel_id')) d.prepare(`DELETE FROM channel_moderation_settings WHERE channel_id IN ${inList(channels)}`).run(...channels);
            del('emotes', 'emotes', [], ['user_id']);
            del('sounds', 'channel_sounds', ['created_by_subject_id'], ['created_by']);
            del('channel_stats', 'stream_first_chats', [], ['channel_user_id']);
            del('audio_requests', 'audio_requests', [], ['channel_user_id']);
            for (const t of ['ctx_channels', 'ctx_streams', 'ctx_managed_streams']) del('live_mirror', t, [], ['user_id']);
            const set = ['username', 'display_name', 'avatar_url', 'profile_color', 'ban_reason'].filter((c) => has(d, 'ctx_users', c));
            for (const id of ids) {
                d.prepare(`UPDATE ctx_users SET ${set.map((c) => `${c} = ${c === 'username' ? '?' : 'NULL'}`).join(', ')} WHERE id = ?`).run(`deleted-${id}`, id);
            }
        }
        const mod = whereFor(d, 'moderation_actions', ['actor_subject_id'], ['target_user_id', 'actor_user_id'], subjects, ids);
        if (mod) add(retained, 'moderation_actions', d.prepare(`SELECT COUNT(*) AS n FROM moderation_actions WHERE ${mod[0]}`).get(...mod[1]).n);
    })();
    return { erased, retained, ids };
}

// ── Events ─────────────────────────────────────────────────────

async function networkCall(path, body) {
    const auth = require('../net/service-auth');
    const config = require('../config');
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${config.networkInternalUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await auth.headers('openvibe.network')) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if (res.status === 401 && attempt === 0) { auth.invalidate('openvibe.network'); continue; }
        return res;
    }
    return null;
}

/** One envelope → 'exported' | 'erased' | 'confirmed' | 'closed' | 'unchanged' | 'ignored:<why>'; throws to be redelivered. */
async function apply(ev, { send = networkCall, log = console, onErased = null } = {}) {
    if (!ev || !TOPICS.includes(ev.event_type)) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const d = db.getDb();
    ensureSchema(d);
    if (ev.event_type === 'network.account.export_requested') {
        if (!EXPORT_RE.test(String(p.export_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        const seen = d.prepare('SELECT sent_at FROM account_data_events WHERE id = ?').get(p.export_id);
        if (seen && seen.sent_at) return 'unchanged';
        const part = exportPart(d, p.subject);
        const res = await send(`/internal/account-exports/${p.export_id}/parts`, { subject: p.subject, ...part });
        if (!res) throw new Error('Network unreachable');
        const outcome = res.ok ? 'exported' : (res.status === 409 || res.status === 404 ? 'closed' : null);
        if (!outcome) throw new Error(`export part refused: ${res.status}`);
        d.prepare('INSERT OR REPLACE INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES (?, ?, ?, ?, ?)')
            .run(p.export_id, 'export', p.subject, JSON.stringify({ result: outcome, files: part.files.length }), new Date().toISOString());
        return outcome;
    }
    if (!DELETION_RE.test(String(p.deletion_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
    let rec = d.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
    let result = 'confirmed';
    if (!rec) {
        const subjects = [p.subject, ...(Array.isArray(p.aliases) ? p.aliases.filter((s) => SUBJECT_RE.test(String(s))) : [])];
        const { ids, ...counts } = erase(d, subjects);
        d.prepare('INSERT INTO account_data_events (id, kind, subject, outcome) VALUES (?, ?, ?, ?)').run(p.deletion_id, 'deletion', p.subject, JSON.stringify(counts));
        log.log(`[AccountData] deletion ${p.deletion_id}: ${JSON.stringify(counts)}`);
        if (onErased) { try { onErased(subjects, ids); } catch { /* caches refill anyway */ } }
        rec = d.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
        result = 'erased';
    }
    if (rec.sent_at) return 'unchanged';
    const o = JSON.parse(rec.outcome || '{}');
    const res = await send(`/internal/account-deletions/${p.deletion_id}/confirmations`, { subject: p.subject, completed_at: rec.applied_at, erased: o.erased || {}, retained: o.retained || {} });
    if (!res) throw new Error('Network unreachable');
    if (!res.ok && res.status !== 404) throw new Error(`confirmation refused: ${res.status}`);
    d.prepare('UPDATE account_data_events SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), p.deletion_id);
    return result;
}

module.exports = { apply, exportPart, erase, ensureSchema, TOPICS };
