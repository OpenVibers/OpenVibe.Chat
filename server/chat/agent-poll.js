'use strict';
/**
 * OpenVibe.Chat — the polls of a Co-pilot room (Agent Streams S5, design 2026-11-06, §3).
 *
 * The agent asks chat to choose: two to four options, open for 30 to 120 seconds. Chat draws the poll card
 * and the people vote (one vote each, by button or by typing !1 to !4). One poll at a time, and at most one
 * poll every five minutes. The owner or a moderator can close a poll early or veto its result.
 *
 * A poll can only choose between the options the agent wrote: Chat never adds one, and the result is the
 * counts only — never who voted for what.
 */
const db = require('../db/database');

/** The counts of a poll: how many people chose each option, never who. */
async function votesOf(pollId) {
    const rows = await db.all('SELECT option_id, COUNT(*) AS n FROM agent_room_poll_votes WHERE poll_id = ? GROUP BY option_id', [String(pollId)]);
    const out = {};
    for (const r of rows) out[String(r.option_id)] = Number(r.n) || 0;
    return out;
}

/** The poll as the contract says it is: an open poll carries no result. */
function pollView(row, votes) {
    const options = (Array.isArray(row.options) ? row.options : []).map((o) => ({
        id: String(o.id), label: String(o.label), votes: Number(votes && votes[o.id]) || 0,
    }));
    const counts = options.map((o) => o.votes);
    const total = counts.reduce((a, b) => a + b, 0);
    const winner = total ? ((options.find((o) => o.votes === Math.max(...counts)) || {}).id || null) : null;
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

/** The open poll of a room, or null. */
async function openPoll(roomId) {
    const row = await db.get("SELECT * FROM agent_room_polls WHERE room_id = ? AND state = 'open' ORDER BY opened_at DESC LIMIT 1", [Number(roomId) || 0]) || null;
    if (row && new Date(row.closes_at).getTime() <= Date.now()) { await closePoll(row); return null; }
    return row;
}

/**
 * A person's vote. One vote per person: the vote is theirs, and pressing again changes it, but they never
 * count twice. Only an open poll takes a vote, and only an option the agent wrote.
 */
async function castVote({ poll, user, optionId }) {
    if (!poll || poll.state !== 'open' || new Date(poll.closes_at).getTime() <= Date.now()) return { ok: false, code: 'agent_poll.not_open' };
    const options = Array.isArray(poll.options) ? poll.options : [];
    const option = options.find((o) => String(o.id) === String(optionId));
    if (!option) return { ok: false, code: 'agent_poll.no_such_option' };
    const userId = Number(user && user.id) || 0;
    if (!userId) return { ok: false, code: 'agent_poll.sign_in' };
    await db.run(
        'INSERT INTO agent_room_poll_votes (poll_id, user_id, option_id, voted_at) VALUES (?, ?, ?, now()) ' +
        'ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id, voted_at = now()',
        [String(poll.id), userId, String(option.id)]
    );
    return { ok: true, poll_id: String(poll.id), option_id: String(option.id) };
}

/** Close a poll early: the result is the counts. */
async function closePoll(poll) {
    const votes = await votesOf(poll.id);
    const options = (Array.isArray(poll.options) ? poll.options : []).map((o) => String(o.id));
    const counts = options.map((id) => Number(votes[id]) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const winner = total ? String(options[counts.indexOf(Math.max(...counts))]) : null;
    const result = { counts, total, winner };
    await db.run(
        "UPDATE agent_room_polls SET state = 'closed', closed_at = now(), result = ? WHERE id = ?",
        [JSON.stringify(result), String(poll.id)]
    );
    return { poll_id: String(poll.id), state: 'closed', result };
}

/** Veto a poll's result: the poll is closed and its result is not the room's. */
async function vetoPoll(poll, by) {
    await db.run(
        "UPDATE agent_room_polls SET state = 'vetoed', closed_at = now(), vetoed_by = ? WHERE id = ?",
        [String(by || ''), String(poll.id)]
    );
    return { poll_id: String(poll.id), state: 'vetoed', vetoed_by: String(by || '') };
}

module.exports = { votesOf, pollView, openPoll, castVote, closePoll, vetoPoll };

