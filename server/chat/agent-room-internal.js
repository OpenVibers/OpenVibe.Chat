'use strict';
/**
 * Live creates the Co-pilot room of a public or unlisted agent stream (Agent Streams S5, §1 and §7).
 *
 *   POST /internal/chat/agent-room   { agent_stream_id, owner_subject, name, close? }   chat.live_bridge.write
 *
 * The room's id is the stream's: agent:<ags_id>. It is made once (a private stream has no room at all),
 * and the banner says what the room is before anyone types: the AI agent reads this chat between steps.
 * `close: true` archives it when the stream ends: the room stays readable, but the Co-pilot reading is over.
 */
const express = require('express');
const serviceAuth = require('../net/service-auth');
const room = require('./agent-room');

const router = express.Router();

router.post('/agent-room', serviceAuth.guard('chat.live_bridge.write'), async (req, res) => {
    try {
        const body = req.body || {};
        const id = room.roomIdOf(body.agent_stream_id);
        if (!id) return res.status(400).json({ error: 'That is not an agent stream id', code: 'agent_room.bad_stream_id' });
        const owner = String(body.owner_subject || '').trim() || null;
        const name = String(body.name || '').trim().slice(0, 40) || id;
        const made = await room.ensureRoom(id, { name, subject: owner });
        if (body.close === true) await require('../db/database').run('UPDATE rooms SET archived_at = ov_now() WHERE id = ? AND archived_at IS NULL', [made.id]);
        res.status(200).json({ room: made.slug, id: made.id, banner: room.BANNER, kind: made.kind, archived: body.close === true });
    } catch (err) {
        console.error('[Chat] the agent room failed:', err.message);
        res.status(500).json({ error: 'The room could not be made', code: 'agent_room.failed' });
    }
});

module.exports = router;

