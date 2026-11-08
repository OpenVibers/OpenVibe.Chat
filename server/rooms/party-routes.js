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
const radio = require('../rooms/radio');
const desktop = require('../rooms/party-desktop');

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

router.get('/radio/tracks', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=30').json({ tracks: await radio.catalogue() });
});

// Link presents its Network node token for Chat, acting for the party owner.
// These routes never accept the invite secret or a browser's session as machine authority.
router.post('/:slug/desktop/claim', express.json({ limit: '2kb' }), async (req, res) => {
    try {
        const hosted = await desktop.authorized(req);
        if (!hosted) return res.status(404).json({ code: 'rooms.not_found' });
        res.set('Cache-Control', 'no-store').json(await desktop.claim(hosted, Number(req.body && req.body.port)));
    } catch (err) { send(res, err); }
});

router.get('/:slug/desktop/access', async (req, res) => {
    try {
        const hosted = await desktop.authorized(req);
        if (!hosted) return res.status(404).json({ code: 'rooms.not_found' });
        res.set('Cache-Control', 'no-store').json(await desktop.access(hosted, String(req.query.subject || '')));
    } catch (err) { send(res, err); }
});

router.post('/:slug/desktop/ready', express.json({ limit: '2kb' }), async (req, res) => {
    try {
        const hosted = await desktop.authorized(req);
        if (!hosted) return res.status(404).json({ code: 'rooms.not_found' });
        res.set('Cache-Control', 'no-store').json({ party: await desktop.ready(hosted, req.body || {}) });
    } catch (err) { send(res, err); }
});

router.post('/:slug/desktop/stopped', async (req, res) => {
    try {
        const hosted = await desktop.authorized(req);
        if (!hosted) return res.status(404).json({ code: 'rooms.not_found' });
        await desktop.stopped(hosted);
        res.status(204).end();
    } catch (err) { send(res, err); }
});

router.get('/:slug/desktop/ticket', requireAuth, async (req, res) => {
    try {
        const row = await parties.bySlug(req.params.slug);
        const party = parties.partyOf(row);
        res.set('Cache-Control', 'no-store').json(await desktop.ticket(row, party, req.user));
    } catch (err) { send(res, err); }
});

router.post('/:slug/desktop/layout', requireAuth, express.json({ limit: '1kb' }), async (req, res) => {
    try {
        const row = await parties.bySlug(req.params.slug), party = parties.partyOf(row);
        res.set('Cache-Control', 'no-store').json({ party: await parties.setDesktopLayout(row, party, req.user, req.body && req.body.layout) });
    } catch (err) { send(res, err); }
});

router.get('/:slug/radio', optionalAuth, async (req, res) => {
    try {
        const row = await parties.bySlug(req.params.slug), party = parties.partyOf(row);
        const out = await radio.state(row, party, { user: req.user || null, key: req.query.k });
        if (!out) return res.status(404).json({ code: 'rooms.not_found' });
        res.set('Cache-Control', 'private, no-store').json({ radio: out });
    } catch (err) { send(res, err); }
});

router.post('/:slug/radio/:action', requireAuth, createLimit, async (req, res) => {
    try {
        const row = await parties.bySlug(req.params.slug), party = parties.partyOf(row);
        if (!row || !party || !await parties.mayView(row, party, req.user, null)) return res.status(404).json({ code: 'rooms.not_found' });
        const out = await radio.change(row, party, req.user, req.params.action, req.body || {});
        res.set('Cache-Control', 'private, no-store').json({ radio: out });
    } catch (err) { send(res, err); }
});

router.get('/:slug', optionalAuth, async (req, res) => {
    try {
        const row = await parties.bySlug(req.params.slug);
        const party = parties.partyOf(row);
        const out = row && party ? await parties.detail(row, party, { user: req.user || null, key: req.query.k }) : null;
        if (!out) return res.status(404).json({ error: 'No such room', code: 'rooms.not_found' });
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ party: out, server_time_ms: Date.now() });
    } catch (err) { send(res, err); }
});

module.exports = router;
