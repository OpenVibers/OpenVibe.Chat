'use strict';
/**
 * A room's memory (plan 2026-11-10, part 3): what the summariser may keep about a room between summaries.
 *
 *   forPrompt(room)                    the shared notes a summariser or an AI member reads, one line each
 *   forRoom(room)                      the page's read: active entries, newest first, with their source messages
 *   remember(room, { text, kind, … })  the summariser's write (deduplicated, capped)
 *   add / correct / remove             a moderator's hand; a person's own removal (their messages sourced it)
 *
 * An entry names the room messages it came from (ids) and the subjects of their authors, so a person can
 * remove what was learned from their own lines, and the account export/deletion can carry it. Removed
 * entries keep their row (soft delete) so a summariser does not recreate them from an old batch.
 */
const db = require('../db/database');

const KINDS = ['topic', 'fact', 'decision', 'request'];
const MAX_TEXT = 400;
const MAX_ACTIVE = 80;
const MAX_SOURCES = 30;
const PROMPT_LIMIT = 12;

class MemoryError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new MemoryError(status, code, message); };
const TEXT_MIN = 3;

function _cleanText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
function _kind(kind) { return KINDS.includes(kind) ? kind : 'fact'; }
function _ids(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_SOURCES);
}
function _confidence(value, fallback = 50) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
}
function _norm(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function _parseJson(raw) { if (Array.isArray(raw)) return raw; try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }

/** A page's entry: sources are resolved now, so a deleted message never comes back as an entry's text. */
async function _shape(row, sources, subject = null) {
    return {
        id: Number(row.id),
        kind: row.kind,
        text: row.text,
        confidence: Number(row.confidence) || 0,
        learned_at: row.learned_at || null,
        learned_by: row.learned_by || 'ai',
        updated_at: row.updated_at || null,
        updated_by: row.updated_by || null,
        mine: !!(subject && _parseJson(row.source_subjects).includes(subject)),
        sources: (sources || []).map((s) => ({
            id: Number(s.id), author: s.username || 'someone', at: s.created_at || null,
            text: String(s.message || '').slice(0, 300),
        })),
    };
}

/** Resolve the stored source ids against the live room messages (deleted and AI-member lines are gone). */
async function _sourcesFor(rows) {
    const ids = [...new Set((rows || []).flatMap((r) => _ids(_parseJson(r.source_message_ids))))];
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const found = await db.all(`SELECT m.id, m.message, m.created_at, u.username
        FROM room_messages m LEFT JOIN ctx_users u ON u.id = m.user_id
        WHERE m.id IN (${marks}) AND m.is_deleted = 0 AND m.ai_member_id IS NULL`, ids) || [];
    const byRoom = new Map();
    for (const m of found) byRoom.set(Number(m.id), m);
    return byRoom;
}

/** The active entries of one room, newest first, with their source messages. */
async function forRoom(room, { limit = 50, subject = null } = {}) {
    const rows = await db.all('SELECT * FROM room_memory WHERE room_id = ? AND removed_at IS NULL ORDER BY learned_at DESC, id DESC LIMIT ?',
        [room.id, Math.min(200, Math.max(1, Number(limit) || 50))]) || [];
    const byId = await _sourcesFor(rows);
    return Promise.all(rows.map((r) => _shape(r, _ids(_parseJson(r.source_message_ids)).map((id) => byId.get(id)).filter(Boolean), subject)));
}

/** What a summariser or an AI member in the room reads. Empty when there is nothing worth saying. */
async function forPrompt(room, { limit = PROMPT_LIMIT } = {}) {
    const rows = await db.all(`SELECT kind, text FROM room_memory
        WHERE room_id = ? AND removed_at IS NULL AND confidence >= 30 ORDER BY learned_at DESC, id DESC LIMIT ?`,
    [room.id, Math.max(1, limit)]) || [];
    return rows.map((r) => `- [${r.kind}] ${r.text}`).join('\n');
}

/**
 * The summariser's write: split the model's memory line into short entries, skip any already known (or
 * removed) for this room, and keep at most MAX_ACTIVE active. The window's message ids and their authors'
 * subjects are the sources; confidence is the summary's, not a quoted line's.
 */
async function remember(room, { memory, source_message_ids: sourceIds = [], source_subjects: sourceSubjects = [], confidence = 40, learned_by: learnedBy = 'ai' } = {}) {
    const lines = String(memory || '')
        .split(/\n+|(?<=[.!?])\s+/)
        .map((s) => s.replace(/^[-•*]\s*/, '').replace(/\s+/g, ' ').trim())
        .filter((s) => s.length >= 12 && s.length <= MAX_TEXT)
        .slice(0, 20);
    if (!lines.length) return 0;
    const ids = _ids(sourceIds);
    const subjects = [...new Set((Array.isArray(sourceSubjects) ? sourceSubjects : []).map(String).filter((s) => /^usr_/.test(s)))];
    const existing = new Set((await db.all('SELECT text FROM room_memory WHERE room_id = ?', [room.id]) || []).map((r) => _norm(r.text)));
    let added = 0;
    for (const text of lines) {
        const key = _norm(text);
        if (!key || existing.has(key)) continue;
        const active = (await db.get('SELECT COUNT(*) AS n FROM room_memory WHERE room_id = ? AND removed_at IS NULL', [room.id]) || {}).n || 0;
        if (Number(active) >= MAX_ACTIVE) break;
        await db.run(`INSERT INTO room_memory (room_id, kind, text, source_message_ids, source_subjects, confidence, learned_by)
            VALUES (?, 'fact', ?, ?::jsonb, ?::jsonb, ?, ?)`,
        [room.id, text, JSON.stringify(ids), JSON.stringify(subjects), _confidence(confidence, 40), String(learnedBy).slice(0, 80)]);
        existing.add(key);
        added++;
    }
    return added;
}

/** A moderator's entry (or a correction of an AI one). */
async function add(room, actor, { text, kind = 'fact', confidence = 80, source_message_ids: sourceIds = [] } = {}) {
    const t = _cleanText(text);
    if (t.length < TEXT_MIN) fail(422, 'memory.text', 'An entry needs a few words');
    const ids = _ids(sourceIds);
    const subjects = ids.length
        ? (await db.all(`SELECT subject_id FROM room_messages WHERE id IN (${ids.map(() => '?').join(',')}) AND room_id = ? AND is_deleted = 0`, [...ids, room.id]) || []).map((r) => r.subject_id).filter(Boolean)
        : [];
    const res = await db.run(`INSERT INTO room_memory (room_id, kind, text, source_message_ids, source_subjects, confidence, learned_by)
        VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)`,
    [room.id, _kind(kind), t, JSON.stringify(ids), JSON.stringify([...new Set(subjects)]), _confidence(confidence, 80), actor && actor.subject_id ? actor.subject_id : 'moderator']);
    return await _one(room, Number(res.lastInsertRowid));
}

async function _one(room, id) {
    const row = await db.get('SELECT * FROM room_memory WHERE id = ? AND room_id = ?', [id, room.id]);
    if (!row) return null;
    const byId = await _sourcesFor([row]);
    return _shape(row, _ids(_parseJson(row.source_message_ids)).map((sid) => byId.get(sid)).filter(Boolean));
}

/** A moderator corrects the words, kind or confidence of an entry. */
async function correct(room, actor, id, patch = {}) {
    const row = await db.get('SELECT * FROM room_memory WHERE id = ? AND room_id = ? AND removed_at IS NULL', [id, room.id]);
    if (!row) fail(404, 'memory.not_found', 'No such entry');
    const text = patch.text !== undefined ? _cleanText(patch.text) : row.text;
    if (text.length < TEXT_MIN) fail(422, 'memory.text', 'An entry needs a few words');
    const kind = patch.kind !== undefined ? _kind(patch.kind) : row.kind;
    const confidence = patch.confidence !== undefined ? _confidence(patch.confidence, row.confidence) : row.confidence;
    await db.run('UPDATE room_memory SET text = ?, kind = ?, confidence = ?, updated_at = ov_now(), updated_by = ? WHERE id = ?',
        [text, kind, confidence, actor && actor.subject_id ? actor.subject_id : 'moderator', row.id]);
    return await _one(room, row.id);
}

/**
 * Remove an entry. A moderator removes any; a person removes one made from their own messages. Soft:
 * the row stays so a later summary does not bring the same words back.
 */
async function remove(room, actor, id, { canModerate = false } = {}) {
    const row = await db.get('SELECT * FROM room_memory WHERE id = ? AND room_id = ? AND removed_at IS NULL', [id, room.id]);
    if (!row) fail(404, 'memory.not_found', 'No such entry');
    const mine = !!(actor && actor.subject_id && _parseJson(row.source_subjects).includes(actor.subject_id));
    if (!canModerate && !mine) fail(403, 'memory.not_yours', 'Only a room moderator, or a person whose messages it came from, removes this');
    await db.run('UPDATE room_memory SET removed_at = ov_now(), removed_by = ? WHERE id = ?',
        [actor && actor.subject_id ? actor.subject_id : 'moderator', row.id]);
    return { removed: true };
}

/** A person's "forget what was learned from my messages" in one room. */
async function removeMine(room, subject) {
    if (!/^usr_/.test(String(subject || ''))) return { removed: 0 };
    const rows = await db.all('SELECT id, source_subjects FROM room_memory WHERE room_id = ? AND removed_at IS NULL', [room.id]) || [];
    let removed = 0;
    for (const r of rows) {
        if (!_parseJson(r.source_subjects).includes(subject)) continue;
        await db.run('UPDATE room_memory SET removed_at = ov_now(), removed_by = ? WHERE id = ?', [subject, r.id]);
        removed++;
    }
    return { removed };
}

module.exports = {
    KINDS, MAX_TEXT, MemoryError,
    forRoom, forPrompt, remember, add, correct, remove, removeMine, _shape, _norm,
};
