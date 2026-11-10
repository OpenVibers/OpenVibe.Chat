'use strict';
/**
 * The Activity API (server/chat/activity.js, migration 0061_chat_activity.sql). Signed in only; every person sees
 * their own activity and nothing else, and each read applies their current access (a room they left, a server
 * they were kicked from, a blocked person, a deleted message).
 *
 *   GET  /api/v1/activity?limit=&before=&kind=mention,reply   newest first, a cursor, a kind filter
 *                                                              → { items, next_before, unread }
 *   GET  /api/v1/activity/unread                              → { unread }
 *   POST /api/v1/activity/read  { ids: [1, 2] } or { all: 1 } → { ok, read, unread }
 *   POST /api/v1/activity/:id/read                            → { ok, read, unread }
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { requireAuth } = require('../auth/auth');
const activity = require('./activity');

const router = express.Router();

router.get('/unread', requireAuth, async (req, res) => {
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ unread: await activity.unreadCount(req.user) });
});

router.post('/read', requireAuth, async (req, res) => {
    const body = req.body || {};
    const all = body.all === true || body.all === 1 || body.all === '1';
    const ids = Array.isArray(body.ids) ? body.ids : (body.id == null ? [] : [body.id]);
    if (!all && !ids.length) return res.status(422).json({ error: 'Say which activity to mark read, or all of it', code: 'activity.ids' });
    const read = await activity.markRead(req.user, { all, ids });
    res.json({ ok: true, read, unread: await activity.unreadCount(req.user) });
});

router.post('/:id/read', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(422).json({ error: 'No such activity', code: 'activity.id' });
    const read = await activity.markRead(req.user, { id });
    if (!read) {
        // Already read, or not this person's: the same answer, because an id must not say whose it is.
        const unread = await activity.unreadCount(req.user);
        return res.json({ ok: true, read: 0, unread });
    }
    res.json({ ok: true, read, unread: await activity.unreadCount(req.user) });
});

router.get('/', requireAuth, async (req, res) => {
    const kind = String(req.query.kind || '').split(',').map((k) => k.trim()).filter(Boolean);
    const bad = kind.filter((k) => !activity.KINDS.includes(k));
    if (bad.length) return res.status(422).json({ error: `Unknown activity kind: ${bad[0]}`, code: 'activity.kind' });
    const limit = Math.min(activity.MAX_LIMIT, Math.max(1, Number(req.query.limit) || 30));
    const before = Number(req.query.before) || null;
    const out = await activity.list(req.user, { before, limit, kind: kind.length ? kind : null });
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ ...out, unread: await activity.unreadCount(req.user) });
});

module.exports = router;
