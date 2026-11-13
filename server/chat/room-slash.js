'use strict';
const db = require('../db/database');
const rooms = require('../rooms/rooms');
const servers = require('../rooms/servers');
const ctx = require('../live-context');
const config = require('../config');

const error = (status, code, message) => { throw new rooms.RoomError(status, code, message); };
const RANK = servers.RANK;

async function parse(room, user, raw) {
    if (!config.slashCommands.enabled || !/^\/[a-z][a-z0-9_-]*(?:\s|$)/i.test(String(raw || ''))) return { handled: false };
    const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(String(raw).trim());
    if (!match) return { handled: false };
    const name = match[1].toLowerCase(), args = (match[2] || '').trim();
    const a = await rooms.access(room, user);
    if (!a.post) error(a.read ? 403 : 404, 'commands.forbidden', 'You cannot write here');
    if (name === 'me') {
        if (!args) error(422, 'commands.options', 'Use /me <action>');
        return { handled: true, text: `* ${user.display_name || user.username} ${args}` };
    }
    if (name === 'shrug') return { handled: true, text: `${args ? `${args} ` : ''}¯\\_(ツ)_/¯` };
    if (name === 'help') {
        const available = require('./slash-commands').BUILT_INS.filter((command) => !command.permission || a.moderate);
        return { handled: true, reply: `Commands: ${available.map((command) => `/${command.name}`).join(', ')}` };
    }
    if (name === 'nick') {
        if (!room.server_id) error(422, 'commands.server_only', '/nick works in a server channel');
        if (!/^[^\x00-\x1f\x7f]{2,32}$/.test(args)) error(422, 'commands.options', 'Use /nick <2–32 character name>');
        await db.run('UPDATE chat_server_members SET nickname = ? WHERE server_id = ? AND user_id = ?', [args, room.server_id, user.id]);
        return { handled: true, reply: `Your server nickname is ${args}.` };
    }
    if (name === 'mute' || name === 'timeout') {
        if (!room.server_id) error(422, 'commands.server_only', `/${name} works in a server channel`);
        const server = await servers.byId(room.server_id);
        const access = await servers.access(server, user);
        if (!access.moderate) error(403, 'commands.forbidden', 'You do not have permission');
        const bits = args.split(/\s+/), target = await ctx.getUserByUsername(bits[0].replace(/^@/, ''));
        if (!target || !(await servers.roleIn(server.id, target.id))) error(404, 'commands.no_user', 'No such member');
        const role = await servers.roleIn(server.id, target.id);
        if (role === 'owner' || (!access.staff && RANK[access.role] >= RANK[role])) error(403, 'commands.rank', 'You cannot time out this member');
        const seconds = name === 'mute' ? 300 : Number(bits[1] || 300);
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) error(422, 'commands.options', 'Timeout must be 60–86400 seconds');
        await db.run(`INSERT INTO chat_server_timeouts (server_id, user_id, expires_at, actor_user_id) VALUES (?, ?, now() + (? * interval '1 second'), ?)
            ON CONFLICT (server_id, user_id) DO UPDATE SET expires_at = excluded.expires_at, actor_user_id = excluded.actor_user_id`, [server.id, target.id, seconds, user.id]);
        await db.logModerationAction({ scope_type: 'server', scope_id: server.slug, actor_user_id: user.id, target_user_id: target.id, action_type: 'server_timeout', details: { seconds } });
        return { handled: true, reply: `${target.username} timed out for ${seconds}s.` };
    }
    if (name === 'poll') {
        const parts = args.split('|').map((s) => s.trim());
        if (parts.length < 3 || parts.length > 11 || !parts[0] || parts.some((s) => !s || s.length > 200)) error(422, 'commands.options', 'Use /poll Question | Option 1 | Option 2');
        const question = parts.shift();
        const r = await db.run('INSERT INTO chat_command_polls (room_id, author_user_id, question, options) VALUES (?, ?, ?, ?::jsonb)', [room.id, user.id, question, JSON.stringify(parts)]);
        return { handled: true, text: `Poll #${r.lastInsertRowid}: ${question}\n${parts.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nVote with /vote ${r.lastInsertRowid} <option number>.`, poll_id: Number(r.lastInsertRowid) };
    }
    if (name === 'vote') {
        const bits = args.split(/\s+/);
        if (bits.length !== 2) error(422, 'commands.options', 'Use /vote <poll number> <option number>');
        const cast = await vote(room, user, bits[0], bits[1]);
        return { handled: true, reply: `Vote ${cast.option} recorded for poll #${cast.poll_id}.` };
    }
    if (name === 'remind') {
        const found = /^(\d+)([mhd])\s+([\s\S]+)$/.exec(args);
        if (!found || found[3].length > 500) error(422, 'commands.options', 'Use /remind 10m <message> (m, h or d; up to 30 days)');
        const scale = { m: 60, h: 3600, d: 86400 }[found[2]], seconds = Number(found[1]) * scale;
        if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 30 * 86400) error(422, 'commands.options', 'Reminder must be 1 minute to 30 days away');
        await db.run(`INSERT INTO chat_command_reminders (room_id, user_id, due_at, text) VALUES (?, ?, now() + (? * interval '1 second'), ?)`, [room.id, user.id, seconds, found[3]]);
        return { handled: true, reply: `I will remind you in ${found[1]}${found[2]}.` };
    }
    const app = room.server_id && await db.get('SELECT response_template FROM chat_registered_commands WHERE server_id = ? AND name = ?', [room.server_id, name]);
    if (app) return { handled: true, text: app.response_template.replace(/\{args\}/g, args).slice(0, 2000) };
    error(422, 'commands.unknown', `Unknown command: /${name}`);
}

async function vote(room, user, pollId, option) {
    const a = await rooms.access(room, user);
    if (!a.post) error(a.read ? 403 : 404, 'commands.forbidden', 'You cannot vote here');
    const poll = await db.get('SELECT * FROM chat_command_polls WHERE id = ? AND room_id = ? AND closes_at > now()', [pollId, room.id]);
    if (!poll) error(404, 'commands.poll_not_found', 'Poll is closed or not found');
    const options = Array.isArray(poll.options) ? poll.options : JSON.parse(poll.options);
    const n = Number(option);
    if (!Number.isInteger(n) || n < 1 || n > options.length) error(422, 'commands.options', 'No such option');
    await db.run('INSERT INTO chat_command_poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?) ON CONFLICT (poll_id, user_id) DO UPDATE SET option_index = excluded.option_index', [poll.id, user.id, n]);
    return { poll_id: Number(poll.id), option: n };
}

async function pollView(room, pollId) {
    const poll = await db.get('SELECT * FROM chat_command_polls WHERE id = ? AND room_id = ?', [pollId, room.id]);
    if (!poll) error(404, 'commands.poll_not_found', 'No such poll');
    const options = Array.isArray(poll.options) ? poll.options : JSON.parse(poll.options);
    const votes = await db.all('SELECT option_index, COUNT(*) AS count FROM chat_command_poll_votes WHERE poll_id = ? GROUP BY option_index', [poll.id]);
    const count = new Map(votes.map((v) => [Number(v.option_index), Number(v.count)]));
    return { id: Number(poll.id), question: poll.question, closes_at: poll.closes_at, options: options.map((label, i) => ({ index: i + 1, label, votes: count.get(i + 1) || 0 })) };
}

let timer = null;
async function deliverReminders() {
    if (!config.slashCommands.enabled) return;
    const due = await db.all('SELECT * FROM chat_command_reminders WHERE due_at <= now() AND delivered_at IS NULL ORDER BY due_at LIMIT 50');
    for (const reminder of due) {
        // Claim once before sending, including on multi-instance Chat. A failed post is still completed;
        // a person who lost access must never gain it through a reminder.
        const claimed = await db.run('UPDATE chat_command_reminders SET delivered_at = now() WHERE id = ? AND delivered_at IS NULL', [reminder.id]);
        if (!claimed.changes) continue;
        const room = await db.get('SELECT * FROM rooms WHERE id = ? AND archived_at IS NULL', [reminder.room_id]), user = await ctx.getUserById(reminder.user_id);
        if (!room || !user) continue;
        try {
            const message = await rooms.post(room, user, `Reminder: ${reminder.text}`, { ai: false });
            require('./chat-server').broadcastToRoom(room.id, { type: 'room_message', room: room.slug, message });
        } catch (err) { console.warn('[Commands] reminder skipped:', err.code || err.message); }
    }
}
function start() { if (!timer) { timer = setInterval(() => { deliverReminders().catch((err) => console.warn('[Commands] reminder:', err.message)); }, 15000); timer.unref(); } }
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { parse, vote, pollView, deliverReminders, start, stop };
