'use strict';
/**
 * The default view for each kind of conversation (bubbles or a chat room) — the plan, 2026-11-09, stage V1:
 * "You can toggle per conversation, and set a default per kind in settings, synced through Network so the Dock
 * follows it."
 *
 * The choice is kept in Chat (migration 0052) because the Network module `chat.preferences` has no field for it
 * yet: adding one is a Contracts change (chat.preferences v3) that only lands with a release and a pin. Until
 * then the choice is Chat's own, and `view_defaults` is written to the Network module only when that module
 * knows the field (it answers with "unknown field" otherwise).
 */
const db = require('../db/database');

const KINDS = ['one_to_one', 'ai', 'group', 'channel'];
const FALLBACK = { one_to_one: 'bubbles', ai: 'bubbles', group: 'room', channel: 'room' };

/** The default view for each kind: what the person chose, or the built-in default. */
async function of(userId) {
    const out = { ...FALLBACK };
    try {
        const rows = await db.all('SELECT kind, view FROM dm_view_defaults WHERE user_id = ?', [userId]);
        for (const r of rows) if (KINDS.includes(r.kind) && (r.view === 'bubbles' || r.view === 'room')) out[r.kind] = r.view;
    } catch { /* the table is not there yet: the defaults stand */ }
    return out;
}

/** Save the defaults for the kinds that were chosen (null leaves a kind as it was). */
async function save(userId, values = {}) {
    for (const kind of KINDS) {
        const view = values[kind];
        if (view !== 'bubbles' && view !== 'room') continue;
        await db.run(`INSERT INTO dm_view_defaults (user_id, kind, view) VALUES (?, ?, ?)
            ON CONFLICT (user_id, kind) DO UPDATE SET view = EXCLUDED.view`, [userId, kind, view]);
    }
    return await of(userId);
}

module.exports = { of, save, KINDS, FALLBACK };
