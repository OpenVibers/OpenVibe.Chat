'use strict';

const express = require('express');
const router = express.Router();
const ctx = require('../live-context');
const consent = require('../net/consent');
const memory = require('../ai/person-memory');
const { optionalAuth, requireAuth } = require('../auth/auth');

async function person(req, res) {
    const username = String(req.params.username || '').trim();
    if (!/^[a-zA-Z0-9_]{1,60}$/.test(username)) { res.status(404).json({ error: 'Person not found' }); return null; }
    const user = await ctx.getUserByUsername(username);
    if (!user) { res.status(404).json({ error: 'Person not found' }); return null; }
    return user;
}

router.get('/:username/memory', optionalAuth, async (req, res) => {
    try {
        const user = await person(req, res); if (!user) return;
        const level = String(req.query.level || 'day');
        if (!['day', 'week', 'month'].includes(level)) return res.status(400).json({ error: 'Invalid level' });
        let channelId = null;
        if (req.query.channel) {
            const channel = await ctx.getUserByUsername(String(req.query.channel));
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
            channelId = Number(channel.id);
        }
        const self = Number(req.user?.id) === Number(user.id);
        if (channelId == null && !self) return res.status(400).json({ error: 'Select a channel' });
        const full = self || (channelId != null && Number(req.user?.id) === channelId);
        res.set('Cache-Control', 'private, no-store');
        // A withdrawn or unverifiable consent removes existing memory as well as blocking new work.
        if (!user.subject_id || !(await consent.allowedSubjects([user.subject_id])).has(user.subject_id)) {
            await memory.forget(user.id, false);
            return res.json({ username: user.username, level, channel: req.query.channel || null, entries: [], opted_out: false, enabled: memory.ENABLED });
        }
        return res.json({ username: user.username, level, channel: req.query.channel || null,
            entries: await memory.read(user.id, { channelId, level, privateView: full }),
            opted_out: await memory.optedOut(user.id), enabled: memory.ENABLED });
    } catch (err) { console.warn('[PersonMemory] read:', err.message); return res.status(500).json({ error: 'Memory unavailable' }); }
});

router.delete('/:username/memory', requireAuth, async (req, res) => {
    try {
        const user = await person(req, res); if (!user) return;
        if (Number(req.user.id) !== Number(user.id)) return res.status(403).json({ error: 'Only this person can delete their memory' });
        await memory.forget(user.id, true);
        res.set('Cache-Control', 'no-store');
        return res.json({ deleted: true, opted_out: true });
    } catch (err) { return res.status(500).json({ error: 'Could not delete memory' }); }
});

router.put('/:username/memory/preferences', requireAuth, async (req, res) => {
    try {
        const user = await person(req, res); if (!user) return;
        if (Number(req.user.id) !== Number(user.id)) return res.status(403).json({ error: 'Only this person can change memory preferences' });
        if (typeof req.body?.opted_out !== 'boolean') return res.status(400).json({ error: 'opted_out must be a boolean' });
        await memory.forget(user.id, req.body.opted_out);
        res.set('Cache-Control', 'no-store');
        return res.json({ opted_out: req.body.opted_out });
    } catch (err) { return res.status(500).json({ error: 'Could not change memory preferences' }); }
});

module.exports = router;
