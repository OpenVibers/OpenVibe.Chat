'use strict';
/**
 * network.subject.merged → Chat (roadmap WS-B task 5, ADR-029; Contracts 0.69.0). Two Network accounts became one:
 * `from` is an alias of `into`. Chat keys people by subject and by Live user id (its ctx_users mirror maps the two);
 * in one transaction it moves the folded-in account's
 *   messages          chat_messages (author, and the channel it was posted in), room messages, DM messages
 *   DMs and rooms     DM participants and room members (where the survivor is already in, the other row goes),
 *                     DM conversations it started, rooms it owns, attachments it added, calls
 *   blocks            DM blocks and the platform-block projection (the survivor's pair wins; blocking oneself goes)
 * to the survivor. Moderation actions and AI summaries stay as they were recorded. Once per event (the consumer's
 * inbox); a second run finds nothing under `from`.
 */
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MERGE_RE = /^mrg_[0-9A-HJKMNP-TV-Z]{26}$/;

const cols = (d, t) => { try { return d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); } catch { return []; } };
const has = (d, t, c) => cols(d, t).includes(c);

/** The payload { merge_id, from, into }, or null. */
function payloadOf(event) {
    const p = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (!MERGE_RE.test(String(p.merge_id || '')) || !SUBJECT_RE.test(String(p.from || '')) || !SUBJECT_RE.test(String(p.into || '')) || p.from === p.into) return null;
    return { merge_id: p.merge_id, from: p.from, into: p.into };
}

function apply({ from, into, merge_id: mergeId }, { log = console } = {}) {
    const d = db.getDb();
    const idOf = (s) => { const r = d.prepare('SELECT id FROM ctx_users WHERE subject_id = ? ORDER BY id LIMIT 1').get(s); return r ? r.id : null; };
    const a = idOf(from); const b = idOf(into);
    const both = a != null && b != null && a !== b;
    const c = { messages: 0, dm: 0, rooms: 0, dropped: 0 };
    d.transaction(() => {
        const set = (t, col, to, fromVal) => (has(d, t, col) ? d.prepare(`UPDATE ${t} SET ${col} = ? WHERE ${col} = ?`).run(to, fromVal).changes : 0);
        // Messages: by subject, and by Live user id when both accounts have one.
        c.messages += set('chat_messages', 'subject_id', into, from) + set('room_messages', 'subject_id', into, from) + set('dm_messages', 'sender_subject_id', into, from);
        if (both) {
            set('chat_messages', 'user_id', b, a); set('chat_messages', 'channel_user_id', b, a);
            set('room_messages', 'user_id', b, a); set('dm_messages', 'sender_id', b, a);
            set('dm_conversations', 'created_by', b, a);
        }
        // Membership: (conversation, user) and (room, user) are one row each; the survivor's stays.
        for (const [t, group] of [['dm_participants', 'conversation_id'], ['room_members', 'room_id']]) {
            if (!has(d, t, 'user_id')) continue;
            if (both) {
                for (const r of d.prepare(`SELECT ${group} AS g FROM ${t} WHERE user_id = ?`).all(a)) {
                    if (d.prepare(`SELECT 1 FROM ${t} WHERE ${group} = ? AND user_id = ?`).get(r.g, b)) { d.prepare(`DELETE FROM ${t} WHERE ${group} = ? AND user_id = ?`).run(r.g, a); c.dropped++; }
                    else { d.prepare(`UPDATE ${t} SET user_id = ? WHERE ${group} = ? AND user_id = ?`).run(b, r.g, a); c[t === 'dm_participants' ? 'dm' : 'rooms']++; }
                }
            }
            if (has(d, t, 'subject_id')) set(t, 'subject_id', into, from);
        }
        set('rooms', 'owner_subject', into, from); set('room_attachments', 'attached_by_subject', into, from);
        set('calls', 'created_by_subject', into, from); set('calls', 'target_subject', into, from);
        // DM blocks (by Live user id, unique per pair) and the platform-block projection (by subject).
        if (both && has(d, 'dm_blocks', 'blocker_id')) {
            for (const [col, other] of [['blocker_id', 'blocked_id'], ['blocked_id', 'blocker_id']]) {
                for (const r of d.prepare(`SELECT id, ${other} AS o FROM dm_blocks WHERE ${col} = ?`).all(a)) {
                    if (r.o === b || d.prepare(`SELECT 1 FROM dm_blocks WHERE ${col} = ? AND ${other} = ?`).get(b, r.o)) { d.prepare('DELETE FROM dm_blocks WHERE id = ?').run(r.id); c.dropped++; }
                    else d.prepare(`UPDATE dm_blocks SET ${col} = ? WHERE id = ?`).run(b, r.id);
                }
            }
        }
        set('dm_blocks', 'blocker_subject_id', into, from);
        if (has(d, 'network_blocks', 'blocker_subject')) {
            for (const [col, other] of [['blocker_subject', 'blocked_subject'], ['blocked_subject', 'blocker_subject']]) {
                for (const r of d.prepare(`SELECT ${other} AS o FROM network_blocks WHERE ${col} = ?`).all(from)) {
                    if (r.o === into || d.prepare(`SELECT 1 FROM network_blocks WHERE ${col} = ? AND ${other} = ?`).get(into, r.o)) d.prepare(`DELETE FROM network_blocks WHERE ${col} = ? AND ${other} = ?`).run(from, r.o);
                    else d.prepare(`UPDATE network_blocks SET ${col} = ? WHERE ${col} = ? AND ${other} = ?`).run(into, from, r.o);
                }
            }
        }
    })();
    log.log(`[Merge] ${mergeId}: ${JSON.stringify({ live_users: [a, b], ...c })}`);
    return 'merged';
}

module.exports = { payloadOf, apply };
