/**
 * OpenVibe.Chat → OpenVibe.Live read mirror.
 *
 * After the cutover Chat is the only writer of its tables, but Live still reads some of them in
 * place (home-page stats, recaps, AI chat context, VOD chat replay, /api/mod queues, analytics),
 * and rollback means Live becomes the authority again. So every change Chat makes to its tables
 * is copied into Live's tables of the same name, same ids:
 *
 *   - this connection's TEMP triggers (db.initDb({ captureMirror: true })) record each change in
 *     live_mirror_outbox — writes by the importer (rows that came from Live) are never recorded;
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

function createMirror({ config, fetchImpl = (...a) => globalThis.fetch(...a), log = console } = {}) {
    let timer = null;
    let busy = false;
    let lastError = null;

    function pending() { return db.get('SELECT COUNT(*) AS n FROM live_mirror_outbox')?.n || 0; }

    function buildChanges(rows) {
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
            const where = cols.map((c) => `${c} = ?`).join(' AND ');
            const row = db.get(`SELECT * FROM ${r.tbl} WHERE ${where}`, cols.map((c) => pk[c]));
            changes.push(row ? { table: r.tbl, op: 'upsert', row } : { table: r.tbl, op: 'delete', pk });
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
                const rows = db.all('SELECT seq, tbl, op, pk FROM live_mirror_outbox ORDER BY seq LIMIT ?', [BATCH]);
                if (!rows.length) break;
                const changes = buildChanges(rows);
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
                db.run('DELETE FROM live_mirror_outbox WHERE seq <= ?', [maxSeq]);
                sent += changes.length;
                lastError = null;
            }
        } finally { busy = false; }
        if (lastError) log.warn(`[Mirror] Live mirror waiting (${pending()} pending): ${lastError}`);
        return { sent, pending: pending(), error: lastError };
    }

    function start() {
        if (timer || !config.live.mirror) return;
        timer = setInterval(() => { flush().catch((e) => log.warn('[Mirror]', e.message)); }, config.live.mirrorIntervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { start, stop, flush, pending, lastError: () => lastError };
}

module.exports = { createMirror };
