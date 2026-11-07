'use strict';
/**
 * OpenVibe.Chat — how the people of a Co-pilot room vote on the agent's poll (Agent Streams S5, §3).
 *
 *   POST /:slug/poll/vote    { poll_id, option }   one vote per person
 *   POST /:slug/poll/close                         the owner or a moderator closes the poll early
 *   POST /:slug/poll/veto                          the owner or a moderator vetoes its result
 *
 * The votes are the counts: the room never says who voted for what. A poll can only choose between the
 * options the agent wrote, so a vote for anything else does not count.
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const db = require('../db/database');
const rooms = require('../rooms/rooms');
const poll = require('./agent-poll');

const router = express.Router();

/** The room and what the person may do in it. */
async function load(req, res) {
    const room = await rooms.bySlug(String(req.params.slug || ''));
    if (!room || room.archived_at) { res.status(404).json({ error: 'No such room', code: 'rooms.not_found' }); return null; }
    const a = await rooms.access(room, req.user);
    if (!a.read) { res.status(403).json({ error: 'You cannot see this room', code: 'rooms.forbidden' }); return null; }
    return { room, a };
}

router.post('/:slug/poll/vote', requireAuth, async (req, res) => {
    try {
        const ctx = await load(req, res);
        if (!ctx) return;
        const body = req.body || {};
        const pollId = String(body.poll_id || '').trim();
        const option = String(body.option || '').trim();
        if (!pollId || !option) return res.status(400).json({ error: 'A poll and an option are required', code: 'agent_poll.bad_request' });
        const row = await db.get('SELECT * FROM agent_room_polls WHERE id = ? AND room_id = ?', [pollId, ctx.room.id]);
        if (!row) return res.status(404).json({ error: 'No such poll', code: 'agent_poll.not_found' });
        const r = await poll.castVote({ poll: row, user: req.user, optionId: option });
        if (!r.ok) return res.status(409).json({ error: 'That vote did not count', code: r.code });
        const votes = await poll.votesOf(pollId);
        res.json(poll.pollView({ ...row, room_slug: ctx.room.slug }, votes));
    } catch (err) {
        console.error('[Chat] the vote failed:', err.message);
        res.status(500).json({ error: 'The vote did not count', code: 'agent_poll.failed' });
    }
});

/** Close a poll early: the owner or a moderator. */
router.post('/:slug/poll/close', requireAuth, async (req, res) => {
    try {
        const ctx = await load(req, res);
        if (!ctx) return;
        if (!ctx.a.moderate) return res.status(403).json({ error: 'Only the owner or a moderator can close a poll', code: 'agent_poll.not_moderator' });
        const pollId = String((req.body || {}).poll_id || '').trim();
        const row = await db.get('SELECT * FROM agent_room_polls WHERE id = ? AND room_id = ?', [pollId, ctx.room.id]);
        if (!row) return res.status(404).json({ error: 'No such poll', code: 'agent_poll.not_found' });
        if (row.state !== 'open') return res.status(409).json({ error: 'That poll is already closed', code: 'agent_poll.not_open' });
        const out = await poll.closePoll(row);
        res.json(out);
    } catch (err) {
        console.error('[Chat] closing the poll failed:', err.message);
        res.status(500).json({ error: 'The poll could not be closed', code: 'agent_poll.failed' });
    }
});

/** Veto a poll's result: the owner or a moderator. */
router.post('/:slug/poll/veto', requireAuth, async (req, res) => {
    try {
        const ctx = await load(req, res);
        if (!ctx) return;
        if (!ctx.a.moderate) return res.status(403).json({ error: 'Only the owner or a moderator can veto a poll', code: 'agent_poll.not_moderator' });
        const pollId = String((req.body || {}).poll_id || '').trim();
        const row = await db.get('SELECT * FROM agent_room_polls WHERE id = ? AND room_id = ?', [pollId, ctx.room.id]);
        if (!row) return res.status(404).json({ error: 'No such poll', code: 'agent_poll.not_found' });
        if (row.state !== 'open') return res.status(409).json({ error: 'That poll is already closed', code: 'agent_poll.not_open' });
        const by = String(req.user.username || req.user.subject_id || 'moderator');
        const out = await poll.vetoPoll(row, by);
        res.json(out);
    } catch (err) {
        console.error('[Chat] vetoing the poll failed:', err.message);
        res.status(500).json({ error: 'The poll could not be vetoed', code: 'agent_poll.failed' });
    }
});

module.exports = router;

