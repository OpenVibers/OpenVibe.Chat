'use strict';
/**
 * Who answers a support conversation (server/inbox/inbox.js): one of the inbox's people takes it by answering, is
 * assigned by a teammate, or, with turns on (inboxes.route = 'round_robin'), a conversation that starts waiting goes
 * to the person whose turn it is: the one assigned longest ago (inbox_members.last_assigned_at). Notifications then go
 * to that person only (server/inbox/notify.js already tells the assignee first).
 */
const db = require('../db/database');

/** The person whose turn it is, or null (turns off, or nobody in the inbox). */
async function nextInTurn(inbox) {
    if (inbox.route !== 'round_robin') return null;
    const row = await db.get(`SELECT user_id FROM inbox_members WHERE inbox_id = ?
        ORDER BY last_assigned_at IS NOT NULL, last_assigned_at, role DESC, user_id LIMIT 1`, [inbox.id]);
    return row ? Number(row.user_id) : null;
}

async function noteAssigned(inboxId, userId) {
    if (userId == null) return;
    await db.run('UPDATE inbox_members SET last_assigned_at = ov_now_iso() WHERE inbox_id = ? AND user_id = ?', [inboxId, userId]);
}

module.exports = { nextInTurn, noteAssigned };
