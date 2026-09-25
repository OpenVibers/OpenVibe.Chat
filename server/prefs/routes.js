/**
 * The signed-in person's chat settings, one router per Network user module Chat owns (./stores.js).
 * Mounted under /api/chat/ (nginx already sends /api/chat/ to Chat):
 *
 *   /api/chat/preferences   chat.preferences     body key `preferences`
 *   /api/chat/tts-settings  chat.tts_defaults    body key `settings`
 *   /api/chat/dm-settings   chat.dm_settings     body key `settings`
 *   /api/chat/presence      chat.presence_prefs  body key `settings`
 *
 *   GET → { namespace, version, revision, <key>, stale? }
 *   PUT { <key>: { field: value | null } }  change these fields (null removes one); optional
 *        If-Match: <revision> makes it fail with 412 if they moved
 *
 * Field names are the namespace's. ETag is the revision. API tokens (hbt_) may read, never write:
 * settings are the person's own.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../auth/auth');
const { PrefsError } = require('./module-store');

function fail(res, err) {
    if (err instanceof PrefsError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
    }
    console.error('[Prefs] unexpected error:', err && err.message);
    return res.status(500).json({ error: 'Internal server error' });
}

const reply = (res, out) => res.set('Cache-Control', 'private, no-store').set('ETag', `"${out.revision}"`).json(out);

function routesFor(store, key) {
    const router = express.Router();
    router.get('/', requireAuth, async (req, res) => {
        try { reply(res, await store.get(req.user.subject_id)); } catch (err) { fail(res, err); }
    });
    router.put('/', requireAuth, async (req, res) => {
        if (req.authSource === 'api_token') return res.status(403).json({ error: 'API tokens cannot change chat settings', code: 'prefs.token_denied' });
        let expectedRevision;
        if (req.headers['if-match'] !== undefined) {
            expectedRevision = Number(String(req.headers['if-match']).replace(/^W\//, '').replace(/"/g, ''));
            if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ error: 'If-Match must be a revision number', code: 'prefs.bad_revision' });
        }
        try { reply(res, await store.update(req.user.subject_id, req.body && req.body[key], { expectedRevision })); } catch (err) { fail(res, err); }
    });
    return router;
}

const stores = require('./stores');
/** { mount path under /api/chat → router } */
const ROUTES = {
    preferences: routesFor(stores.preferences, 'preferences'),
    'tts-settings': routesFor(stores.tts, 'settings'),
    'dm-settings': routesFor(stores.dm, 'settings'),
    presence: routesFor(stores.presence, 'settings'),
};

module.exports = { routesFor, ROUTES };
