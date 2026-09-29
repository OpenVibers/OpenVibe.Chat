/**
 * The chat-AI job's fallback: a deterministic, extractive summary built from the message batch
 * itself when OpenVibe.AI does not answer (disabled, over quota, refuses the namespace, or the run
 * fails). It produces the same output fields as the `chat.global` / `chat.profile` workflows, so
 * the stored row and every route shape are identical either way.
 *
 * Live had no extractive summariser (its job simply skipped a failed call); Chat needs one because
 * the `chat.*` workflows do not exist in OpenVibe.AI yet (see the report's "For Opus"), so this is
 * the summary the feature serves until they do.
 */
'use strict';

const MSG_MAX_CHARS = 220;

function _clip(str, n) { str = (str == null ? '' : String(str)).trim(); return str.length > n ? str.slice(0, n) : str; }
function _oneLine(str, n) { return _clip(String(str == null ? '' : str).replace(/\s+/g, ' '), n); }

function _parseSqlTime(s) { return s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : 0; }

function _minsAgo(ts, now) {
    const t = _parseSqlTime(ts);
    return t ? Math.max(0, Math.round((now - t) / 60000)) : null;
}

// A placeholder the model itself refuses ("short title", "one sentence") never becomes a label.
const _PLACEHOLDER = /^(short title|one sentence|label|title|detail|\.\.\.)$/i;

/** Notable moments: non-chat activity (donations, clips, sound events), else the latest messages. */
function _timeline(rows, now) {
    const notable = rows.filter((r) => r.message_type && r.message_type !== 'chat' && r.message_type !== 'tts');
    const picked = (notable.length ? notable : rows.slice(-5)).slice(-10);
    return picked
        .map((r) => {
            const label = _oneLine(r.message, 80);
            if (!label || _PLACEHOLDER.test(label)) return null;
            return { label, detail: _oneLine(r.username || r.channel_username || '', 120), mins_ago: _minsAgo(r.timestamp || r.created_at, now) };
        })
        .filter(Boolean);
}

/** The global overview: how much traffic, who and where, with a few representative lines. */
function globalFrom(rows, { windowLabel = 'recent window', priorMemory = '', now = Date.now() } = {}) {
    const authors = new Set(rows.map((r) => r.username).filter(Boolean));
    const rooms = new Set(rows.map((r) => r.channel_username || (r.is_global ? 'global' : null)).filter(Boolean));
    const sample = rows.slice(-3).map((r) => _oneLine(r.message, 120)).filter(Boolean);
    const recent_overview = _clip(
        `${rows.length} messages from ${authors.size} chatter${authors.size === 1 ? '' : 's'} in ${rooms.size || 1} room${rooms.size === 1 ? '' : 's'} during the ${windowLabel}.` +
        (sample.length ? ` Latest: ${sample.join(' · ')}` : ''),
        2000
    );
    return {
        recent_overview,
        memory: _clip(priorMemory || (sample[0] ? `Latest: ${sample[0]}` : ''), 1600),
        timeline: _timeline(rows, now),
    };
}

/** The per-subject (user / relay / anon) insight: today vs. all-time from the batch. */
function profileFrom(rows, { name = '', subjectKind = 'user', priorMemory = '', has24h = false, seen = 0, now = Date.now() } = {}) {
    const sample = rows.slice(-3).map((r) => _oneLine(r.message, 120)).filter(Boolean);
    const who = name || `${subjectKind} user`;
    const overview_24h = has24h
        ? _clip(`${who}: ${rows.length} message${rows.length === 1 ? '' : 's'} in the last 24 hours.` + (sample.length ? ` Latest: ${sample.join(' · ')}` : ''), 1200)
        : '';
    const overview_alltime = _clip(`${who} has ${seen + rows.length} message${seen + rows.length === 1 ? '' : 's'} seen.` + (sample.length ? ` Latest: ${sample.join(' · ')}` : ''), 1200);
    return {
        overview_24h,
        overview_alltime,
        memory: _clip(priorMemory || (sample[0] ? `Latest: ${sample[0]}` : ''), 1200),
        timeline: _timeline(rows, now),
    };
}

module.exports = { globalFrom, profileFrom, _timeline, MSG_MAX_CHARS };
