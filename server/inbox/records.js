'use strict';
/**
 * An inbox's records (migrations/0026_inbox_retention.sql): how long its finished conversations are kept, and the
 * owner's export of them.
 *
 *   sweep({ now? }) → { deleted }   hourly (server/chat/chat-server.js): in each inbox with retention_days, conversations
 *                                   that are resolved, or that only Vibe ever answered, and quiet for longer than that,
 *                                   go with their messages and translations, 500 an inbox a pass. A visitor waiting for a
 *                                   person, or a conversation a person has open, is never swept.
 *   conversations(inbox) → [{ ...convShape, messages }]   newest first, at most 5,000 (the JSON export)
 *   csv(inbox) → text                                     the same, one row per message
 */
const db = require('../db/database');

const RETENTION_CHOICES = [30, 90, 180, 365, 730];   // the settings' choices; the API takes 7 to 3650
const BATCH = 500;
const EXPORT_MAX = 5000;

/** ov_now()'s format, for comparing with the conversations' text timestamps. */
const stamp = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

async function sweep({ now = new Date() } = {}) {
    let deleted = 0;
    const kept = await db.all('SELECT id, retention_days FROM inboxes WHERE retention_days IS NOT NULL');
    for (const ib of kept) {
        const cutoff = stamp(new Date(now.getTime() - Number(ib.retention_days) * 86_400_000));
        const ids = (await db.all(`SELECT id FROM inbox_conversations WHERE inbox_id = ? AND status IN ('resolved', 'bot') AND COALESCE(last_message_at, created_at) < ?
            ORDER BY COALESCE(last_message_at, created_at) LIMIT ${BATCH}`, [ib.id, cutoff])).map((r) => r.id);
        if (!ids.length) continue;
        await db.run('DELETE FROM inbox_translations WHERE message_id IN (SELECT id FROM inbox_messages WHERE conversation_id = ANY(?))', [ids]);
        await db.run('DELETE FROM inbox_messages WHERE conversation_id = ANY(?)', [ids]);
        await db.run('DELETE FROM inbox_conversations WHERE id = ANY(?)', [ids]);
        deleted += ids.length;
    }
    return { deleted };
}

async function conversations(inbox) {
    const { convShape } = require('./inbox');
    const convs = await db.all(`SELECT * FROM inbox_conversations WHERE inbox_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ${EXPORT_MAX}`, [inbox.id]);
    const byConv = new Map(convs.map((c) => [c.id, []]));
    if (convs.length) {
        for (const m of await db.all('SELECT id, conversation_id, author, author_name, body, created_at FROM inbox_messages WHERE conversation_id = ANY(?) ORDER BY id', [convs.map((c) => c.id)])) {
            byConv.get(m.conversation_id).push({ id: Number(m.id), author: m.author, author_name: m.author_name || null, body: m.body, created_at: m.created_at });
        }
    }
    return convs.map((c) => ({ ...convShape(c), created_at: c.created_at, last_message_at: c.last_message_at || null, messages: byConv.get(c.id) }));
}

// A spreadsheet runs a cell that starts with = + - @ (or a tab or return before one) as a formula: such cells start with '.
const cell = (v) => { const s = v == null ? '' : String(v); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
const COLUMNS = ['conversation_id', 'status', 'visitor_name', 'visitor_email', 'verified', 'page_url', 'rating', 'rating_comment', 'message_id', 'author', 'author_name', 'body', 'created_at'];

async function csv(inbox) {
    const lines = [COLUMNS.join(',')];
    for (const c of await conversations(inbox)) {
        for (const m of c.messages) {
            lines.push([c.id, c.status, c.visitor_name, c.visitor_email, c.verified ? 'yes' : 'no', c.page_url, c.rating, c.rating_comment, m.id, m.author, m.author_name, m.body, m.created_at].map(cell).join(','));
        }
    }
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = { RETENTION_CHOICES, EXPORT_MAX, sweep, conversations, csv };
