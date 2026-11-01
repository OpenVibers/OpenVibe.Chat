'use strict';
/**
 * What Vibe really did in its answer (plan L48, V2; the owner, 2026-11-01: "use a voice feature to tell it to set a
 * reminder… have a conversation with your Vibe AI"). Vibe's answer used to be plain text, so the Dock's Vibe tab
 * (OpenVibe.Shared/dock-vibe.js) and Chat's own /vibe page could only show what Vibe said, never what Vibe did.
 *
 * When a turn really sets a reminder (set_reminder) or a timer (start_timer), or stops one (stop_reminder,
 * stop_timer), what it did is kept with the answer: a small JSON list in room_messages.results (nullable jsonb,
 * migrations/0036_vibe_results.sql), at most four items, each
 *
 *   { kind: 'reminder' | 'timer', action: 'set' | 'stopped', id?, title, when?, url? }
 *
 * - a reminder: its id (rem_…), its title ("Stretch"), when it fires in words ("every 2 hours") and the page where
 *   the person manages it (https://openvibe.today/me#reminders — the only address a result may carry).
 * - a timer: what it is ("25 min focus"). The Dock holds one timer per person, so a timer has no id.
 *
 * The list belongs to the answer: it is written when the answer is posted and it goes with the message. A result the
 * person undoes (POST /api/vibe/undo) is kept, with its action changed to 'stopped': the chip then reads as stopped
 * and is not offered again. The age of a result is the age of its answer (the list is written with it), so no result
 * needs a timestamp of its own.
 *
 *   ofTool(name, result)              → the entry a tool call produced, or null
 *   save(messageId, entries)          → keep them with the answer; the answer's row
 *   list(value)                       → the entries as they are kept (a JSON list, at most four)
 *   undo({ messageId, index, user })  → stop that reminder or that timer, and mark the result undone
 */
const db = require('../db/database');

const MAX = 4;
const KINDS = ['reminder', 'timer'];
const ACTIONS = ['set', 'stopped'];
const REMINDER_URL = 'https://openvibe.today/me#reminders';
const DAY = 24 * 3600 * 1000;

class ResultError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new ResultError(status, code, message); };

const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** One entry as it is kept and shown: only these fields, and a URL only for a reminder on openvibe.today. */
function entry({ kind, action, id, title, when, url } = {}) {
    const k = KINDS.includes(String(kind)) ? String(kind) : null;
    const a = ACTIONS.includes(String(action)) ? String(action) : null;
    const t = text(title, 120);
    if (!k || !a || !t) return null;   // a chip without a title says nothing
    const out = { kind: k, action: a };
    const i = text(id, 64);
    if (i) out.id = i;
    out.title = t;
    const w = text(when, 120);
    if (w) out.when = w;
    const u = text(url, 300);
    if (u && k === 'reminder' && /^https:\/\/openvibe\.today\//.test(u)) out.url = u;
    return out;
}

/** A reminder, set or stopped: Today's own words for it ("Every 2 hours, 9 am–5 pm"). */
function reminder(r, action) {
    if (!r || typeof r !== 'object') return null;
    return entry({ kind: 'reminder', action, id: r.id, title: r.title, when: r.when || r.summary || r.next_at, url: REMINDER_URL });
}

/** A timer, set or stopped: "25 min focus" (the Dock's own shape: minutes, kind, label, rounds). */
function timer(t, action) {
    if (!t || typeof t !== 'object') return null;
    const minutes = Number(t.minutes);
    const label = text(t.label, 60);
    const kind = text(t.kind, 40);
    const bits = [];
    if (Number.isFinite(minutes) && minutes > 0) bits.push(Math.round(minutes) + ' min');
    if (label) bits.push(label);
    else if (kind) bits.push(kind);
    return entry({ kind: 'timer', action, title: bits.join(' ') || text(t.title, 120), when: text(t.when || t.summary, 120) });
}

/** The entry a tool call produced, or null when the call changed nothing the person can see or undo. */
function ofTool(name, result) {
    if (!result || typeof result !== 'object') return null;
    if (name === 'set_reminder') return reminder(result.reminder, 'set');
    if (name === 'stop_reminder') return reminder(result.stopped, 'stopped');
    if (name === 'start_timer') return timer(result.timer || result.started, 'set');
    if (name === 'stop_timer') return timer(result.stopped || result.timer, 'stopped');
    return null;
}

/** The entries as they are kept, whatever the driver gave back (a jsonb column comes back parsed). */
function list(value) {
    let raw = value;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => entry(e || {})).filter(Boolean).slice(0, MAX);
}

/** Keep the results with the answer: at most four, in the order they happened. → the answer's row, or null. */
async function save(messageId, entries) {
    const kept = (Array.isArray(entries) ? entries : []).map((e) => entry(e || {})).filter(Boolean).slice(0, MAX);
    const id = Number(messageId) || 0;
    if (!id || !kept.length) return null;
    await db.run('UPDATE room_messages SET results = ? WHERE id = ?', [JSON.stringify(kept), id]);
    const row = await require('./rooms').messageById(id);
    if (row) row.results = kept;   // the same list, parsed: what the Dock and the page read
    return row;
}

/** The Dock's timer, stopped with the tool Vibe itself uses, so the Dock and Vibe keep one timer between them. */
async function stopTimer(row, user) {
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', [row.room_id]);
    const member = await db.get("SELECT * FROM room_ai_members WHERE room_id = ? AND handle = 'vibe'", [row.room_id]);
    const out = await require('./ai-tools').runWithResult('stop_timer', '{}', { member, room, user, subject: user.subject_id || null });
    const result = out && out.result;
    if (!result || result.error) fail(502, 'vibe.undo_failed', result && result.error ? String(result.error).slice(0, 200) : 'The timer could not be stopped');
    return result;
}

/**
 * Undo one result of an answer: the reminder is stopped on OpenVibe.Today, the timer on the Dock. Only the person
 * whose chat it is may undo it, only what Vibe set, and only within a day of the answer; the result is then marked
 * undone (its action becomes 'stopped') so it is not offered again.
 */
async function undo({ messageId, index, user }) {
    const row = await db.get('SELECT m.id AS message_id, m.created_at, m.ai_member_id, m.results, r.id AS room_id, r.owner_id, r.assistant '
        + 'FROM room_messages m JOIN rooms r ON r.id = m.room_id WHERE m.id = ?', [Number(messageId) || 0]);
    // Someone else's answer, a message that is not an answer, or a chat that is not a Vibe chat: all the same 404.
    if (!row || !row.ai_member_id || Number(row.assistant) !== 1 || Number(row.owner_id) !== Number(user.id)) {
        fail(404, 'vibe.undo_not_found', 'No such answer');
    }
    const entries = list(row.results);
    const one = entries[index];
    if (!one) fail(404, 'vibe.undo_not_found', 'No such result');
    if (one.action !== 'set') fail(409, 'vibe.undo_already', 'That is already undone');
    const stamp = String(row.created_at || '');
    const at = Date.parse(stamp.includes('T') ? stamp : stamp.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(at) || Date.now() - at > DAY) fail(410, 'vibe.undo_gone', 'That is too old to undo');
    if (one.kind === 'reminder') {
        if (!one.id) fail(409, 'vibe.undo_not_undoable', 'That reminder cannot be stopped');
        const out = await require('./vibe-reminders').stop(user.subject_id || null, one.id);
        if (!out || out.error) fail(502, 'vibe.undo_failed', (out && out.error) ? String(out.error).slice(0, 200) : 'The reminder could not be stopped');
    } else {
        await stopTimer(row, user);
    }
    // Mark it undone, and only if it was still undoable a moment ago (two taps at once: the second one loses).
    const next = entries.slice();
    next[index] = { ...one, action: 'stopped' };
    const written = await db.run('UPDATE room_messages SET results = ? WHERE id = ? AND results = ?',
        [JSON.stringify(next), row.message_id, JSON.stringify(entries)]);
    if (!written.changes) fail(409, 'vibe.undo_already', 'That is already undone');
    return { results: next, undone: { kind: one.kind, id: one.id || null, title: one.title } };
}

module.exports = { MAX, KINDS, ACTIONS, REMINDER_URL, ResultError, entry, ofTool, list, save, undo };
