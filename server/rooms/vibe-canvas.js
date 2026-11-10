'use strict';
const crypto = require('crypto');
const db = require('../db/database');
const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
const ID = /^cv_[0-9a-f]{24}$/;
const MAX_CONTENT = 200_000;
function shape(row) { return row && { id: row.id, title: row.title, kind: row.kind, version: Number(row.version), content: row.content, created_at: row.created_at, updated_at: row.updated_at }; }
function validate({ title, kind, content }) {
    const name = String(title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
    const type = kind === 'code' ? 'code' : kind === 'document' ? 'document' : '';
    const body = String(content == null ? '' : content);
    if (!name || !type || !body.trim() || body.length > MAX_CONTENT) fail(422, 'vibe.canvas_invalid', 'Canvas needs a title, a document or code type, and up to 200,000 characters');
    return { title: name, kind: type, content: body };
}
async function list(room) {
    return (await db.all('SELECT id, title, kind, version, created_at, updated_at FROM vibe_canvases WHERE room_id = ? ORDER BY updated_at DESC', [room.id])).map(shape);
}
async function get(room, id) {
    if (!ID.test(String(id || ''))) fail(404, 'vibe.canvas_not_found', 'No such canvas');
    const row = await db.get('SELECT * FROM vibe_canvases WHERE id = ? AND room_id = ?', [id, room.id]);
    if (!row) fail(404, 'vibe.canvas_not_found', 'No such canvas');
    return shape(row);
}
async function write(room, user, input, id = null) {
    const doc = validate(input);
    if (id && !ID.test(String(id))) fail(404, 'vibe.canvas_not_found', 'No such canvas');
    return await db.tx(async () => {
        if (!id) {
            id = `cv_${crypto.randomBytes(12).toString('hex')}`;
            await db.run('INSERT INTO vibe_canvases (id, room_id, title, kind, content) VALUES (?, ?, ?, ?, ?)', [id, room.id, doc.title, doc.kind, doc.content]);
            await db.run('INSERT INTO vibe_canvas_versions (canvas_id, version, content, created_by) VALUES (?, 1, ?, ?)', [id, doc.content, String(user.subject_id || user.id)]);
        } else {
            const current = await db.get('SELECT version FROM vibe_canvases WHERE id = ? AND room_id = ?', [id, room.id]);
            if (!current) fail(404, 'vibe.canvas_not_found', 'No such canvas');
            const version = Number(current.version) + 1;
            await db.run('UPDATE vibe_canvases SET title = ?, kind = ?, version = ?, content = ?, updated_at = ov_now() WHERE id = ? AND room_id = ?', [doc.title, doc.kind, version, doc.content, id, room.id]);
            await db.run('INSERT INTO vibe_canvas_versions (canvas_id, version, content, created_by) VALUES (?, ?, ?, ?)', [id, version, doc.content, String(user.subject_id || user.id)]);
        }
        return await get(room, id);
    });
}
async function versions(room, id) {
    await get(room, id);
    return (await db.all('SELECT version, content, created_by, created_at FROM vibe_canvas_versions WHERE canvas_id = ? ORDER BY version DESC LIMIT 100', [id])).map((v) => ({ ...v, version: Number(v.version) }));
}
module.exports = { ID, MAX_CONTENT, list, get, write, versions, _validate: validate };
