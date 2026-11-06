'use strict';
/**
 * OpenVibe.Chat — the machine TTS route (Agent Streams S4, design 2026-11-06).
 *
 * The desk (OpenVibe.Node) asks Chat for the sound of a line the agent said. The desk holds a node token for
 * audience openvibe.chat that carries the capability chat.tts.speak and names the person it acts for
 * (`on_behalf_of`, the Network's rule for a node token acting for its owner). Chat speaks in that person's voice and
 * on that person's allowance.
 *
 *   POST /api/agent-voice/speak  { text, voice?, own? }  →  { audio, mime_type, rate }
 *
 * The text is one line (the design's 220 characters at most). `voice` is a Chat voice id; `own` asks for the
 * person's own voice (their saved voice settings), never another person's.
 *
 * The route is public but not open: it takes a service token only. Unlike Chat's /internal routes (loopback only),
 * a desk is a machine on the person's own network, so this one route accepts a token from outside.
 */
const express = require('express');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const contracts = require('openvibe-contracts');
const config = require('../config');
const { keys } = require('../net/service-auth');
const ttsEngine = require('./tts-engine');

const { capabilities, http } = contracts;
const AUDIENCE = 'openvibe.chat';
const CAPABILITY = 'chat.tts.speak';
// The design's line length: one line, never a paragraph.
const MAX_CHARS = 220;

const router = express.Router();
router.use(express.json({ limit: '8kb' }));

/** The person the token names, or null: a node token acts for its owner (`on_behalf_of`), a person token is the person. */
function personOf(claims) {
    const onBehalf = String(claims.on_behalf_of || '');
    if (onBehalf) return onBehalf;
    const sub = String(claims.sub || '');
    return sub.startsWith('usr_') ? sub : null;
}

/** The service token guard for this route: the capability, and a person the token speaks for. */
async function guard(req, res, next) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'no service token' });
    const r = await verifyServiceToken(auth.slice(7).trim(), { ...keys().verifyOptions, issuer: config.networkUrl, audience: AUDIENCE, contracts });
    if (!r.ok) {
        if (r.code === 'token.unavailable') return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded' });
        return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason });
    }
    // The capability is not in the contracts registry yet, so the grant in the token is what is checked.
    const c = capabilities.get(CAPABILITY)
        ? capabilities.check(r.claims, CAPABILITY)
        : (capabilities.grants(r.claims.cap, CAPABILITY) ? { allowed: true } : { allowed: false });
    if (!c.allowed) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} not granted` });
    const person = personOf(r.claims);
    if (!person) return http.sendProblem(res, 403, 'subject.not_delegated', { detail: 'the token names nobody' });
    req.principal = { sub: r.claims.sub, cap: r.claims.cap, person };
    next();
}

router.post('/speak', guard, async (req, res) => {
    try {
        const body = req.body || {};
        const text = String(body.text || '').trim().slice(0, MAX_CHARS);
        if (!text) return res.status(400).json({ error: 'text is required', code: 'text_required' });
        const own = !!body.own;
        const voice = typeof body.voice === 'string' ? body.voice : '';
        // The person's own voice comes from their own saved voice settings; a site voice comes from the catalogue.
        const result = own
            ? await ttsEngine.synthesizeUserVoice(text, req.principal.person, req.principal.person)
            : await ttsEngine.synthesize(text, voice || undefined, req.principal.person);
        if (!result) return res.status(503).json({ error: 'The voice is unavailable', code: 'voice_unavailable' });
        res.set('Cache-Control', 'no-store');
        res.json({ audio: result.audio, mime_type: result.mimeType, rate: 48000, voice_id: result.voiceId || voice || null });
    } catch (err) {
        console.error('[Chat] the agent voice failed:', err.message);
        res.status(500).json({ error: 'The line could not be spoken', code: 'tts_failed' });
    }
});

module.exports = router;