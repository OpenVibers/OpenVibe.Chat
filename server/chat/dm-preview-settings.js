'use strict';
/**
 * Link previews in direct messages (plan "embeds", part 4): a person's own switch, on by default, kept in Chat
 * because it only governs what Chat does with a DM address (it is not a portable Network preference).
 *
 * Privacy rule: a DM address is fetched only when every person in the conversation has the switch on. Off on one
 * side and the message gains no preview at all; the stored previews of earlier messages are hidden on every read
 * too, so turning it off also stops showing what was already fetched. The setting is per person, not per
 * conversation: it covers every DM they are in, including a group.
 *
 * Enforcement lives in server/chat/dm.js (send and read), the checkbox in the Chat settings page.
 */
const db = require('../db/database');

/** True for a person with the switch on, including someone who never touched it (no row = the default). */
async function enabledFor(userId) {
    const id = Number(userId) || 0;
    if (!(id > 0)) return false;
    const row = await db.get('SELECT enabled FROM dm_link_preview_settings WHERE user_id = ?', [id]).catch(() => ({ enabled: false }));
    if (!row) return true;
    return !(row.enabled === false || row.enabled === 0 || row.enabled === '0');
}

/** Save a person's choice: true is the default, so it stores the on state too rather than deleting the row. */
async function setEnabled(userId, enabled) {
    const id = Number(userId) || 0;
    if (!(id > 0)) return false;
    await db.run(`INSERT INTO dm_link_preview_settings (user_id, enabled) VALUES (?, ?)
                  ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = ov_now()`, [id, enabled !== false]);
    return true;
}

/**
 * Whether this conversation may fetch or show previews: false when anyone in it has the switch off. One query,
 * so a DM read never waits on one Network module per person.
 */
async function allowedIn(conversationId) {
    const id = Number(conversationId) || 0;
    if (!(id > 0)) return false;
    const row = await db.get(`SELECT COUNT(*) AS off FROM dm_participants p
                              JOIN dm_link_preview_settings s ON s.user_id = p.user_id
                              WHERE p.conversation_id = ? AND s.enabled = false`, [id]).catch(() => ({ off: 1 }));
    return !(row && Number(row.off) > 0);
}

module.exports = { enabledFor, setEnabled, allowedIn };
