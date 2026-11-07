'use strict';
/**
 * The person's own voice (Opus's design, 2026-11-06, step 6): a companion's answer read aloud in the
 * character's own voice.
 *
 *   POST /api/tts/speak  { text, voice }  →  { audio, mime_type, rate, voice_id }
 *
 * The person themself, with their own Network token - the same way the Dock reaches /api/vibe - so the
 * read-aloud spends their own allowance and their own rate limit. The site's own voices only: a cloned
 * voice is never used here (a cloned voice needs its owner's opt-in, and that is a separate thing).
 *
 * The text is one line: the contract's chat.tts-speak-request@1 caps it at 220 characters, and the
 * contract says so for this route too. A longer answer is spoken as its first line.
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const ttsEngine = require('./tts-engine');
// The per-person limiter is the agent voice's own (server/chat/tts-machine.js): one counter per person,
// six a minute and 900 a day, so the desk and the companions cannot double the allowance.
const allow = require('./tts-machine')._allow;

// The design's line length: one line, never a paragraph (chat.tts-speak-request@1).
const MAX_CHARS = 220;

const router = express.Router();
router.use(express.json({ limit: '8kb' }));
// The guard belongs to this route alone. The router is mounted under /api/tts, whose other routes (the voice
// catalogue, the settings, the stashed clips) are public and must stay that way.

/** The voice is for the person themself: an API token or a Dock token is refused. */
const personOnly = (req, res, next) => (req.authSource === 'api_token' || req.authSource === 'dock'
    ? res.status(403).json({ error: 'The voice is for the person themself', code: 'tts.person_only' })
    : next());

/** The person the rate limit counts: their Network subject (usr_...), the same id the agent voice counts. */
function personOf(req) {
    if (req.user && req.user.subject_id) return String(req.user.subject_id);
    if (req.user && req.user.id != null) return 'user:' + String(req.user.id);
    return 'anonymous';
}

router.post('/speak', requireAuth, personOnly, async (req, res) => {
    try {
        const person = personOf(req);
        if (!allow(person)) {
            res.set('Retry-After', '20');
            return res.status(429).json({ error: 'Too many lines spoken right now', code: 'voice_rate_limited' });
        }
        const body = req.body || {};
        const text = String(body.text || '').trim().slice(0, MAX_CHARS);
        if (!text) return res.status(400).json({ error: 'text is required', code: 'text_required' });
        const voice = typeof body.voice === 'string' ? body.voice : '';
        const result = await ttsEngine.synthesize(text, voice || undefined, person);
        if (!result) return res.status(503).json({ error: 'The voice is unavailable', code: 'voice_unavailable' });
        res.set('Cache-Control', 'no-store');
        res.json({ audio: result.audio, mime_type: result.mimeType, rate: 48000, voice_id: result.voiceId || voice || null });
    } catch (err) {
        console.error('[Chat] the companion voice failed:', err.message);
        res.status(500).json({ error: 'The line could not be spoken', code: 'tts_failed' });
    }
});

module.exports = router;
module.exports._allow = allow;
module.exports._personOf = personOf;
