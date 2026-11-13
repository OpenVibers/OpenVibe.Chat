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
// The window's moments, newest last: each event once (a sound played three times is one line, "×3", at its latest),
// and the latest messages beside them, so a window of repeated sound plays still shows what was said today (the owner,
// 11-13: "played !africa" three times, and nothing from today).
function _timeline(rows, now) {
    const isEvent = (r) => !!(r.message_type && r.message_type !== 'chat' && r.message_type !== 'tts');
    const byLabel = new Map();
    for (const r of rows) {
        if (!isEvent(r)) continue;
        const label = _oneLine(r.message, 80);
        if (!label || _PLACEHOLDER.test(label)) continue;
        const key = label.toLowerCase();
        const was = byLabel.get(key);
        byLabel.set(key, { r, label, n: was ? was.n + 1 : 1 });
    }
    const events = [...byLabel.values()].slice(-6);
    const said = rows.filter((r) => !isEvent(r) && r.message_type !== 'tts').slice(-Math.max(3, 8 - events.length));
    const at = (r) => Date.parse(r.timestamp || r.created_at || '') || 0;
    const picked = [...events.map((e) => ({ ...e, kind: 'event' })), ...said.map((r) => ({ r, label: _oneLine(r.message, 80), n: 1, kind: 'message' }))]
        .filter((e) => e.label && !_PLACEHOLDER.test(e.label))
        .sort((x, y) => at(x.r) - at(y.r))
        .slice(-10);
    return picked.map(({ r, label, n, kind }) => ({
        label: n > 1 ? `${label} ×${n}` : label, detail: _oneLine(r.username || r.channel_username || '', 120),
        mins_ago: _minsAgo(r.timestamp || r.created_at, now), kind, message_id: r.id == null ? null : Number(r.id),
    }));
}

// The words the window keeps coming back to (the same stop-list rule as the job's topics).
const TOPIC_STOP = new Set(('the and for that this with you your are was were have has had not but all can '
    + 'just from they them their there here what when who how why will would could should about into over than then '
    + 'its it\'s i\'m dont don\'t im ive you\'re your\'re hes shes theyre we\'re thats whats lets get got like one '
    + 'now out up off too very really some any more most much many also only even still back well good bad lol lmao '
    + 'yeah yes nope ok okay hi hello hey thanks thank please bro dude guys guy chat room message messages people').split(' '));
function _topics(rows, limit = 3) {
    const counts = new Map();
    for (const r of rows || []) {
        const text = String((r && r.message) || '').toLowerCase()
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/:[a-z0-9_+-]+:/g, ' ')
            .replace(/@[a-z0-9_.-]+/g, ' ');
        for (const m of text.matchAll(/[a-z][a-z'’-]{2,}/g)) {
            const word = m[0].replace(/['’-]+$/g, '');
            if (word.length < 3 || TOPIC_STOP.has(word)) continue;
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    }
    return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit).map(([label]) => label);
}

/**
 * The global overview, for someone arriving now: two sentences. The first says what the room is talking
 * about (its most-mentioned words, or that it is quiet); the second says who is here and the latest line.
 * This is the fallback when OpenVibe.AI does not answer; the AI template asks for the same two-sentence shape.
 */
function globalFrom(rows, { windowLabel = 'recent window', priorMemory = '', now = Date.now() } = {}) {
    const authors = new Set(rows.map((r) => r.username).filter(Boolean));
    const sample = rows.slice(-3).map((r) => _oneLine(r.message, 120)).filter(Boolean);
    const topics = _topics(rows);
    const first = topics.length
        ? `The talk is mostly about ${topics.join(', ')}.`
        : `It is quiet in the room during the ${windowLabel}.`;
    const people = authors.size;
    const second = sample.length
        ? `${people || rows.length} ${people === 1 ? 'person has' : 'people have'} been chatting; the latest line was “${sample[sample.length - 1]}”.`
        : `${people} ${people === 1 ? 'person is' : 'people are'} here.`;
    const recent_overview = _clip(`${first} ${second}`, 2000);
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
