'use strict';
const db = require('../db/database');
const linkCards = require('./link-cards');
const linkPreviews = require('./link-previews');
const wordFilter = require('./word-filter');
const outbox = require('../events/service-outbox');
const history = require('./history-store');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const millis = (value) => Date.parse(String(value || '').includes('T') ? value : `${String(value || '').replace(' ', 'T')}Z`);
function error(status, message) { const e = new Error(message); e.status = status; return e; }
async function edit(id, user, text, { now = Date.now() } = {}) {
    const row = await db.get('SELECT * FROM chat_messages WHERE id = ?', [id]);
    if (!row || row.is_deleted || row.message_type !== 'chat' || (row.auto_delete_at && Date.parse(row.auto_delete_at) <= now)) throw error(404, 'No such message');
    if (!user || Number(row.user_id) !== Number(user.id)) throw error(403, 'Only the author can edit this');
    if (!Number.isFinite(millis(row.timestamp)) || now - millis(row.timestamp) > WINDOW_MS) throw error(403, 'Messages can be edited for 24 hours');
    const body = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!body || body.length > 6000) throw error(422, 'Write a message of at most 6000 characters');
    const filtered = wordFilter.check(body);
    const message = filtered.safe ? body : filtered.filtered;
    if (wordFilter.isSpam(message)) throw error(422, 'Message blocked: detected as spam');
    const { card, pending } = await linkCards.forSend(message);
    const editedAt = new Date(now).toISOString();
    await db.tx(async () => {
        await db.run(`UPDATE chat_messages SET edit_history = edit_history || jsonb_build_array(jsonb_build_object('message', message, 'edited_at', CAST(? AS text))), message = ?, card = ?, edited_at = ? WHERE id = ?`, [row.edited_at || row.timestamp, message, linkCards.toJson(card), editedAt, id]);
        await linkPreviews.replaceForEdit('chat', id);
        await outbox.emit({ event_type: 'chat.message.edited', visibility: 'public', actorSubject: row.subject_id || await db.subjectFor(user.id), subject: { type: 'chat_message', id: String(id) }, payload: { message_id: Number(id), room: row.stream_id || row.channel_user_id ? { type: 'channel', channel_user_id: row.channel_user_id || null, stream_id: row.stream_id || null } : { type: 'global' }, user_subject: row.subject_id || await db.subjectFor(user.id), text: message.slice(0, 2000), edited_at: editedAt } });
    });
    history.invalidate();
    if (pending) linkCards.fillLater('chat_messages', Number(id), pending);
    linkPreviews.schedule({ scope: 'chat', messageId: Number(id), text: message, onReady: async (embeds) => {
        const server = require('./chat-server');
        const frame = { type: 'chat_embeds', id: Number(id), embeds };
        if (row.stream_id || row.channel_user_id) await server.broadcastToChannelRoom(row.channel_user_id, row.stream_id, frame);
        await server.broadcastGlobal(frame);
    } });
    return { id: Number(id), message, edited_at: editedAt, card, stream_id: row.stream_id || null, channel_user_id: row.channel_user_id || null, is_global: !!row.is_global, timestamp: row.timestamp, user_id: row.user_id };
}
module.exports = { edit, WINDOW_MS };
