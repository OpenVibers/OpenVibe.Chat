'use strict';
/**
 * OpenVibe.Chat — the routes a task's service (Codes or Actor) asks for on a Co-pilot room
 * (Agent Streams S5, design 2026-11-06).
 *
 *   GET  /api/v1/rooms/agent:<id>/digest?since=   →  chat.agent-digest@1
 *   POST /api/v1/rooms/agent:<id>/poll             →  chat.agent-poll@1 (the poll the agent asks for)
 *   GET  /api/v1/rooms/agent:<id>/poll             →  chat.agent-poll@1 (the result, once it is closed)
 *   POST /api/v1/rooms/agent:<id>/answer           →  the agent's answer line, posted in the room
 *
 * The routes take a service token only: the caller is Codes or Actor acting for the stream's owner (a node
 * token names its owner in `on_behalf_of`). The room is the owner's: the token names the owner, so a digest is
 * that owner's room and never another person's.
 *
 * The digest leaves out the people it must leave out (a timed-out or banned person, an account younger than a
 * day, a person who set 'Agents don't read my messages'), keeps a link as its domain only, and holds the caps:
 * ten items and 1,500 characters.
 */
const express = require('express');
const { ids } = require('openvibe-contracts');
const db = require('../db/database');
const room = require('./agent-room');

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

/** The room the token may read: the one whose owner the token names. */
async function loadRoom(req, res) {
    const raw = String(req.params.roomId || '');
    if (!raw.startsWith('agent:')) { res.status(400).json({ error: 'That is not an agent room', code: 'agent_room.not_an_agent_room' }); return null; }
    const roomId = room.roomIdOf(raw.slice('agent:'.length));
    if (!roomId) { res.status(404).json({ error: 'No such agent room', code: 'agent_room.not_found' }); return null; }
    const row = await room.roomByAgentId(roomId);
    if (!row) { res.status(404).json({ error: 'No such agent room', code: 'agent_room.not_found' }); return null; }
    // The room belongs to the person the token speaks for.
    const owner = String(row.owner_subject || '');
    if (owner && owner !== req.principal.person) {
        res.status(403).json({ error: 'That room belongs to another account', code: 'agent_room.not_yours' });
        return null;
    }
    return row;
}

// ── The digest ───────────────────────────────────────────────────────────

router.get('/:roomId/digest', room.guard('chat.agent_digest.read'), async (req, res) => {
    try {
        const row = await loadRoom(req, res);
        if (!row) return;
        const since = req.query.since ? String(req.query.since) : null;
        // One read per step, and at most one every 20 s: the cursor says how far it has read.
        const reader = String(req.principal.sub || '');
        const cursor = await db.get('SELECT * FROM agent_room_reads WHERE room_id = ? AND reader = ?', [row.id, reader]);
        const now = Date.now();
        if (cursor && Number(cursor.last_read_at_ms) && now - Number(cursor.last_read_at_ms) < room.READ_INTERVAL_MS) {
            res.set('Retry-After', '20');
            return res.status(429).json({ error: 'The digest was read a moment ago', code: 'agent_digest.too_soon' });
        }
        const out = await room.digest(row, { since, now });
        await db.run(
            `INSERT INTO agent_room_reads (room_id, reader, last_read_at, last_message_id, last_read_at_ms, updated_at)
             VALUES (?, ?, now(), ?, ?, now())
             ON CONFLICT (room_id, reader) DO UPDATE SET last_read_at = now(), last_message_id = EXCLUDED.last_message_id,
                 last_read_at_ms = EXCLUDED.last_read_at_ms, updated_at = now()`,
            [row.id, reader, Number(cursor && cursor.last_message_id) || 0, now]
        );
        res.set('Cache-Control', 'no-store');
        res.json(out);
    } catch (err) {
        console.error('[Chat] the digest failed:', err.message);
        res.status(500).json({ error: 'The digest could not be made', code: 'agent_digest.failed' });
    }
});

// ── The polls ────────────────────────────────────────────────────────────

/** The options the agent wrote, cleaned: two to four, each with its number and its text. */
function cleanOptions(value) {
    if (!Array.isArray(value)) return null;
    if (value.length < room.POLL_MIN_SECONDS / 30 || value.length > 4) return null;
    const out = [];
    for (let i = 0; i < value.length; i++) {
        const raw = value[i];
        const label = typeof raw === 'string' ? raw.trim() : (raw && typeof raw === 'object' ? String(raw.label || '').trim() : '');
        if (!label || label.length > 80) return null;
        out.push({ id: String(i + 1), label: label.slice(0, 80) });
    }
    return out;
}

/** The poll as the contract says it is. */
function pollView(row, votes) {
    const options = (Array.isArray(row.options) ? row.options : []).map((o) => ({
        id: String(o.id), label: String(o.label), votes: Number(votes && votes[o.id]) || 0,
    }));
    const counts = options.map((o) => o.votes);
    const total = counts.reduce((a, b) => a + b, 0);
    const winner = total ? (options.find((o) => o.votes === Math.max(...counts)) || {}).id || null : null;
    const closed = row.state !== 'open';
    return {
        poll_id: String(row.id),
        room: String(row.room_slug || ''),
        question: String(row.question || ''),
        options,
        opened_at: new Date(row.opened_at).toISOString(),
        closes_at: new Date(row.closes_at).toISOString(),
        closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
        state: String(row.state),
        result: closed ? { counts, total, winner } : null,
        vetoed_by: row.vetoed_by ? String(row.vetoed_by) : null,
    };
}

router.post('/:roomId/poll', room.guard('chat.agent_poll.write'), async (req, res) => {
    try {
        const row = await loadRoom(req, res);
        if (!row) return;
        const body = req.body || {};
        const question = String(body.question || '').trim().slice(0, 200);
        if (!question) return res.status(400).json({ error: 'A question is required', code: 'agent_poll.no_question' });
        const options = cleanOptions(body.options);
        if (!options) return res.status(422).json({ error: 'A poll has two to four options', code: 'agent_poll.bad_options' });
        const seconds = Math.min(room.POLL_MAX_SECONDS, Math.max(room.POLL_MIN_SECONDS, Number(body.duration_seconds) || room.POLL_MIN_SECONDS));
        const now = Date.now();
        // One poll at a time, and at most one every five minutes.
        const open = await db.get("SELECT * FROM agent_room_polls WHERE room_id = ? AND state = 'open' ORDER BY opened_at DESC LIMIT 1", [row.id]);
        if (open) return res.status(409).json({ error: 'A poll is already running', code: 'agent_poll.already_running' });
        const last = await db.get('SELECT opened_at FROM agent_room_polls WHERE room_id = ? ORDER BY opened_at DESC LIMIT 1', [row.id]);
        if (last && now - new Date(last.opened_at).getTime() < room.POLL_GAP_MS) {
            res.set('Retry-After', '300');
            return res.status(429).json({ error: 'A poll was asked for a moment ago', code: 'agent_poll.too_soon' });
        }
        const pollId = ids.newId('pol');
        await db.run(
            `INSERT INTO agent_room_polls (id, room_id, question, options, opened_at, closes_at, state, asked_by) VALUES (?, ?, ?, ?, now(), now() + (? * 1000), 'open', ?)`,
            [pollId, row.id, question, JSON.stringify(options), seconds, String(req.principal.sub || '')]
        );
        await announce(row, { type: 'poll', poll_id: pollId, question, options, closes_at: new Date(now + seconds * 1000).toISOString() });
        const created = await db.get('SELECT * FROM agent_room_polls WHERE id = ?', [pollId]);
        res.set('Cache-Control', 'no-store');
        res.status(201).json(pollView({ ...created, room_slug: row.slug }, {}));
    } catch (err) {
        console.error('[Chat] the poll failed:', err.message);
        res.status(500).json({ error: 'The poll could not be started', code: 'agent_poll.failed' });
    }
});

router.get('/:roomId/poll', room.guard('chat.agent_poll.write'), async (req, res) => {
    try {
        const row = await loadRoom(req, res);
        if (!row) return;
        const id = String(req.query.poll_id || '');
        const found = id
            ? await db.get('SELECT * FROM agent_room_polls WHERE id = ? AND room_id = ?', [id, row.id])
            : await db.get('SELECT * FROM agent_room_polls WHERE room_id = ? ORDER BY opened_at DESC LIMIT 1', [row.id]);
        if (!found) return res.status(404).json({ error: 'No such poll', code: 'agent_poll.not_found' });
        const votes = await votesOf(found.id);
        res.set('Cache-Control', 'no-store');
        res.json(pollView({ ...found, room_slug: row.slug }, votes));
    } catch (err) {
        console.error('[Chat] the poll result failed:', err.message);
        res.status(500).json({ error: 'The poll result could not be read', code: 'agent_poll.failed' });
    }
});

/** The counts of a poll: how many people chose each option, never who. */
async function votesOf(pollId) {
    const rows = await db.all('SELECT option_id, COUNT(*) AS n FROM agent_room_poll_votes WHERE poll_id = ? GROUP BY option_id', [String(pollId)]);
    const out = {};
    for (const r of rows) out[String(r.option_id)] = Number(r.n) || 0;
    return out;
}

// ── The agent's own chat identity ────────────────────────────────────────

/**
 * The agent answers one item by name. The line is posted in the room by the agent's own chat identity, which
 * is labelled 'AI agent' and may post one message every 20 seconds.
 */
router.post('/:roomId/answer', room.guard('chat.agent_digest.read'), async (req, res) => {
    try {
        const row = await loadRoom(req, res);
        if (!row) return;
        const body = req.body || {};
        const text = String(body.text || '').trim().slice(0, 2000);
        if (!text) return res.status(400).json({ error: 'A line is required', code: 'agent_answer.no_text' });
        const identity = await db.get('SELECT * FROM agent_room_identities WHERE room_id = ?', [row.id])
            || await db.run('INSERT INTO agent_room_identities (room_id) VALUES (?) ON CONFLICT (room_id) DO NOTHING', [row.id]).then(() => db.get('SELECT * FROM agent_room_identities WHERE room_id = ?', [row.id]));
        const now = Date.now();
        const last = identity && identity.last_message_at ? new Date(identity.last_message_at).getTime() : 0;
        if (last && now - last < room.AGENT_MESSAGE_INTERVAL_MS) {
            res.set('Retry-After', '20');
            return res.status(429).json({ error: 'The agent posted a moment ago', code: 'agent_answer.too_soon' });
        }
        // The answer names the person it answers: '@mira asked why the test is flaky: it is a timezone bug.'
        const mentions = Array.from(text.matchAll(/@([a-z0-9_]{2,32})/gi)).map((m) => String(m[1]).toLowerCase());
        const id = await db.tx(async () => {
            const r = await db.run(
                'INSERT INTO room_messages (room_id, user_id, subject_id, message, agent_stream) VALUES (?, 0, NULL, ?, true)',
                [row.id, text]
            );
            await db.run('UPDATE rooms SET message_count = message_count + 1, last_message_at = ov_now() WHERE id = ?', [row.id]);
            await db.run('UPDATE agent_room_identities SET last_message_at = now() WHERE room_id = ?', [row.id]);
            return Number(r.lastInsertRowid);
        });
        await announce(row, { type: 'agent_message', id, label: room.AGENT_LABEL, handle: room.AGENT_HANDLE, message: text, mentions });
        res.set('Cache-Control', 'no-store');
        res.status(201).json({ ok: true, id, label: room.AGENT_LABEL, handle: room.AGENT_HANDLE });
    } catch (err) {
        console.error('[Chat] the answer failed:', err.message);
        res.status(500).json({ error: 'The answer could not be posted', code: 'agent_answer.failed' });
    }
});

/** Tell the room's watchers: a poll was started, or the agent answered. */
async function announce(row, payload) {
    try {
        require('./chat-server').broadcastToRoom(row.id, { type: payload.type, room: row.slug, ...payload });
    } catch { /* the room is quiet when nobody is watching */ }
}

module.exports = router;
module.exports._pollView = pollView;
module.exports._votesOf = votesOf;
module.exports._cleanOptions = cleanOptions;
