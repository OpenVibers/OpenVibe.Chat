'use strict';
/**
 * Vibe's memory of a person (consumer plan §4: the Vibe app's Memory; migrations/0031_vibe_memory.sql). Short notes Vibe
 * keeps across all of a person's own chats with it: what they asked it to remember, or a lasting preference they told it
 * (its remember tool, server/rooms/ai-tools.js), and the notes they write themselves on /vibe/memory. Only their own Vibe
 * chats read them, never a room Vibe was added to (others read those). They see, add and delete every note; with the
 * memory off Vibe neither reads nor saves any; the notes go with the account export and deletion.
 *
 *   list(user)                         → [{ id, text, source, created_at }], newest first
 *   add(user, text, { source, roomId }) → { note } or { error }: empty, too long, secret-looking, the same note, full, off
 *   remove(user, id)                   → true when the note was theirs
 *   clear(user)                        → how many notes went
 *   isOn(user) / setOn(user, on)
 *   forPrompt(user)                    → the notes as "[id] text" lines for Vibe's instructions: '' when there are none,
 *                                        null when the memory is off
 */
const db = require('../db/database');

const MAX_NOTES = 50;
const TEXT_MAX = 300;
// What a memory note must never hold: card and account numbers, passwords and keys (the person can still tell Vibe in
// a chat; it is just not kept).
const SECRET = /(?:\d[ -]?){12,19}|\bpass(?:word|code|phrase)\b|\bpin\s*(?:code|number)?\s*(?:is|:)|\b(?:sk|pk|rk)[-_][A-Za-z0-9]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bhbt_[A-Za-z0-9]+|\bxox[abp]-|-----BEGIN/i;

const cleanText = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const wire = (r) => ({ id: Number(r.id), text: r.text, source: r.source, created_at: r.created_at });

async function isOn(user) {
    if (!user) return false;
    return !(await db.get('SELECT 1 AS off FROM vibe_memory_off WHERE user_id = ?', [user.id]));
}

async function setOn(user, on) {
    if (on) await db.run('DELETE FROM vibe_memory_off WHERE user_id = ?', [user.id]);
    else await db.run('INSERT INTO vibe_memory_off (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING', [user.id]);
    return on;
}

async function list(user) {
    if (!user) return [];
    return (await db.all('SELECT * FROM vibe_memory WHERE user_id = ? ORDER BY id DESC LIMIT ?', [user.id, MAX_NOTES])).map(wire);
}

async function add(user, text, { source = 'vibe', roomId = null } = {}) {
    const note = cleanText(text);
    if (!note) return { error: 'The note is empty.' };
    if (note.length > TEXT_MAX) return { error: `A note can be up to ${TEXT_MAX} characters.` };
    if (SECRET.test(note)) return { error: 'Memory never keeps passwords, keys or card and account numbers.' };
    if (source === 'vibe' && !(await isOn(user))) return { error: 'They switched Vibe\'s memory off.' };
    return await db.tx(async () => {
        const rows = await db.all('SELECT text FROM vibe_memory WHERE user_id = ? FOR UPDATE', [user.id]);
        if (rows.some((r) => r.text.toLowerCase() === note.toLowerCase())) return { error: 'That is already in memory.' };
        if (rows.length >= MAX_NOTES) return { error: `Memory is full (${MAX_NOTES} notes): delete some on openvibe.chat/vibe/memory first.` };
        const row = await db.get('INSERT INTO vibe_memory (user_id, text, source, room_id) VALUES (?, ?, ?, ?) RETURNING *', [user.id, note, source === 'you' ? 'you' : 'vibe', roomId]);
        return { note: wire(row) };
    });
}

async function remove(user, id) {
    const n = Number(id);
    if (!user || !Number.isSafeInteger(n) || n < 1) return false;
    return (await db.run('DELETE FROM vibe_memory WHERE id = ? AND user_id = ?', [n, user.id])).changes > 0;
}

async function clear(user) {
    return (await db.run('DELETE FROM vibe_memory WHERE user_id = ?', [user.id])).changes;
}

async function forPrompt(user) {
    if (!user || !(await isOn(user))) return null;
    return (await list(user)).map((n) => `[${n.id}] ${n.text}`).join('\n');
}

module.exports = { MAX_NOTES, TEXT_MAX, isOn, setOn, list, add, remove, clear, forPrompt };
