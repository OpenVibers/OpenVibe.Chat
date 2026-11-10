'use strict';
/**
 * A room's memory (plan 2026-11-10, part 3): GET/POST/PATCH/DELETE /api/v1/rooms/:id/memory.
 *
 *   GET    /:id/memory                     members: the room's active entries, newest first, with sources
 *   GET    /:id/memory?mine=1              the same (the person's own view)
 *   POST   /:id/memory                     a moderator adds an entry { text, kind?, confidence?, source_message_ids? }
 *   PATCH  /:id/memory/:entryId            a moderator corrects it { text?, kind?, confidence? }
 *   DELETE /:id/memory/:entryId            a moderator removes any; a person removes one from their own messages
 *   DELETE /:id/memory?mine=1              a person forgets everything learned from their own messages here
 *
 * Reads need a signed-in person who may read the room (a public room: anyone signed in; a private one:
 * its members and staff), because memory is what the room keeps about its people. Writes are a moderator's,
 * except the person's own removal. A DM and a chat with Vibe are not rooms here.
 */
const express = require('express');
const router = express.Router();
const rooms = require('../rooms/rooms');
const memory = require('../rooms/memory');
const { optionalAuth } = require('../auth/auth');

function send(res, status, body) { return res.status(status).json(body); }

async function resolve(req, res) {
    const id = String(req.params.id || '');
    const room = await rooms.bySlug(id);
    if (!room || Number(room.assistant) === 1) { send(res, 404, { error: 'Room memory not found' }); return null; }
    if (!req.user) { send(res, 401, { error: 'Sign in to read what this room remembers' }); return null; }
    const access = await rooms.access(room, req.user);
    if (!access.read) { send(res, 404, { error: 'Room memory not found' }); return null; }
    return { room, access };
}

function fail(res, err) {
    if (err instanceof memory.MemoryError || err instanceof rooms.RoomError) return send(res, err.status, { error: err.message, code: err.code });
    console.error('[RoomMemory]', err && err.message);
    return send(res, 500, { error: 'Something went wrong' });
}

router.get('/:id/memory', optionalAuth, async (req, res) => {
    try {
        const x = await resolve(req, res); if (!x) return;
        const entries = await memory.forRoom(x.room, { subject: req.user.subject_id || null });
        res.set('Cache-Control', 'private, no-store');
        return res.json({ room: { slug: x.room.slug, name: x.room.name }, entries, kinds: memory.KINDS,
            can_edit: !!x.access.moderate, me: req.user.subject_id || null });
    } catch (err) { return fail(res, err); }
});

router.post('/:id/memory', optionalAuth, async (req, res) => {
    try {
        const x = await resolve(req, res); if (!x) return;
        if (!x.access.moderate) return send(res, 403, { error: 'Only a moderator adds to the room\'s memory' });
        const entry = await memory.add(x.room, req.user, req.body || {});
        return res.status(201).json({ entry });
    } catch (err) { return fail(res, err); }
});

router.patch('/:id/memory/:entryId', optionalAuth, async (req, res) => {
    try {
        const x = await resolve(req, res); if (!x) return;
        if (!x.access.moderate) return send(res, 403, { error: 'Only a moderator corrects the room\'s memory' });
        const entry = await memory.correct(x.room, req.user, Number(req.params.entryId), req.body || {});
        return res.json({ entry });
    } catch (err) { return fail(res, err); }
});

router.delete('/:id/memory', optionalAuth, async (req, res) => {
    try {
        if (String(req.query.mine || '') !== '1') return send(res, 400, { error: 'Pass ?mine=1 to forget what was learned from your messages' });
        const x = await resolve(req, res); if (!x) return;
        if (!req.user.subject_id) return send(res, 403, { error: 'Only a signed-in person has messages here' });
        return res.json(await memory.removeMine(x.room, req.user.subject_id));
    } catch (err) { return fail(res, err); }
});

router.delete('/:id/memory/:entryId', optionalAuth, async (req, res) => {
    try {
        const x = await resolve(req, res); if (!x) return;
        return res.json(await memory.remove(x.room, req.user, Number(req.params.entryId), { canModerate: !!x.access.moderate }));
    } catch (err) { return fail(res, err); }
});

module.exports = router;
