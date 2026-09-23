'use strict';
// ═══════════════════════════════════════════════════════════════
// Deploy notices in chat — one tidy, rolling message instead of a line per restart.
// (Moved from OpenVibe.Live server/chat/deploy-notice.js, W6.)
//
// Live still decides WHAT shipped — its git HEAD and the `deploy_last_announced` site setting —
// and hands the new commits to Chat over the bridge (bridge op deployNotice). Chat keeps the part
// that is chat:
//   • Consecutive deploys fold into ONE stored message: while the newest global chat row is a deploy
//     notice (nobody has spoken since) and it is under 12 hours old, that row is updated in place.
//   • The row stores data, not prose: metadata { kind: 'deploy', commits[], deploys, first_at,
//     updated_at }. Clients render times from ISO timestamps, so they are always right.
//   • The live broadcast carries the row id; clients replace the card with that id instead of
//     appending, so reconnects and repeats can never duplicate it.
//   • Late joiners of this announcement get it once (replayTo, from the join handler).
// ═══════════════════════════════════════════════════════════════

const FOLD_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_COMMITS = 40;
const ATTEMPTS_MS = [5000, 20000, 45000];        // clients reconnect with backoff after a restart

// The notice for the announcing boot, kept for a while so clients that reconnect late still get it exactly once.
const REPLAY_MS = 15 * 60 * 1000;
let _live = null;   // { payload, until, sent: WeakSet }

const parseLog = (raw) => raw.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, short, date, ...rest] = line.split('\x1f');
    return { hash, short, date, subject: rest.join(' ').trim().slice(0, 200) };
}).filter(c => /^[0-9a-f]{40}$/.test(c.hash || ''));

const plainText = (meta) => `🚀 ${meta.commits.length} update${meta.commits.length === 1 ? '' : 's'} shipped: ${meta.commits.slice(0, 3).map(c => c.subject).join(' · ')}${meta.commits.length > 3 ? ` · and ${meta.commits.length - 3} more` : ''}`;

/** Insert a notice, or fold into the newest row when that row is itself a recent deploy notice. */
function persist(db, commits) {
    const nowIso = new Date().toISOString();
    const newest = db.get('SELECT id, message_type, metadata FROM chat_messages WHERE is_global = 1 AND is_deleted = 0 ORDER BY id DESC LIMIT 1');
    let prev = null;
    if (newest && newest.message_type === 'system' && newest.metadata) {
        try { const m = JSON.parse(newest.metadata); if (m && m.kind === 'deploy' && Date.now() - Date.parse(m.first_at) < FOLD_WINDOW_MS) prev = m; } catch { /* not ours */ }
    }
    if (prev) {
        const seen = new Set(commits.map(c => c.hash));
        const merged = commits.concat((prev.commits || []).filter(c => !seen.has(c.hash))).slice(0, MAX_COMMITS);
        const meta = { kind: 'deploy', commits: merged, deploys: (prev.deploys || 1) + 1, first_at: prev.first_at, updated_at: nowIso };
        db.run('UPDATE chat_messages SET message = ?, metadata = ? WHERE id = ?', [plainText(meta), JSON.stringify(meta), newest.id]);
        return { id: newest.id, meta };
    }
    const meta = { kind: 'deploy', commits: commits.slice(0, MAX_COMMITS), deploys: 1, first_at: nowIso, updated_at: nowIso };
    const res = db.saveChatMessage({ stream_id: null, user_id: null, anon_id: null, username: 'OpenVibe.Live', message: plainText(meta), message_type: 'system', is_global: true, metadata: meta });
    return { id: res && (res.lastInsertRowid || res.lastID || res.id) || null, meta };
}

/**
 * Announce commits Live just shipped (Live filtered them against deploy_last_announced).
 * @returns {{ announced: number }}
 */
function announceCommits({ db, chatServer, commits, log = console }) {
    const list = (Array.isArray(commits) ? commits : []).filter((c) => c && /^[0-9a-f]{40}$/.test(c.hash || '')).map((c) => ({
        hash: c.hash, short: String(c.short || c.hash.slice(0, 7)).slice(0, 12), date: String(c.date || ''), subject: String(c.subject || '').slice(0, 200),
    }));
    if (!list.length) return { announced: 0 };

    let saved;
    try { saved = persist(db, list); }
    catch (err) { log.warn('[Deploy notice] not saved:', err.message); return { announced: 0 }; }

    const payload = JSON.stringify({ type: 'update', kind: 'deploy', id: saved.id, fresh: list.map(c => c.hash), url: '/updates', timestamp: saved.meta.updated_at, ...saved.meta });
    const sent = new WeakSet();
    _live = { payload, until: Date.now() + REPLAY_MS, sent };
    const push = () => {
        let n = 0;
        for (const [ws] of chatServer.clients) {
            if (sent.has(ws) || ws.readyState !== 1 || ws.bufferedAmount > 256 * 1024) continue;
            try { ws.send(payload); sent.add(ws); n++; } catch { /* socket went away */ }
        }
        return n;
    };
    ATTEMPTS_MS.forEach((ms, i) => { const t = setTimeout(() => { const n = push(); if (n) log.log(`[Deploy notice] ${list.length} commit(s) → ${n} client(s) (pass ${i + 1})`); }, ms); if (t.unref) t.unref(); });
    return { announced: list.length, id: saved.id };
}

/**
 * Called when a chat client finishes joining: if a deploy was just announced and this socket has not
 * had it, send it now. Covers clients whose reconnect backoff outlasted the broadcast passes, a chat
 * server that came up late, and tabs that were asleep. The card is keyed by row id, so a repeat cannot
 * duplicate.
 */
function replayTo(ws) {
    if (!_live || Date.now() > _live.until || _live.sent.has(ws)) return false;
    try { if (ws.readyState === 1) { ws.send(_live.payload); _live.sent.add(ws); return true; } } catch { /* socket went away */ }
    return false;
}

module.exports = { replayTo, announceCommits, persist, plainText, parseLog };
