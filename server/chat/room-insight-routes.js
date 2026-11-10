'use strict';
/**
 * A room's public AI insight (plan 2026-11-10, part 1): GET /api/v1/rooms/:id/insight.
 *
 * One shape for every room — Global first, then a server's channels and rooms — so a reader never needs
 * to know which kind of room it opened. Global's stable id is `global`; a room not covered by the
 * rollout answers 404 rather than an empty shape, so a client can tell "no such room" from "quiet".
 */
const express = require('express');
const router = express.Router();
const roomInsight = require('./room-insight');

router.get('/:id/insight', async (req, res) => {
    const id = String(req.params.id || '');
    if (id !== 'global') return res.status(404).json({ error: 'Room insight not found' });
    try {
        const insight = await roomInsight.global();
        // A minute of cache: the job rewrites at most every 30 minutes and the answer is the same for everyone.
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(insight);
    } catch (err) {
        console.warn('[RoomInsight] global read failed:', err && err.message);
        return res.status(500).json({ error: 'Failed to load room insight' });
    }
});

module.exports = router;
