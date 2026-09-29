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

// Static statements per table (plan T3 decision 7: no interpolated identifiers). @s is the person's subjects,
// @ids their Live user ids (either can be empty: `= ANY('{}')` matches nothing).

/** The Live user ids of these subjects (Chat's ctx_users mirror). */
async function liveIds(d, subjects) {
    return (await d.prepare('SELECT id FROM ctx_users WHERE subject_id = ANY(?)').all(subjects)).map((r) => r.id);
}

// ── Export ─────────────────────────────────────────────────────

// [file, rows]: at most ROW_LIMIT + 1 of the most recent (highest key first; SQLite read these by rowid).
const LIMIT = ROW_LIMIT + 1;
const EXPORTS = [
    ['chat_messages.json', `SELECT * FROM chat_messages WHERE subject_id = ANY(@s) OR user_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['room_messages.json', `SELECT * FROM room_messages WHERE subject_id = ANY(@s) OR user_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['direct_messages.json', `SELECT * FROM dm_messages WHERE sender_subject_id = ANY(@s) OR sender_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['conversations.json', `SELECT * FROM dm_participants WHERE subject_id = ANY(@s) OR user_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['rooms_owned.json', `SELECT * FROM rooms WHERE owner_subject = ANY(@s) OR owner_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['calls.json', `SELECT * FROM calls WHERE created_by_subject = ANY(@s) OR target_subject = ANY(@s) OR created_by = ANY(@ids) OR target_user_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['blocks.json', `SELECT * FROM network_blocks WHERE blocker_subject = ANY(@s) ORDER BY updated_at DESC, blocked_subject DESC LIMIT ${LIMIT}`],
    ['dm_blocks.json', `SELECT * FROM dm_blocks WHERE blocker_subject_id = ANY(@s) OR blocker_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['emotes.json', `SELECT * FROM emotes WHERE user_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['sounds.json', `SELECT * FROM channel_sounds WHERE created_by_subject_id = ANY(@s) OR created_by = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
    ['moderation_on_you.json', `SELECT * FROM moderation_actions WHERE target_user_id = ANY(@ids) ORDER BY id DESC LIMIT ${LIMIT}`],
];

async function exportPart(d, subject) {
    const ids = await liveIds(d, [subject]);
    const files = []; const truncated = [];
    for (const [name, text] of EXPORTS) {
        let rows = await d.prepare(text).all({ s: [subject], ids });
        if (name === 'chat_messages.json') rows = rows.map(db.chatMessageRow);
        if (name === 'moderation_on_you.json') rows = rows.map(({ actor_user_id, actor_subject_id, ...r }) => db.moderationRow(r));   // who acted is staff's, not theirs
        if (!rows.length) continue;
        if (rows.length > ROW_LIMIT) truncated.push(name);
        files.push({ name, content: rows.slice(0, ROW_LIMIT) });
    }
    return { files, truncated };
}

// ── Deletion ───────────────────────────────────────────────────

// [erased key, DELETE]: in this order, in one transaction.
const ERASE_FIRST = [
    ['messages', 'DELETE FROM chat_messages WHERE subject_id = ANY(@s) OR user_id = ANY(@ids)'],
    ['room_messages', 'DELETE FROM room_messages WHERE subject_id = ANY(@s) OR user_id = ANY(@ids)'],
    ['direct_messages', 'DELETE FROM dm_messages WHERE sender_subject_id = ANY(@s) OR sender_id = ANY(@ids)'],
    ['conversations_left', 'DELETE FROM dm_participants WHERE subject_id = ANY(@s) OR user_id = ANY(@ids)'],
    ['conversations', 'DELETE FROM dm_conversations WHERE id NOT IN (SELECT conversation_id FROM dm_participants)'],
    ['room_memberships', 'DELETE FROM room_members WHERE user_id = ANY(@ids)'],
    ['room_attachments', 'DELETE FROM room_attachments WHERE attached_by_subject = ANY(@s)'],
];
const ERASE_AFTER_ROOMS = [
    ['calls', 'DELETE FROM calls WHERE created_by_subject = ANY(@s) OR target_subject = ANY(@s) OR created_by = ANY(@ids) OR target_user_id = ANY(@ids)'],
    ['blocks', 'DELETE FROM network_blocks WHERE blocker_subject = ANY(@s) OR blocked_subject = ANY(@s)'],
    ['blocks', 'DELETE FROM dm_blocks WHERE blocker_subject_id = ANY(@s) OR blocker_id = ANY(@ids) OR blocked_id = ANY(@ids)'],
    // A person's own summaries and timeline are keyed by their Live id (scope 'user').
    ['ai_summaries', "DELETE FROM chat_ai_summaries WHERE scope = 'user' AND subject_id = ANY(@ids)"],
    ['timeline', "DELETE FROM chat_timeline_events WHERE scope = 'user' AND subject_id = ANY(@ids)"],
    ['tags', 'DELETE FROM user_tags WHERE user_id = ANY(@ids)'],
    ['moderator_roles', 'DELETE FROM channel_moderators WHERE user_id = ANY(@ids)'],
    ['pending_messages', 'DELETE FROM pending_ip_messages WHERE user_id = ANY(@ids)'],
];
// Their channel (only when they have Live ids): emotes, sounds, moderators, stats, audio requests, the Live mirrors.
const ERASE_CHANNEL = [
    ['moderator_roles', 'DELETE FROM channel_moderators WHERE channel_id IN (SELECT id FROM ctx_channels WHERE user_id = ANY(@ids))'],
    [null, 'DELETE FROM channel_moderation_settings WHERE channel_id IN (SELECT id FROM ctx_channels WHERE user_id = ANY(@ids))'],
    ['emotes', 'DELETE FROM emotes WHERE user_id = ANY(@ids)'],
    ['sounds', 'DELETE FROM channel_sounds WHERE created_by_subject_id = ANY(@s) OR created_by = ANY(@ids)'],
    ['channel_stats', 'DELETE FROM stream_first_chats WHERE channel_user_id = ANY(@ids)'],
    ['audio_requests', 'DELETE FROM audio_requests WHERE channel_user_id = ANY(@ids)'],
    ['live_mirror', 'DELETE FROM ctx_channels WHERE user_id = ANY(@ids)'],
    ['live_mirror', 'DELETE FROM ctx_streams WHERE user_id = ANY(@ids)'],
    ['live_mirror', 'DELETE FROM ctx_managed_streams WHERE user_id = ANY(@ids)'],
];

async function erase(d, subjects) {
    const ids = await liveIds(d, subjects);
    const p = { s: subjects, ids };
    const erased = {}; const retained = {};
    const add = (o, k, n) => { if (k && n) o[k] = (o[k] || 0) + n; };
    const del = async ([key, text]) => { const st = d.prepare(text); add(erased, key, (await (text.includes('@') ? st.run(p) : st.run())).changes); };
    await d.tx(async () => {
        for (const e of ERASE_FIRST) await del(e);
        for (const r of await d.prepare('SELECT id FROM rooms WHERE owner_subject = ANY(@s) OR owner_id = ANY(@ids)').all(p)) {
            const others = await d.prepare('SELECT 1 FROM room_members WHERE room_id = ? LIMIT 1').get(r.id);
            if (others) { await d.prepare('UPDATE rooms SET owner_subject = NULL WHERE id = ?').run(r.id); add(retained, 'rooms_without_owner', 1); }
            else {
                await d.prepare('DELETE FROM room_messages WHERE room_id = ?').run(r.id);
                await d.prepare('DELETE FROM rooms WHERE id = ?').run(r.id);
                add(erased, 'rooms', 1);
            }
        }
        for (const e of ERASE_AFTER_ROOMS) await del(e);
        if (ids.length) {
            for (const e of ERASE_CHANNEL) await del(e);
            await d.prepare(`UPDATE ctx_users SET username = 'deleted-' || id, display_name = NULL, avatar_url = NULL, profile_color = NULL, ban_reason = NULL
                             WHERE id = ANY(?)`).run(ids);
        }
        const n = await d.prepare('SELECT COUNT(*) AS n FROM moderation_actions WHERE actor_subject_id = ANY(@s) OR target_user_id = ANY(@ids) OR actor_user_id = ANY(@ids)').get(p);
        add(retained, 'moderation_actions', n.n);
    });
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
    if (ev.event_type === 'network.account.export_requested') {
        if (!EXPORT_RE.test(String(p.export_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        const seen = await d.prepare('SELECT sent_at FROM account_data_events WHERE id = ?').get(p.export_id);
        if (seen && seen.sent_at) return 'unchanged';
        const part = await exportPart(d, p.subject);
        const res = await send(`/internal/account-exports/${p.export_id}/parts`, { subject: p.subject, ...part });
        if (!res) throw new Error('Network unreachable');
        const outcome = res.ok ? 'exported' : (res.status === 409 || res.status === 404 ? 'closed' : null);
        if (!outcome) throw new Error(`export part refused: ${res.status}`);
        await d.prepare(`INSERT INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, subject = excluded.subject, outcome = excluded.outcome, sent_at = excluded.sent_at, applied_at = ov_now_iso()`)
            .run(p.export_id, 'export', p.subject, JSON.stringify({ result: outcome, files: part.files.length }), new Date().toISOString());
        return outcome;
    }
    if (!DELETION_RE.test(String(p.deletion_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
    let rec = await d.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
    let result = 'confirmed';
    if (!rec) {
        const subjects = [p.subject, ...(Array.isArray(p.aliases) ? p.aliases.filter((s) => SUBJECT_RE.test(String(s))) : [])];
        const { ids, ...counts } = await erase(d, subjects);
        await d.prepare('INSERT INTO account_data_events (id, kind, subject, outcome) VALUES (?, ?, ?, ?)').run(p.deletion_id, 'deletion', p.subject, JSON.stringify(counts));
        log.log(`[AccountData] deletion ${p.deletion_id}: ${JSON.stringify(counts)}`);
        if (onErased) { try { onErased(subjects, ids); } catch { /* caches refill anyway */ } }
        rec = await d.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
        result = 'erased';
    }
    if (rec.sent_at) return 'unchanged';
    const o = JSON.parse(rec.outcome || '{}');
    const res = await send(`/internal/account-deletions/${p.deletion_id}/confirmations`, { subject: p.subject, completed_at: rec.applied_at, erased: o.erased || {}, retained: o.retained || {} });
    if (!res) throw new Error('Network unreachable');
    if (!res.ok && res.status !== 404) throw new Error(`confirmation refused: ${res.status}`);
    await d.prepare('UPDATE account_data_events SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), p.deletion_id);
    return result;
}

// The table is in migrations/0001_initial.sql; kept for callers.
function ensureSchema() {}

module.exports = { apply, exportPart, erase, ensureSchema, TOPICS };
