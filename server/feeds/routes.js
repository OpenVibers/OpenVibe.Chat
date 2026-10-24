'use strict';
/**
 * Feeds over HTTP (server/feeds/feeds.js, docs/platform.md). One router at /api/chat/feeds; the public and publishing
 * routes answer any site without cookies (server/app.js), the owner's need a sign-in (or an API token as its person).
 *
 * Anyone:
 *   GET    /?slot=1,2 | ?channel=username   { feeds }: the feeds shown on those Live channel slots (Live's chat asks)
 *   GET    /:id                             { feed, publisher, events }: what a viewer sees now (after the delay)
 * Publishers (Authorization: Bearer ovf_…, the feed's key):
 *   POST   /:id/hello                       { sessionKey?, publisher? } → { sessionKey, publisher }
 *   POST   /:id/events                      an event, { events: [...] } (at most 50) or Live's envelopes → { events }
 *   POST   /:id/hooks/claude-code           Claude Code's hook JSON as is (an "http" hook) → {} (never blocks it)
 * The owner:
 *   GET    /mine                            { feeds }
 *   POST   /                                { title?, room?, slot?, settings? } → 201 { feed, key } (the key, once)
 *   PATCH  /:id                             { title?, room?, slot?, settings? } → { feed }
 *   POST   /:id/key                         → { key } (a new key; the old one stops working)
 *   DELETE /:id
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('openvibe-shared/cache-policy');
const { requireAuth } = require('../auth/auth');
const feeds = require('./feeds');

function send(res, err) {
    if (err instanceof feeds.FeedError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Feeds]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong' });
}
const noStore = (res) => res.set('Cache-Control', cache.htmlHeaders({ private: true }));
const router = express.Router();
const readLimit = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
// Per feed key: an agent working hard sends a few events a second.
const publishLimit = rateLimit({
    windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `feed:${req.params.id}`,
    message: { error: 'Slow down a little', code: 'feeds.slow_down' },
});

// The feed's key first (a wrong key spends the address's allowance, not the feed's), then the feed's own allowance.
const keyLimit = rateLimit({ windowMs: 60_000, max: 1200, standardHeaders: true, legacyHeaders: false });
async function withKey(req, res, next) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const feed = m ? await feeds.byKey(m[1]) : null;
    if (!feed || feed.id !== req.params.id) return res.status(401).json({ error: 'The feed\'s key is missing or wrong', code: 'feeds.key' });
    req.feed = feed;
    next();
}
const publisher = [keyLimit, withKey, publishLimit];
async function ownFeed(req, res) {
    const feed = await feeds.get(req.params.id);
    if (!feed || feed.owner_id !== Number(req.user.id)) { res.status(404).json({ error: 'No such feed', code: 'feeds.not_found' }); return null; }
    return feed;
}

// ── Anyone ─────────────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/', readLimit, async (req, res, next) => {
    if (!req.query.slot && !req.query.channel) return next();
    try {
        let slots = String(req.query.slot || '').split(',').map(Number).filter(Boolean);
        if (req.query.channel) {
            const ctx = require('../live-context');
            const owner = await ctx.getUserByUsername(String(req.query.channel));
            slots = owner ? (await ctx.getManagedStreamsByUserId(owner.id)).map((m) => Number(m.id)) : [];
        }
        const list = (await feeds.forSlots(slots)).filter((f) => f.settings.enabled && !f.settings.paused);
        res.set('Cache-Control', 'public, max-age=15').json({ feeds: list.map((f) => ({ ...feeds.publicShape(f), managed_stream_id: f.managed_stream_id })) });
    } catch (err) { send(res, err); }
});

// ── The owner ──────────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
    try { noStore(res).json({ feeds: await feeds.mine(req.user) }); } catch (err) { send(res, err); }
});
router.post('/', requireAuth, async (req, res) => {
    try { const r = await feeds.create(req.user, req.body || {}); noStore(res).status(201).json(r); } catch (err) { send(res, err); }
});
router.patch('/:id', requireAuth, async (req, res) => {
    const feed = await ownFeed(req, res); if (!feed) return;
    try { noStore(res).json({ feed: await feeds.update(feed, req.user, req.body || {}) }); } catch (err) { send(res, err); }
});
router.post('/:id/key', requireAuth, async (req, res) => {
    const feed = await ownFeed(req, res); if (!feed) return;
    try { noStore(res).json({ key: await feeds.rotateKey(feed) }); } catch (err) { send(res, err); }
});
router.delete('/:id', requireAuth, async (req, res) => {
    const feed = await ownFeed(req, res); if (!feed) return;
    try { await feeds.remove(feed); res.status(204).end(); } catch (err) { send(res, err); }
});

router.get('/:id', readLimit, async (req, res) => {
    const feed = await feeds.get(req.params.id);
    if (!feed) return res.status(404).json({ error: 'No such feed', code: 'feeds.not_found' });
    try { noStore(res).json(await feeds.view(feed, { limit: req.query.limit })); } catch (err) { send(res, err); }
});

// ── Publishers ─────────────────────────────────────────────────────────────────────────────────────────────────────
router.post('/:id/hello', publisher, async (req, res) => {
    try { res.json(await feeds.hello(req.feed, req.body || {})); } catch (err) { send(res, err); }
});
router.post('/:id/events', publisher, async (req, res) => {
    try { res.status(202).json({ events: await feeds.publish(req.feed, req.body) }); } catch (err) { send(res, err); }
});
router.post('/:id/hooks/claude-code', publisher, async (req, res) => {
    try {
        const events = feeds.fromClaudeCode(req.body);
        if (events.length) await feeds.publish(req.feed, events);
    } catch (err) { if (!(err instanceof feeds.FeedError)) console.warn('[Feeds] claude-code:', err.message); }
    res.json({});   // an empty answer: Claude Code carries on as if the hook was not there
});

module.exports = router;
