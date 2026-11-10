'use strict';
/**
 * One room's AI insight, as GET /api/v1/rooms/:id/insight answers it (plan 2026-11-10, parts 1 and 2).
 *
 * The writer is the existing chat-AI job (server/ai/chat-ai.js): the same schedule, the same window and
 * budget rules, only when there were new messages, and only the messages of people who allowed AI use of
 * them. This module is the reader: it shapes a stored summary and the append-only timeline into one answer
 * for every room, so a room, a server's channel and a Live channel read the same thing.
 *
 *   { overview: { text, topics: [{ label, count }], people, messages, from, to, updated_at },
 *     timeline: [{ at, kind, title, text, message_id }],
 *     state: 'ready' | 'quiet' | 'off' }
 *
 * Quiet is said as quiet: when the last summary is old (or there is none), the overview text is empty and
 * only the stored timeline remains. Off is a room whose owner has not turned the insight on: no text, no
 * timeline, and never a DM or a chat with Vibe. The timeline is newest first.
 */
const db = require('../db/database');

const QUIET_AFTER_MS = 6 * 60 * 60 * 1000;   // the job refreshes a busy room at least every 30 min
const TIMELINE_LIMIT = 40;

function _time(s) { return s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : 0; }

function _topics(raw) {
    let list = [];
    try { list = JSON.parse(raw || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) return [];
    return list
        .map((t) => ({ label: String((t && t.label) || '').trim().slice(0, 60), count: Math.max(0, Number(t && t.count) || 0) }))
        .filter((t) => t.label)
        .slice(0, 20);
}

function _timeline(events) {
    return (events || []).map((e) => ({
        at: e.ts || null,
        kind: e.kind || 'moment',
        title: String(e.label || '').slice(0, 140),
        text: String(e.detail || ''),
        message_id: e.message_id == null ? null : Number(e.message_id),
    })).filter((e) => e.at && e.title);
}

/**
 * One answer from a summary row and its timeline. `enabled` false (a private room whose owner has not
 * turned insight on, or a chat with Vibe) is `off`: empty, not a history leak.
 */
function _shape(row, events, enabled = true) {
    if (!enabled) {
        return {
            overview: { text: '', topics: [], people: 0, messages: 0, from: null, to: null, updated_at: null },
            timeline: [],
            state: 'off',
        };
    }
    const fresh = !!(row && row.overview && row.window_end && Date.now() - _time(row.window_end) < QUIET_AFTER_MS);
    const state = fresh ? 'ready' : 'quiet';
    return {
        overview: {
            text: fresh ? String(row.overview) : '',
            topics: fresh ? _topics(row.topics_json) : [],
            people: fresh ? (Number(row.people) || 0) : 0,
            messages: fresh ? (Number(row.window_message_count) || 0) : 0,
            from: row ? (row.window_start || null) : null,
            to: row ? (row.window_end || null) : null,
            updated_at: row ? (row.updated_at || null) : null,
        },
        timeline: _timeline(events),
        state,
    };
}

/** The Global room's insight (scope `global`, written by the site-wide job). */
async function global() {
    const [row, events] = await Promise.all([
        db.getChatAiSummary('global', 0, 'global'),
        db.getChatTimelineEvents({ scope: 'global', subjectId: 0, limit: TIMELINE_LIMIT }),
    ]);
    return _shape(row, events);
}

/** A room's (or a server channel's) insight: scope `room`, subject is the rooms row's id. */
async function room(roomRow, { enabled = true } = {}) {
    const [row, events] = await Promise.all([
        db.getChatAiSummary('room', roomRow.id, 'rolling'),
        db.getChatTimelineEvents({ scope: 'room', subjectId: roomRow.id, limit: TIMELINE_LIMIT }),
    ]);
    return _shape(row, events, enabled);
}

/** A Live channel chat's insight: scope `channel`, subject is the broadcaster's user id. */
async function channel(channelUserId, { enabled = true } = {}) {
    const id = Number(channelUserId);
    if (!id) return _shape(null, [], false);
    const [row, events] = await Promise.all([
        db.getChatAiSummary('channel', id, 'rolling'),
        db.getChatTimelineEvents({ scope: 'channel', subjectId: id, limit: TIMELINE_LIMIT }),
    ]);
    return _shape(row, events, enabled);
}

module.exports = { global, room, channel, _shape, _topics, QUIET_AFTER_MS };
