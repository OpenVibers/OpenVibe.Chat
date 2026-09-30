/**
 * OpenVibe.Chat → OpenVibe.Live read mirror.
 *
 * After the cutover Chat is the only writer of its tables, but Live still reads some of them in
 * place (home-page stats, recaps, AI chat context, VOD chat replay, /api/mod queues, analytics),
 * and rollback means Live becomes the authority again. So every change Chat makes to its tables
 * (C-02) is copied into Live's tables of the same name, same ids:
 *
 *   - PostgreSQL triggers on the twelve tables (migrations/0001_initial.sql) record each change in
 *     live_mirror_outbox in the writing transaction — skipped where the transaction set ov.mirror_skip = '1'
 *     (the importers: rows that came from Live are never recorded);
 *   - this relay sends batches to Live's POST /internal/chat-effects/mirror (capability
 *     live.chat_mirror.write) as { changes: [{ table, op: 'upsert', row } | { table, op: 'delete', pk }] }
 *     with the row as it is NOW (so repeated changes to one row collapse into one upsert);
 *   - Live applies them idempotently (INSERT … ON CONFLICT DO UPDATE on the columns it has; it
 *     refuses unless it runs with CHAT_AUTHORITY=chat, so a rehearsal can never touch production).
 *
 * Rows leave the outbox only when Live acknowledged them; a Live outage just queues. Before a
 * rollback, `pending()` must be 0 (docs/cutover.md).
 */
'use strict';

const db = require('../db/database');
const serviceAuth = require('../net/service-auth');

const BATCH = 200;
const MAX_BODY = 800 * 1024;   // Live parses JSON bodies up to 1 MB
const SCOPE = 'live.chat_mirror.write';

// The row as it is now, per mirrored table (static statements, keyed as db.CHAT_TABLES).
const ROW_SQL = {
    chat_messages: 'SELECT * FROM chat_messages WHERE id = ?',
    dm_conversations: 'SELECT * FROM dm_conversations WHERE id = ?',
    dm_participants: 'SELECT * FROM dm_participants WHERE id = ?',
    dm_messages: 'SELECT * FROM dm_messages WHERE id = ?',
    dm_blocks: 'SELECT * FROM dm_blocks WHERE id = ?',
    tts_voice_overrides: 'SELECT * FROM tts_voice_overrides WHERE identity_key = ?',
    channel_sounds: 'SELECT * FROM channel_sounds WHERE id = ?',
    relay_users: 'SELECT * FROM relay_users WHERE id = ?',
    hidden_relay_users: 'SELECT * FROM hidden_relay_users WHERE id = ?',
    pending_ip_messages: 'SELECT * FROM pending_ip_messages WHERE id = ?',
    stream_first_chats: 'SELECT * FROM stream_first_chats WHERE chatter_key = ? AND channel_user_id = ?',
    moderation_actions: 'SELECT * FROM moderation_actions WHERE id = ?',
};

function createMirror({ config, fetchImpl = (...a) => globalThis.fetch(...a), log = console } = {}) {
    let timer = null;
    let busy = false;
    let lastError = null;

    async function pending() { return (await db.get('SELECT COUNT(*) AS n FROM live_mirror_outbox'))?.n || 0; }

    async function buildChanges(rows) {
        // Newest state per row: several changes to one key collapse into the last op.
        const byKey = new Map();
        for (const r of rows) byKey.set(`${r.tbl}|${r.pk}`, r);
        const changes = [];
        for (const r of byKey.values()) {
            const cols = db.CHAT_TABLES[r.tbl];
            if (!cols) continue;
            let pk;
            try { pk = JSON.parse(r.pk); } catch { continue; }
            if (r.op === 'delete') { changes.push({ table: r.tbl, op: 'delete', pk }); continue; }
            const row = await db.get(ROW_SQL[r.tbl], cols.map((c) => pk[c]));
            changes.push(row ? { table: r.tbl, op: 'upsert', row: r.tbl === 'moderation_actions' ? db.moderationRow(row) : r.tbl === 'chat_messages' ? db.chatMessageRow(row) : row } : { table: r.tbl, op: 'delete', pk });
        }
        return changes;
    }

    async function flush() {
        if (!config.live.mirror) return { sent: 0, disabled: true };
        if (busy) return { sent: 0, busy: true };
        busy = true;
        let sent = 0;
        try {
            for (;;) {
                const rows = await db.all('SELECT seq, tbl, op, pk FROM live_mirror_outbox ORDER BY seq LIMIT ?', [BATCH]);
                if (!rows.length) break;
                const changes = await buildChanges(rows);
                // Requests stay under Live's body limit; a batch is acknowledged when all its parts are.
                const parts = [[]];
                let size = 0;
                for (const c of changes) {
                    const n = Buffer.byteLength(JSON.stringify(c));
                    if (parts[parts.length - 1].length && size + n > MAX_BODY) { parts.push([]); size = 0; }
                    parts[parts.length - 1].push(c);
                    size += n;
                }
                let failed = false;
                for (const part of parts) {
                    let res;
                    try {
                        res = await fetchImpl(`${config.live.internalUrl}/internal/chat-effects/mirror`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', ...(await serviceAuth.headers(config.live.audience, SCOPE)) },
                            body: JSON.stringify({ changes: part }),
                            signal: AbortSignal.timeout(15000),
                        });
                    } catch (err) { lastError = err.message; failed = true; break; }
                    if (res.status === 401) serviceAuth.invalidate(config.live.audience, SCOPE);
                    if (!res.ok) {
                        const text = await res.text().catch(() => '');
                        lastError = `${res.status} ${text.slice(0, 200)}`;
                        failed = true;
                        break;
                    }
                }
                if (failed) break;
                const maxSeq = rows[rows.length - 1].seq;
                await db.run('DELETE FROM live_mirror_outbox WHERE seq <= ?', [maxSeq]);
                sent += changes.length;
                lastError = null;
            }
        } finally { busy = false; }
        if (lastError) log.warn(`[Mirror] Live mirror waiting (${await pending()} pending): ${lastError}`);
        return { sent, pending: await pending(), error: lastError };
    }

    // The triggers record every change; with the mirror off (rehearsals, tests) nothing is kept, as when the capture
    // was per connection and off: the queue is emptied on the same cadence instead of sent.
    async function discard() { await db.run('DELETE FROM live_mirror_outbox'); }

    function start() {
        if (timer) return;
        if (!config.live.mirror) {
            timer = setInterval(() => { discard().catch((e) => log.warn('[Mirror]', e.message)); }, config.live.mirrorIntervalMs);
            if (timer.unref) timer.unref();
            return;
        }
        timer = setInterval(() => { flush().catch((e) => log.warn('[Mirror]', e.message)); }, config.live.mirrorIntervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { start, stop, flush, pending, lastError: () => lastError };
}

module.exports = { createMirror };
