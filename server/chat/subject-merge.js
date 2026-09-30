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

// Static statements per table (plan T3 decision 7: no interpolated identifiers). @to/@from: a subject or a Live id.
const BY_SUBJECT_MESSAGES = [
    'UPDATE chat_messages SET subject_id = @to WHERE subject_id = @from',
    'UPDATE room_messages SET subject_id = @to WHERE subject_id = @from',
    'UPDATE dm_messages SET sender_subject_id = @to WHERE sender_subject_id = @from',
];
const BY_USER = [
    'UPDATE chat_messages SET user_id = @to WHERE user_id = @from',
    'UPDATE chat_messages SET channel_user_id = @to WHERE channel_user_id = @from',
    'UPDATE room_messages SET user_id = @to WHERE user_id = @from',
    'UPDATE dm_messages SET sender_id = @to WHERE sender_id = @from',
    'UPDATE dm_conversations SET created_by = @to WHERE created_by = @from',
];
// Membership: (group, user) is one row; the survivor's stays.
const MEMBERSHIP = [
    {
        counter: 'dm',
        groups: 'SELECT conversation_id AS g FROM dm_participants WHERE user_id = ?',
        has: 'SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?',
        drop: 'DELETE FROM dm_participants WHERE conversation_id = ? AND user_id = ?',
        move: 'UPDATE dm_participants SET user_id = ? WHERE conversation_id = ? AND user_id = ?',
        subject: 'UPDATE dm_participants SET subject_id = @to WHERE subject_id = @from',
    },
    {
        counter: 'rooms',
        groups: 'SELECT room_id AS g FROM room_members WHERE user_id = ?',
        has: 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
        drop: 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?',
        move: 'UPDATE room_members SET user_id = ? WHERE room_id = ? AND user_id = ?',
        subject: null,
    },
];
const BY_SUBJECT_OTHER = [
    'UPDATE rooms SET owner_subject = @to WHERE owner_subject = @from',
    'UPDATE room_attachments SET attached_by_subject = @to WHERE attached_by_subject = @from',
    'UPDATE calls SET created_by_subject = @to WHERE created_by_subject = @from',
    'UPDATE calls SET target_subject = @to WHERE target_subject = @from',
];
// Blocks, from either side: the survivor's pair wins, blocking oneself goes.
const DM_BLOCKS = [
    { rows: 'SELECT id, blocked_id AS o FROM dm_blocks WHERE blocker_id = ?', exists: 'SELECT 1 FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?', move: 'UPDATE dm_blocks SET blocker_id = ? WHERE id = ?' },
    { rows: 'SELECT id, blocker_id AS o FROM dm_blocks WHERE blocked_id = ?', exists: 'SELECT 1 FROM dm_blocks WHERE blocked_id = ? AND blocker_id = ?', move: 'UPDATE dm_blocks SET blocked_id = ? WHERE id = ?' },
];
const NETWORK_BLOCKS = [
    {
        rows: 'SELECT blocked_subject AS o FROM network_blocks WHERE blocker_subject = ?',
        exists: 'SELECT 1 FROM network_blocks WHERE blocker_subject = ? AND blocked_subject = ?',
        drop: 'DELETE FROM network_blocks WHERE blocker_subject = ? AND blocked_subject = ?',
        move: 'UPDATE network_blocks SET blocker_subject = ? WHERE blocker_subject = ? AND blocked_subject = ?',
    },
    {
        rows: 'SELECT blocker_subject AS o FROM network_blocks WHERE blocked_subject = ?',
        exists: 'SELECT 1 FROM network_blocks WHERE blocked_subject = ? AND blocker_subject = ?',
        drop: 'DELETE FROM network_blocks WHERE blocked_subject = ? AND blocker_subject = ?',
        move: 'UPDATE network_blocks SET blocked_subject = ? WHERE blocked_subject = ? AND blocker_subject = ?',
    },
];

/** The payload { merge_id, from, into }, or null. */
function payloadOf(event) {
    const p = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (!MERGE_RE.test(String(p.merge_id || '')) || !SUBJECT_RE.test(String(p.from || '')) || !SUBJECT_RE.test(String(p.into || '')) || p.from === p.into) return null;
    return { merge_id: p.merge_id, from: p.from, into: p.into };
}

async function apply({ from, into, merge_id: mergeId }, { log = console } = {}) {
    const d = db.getDb();
    const idOf = async (s) => { const r = await d.prepare('SELECT id FROM ctx_users WHERE subject_id = ? ORDER BY id LIMIT 1').get(s); return r ? r.id : null; };
    const a = await idOf(from); const b = await idOf(into);
    const both = a != null && b != null && a !== b;
    const c = { messages: 0, dm: 0, rooms: 0, dropped: 0 };
    await d.tx(async () => {
        const set = async (text, to, fromVal) => (await d.prepare(text).run({ to, from: fromVal })).changes;
        // Messages: by subject, and by Live user id when both accounts have one.
        for (const q of BY_SUBJECT_MESSAGES) c.messages += await set(q, into, from);
        if (both) for (const q of BY_USER) await set(q, b, a);
        for (const m of MEMBERSHIP) {
            if (both) {
                for (const r of await d.prepare(m.groups).all(a)) {
                    if (await d.prepare(m.has).get(r.g, b)) { await d.prepare(m.drop).run(r.g, a); c.dropped++; }
                    else { await d.prepare(m.move).run(b, r.g, a); c[m.counter]++; }
                }
            }
            if (m.subject) await set(m.subject, into, from);
        }
        for (const q of BY_SUBJECT_OTHER) await set(q, into, from);
        // DM blocks (by Live user id, unique per pair) and the platform-block projection (by subject).
        if (both) {
            for (const q of DM_BLOCKS) {
                for (const r of await d.prepare(q.rows).all(a)) {
                    if (r.o === b || await d.prepare(q.exists).get(b, r.o)) { await d.prepare('DELETE FROM dm_blocks WHERE id = ?').run(r.id); c.dropped++; }
                    else await d.prepare(q.move).run(b, r.id);
                }
            }
        }
        await set('UPDATE dm_blocks SET blocker_subject_id = @to WHERE blocker_subject_id = @from', into, from);
        for (const q of NETWORK_BLOCKS) {
            for (const r of await d.prepare(q.rows).all(from)) {
                if (r.o === into || await d.prepare(q.exists).get(into, r.o)) await d.prepare(q.drop).run(from, r.o);
                else await d.prepare(q.move).run(into, from, r.o);
            }
        }
    });
    log.log(`[Merge] ${mergeId}: ${JSON.stringify({ live_users: [a, b], ...c })}`);
    return 'merged';
}

module.exports = { payloadOf, apply };
