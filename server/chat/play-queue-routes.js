'use strict';
/**
 * OpenVibe.Chat — the routes of the chat plays queue (Agent Streams S6, §2 and §8).
 *
 * The people of the room:
 *   POST /api/chat/rooms/:slug/play/vote            { request_id }   one vote per person
 *   POST /api/chat/rooms/:slug/play/skip            { request_id }   the owner or a moderator
 *   POST /api/chat/rooms/:slug/play/remove          { request_id }   the owner or a moderator
 *   POST /api/chat/rooms/:slug/play/pin             { request_id, on } the owner or a moderator
 *   GET  /api/chat/rooms/:slug/play                                  the queue, for the room
 *
 * The task's service (Codes), for the stream's owner:
 *   GET  /api/v1/rooms/agent:<id>/play-queue                        chat.play_queue.read
 *   POST /api/v1/rooms/agent:<id>/play-queue/:request_id            chat.play_queue.write
 *
 * The queue's people and votes belong to the room: the task's service may move a request along and record
 * how it ended, and nothing else.
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const db = require('../db/database');
const rooms = require('../rooms/rooms');
const room = require('./agent-room');
const queue = require('./play-queue');

const member = express.Router();
const service = express.Router();

/** The room and what the person may do in it. */
async function load(req, res) {
    const found = await rooms.bySlug(String(req.params.slug || ''));
    if (!found || found.archived_at) { res.status(404).json({ error: 'No such room', code: 'rooms.not_found' }); return null; }
    const a = await rooms.access(found, req.user);
    if (!a.read) { res.status(403).json({ error: 'You cannot see this room', code: 'rooms.forbidden' }); return null; }
    return { room: found, a };
}

/** The request of the body, in this room. */
async function requestOf(ctx, req, res) {
    const id = String((req.body || {}).request_id || '').trim();
    if (!id) { res.status(400).json({ error: 'A request is required', code: 'play_queue.bad_request' }); return null; }
    const row = await db.get('SELECT * FROM agent_play_requests WHERE id = ? AND room_id = ?', [id, ctx.room.id]);
    if (!row) { res.status(404).json({ error: 'No such request', code: 'play_queue.not_found' }); return null; }
    return row;
}

// ── The people of the room ───────────────────────────────────────────────

member.get('/:slug/play', requireAuth, async (req, res) => {
    try {
        const ctx = await load(req, res);
        if (!ctx) return;
        const open = await queue.openRequests(ctx.room);
        const current = await queue.currentRequest(ctx.room);
        res.json({
            room: ctx.room.slug,
            current: current ? queue.requestView(current.row, current.votes) : null,
            requests: open.map((r) => queue.requestView(r.row, r.votes)),
        });
    } catch (err) {
        console.error('[Chat] the queue could not be read:', err.message);
        res.status(500).json({ error: 'The queue could not be read', code: 'play_queue.failed' });
    }
});

member.post('/:slug/play/vote', requireAuth, async (req, res) => {
    try {
        const ctx = await load(req, res);
        if (!ctx) return;
        const row = await requestOf(ctx, req, res);
        if (!row) return;
        const out = await queue.vote(row, req.user);
        if (!out.ok) return res.status(409).json({ error: 'That vote did not count', code: out.code });
        const fresh = await db.get('SELECT * FROM agent_play_requests WHERE id = ?', [row.id]);
        res.json(queue.requestView(fresh, await queue.votesOf(fresh)));
    } catch (err) {
        console.error('[Chat] the vote failed:', err.message);
        res.status(500).json({ error: 'The vote did not count', code: 'play_queue.failed' });
    }
});

/** Skip, remove and pin: the owner or a moderator. */
for (const [action, fn] of [['skip', queue.skip], ['remove', queue.remove]]) {
    member.post(`/:slug/play/${action}`, requireAuth, async (req, res) => {
        try {
            const ctx = await load(req, res);
            if (!ctx) return;
            if (!ctx.a.moderate) return res.status(403).json({ error: 'Only the owner or a moderator can do that', code: 'play_queue.not_moderator' });
            const row = await requestOf(ctx, req, res);
            if (!row) return;
            const out = await fn(row, { room: ctx.room, username: req.user.username, handle: req.user.username });
            res.json(out);
        } catch (err) {
            console.error('[Chat] the request could not be changed:', err.message);
            res.status(500).json({ error: 'The request could not be changed', code: 'play_queue.failed' });
        }
    });
}

member.post('/:slug/play/pin', requireAuth, async (req, res) => {
    try {
        const ctx = await load(req, res);
        if (!ctx) return;
        if (!ctx.a.moderate) return res.status(403).json({ error: 'Only the owner or a moderator can do that', code: 'play_queue.not_moderator' });
        const row = await requestOf(ctx, req, res);
        if (!row) return;
        const on = (req.body || {}).on !== false;
        const out = await queue.pin(row, { room: ctx.room, username: req.user.username, handle: req.user.username }, on);
        res.json(out);
    } catch (err) {
        console.error('[Chat] the request could not be pinned:', err.message);
        res.status(500).json({ error: 'The request could not be pinned', code: 'play_queue.failed' });
    }
});

// ── The task's service, for the stream's owner ───────────────────────────

/** The room the token may work on: the one whose owner the token names. */
async function loadRoom(req, res) {
    const raw = String(req.params.roomId || '');
    if (!raw.startsWith('agent:')) { res.status(400).json({ error: 'That is not an agent room', code: 'agent_room.not_an_agent_room' }); return null; }
    const roomId = room.roomIdOf(raw.slice('agent:'.length));
    if (!roomId) { res.status(404).json({ error: 'No such agent room', code: 'agent_room.not_found' }); return null; }
    const row = await room.roomByAgentId(roomId);
    if (!row) { res.status(404).json({ error: 'No such agent room', code: 'agent_room.not_found' }); return null; }
    const owner = String(row.owner_subject || '');
    if (owner && owner !== req.principal.person) {
        res.status(403).json({ error: 'That room belongs to another account', code: 'agent_room.not_yours' });
        return null;
    }
    return row;
}

service.get('/:roomId/play-queue', room.guard('chat.play_queue.read'), async (req, res) => {
    try {
        const row = await loadRoom(req, res);
        if (!row) return;
        const open = await queue.openRequests(row);
        const current = await queue.currentRequest(row);
        res.set('Cache-Control', 'no-store');
        res.json({
            room: row.slug,
            current: current ? queue.requestView(current.row, current.votes) : null,
            next: open.length ? queue.requestView(open[0].row, open[0].votes) : null,
            requests: open.map((r) => queue.requestView(r.row, r.votes)),
        });
    } catch (err) {
        console.error('[Chat] the queue could not be read:', err.message);
        res.status(500).json({ error: 'The queue could not be read', code: 'play_queue.failed' });
    }
});

service.post('/:roomId/play-queue/:requestId', room.guard('chat.play_queue.write'), async (req, res) => {
    try {
        const row = await loadRoom(req, res);
        if (!row) return;
        const id = String(req.params.requestId || '').trim();
        const found = await db.get('SELECT * FROM agent_play_requests WHERE id = ? AND room_id = ?', [id, row.id]);
        if (!found) return res.status(404).json({ error: 'No such request', code: 'play_queue.not_found' });
        const body = req.body || {};
        const state = String(body.state || '').toLowerCase();
        let updated = null;
        if (state === 'running') {
            updated = await queue.markRunning(id);
        } else if (state === 'done' || state === 'failed') {
            const result = body.result || {};
            updated = await queue.finish(id, {
                outcome: result.outcome || state,
                line: String(result.line || ''),
                scratch_url: result.scratch_url || null,
                task_id: result.task_id || null,
            });
            await queue.say(row, String(result.line || '').slice(0, 200));
        } else {
            return res.status(400).json({ error: 'A request moves to running, done or failed', code: 'play_queue.bad_state' });
        }
        res.set('Cache-Control', 'no-store');
        res.json(queue.requestView(updated, await queue.votesOf(updated)));
    } catch (err) {
        console.error('[Chat] the request could not be written:', err.message);
        res.status(500).json({ error: 'The request could not be written', code: 'play_queue.failed' });
    }
});

module.exports = { member, service };
