'use strict';
/**
 * Owner-only Vibe persona settings (the owner, 2026-11-12): GET|POST /api/admin/persona and
 * POST /api/admin/persona/remake. The same store and actions as the page at /admin/persona
 * (server/web/persona-admin.js), so a script or another agent does exactly what the owner does.
 *
 *   GET  /api/admin/persona              { settings, defaults, spend, models, conversations, month, revision }
 *   POST /api/admin/persona              { enabled?, text_model?, images?, image_model?, check_every?, monthly_cap_usd? }
 *   POST /api/admin/persona/remake       { slug } → { persona }, 409 persona.busy / persona.cap / persona.no_answer
 *
 * Every route is for the owner's own sign-in (not an API token), and every route is owner-only: the same
 * isOwner() rule the rest of Chat uses (an admin with Network's owner flag).
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const { isOwner } = require('../auth/permissions');
const { limits } = require('../net/actor-limits');
const persona = require('../persona');

const router = express.Router();
const manageLimit = limits('chat.persona.manage', { minute: 30, hour: 300 });
const readLimit = limits('chat.persona.read', { minute: 120, hour: 1200 });

router.use(requireAuth);
router.use((req, res, next) => {
    if (req.authSource === 'api_token') return res.status(403).json({ error: 'Vibe persona settings are for the owner\'s own sign-in', code: 'persona.person_only' });
    if (!isOwner(req.user)) return res.status(403).json({ error: 'Only the owner changes the Vibe personas', code: 'persona.owner' });
    next();
});

function send(res, err) {
    if (err && err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Vibe persona admin]', err && err.message);
    return res.status(500).json({ error: 'Something went wrong', code: 'persona.error' });
}

router.get('/', readLimit, async (_req, res) => {
    try { res.set('Cache-Control', 'private, no-store').json(await persona.state(req.user.id)); } catch (err) { send(res, err); }
});

router.post('/', manageLimit, async (req, res) => {
    try {
        const actor = req.user.subject_id ? { type: 'user', id: String(req.user.subject_id) } : null;
        res.set('Cache-Control', 'private, no-store').json(await persona.update(req.body || {}, { actor, reason: 'Vibe persona settings', ownerId: req.user.id }));
    } catch (err) { send(res, err); }
});

router.post('/remake', manageLimit, async (req, res) => {
    try {
        const slug = String((req.body && req.body.slug) || '');
        const made = await persona.remake(slug, req.user.id);
        res.set('Cache-Control', 'private, no-store').json({ persona: made, conversations: (await persona.state(req.user.id)).conversations });
    } catch (err) { send(res, err); }
});

module.exports = router;
