/**
 * The signed-in person's chat preferences (Network user module chat.preferences, ./chat-preferences.js).
 * Mounted at /api/chat/preferences (nginx already sends /api/chat/ to Chat).
 *
 *   GET /api/chat/preferences                  → { namespace, version, revision, preferences, stale? }
 *   PUT /api/chat/preferences  { preferences }  change these fields (null removes one); optional
 *                                               If-Match: <revision> makes it fail with 412 if they moved
 *
 * Field names are the namespace's (timestamps, compact, font_scale, show_badges, hide_emotes). ETag is
 * the revision. API tokens (hbt_) may read, never write: preferences are the person's own.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../auth/auth');
const prefs = require('./chat-preferences');

const router = express.Router();

function fail(res, err) {
    if (err instanceof prefs.PrefsError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
    }
    console.error('[Prefs] unexpected error:', err && err.message);
    return res.status(500).json({ error: 'Internal server error' });
}

const reply = (res, out) => res.set('Cache-Control', 'private, no-store').set('ETag', `"${out.revision}"`).json(out);

router.get('/', requireAuth, async (req, res) => {
    try { reply(res, await prefs.get(req.user.subject_id)); } catch (err) { fail(res, err); }
});

router.put('/', requireAuth, async (req, res) => {
    if (req.authSource === 'api_token') return res.status(403).json({ error: 'API tokens cannot change chat preferences', code: 'prefs.token_denied' });
    let expectedRevision;
    if (req.headers['if-match'] !== undefined) {
        expectedRevision = Number(String(req.headers['if-match']).replace(/^W\//, '').replace(/"/g, ''));
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ error: 'If-Match must be a revision number', code: 'prefs.bad_revision' });
    }
    try { reply(res, await prefs.update(req.user.subject_id, req.body && req.body.preferences, { expectedRevision })); } catch (err) { fail(res, err); }
});

module.exports = router;
