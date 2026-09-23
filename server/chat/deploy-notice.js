'use strict';
// ═══════════════════════════════════════════════════════════════
// Deploy notices in chat — one tidy, rolling message instead of a line per restart.
// (Moved from OpenVibe.Live server/chat/deploy-notice.js, W6.)
//
// Live still decides WHAT shipped — its git HEAD and the `deploy_last_announced` site setting — and
// tells Chat two ways while the Chat bridge is being retired (compatibility register C-84):
//   • the bridge op deployNotice (Live server/chat/chat-remote.js), commits newest first, so the
//     first one is the head Live deployed → announceCommits();
//   • the durable OpenVibe.Events event live.release.deployed (Live server/events/release-events.js),
//     subject { type: 'release', id: <head> } → applyReleaseEvent(), from ../events/consumer.js.
// Both claim the release by its head commit in deploy_releases, in the SAME transaction that stores
// or folds the card: the first to arrive makes the card, the other finds the head claimed and only
// records when it saw it. So the same head never makes two cards, whichever path comes first, and a
// repeat of either (a bridge retry, an Events redelivery, Live re-announcing after a crash) is one
// card. Once the event path has carried a clean deploy, the bridge op can go.
//
// Chat keeps the part that is chat:
//   • Consecutive deploys fold into ONE stored message: while the newest chat row in ANY room is a
//     deploy notice (nobody has spoken since) and its first deploy is under 3 hours old, that row is
//     updated in place.
//   • The row stores data, not prose: metadata { kind: 'deploy', commits[], deploys, first_at,
//     updated_at }. Clients render times from ISO timestamps, so they are always right.
//   • The live broadcast carries the row id; clients replace the card with that id instead of
//     appending, so reconnects and repeats can never duplicate it.
//   • Late joiners of this announcement get it once (replayTo, from the join handler).
// ═══════════════════════════════════════════════════════════════

// A card covers at most 3 hours of deploys, so its time range stays readable.
const FOLD_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_COMMITS = 40;
const ATTEMPTS_MS = [5000, 20000, 45000];        // clients reconnect with backoff after a restart
// A live.release.deployed older than this announces nothing (an operator replay, or Events catching
// up after a long outage): the card would sit under hours of chat with an old time.
const RELEASE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{40}$/;

// The notice for the announcing boot, kept for a while so clients that reconnect late still get it exactly once.
const REPLAY_MS = 15 * 60 * 1000;
let _live = null;   // { payload, until, sent: WeakSet }

const parseLog = (raw) => raw.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, short, date, ...rest] = line.split('\x1f');
    return { hash, short, date, subject: rest.join(' ').trim().slice(0, 200) };
}).filter(c => HASH_RE.test(c.hash || ''));

/** Live's commit list as stored on the card: full hashes only, fields capped (both paths). */
const cleanCommits = (commits) => (Array.isArray(commits) ? commits : []).filter((c) => c && HASH_RE.test(c.hash || '')).map((c) => ({
    hash: c.hash, short: String(c.short || c.hash.slice(0, 7)).slice(0, 12), date: String(c.date || ''), subject: String(c.subject || '').slice(0, 200),
}));

const plainText = (meta) => `🚀 ${meta.commits.length} update${meta.commits.length === 1 ? '' : 's'} shipped: ${meta.commits.slice(0, 3).map(c => c.subject).join(' · ')}${meta.commits.length > 3 ? ` · and ${meta.commits.length - 3} more` : ''}`;

/**
 * Insert a notice, or fold into the newest row when that row is itself a recent deploy notice.
 * "Newest" is across EVERY room: the global feed shows stream and channel messages too, so a card
 * that kept folding while people chatted in a stream ended up with a time range running past the
 * messages under it. Anyone speaking anywhere since the last card starts a new card.
 */
function persist(db, commits) {
    const nowIso = new Date().toISOString();
    const newest = db.get('SELECT id, message_type, metadata FROM chat_messages WHERE is_deleted = 0 ORDER BY id DESC LIMIT 1');
    let prev = null;
    if (newest && newest.message_type === 'system' && newest.metadata) {
        try { const m = JSON.parse(newest.metadata); if (m && m.kind === 'deploy' && Date.now() - Date.parse(m.first_at) < FOLD_WINDOW_MS) prev = m; } catch { /* not ours */ }
    }
    if (prev) {
        const seen = new Set(commits.map(c => c.hash));
        const merged = commits.concat((prev.commits || []).filter(c => !seen.has(c.hash))).slice(0, MAX_COMMITS);
        const meta = { kind: 'deploy', commits: merged, deploys: (prev.deploys || 1) + 1, first_at: prev.first_at, updated_at: nowIso };
        db.run('UPDATE chat_messages SET message = ?, metadata = ? WHERE id = ?', [plainText(meta), JSON.stringify(meta), newest.id]);
        return { id: newest.id, meta, folded: true };
    }
    const meta = { kind: 'deploy', commits: commits.slice(0, MAX_COMMITS), deploys: 1, first_at: nowIso, updated_at: nowIso };
    const res = db.saveChatMessage({ stream_id: null, user_id: null, anon_id: null, username: 'OpenVibe.Live', message: plainText(meta), message_type: 'system', is_global: true, metadata: meta });
    return { id: Number(res && (res.lastInsertRowid || res.lastID || res.id)) || null, meta, folded: false };
}

/**
 * Claim the release (its head commit) and store or fold its card, in ONE transaction. The first path
 * to arrive makes the card; the other finds the head claimed, notes when it saw it, and changes
 * nothing else. Returns { duplicate: true, id } or { duplicate: false, saved }.
 */
function claimRelease(db, { head, commits, via, eventId = null, now = Date.now() }) {
    const seenCol = via === 'events' ? 'event_at' : 'bridge_at';
    return db.transaction(() => {
        const claimed = db.get('SELECT message_id FROM deploy_releases WHERE head = ?', [head]);
        if (claimed) {
            db.run(`UPDATE deploy_releases SET ${seenCol} = COALESCE(${seenCol}, ?), event_id = COALESCE(event_id, ?) WHERE head = ?`, [now, eventId, head]);
            return { duplicate: true, id: claimed.message_id };
        }
        const saved = persist(db, commits);
        db.run(`INSERT INTO deploy_releases (head, message_id, first_via, ${seenCol}, event_id, commit_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [head, saved.id, via, now, eventId, commits.length, now]);
        return { duplicate: false, saved };
    });
}

/** Push the card to every connected client (three passes: clients reconnect with backoff) and keep it for late joiners. */
function broadcast({ chatServer, saved, list, log = console }) {
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
}

/**
 * The bridge path: commits Live just shipped (Live filtered them against deploy_last_announced),
 * newest first, so the first is the head. A head already announced (by the event, or a retried
 * bridge call) announces nothing.
 * @returns {{ announced: number, id?: number, duplicate?: boolean }}
 */
function announceCommits({ db, chatServer, commits, log = console }) {
    const list = cleanCommits(commits);
    if (!list.length) return { announced: 0 };
    const head = list[0].hash;

    let r;
    try { r = claimRelease(db, { head, commits: list, via: 'bridge' }); }
    catch (err) { log.warn('[Deploy notice] not saved:', err.message); return { announced: 0 }; }
    if (r.duplicate) {
        log.log(`[Deploy notice] ${head.slice(0, 7)} already announced (card ${r.id}); the bridge copy changes nothing`);
        return { announced: 0, id: r.id, duplicate: true };
    }
    broadcast({ chatServer, saved: r.saved, list, log });
    return { announced: list.length, id: r.saved.id };
}

/** The release a live.release.deployed envelope announces ({ head, commits }), or an 'ignored:*' outcome. No I/O. */
function releaseFrom(event, { now = Date.now(), maxAgeMs = RELEASE_MAX_AGE_MS } = {}) {
    if (!event || event.event_type !== 'live.release.deployed') return 'ignored:type';
    if (event.source !== 'live') return 'ignored:source';
    const s = event.subject && typeof event.subject === 'object' ? event.subject : {};
    if (s.type !== 'release' || !HASH_RE.test(String(s.id || ''))) return 'ignored:subject';
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (p.redacted === true) return 'ignored:redacted';
    const commits = cleanCommits(p.commits);
    if (!commits.length) return 'ignored:payload';
    const at = Date.parse(p.deployed_at || event.timestamp || '');
    if (Number.isFinite(at) && now - at > maxAgeMs) return 'ignored:stale';
    return { head: s.id, commits };
}

/**
 * The Events path, called inside the consumer's inbox transaction (synchronous). Returns an
 * 'ignored:*' outcome, or { outcome, detail, after } where after() broadcasts once the transaction
 * has committed. outcome: announced (a new card) | folded (into the last card) | duplicate:release
 * (the bridge, or an earlier event with this head, made the card already).
 */
function applyReleaseEvent({ db, chatServer, event, now = Date.now(), maxAgeMs = RELEASE_MAX_AGE_MS, log = console }) {
    const rel = releaseFrom(event, { now, maxAgeMs });
    if (typeof rel === 'string') return rel;
    const r = claimRelease(db, { head: rel.head, commits: rel.commits, via: 'events', eventId: event.event_id, now });
    const detail = { head: rel.head, message_id: r.duplicate ? r.id : r.saved.id, commits: rel.commits.length };
    if (r.duplicate) return { outcome: 'duplicate:release', detail };
    return { outcome: r.saved.folded ? 'folded' : 'announced', detail, after: () => broadcast({ chatServer, saved: r.saved, list: rel.commits, log }) };
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

module.exports = { replayTo, announceCommits, applyReleaseEvent, releaseFrom, claimRelease, persist, plainText, parseLog, cleanCommits, RELEASE_MAX_AGE_MS };
