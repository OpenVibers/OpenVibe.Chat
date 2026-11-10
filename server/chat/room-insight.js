'use strict';
/**
 * One room's AI insight, as GET /api/v1/rooms/:id/insight answers it (plan 2026-11-10, part 1: Global).
 *
 * The writer is the existing chat-AI job (server/ai/chat-ai.js): the same schedule, the same window and
 * budget rules, only when there were new messages, and only the messages of people who allowed AI use of
 * them. This module is the reader: it shapes the stored summary and the append-only timeline into one
 * answer for every room, so Live and Chat can read the same thing.
 *
 *   { overview: { text, topics: [{ label, count }], people, messages, from, to, updated_at },
 *     timeline: [{ at, kind, title, text, message_id }],
 *     state: 'ready' | 'quiet' | 'off' }
 *
 * Quiet is said as quiet: when the last summary is old (or there is none), the overview text is empty and
 * only the stored timeline remains. The timeline is newest first, which is what someone arriving wants.
 */
const db = require('../db/database');

const QUIET_AFTER_MS = 6 * 60 * 60 * 1000;   // the job refreshes Global at least every 30 min when there is news
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

function _shape(row, events) {
    // A summary written from nobody's messages is not a read of the room: zero consenting people means
    // quiet, however recent the row is (rows written before the consent filter carry no people count).
    const fresh = !!(row && row.overview && Number(row.people) > 0 && row.window_end && Date.now() - _time(row.window_end) < QUIET_AFTER_MS);
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

/** The Global room's insight. Other rooms answer through room-insight in part 2. */
async function global() {
    const [row, events] = await Promise.all([
        db.getChatAiSummary('global', 0, 'global'),
        db.getChatTimelineEvents({ scope: 'global', subjectId: 0, limit: TIMELINE_LIMIT }),
    ]);
    return _shape(row, events);
}

module.exports = { global, _shape, _topics, QUIET_AFTER_MS };
