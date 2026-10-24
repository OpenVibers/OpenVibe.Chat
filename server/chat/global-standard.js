'use strict';
/**
 * What OpenVibe's own global room shows: the openvibe.chat front page, /global and the global feed on every site, where
 * every stream's and channel's chat is mirrored (chat-server forwardToGlobal / forwardToGlobalByChannel). A stream or
 * channel room keeps its streamer's own rules; the global room has OpenVibe's: no core slur (moderation-utils), which
 * global chat already refuses at send time one line at a time.
 *
 * 2026-10-24: a viewer flooded goosely's offline channel with 600–1,378-character walls of block characters, then spelled
 * a slur one letter per line; all of it showed on openvibe.chat's front page. So here:
 *   - a core slur spelled across one sender's short lines (each at most SHORT visible characters, at most RUN_MS
 *     apart) hides the whole run;
 *   - a mirrored line (from a stream or channel room) is not shown when it is a wall or has no letter, digit or emoji at
 *     all (".", ",", "%%%%").
 * The same viewer came back that afternoon with "[8][8][8]…" walls (a digit in every three characters passed the
 * letters-or-digits share) and with walls typed in the global room itself, which only refused slurs. So a wall is now
 * long and either mostly not letters or digits, or one short piece repeated (it compresses to almost nothing), and the
 * global room refuses walls at send time (chat-server _chatRulesBlock) and hides any already there.
 * Mirrored lines stay in their own room. The front page and the global history filter rows (filterFeed); the live mirror
 * asks a run guard per line (createRunGuard).
 */
const zlib = require('zlib');
const { containsCoreSlur } = require('./moderation-utils');

const SHORT = 4;
const RUN_MS = 60 * 1000;
const WALL_MIN = 120;
const WORDISH = /[\p{L}\p{N}\p{Extended_Pictographic}]/gu;

const visible = (text) => [...String(text == null ? '' : text).replace(/\s+/g, '')];
const isShort = (text) => { const n = visible(text).length; return n > 0 && n <= SHORT; };
// Deflated size over UTF-8 size: ordinary sentences stay above ~0.45 at this length, one piece repeated falls under 0.05.
const REPEAT_RATIO = 0.15;
function isWall(text) {
    const v = visible(text);
    if (v.length < WALL_MIN) return false;
    const s = v.join('');
    if ((s.match(WORDISH) || []).length / v.length < 0.3) return true;
    return zlib.deflateRawSync(s).length / Buffer.byteLength(s) < REPEAT_RATIO;
}
const hasWords = (text) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(String(text || ''));
const senderOf = (m) => (m.user_id ? `u:${m.user_id}` : m.anon_id ? `a:${m.anon_id}` : `n:${m.username || ''}`);
const mirroredRow = (m) => !!(m.stream_id || m.channel_user_id) && !m.is_global;
const atOf = (m) => { const s = String(m.timestamp || ''); const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : 0; };

/** One line on its own: `mirrored` is a line from a stream or channel room. */
function lineOk(text, { mirrored = false } = {}) {
    if (containsCoreSlur(String(text || ''), [])) return false;
    if (isWall(text) || (mirrored && !hasWords(text))) return false;
    return true;
}

/** Rows of the global feed without what the global room does not show, in the order given. */
function filterFeed(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const drop = new Set();
    const runs = new Map();   // sender → its current run of short lines, oldest first
    const close = (run) => { if (run && run.length > 1 && containsCoreSlur(run.map((r) => r.message).join(' '), [])) run.forEach((r) => drop.add(r)); };
    for (const r of [...list].sort((a, b) => Number(a.id) - Number(b.id))) {
        if ((r.message_type || 'chat') !== 'chat') continue;
        const key = senderOf(r);
        const run = runs.get(key);
        if (!isShort(r.message)) { close(run); runs.delete(key); continue; }
        if (run && atOf(r) - atOf(run[run.length - 1]) <= RUN_MS) run.push(r);
        else { close(run); runs.set(key, [r]); }
    }
    for (const run of runs.values()) close(run);
    return list.filter((r) => !drop.has(r) && ((r.message_type || 'chat') !== 'chat' || lineOk(r.message, { mirrored: mirroredRow(r) })));
}

/**
 * The live side: check(line) as each line is said → { ok, retract }. ok = it may be shown in the global room now;
 * retract = the ids of the sender's earlier lines that this one turns into a slur (shown already: delete them there).
 * line = { id, message, user_id?, anon_id?, username?, mirrored }.
 */
function createRunGuard({ now = Date.now } = {}) {
    const runs = new Map();   // sender → [{ id, text, at }]
    return {
        check(line) {
            const key = senderOf(line);
            const at = now();
            if (!isShort(line.message)) { runs.delete(key); return { ok: lineOk(line.message, line), retract: [] }; }
            const run = (runs.get(key) || []).filter((x) => at - x.at <= RUN_MS);
            run.push({ id: line.id, text: String(line.message), at });
            if (run.length > 1 && containsCoreSlur(run.map((x) => x.text).join(' '), [])) {
                runs.delete(key);
                return { ok: false, retract: run.slice(0, -1).map((x) => x.id).filter(Boolean) };
            }
            runs.set(key, run.slice(-24));
            if (runs.size > 5000) runs.delete(runs.keys().next().value);
            return { ok: lineOk(line.message, line), retract: [] };
        },
    };
}

module.exports = { lineOk, filterFeed, createRunGuard, isWall, SHORT, RUN_MS };
