'use strict';
/**
 * /api/chat/parties — Watch Together's parties, the way openvibe.party and the sites that start one reach them.
 * The room routes (server/rooms/routes.js, /api/chat/rooms/parties…) keep serving the agent-stream parties; both
 * go through server/rooms/parties.js, so the secret, the 404 and the clock are decided in one place.
 *
 *   POST /        { media, source_url?, title } — a signed-in person starts a media party. 201 { party, join_secret }:
 *                 the join link (openvibe.party/p/<slug>?k=…) carries the secret, and this answer is the only place
 *                 it exists. The room's clock starts paused at 0 on the media and the remote is the creator's.
 *   GET  /:slug   ?k=<secret> — the party as a viewer sees it: title, media, source_url, the host (subject and name),
 *                 the clock, and (for a member) the people and the remote. A stranger without the key, or with a
 *                 wrong one, gets the same 404 as a missing room.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { requireAuth, optionalAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const parties = require('../rooms/parties');

const router = express.Router();

// Starting a party: the same budget as making a room (owners keep at most MAX_ROOMS_PER_OWNER).
const createLimit = limits('chat.party.create', { minute: 10, hour: 60 });

function send(res, err) {
    if (err instanceof parties.PartyError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Parties]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}

router.post('/', requireAuth, createLimit, async (req, res) => {
    try {
        const out = await parties.create(req.user, req.body || {});
        res.status(201).json({ party: out.party, join_secret: out.join_secret });
    } catch (err) { send(res, err); }
});

router.get('/:slug', optionalAuth, async (req, res) => {
    try {
        const row = await parties.bySlug(req.params.slug);
        const party = parties.partyOf(row);
        const out = row && party ? await parties.detail(row, party, { user: req.user || null, key: req.query.k }) : null;
        if (!out) return res.status(404).json({ error: 'No such room', code: 'rooms.not_found' });
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ party: out });
    } catch (err) { send(res, err); }
});

module.exports = router;
