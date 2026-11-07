'use strict';
/**
 * OpenVibe.Chat — the Co-pilot room of a live agent stream, and what an agent may read of it
 * (Agent Streams S5, design 2026-11-06).
 *
 * The room: kind 'agent_stream', id `agent:<ags_id>`, created by Live when the stream is public or unlisted
 * (a private stream has no room). It says what it is before anyone types, in a pinned banner:
 *
 *   "The AI agent reads this chat between steps. It may answer you by name."
 *
 * The digest: between two steps the agent asks what chat said since its last read. It never reads the raw room:
 *
 *   GET  /api/v1/rooms/agent:<id>/digest?since=   →  chat.agent-digest@1
 *
 * Chat chooses what goes in and who is left out. At most ten items and 1,500 characters; each item has who (the
 * display name and the handle), what (cut to 200 characters), its kind (a question, a suggestion or a reaction)
 * and its upvotes (a thumbs up on the message counts). Repeats are grouped, greetings and spam are dropped, and
 * the most-upvoted questions and suggestions come first. Nobody is left in by accident: a person who is timed
 * out or banned, whose account is younger than a day, or who set 'Agents don't read my messages' is never in
 * the digest. A link is kept as its domain only; code and commands stay as text.
 *
 * The poll: the agent asks chat to choose.
 *
 *   POST /api/v1/rooms/agent:<id>/poll   { question, options, duration_seconds }  →  chat.agent-poll@1
 *   GET  /api/v1/rooms/agent:<id>/poll                                         →  chat.agent-poll@1 (the result)
 *
 * Two to four options, open for 30 to 120 seconds. Chat draws the poll card; `!1` to `!4` vote too. One vote
 * per person, one poll at a time, and at most one poll every five minutes. The owner (or a moderator) can close
 * a poll early or veto its result. A poll can only choose between the options the agent wrote: Chat never adds
 * one.
 *
 * The agent's own chat identity: it posts an answer line in the room, labelled 'AI agent', at most one message
 * every 20 seconds.
 *
 * Auth: the caller is Codes or Actor, the task's service, acting for the stream's owner (a node token names
 * its owner in `on_behalf_of`). The routes take a service token only, and the room is the owner's: the token
 * names the owner, so a digest is that owner's room and never another person's.
 */
const express = require('express');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const contracts = require('openvibe-contracts');
const config = require('../config');
const { keys } = require('../net/service-auth');
const db = require('../db/database');
const ctx = require('../live-context');
const wordFilter = require('../chat/word-filter');
const prefs = require('../prefs/stores');

const { capabilities, http } = contracts;
const AUDIENCE = 'openvibe.chat';
const DIGEST_CAPABILITY = 'chat.agent_digest.read';
const POLL_CAPABILITY = 'chat.agent_poll.write';

// The design's numbers.
const MAX_ITEMS = 10;
const MAX_CHARS = 1500;
const MAX_ITEM_CHARS = 200;
const MIN_ACCOUNT_AGE_MS = 86_400_000;          // a day-old account or younger is left out
const READ_INTERVAL_MS = 20_000;                // one read per step, and at most one every 20 s
const POLL_MIN_SECONDS = 30;
const POLL_MAX_SECONDS = 120;
const POLL_GAP_MS = 300_000;                    // at most one poll every five minutes
const AGENT_MESSAGE_INTERVAL_MS = 20_000;       // the agent's identity: one message every 20 s
const BANNER = 'The AI agent reads this chat between steps. It may answer you by name.';
const AGENT_LABEL = 'AI agent';
const AGENT_HANDLE = 'aiagent';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The room id of an agent stream's room: `agent:<ags_id>`. */
function roomIdOf(agsId) {
    const id = String(agsId || '').trim();
    return /^ags_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? `agent:${id}` : null;
}

/**
 * The person the token speaks for, or null: a node token names its owner (`on_behalf_of`), a person token is the
 * person, and a first-party service (Codes or Actor) names them in X-OV-Subject, the form Actor established.
 */
function personOf(claims, req) {
    const onBehalf = String(claims.on_behalf_of || '');
    if (onBehalf) return onBehalf;
    const sub = String(claims.sub || '');
    if (sub.startsWith('usr_')) return sub;
    if (/^(svc|node):/.test(sub) && req && req.get) {
        const named = String(req.get('x-ov-subject') || '');
        if (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(named)) return named;
    }
    return null;
}

/** The service token guard: the capability, and a person the token speaks for. */
function guard(capability) {
    return async function serviceGuard(req, res, next) {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'no service token' });
        const r = await verifyServiceToken(auth.slice(7).trim(), { ...keys().verifyOptions, issuer: config.networkUrl, audience: AUDIENCE, contracts });
        if (!r.ok) {
            if (r.code === 'token.unavailable') return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded' });
            return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason });
        }
        const c = capabilities.get(capability)
            ? capabilities.check(r.claims, capability)
            : (capabilities.grants(r.claims.cap, capability) ? { allowed: true } : { allowed: false });
        if (!c.allowed) return http.sendProblem(res, 403, 'capability.denied', { detail: `${capability} not granted` });
        const person = personOf(r.claims, req);
        if (!person) return http.sendProblem(res, 403, 'subject.not_delegated', { detail: 'the token names nobody' });
        req.principal = { sub: r.claims.sub, cap: r.claims.cap, person };
        next();
    };
}

// ── The room ─────────────────────────────────────────────────────────────

/** The Co-pilot room of an agent stream, by its id, or null. */
async function roomByAgentId(agentRoomId) {
    return await db.get("SELECT * FROM rooms WHERE slug = ? AND kind = 'agent_stream' AND archived_at IS NULL", [String(agentRoomId || '')]) || null;
}

/**
 * The room for an agent stream, made if it is not there yet (Live calls this when the stream becomes public
 * or unlisted). The banner is the room's purpose, said before anyone types.
 */
async function ensureRoom(agentRoomId, { owner, name, subject } = {}) {
    const existing = await roomByAgentId(agentRoomId);
    if (existing) return existing;
    const slug = String(agentRoomId || '');
    const id = await db.tx(async () => {
        const r = await db.run(
            "INSERT INTO rooms (slug, name, topic, kind, visibility, owner_id, owner_subject) VALUES (?, ?, ?, 'agent_stream', 'public', ?, ?)",
            [slug, String(name || slug).slice(0, 40), BANNER, owner ? Number(owner.id) || 0 : 0, subject || null]
        );
        const roomId = Number(r.lastInsertRowid);
        await db.run("INSERT INTO agent_room_identities (room_id) VALUES (?) ON CONFLICT (room_id) DO NOTHING", [roomId]);
        return roomId;
    });
    return await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
}

// ── The digest ───────────────────────────────────────────────────────────

/** A link is kept as its domain only: 'a link to github.com'. The agent never follows a link from chat. */
function domainOnly(text) {
    return String(text || '').replace(/\bhttps?:\/\/([^\s/]+)[^\s]*/gi, (m, host) => `a link to ${host}`);
}

/** Cut to the item's length, on a word boundary where there is one. */
function cut(text, max = MAX_ITEM_CHARS) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

/** A greeting is not a question and not a suggestion: it is noise in a digest. */
const GREETING = /^(?:hi|hey|hello|yo|sup|good (?:morning|afternoon|evening|night)|thanks|thank you|ty|thx|ok|okay|k|kk|bye|goodbye|lol|\W+)$/i;

/** What the line is: a question, a suggestion, or a reaction. */
function kindOf(text) {
    const s = String(text || '').trim();
    if (!s) return 'reaction';
    if (/(?:\?|\bhow\b|\bwhy\b|\bwhat\b|\bwhen\b|\bwhere\b|\bwhich\b|\bwho\b|\bcan you\b|\bdoes\b|\bis there\b)/i.test(s)) return 'question';
    if (/(?:\bplease\b|\bshould\b|\btry\b|\bmaybe\b|\bsuggest\b|\buse\b|\badd\b|\bchange\b|\bfix\b|\brename\b|\bwrite\b|\bdo\b)/i.test(s)) return 'suggestion';
    return 'reaction';
}

/** The account must be at least a day old, and the person must not be timed out or banned. */
async function eligible(row, now) {
    if (!row) return false;
    if (Number(row.is_banned) === 1) return false;
    if (row.user_id && ctx.isUserBanned && ctx.isUserBanned(Number(row.user_id))) return false;
    // A person who is timed out in this room is left out of the digest too.
    if (row.user_id && row.room_id) {
        const mute = await db.get('SELECT until_at FROM room_member_timeouts WHERE room_id = ? AND user_id = ?', [row.room_id, Number(row.user_id)]);
        if (mute) {
            const until = Date.parse(String(mute.until_at || '').replace(' ', 'T') + (String(mute.until_at || '').endsWith('Z') ? '' : 'Z'));
            if (!Number.isFinite(until) || until > now) return false;
        }
    }
    const created = Date.parse(String(row.account_created_at || '').replace(' ', 'T') + (String(row.account_created_at || '').endsWith('Z') ? '' : 'Z'));
    if (!Number.isFinite(created)) return false;
    if (now - created < MIN_ACCOUNT_AGE_MS) return false;
    return true;
}

/**
 * The digest of a room since a moment: at most ten items and 1,500 characters.
 * Chat chooses the items and leaves out the people it must leave out.
 */
async function digest(room, { since = null, now = Date.now() } = {}) {
    const sinceMs = since ? Date.parse(String(since).replace(' ', 'T') + (String(since).endsWith('Z') ? '' : 'Z')) : null;
    const from = Number.isFinite(sinceMs) ? sinceMs : 0;
    const rows = await db.all(
        `SELECT m.id, m.room_id, m.message, m.created_at, m.user_id, u.username, u.display_name, u.created_at AS account_created_at,
                 u.is_banned, COALESCE(m.subject_id, u.subject_id) AS subject_id
            FROM room_messages m
            LEFT JOIN ctx_users u ON u.id = m.user_id AND m.ai_member_id IS NULL
            WHERE m.room_id = ? AND m.is_deleted = 0 AND m.ai_member_id IS NULL
            ORDER BY m.id ASC`,
        [room.id]
    );
    // The people the settings leave out, read once: the namespace is Chat's own module store.
    const out = [];
    const groups = new Map();
    for (const row of rows) {
        const at = Date.parse(String(row.created_at || '').replace(' ', 'T') + (String(row.created_at || '').endsWith('Z') ? '' : 'Z'));
        if (!Number.isFinite(at) || at <= from) continue;
        const text = String(row.message || '').trim();
        if (!text) continue;
        if (GREETING.test(text)) continue;
        if (wordFilter.isSpam(text)) continue;
        if (!await eligible(row, now)) continue;
        if (await optedOut(row)) continue;
        const what = cut(domainOnly(text));
        const key = what.toLowerCase();
        const hit = groups.get(key);
        if (hit) { hit.repeated += 1; continue; }          // repeats are one item
        groups.set(key, {
            who: { display_name: String(row.display_name || row.username || 'someone').slice(0, 80), handle: String(row.username || '').toLowerCase().slice(0, 32) },
            what,
            kind: kindOf(text),
            upvotes: await upvotesOf(row.id),
            repeated: 1,
        });
    }
    for (const item of groups.values()) out.push(item);
    // The most-upvoted questions and suggestions come first; the reactions come last.
    const rank = { question: 0, suggestion: 1, reaction: 2 };
    out.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.upvotes - a.upvotes) || a.what.localeCompare(b.what));
    // The caps: ten items and 1,500 characters.
    let chars = 0;
    const kept = [];
    let truncated = false;
    for (const item of out) {
        if (kept.length >= MAX_ITEMS) { truncated = true; break; }
        const size = item.what.length + item.who.display_name.length + item.who.handle.length + 8;
        if (chars + size > MAX_CHARS) { truncated = true; break; }
        chars += size;
        kept.push(item);
    }
    return {
        room: room.slug,
        since: since ? new Date(from).toISOString() : null,
        until: new Date(now).toISOString(),
        items: kept,
        chars,
        truncated,
    };
}

/** Whether the person set 'Agents don't read my messages'. The setting is the person's own choice. */
async function optedOut(row) {
    if (!row.user_id || !row.subject_id) return false;
    try {
        const data = await prefs.preferences.get(row.subject_id);
        const pref = (data && data.preferences) || {};
        return pref.agents_read_messages === false;
    } catch {
        return true;                                     // a privacy setting fails closed: an outage reads nobody
    }
}

/** How many thumbs up a message carries. */
async function upvotesOf(messageId) {
    const row = await db.get('SELECT COUNT(*) AS n FROM room_message_reactions WHERE message_id = ? AND reaction = ?', [Number(messageId) || 0, 'thumbsup']);
    return Number(row && row.n) || 0;
}

module.exports = {
    BANNER, AGENT_LABEL, AGENT_HANDLE,
    MAX_ITEMS, MAX_CHARS, MAX_ITEM_CHARS, MIN_ACCOUNT_AGE_MS, READ_INTERVAL_MS,
    POLL_MIN_SECONDS, POLL_MAX_SECONDS, POLL_GAP_MS, AGENT_MESSAGE_INTERVAL_MS,
    roomIdOf, personOf, guard, roomByAgentId, ensureRoom, digest,
    domainOnly, cut, kindOf, eligible, optedOut, upvotesOf,
};
