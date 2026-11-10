'use strict';
/**
 * A room's AI insight (plan 2026-11-10, parts 1 and 2): GET /api/v1/rooms/:id/insight.
 *
 * One shape for every room, so a reader never needs to know which kind it opened:
 *   global              the site's Global room (public)
 *   <slug>              a room or a server's text channel (public when the room is; members only when private)
 *   channel:<user id>   a Live channel's chat, keyed by the broadcaster's Chat user id (public, as the channel is)
 *
 * A private room whose owner has not turned insight on answers `state: "off"` to a member, and 404 to
 * everyone else (the room itself is invisible). A DM is not a room and never answers; a chat with Vibe is
 * a person's own conversation and answers 404.
 */
const express = require('express');
const router = express.Router();
const rooms = require('../rooms/rooms');
const roomInsight = require('./room-insight');
const { optionalAuth } = require('../auth/auth');

router.get('/:id/insight', optionalAuth, async (req, res) => {
    const id = String(req.params.id || '');
    try {
        if (id === 'global') {
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(await roomInsight.global());
        }
        // A Live channel's chat: the job keys it by the broadcaster's Chat user id.
        if (id.startsWith('channel:')) {
            const channelUserId = Number(id.slice('channel:'.length));
            if (!channelUserId) return res.status(404).json({ error: 'Room insight not found' });
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(await roomInsight.channel(channelUserId));
        }
        const room = await rooms.bySlug(id);
        if (!room || Number(room.assistant) === 1) return res.status(404).json({ error: 'Room insight not found' });
        const access = await rooms.access(room, req.user || null);
        if (!access.read) return res.status(404).json({ error: 'Room insight not found' });
        res.set('Cache-Control', `${req.user ? 'private' : 'public'}, max-age=60`);
        return res.json(await roomInsight.room(room, { enabled: rooms.insightOn(room) }));
    } catch (err) {
        console.warn('[RoomInsight] read failed:', err && err.message);
        return res.status(500).json({ error: 'Failed to load room insight' });
    }
});

// A channel's display name is kept nowhere in chat_ai_summaries; the read shape does not need it. Exported
// for tests that want the key format.
function channelKey(channelUserId) { return `channel:${Number(channelUserId)}`; }

module.exports = router;
module.exports.channelKey = channelKey;
