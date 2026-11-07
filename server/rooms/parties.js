'use strict';
/**
 * Watch parties (Agent Streams S7, design 2026-11-06 §4): a Chat room of kind 'party' where friends watch a public
 * agent stream or its VOD in sync, with their own chat beside the stream's.
 *
 *   - Sync: on a VOD the position follows the host's; on a live stream it follows the live edge (no position).
 *   - Joining is by the party's link. The link carries a secret, the row stores its sha256 only, and a stranger
 *     without it sees the same 404 as a missing room.
 *   - Private by default: rooms.visibility is 'private', the party is never in the directory, and `listed` only lets
 *     the stream's page count it ("3 parties watching"). The count query never reads a member or a name.
 *
 * The room itself is rooms.js's (name, members, messages, moderation); this module owns only the party facts.
 */
const crypto = require('crypto');
const db = require('../db/database');
const rooms = require('./rooms');

const AGENT_STREAM_RE = /^ags_[0-9A-HJKMNP-TV-Z]{26}$/;
const VOD_RE = /^\d{1,16}$/;
const MAX_TITLE = 200;
const BASE_URL = () => String(process.env.OV_CHAT_PUBLIC_URL || 'https://openvibe.chat').replace(/\/+$/, '');

class PartyError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new PartyError(status, code, message); };
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const secret = () => crypto.randomBytes(18).toString('base64url').slice(0, 24);

function titleOf(value) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!text || Array.from(text).length > MAX_TITLE) fail(422, 'party.title', 'A party needs a title of 1–200 characters');
    return text;
}

/** A VOD's id: Media's numeric id, as Live and the Rundown carry it. */
function vodOf(value) {
    if (value == null || value === '') return null;
    if (!VOD_RE.test(String(value))) fail(422, 'party.vod', 'vod_id is the recording\'s number');
    return Number(value);
}

function modeOf(vodId) { return vodId == null ? 'live' : 'vod'; }

/** The party's position now: on a VOD, a playing one moves with the clock; a live one is the live edge. */
function syncOf(party, now = Date.now()) {
    if (!party || party.mode === 'live') return { mode: 'live', playing: true };
    const at = party.position_at instanceof Date ? party.position_at.getTime() : Date.parse(String(party.position_at).includes('T') ? party.position_at : `${String(party.position_at).replace(' ', 'T')}Z`);
    const since = party.playing && Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : 0;
    return {
        mode: 'vod',
        position_s: Math.max(0, Number(party.position_s) || 0) + since,
        playing: !!party.playing,
        at: new Date(Number.isFinite(at) ? at : now).toISOString(),
    };
}

function joinUrl(row, rawSecret = null) {
    const base = `${BASE_URL()}/rooms/${encodeURIComponent(row.slug)}`;
    return rawSecret ? `${base}?k=${encodeURIComponent(rawSecret)}` : base;
}

function view(row, party, { rawSecret = null, now = Date.now() } = {}) {
    return {
        id: row.slug,
        agent_stream_id: party.agent_stream_id,
        vod_id: party.vod_id == null ? null : String(party.vod_id),
        host: party.host_subject,
        title: row.name,
        sync: syncOf(party, now),
        visibility: 'private',
        listed: !!party.listed,
        join_url: joinUrl(row, rawSecret),
        created_at: new Date(party.created_at instanceof Date ? party.created_at.getTime() : Date.parse(String(party.created_at).includes('T') ? party.created_at : `${String(party.created_at).replace(' ', 'T')}Z`)).toISOString(),
        ...(party.ended_at ? { ended_at: new Date(party.ended_at).toISOString() } : {}),
    };
}

/**
 * Start a party on a public agent stream or its VOD. The room is private; only the link (with its secret) opens it.
 * Returns the party and the one time its raw join secret exists.
 */
async function create(user, { agent_stream_id: agentStreamId, vod_id: vodId = null, title, listed = false } = {}) {
    if (!user) fail(401, 'party.sign_in', 'Sign in to start a watch party');
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(user.subject_id || ''))) fail(409, 'party.no_subject', 'This account has no OpenVibe subject yet; sign in again');
    const streamId = String(agentStreamId || '');
    if (!AGENT_STREAM_RE.test(streamId)) fail(422, 'party.stream', 'agent_stream_id is an agent stream id (ags_…)');
    const name = titleOf(title);
    const vod = vodOf(vodId);
    const raw = secret();
    // The room name has its own 3–40 cap; the party's title (up to 200) stays on the party and the page.
    const roomName = (name.length < 3 ? `Party: ${name}` : name).slice(0, 40);
    const slug = `party-${crypto.randomBytes(4).toString('hex')}`;
    const room = await rooms.create(user, { name: roomName, slug, kind: 'party', visibility: 'private', topic: name, party: true });
    const id = room.id;
    await db.run(
        `INSERT INTO room_parties (room_id, agent_stream_id, vod_id, host_user_id, host_subject, mode, playing, listed, join_secret_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, streamId, vod, user.id, user.subject_id || '', modeOf(vod), false, !!listed, sha256(raw)]
    );
    const row = await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
    const party = await db.get('SELECT * FROM room_parties WHERE room_id = ?', [id]);
    return { party: view(row, party, { rawSecret: raw }), roomId: id, join_secret: raw };
}

async function bySlug(slug) {
    const row = await db.get('SELECT r.*, p.room_id AS party_room_id, p.agent_stream_id, p.vod_id, p.host_user_id, p.host_subject, p.mode, p.position_s, p.playing, p.position_at, p.listed, p.join_secret_hash, p.ended_at, p.created_at AS party_created_at FROM rooms r JOIN room_parties p ON p.room_id = r.id WHERE r.slug = ?', [String(slug || '').toLowerCase()]);
    return row || null;
}

function partyOf(row) {
    return row && row.party_room_id ? {
        room_id: row.party_room_id, agent_stream_id: row.agent_stream_id, vod_id: row.vod_id,
        host_user_id: row.host_user_id, host_subject: row.host_subject, mode: row.mode,
        position_s: row.position_s, playing: row.playing, position_at: row.position_at, listed: row.listed,
        join_secret_hash: row.join_secret_hash, ended_at: row.ended_at, created_at: row.party_created_at,
    } : null;
}

function keyMatches(party, key) {
    if (!key || !party || !party.join_secret_hash) return false;
    const a = Buffer.from(sha256(key));
    const b = Buffer.from(String(party.join_secret_hash));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Whether this caller may read the party: a member, the host, chat staff, or the holder of the link's secret. */
async function mayView(row, party, user, key) {
    const access = await rooms.access(row, user || null);
    if (access.read) return true;
    return keyMatches(party, key);
}

/** Join with the link's secret: the secret is the invitation, and membership is remembered after it. */
async function joinWithLink(row, party, user, key) {
    if (!user) fail(401, 'party.sign_in', 'Sign in to join the party');
    if (party.ended_at) fail(410, 'party.ended', 'This party has ended');
    const role = await rooms.access(row, user);
    if (role.role) return { role: role.role };
    if (!keyMatches(party, key)) fail(404, 'rooms.not_found', 'No such room');
    const joined = await rooms.join({ ...row, visibility: 'public' }, user);
    return { role: joined };
}

/** The host moves the VOD (or pauses it). Live parties follow the live edge and take no position. */
async function setSync(row, party, user, { position_s: position, playing } = {}) {
    if (!user || Number(user.id) !== Number(party.host_user_id)) fail(403, 'party.not_host', 'Only the host moves the party');
    if (party.mode === 'live') fail(409, 'party.live_edge', 'A live party follows the live edge; there is no position to set');
    let pos = party.position_s;
    if (position !== undefined) {
        const n = Number(position);
        if (!Number.isInteger(n) || n < 0 || n > 7 * 24 * 60 * 60) fail(422, 'party.position', 'position_s is whole seconds');
        pos = n;
    }
    const play = playing === undefined ? party.playing : !!playing;
    await db.run('UPDATE room_parties SET position_s = ?, playing = ?, position_at = now() WHERE room_id = ?', [pos, play, party.room_id]);
    const fresh = await bySlug(row.slug);
    return view(fresh, partyOf(fresh));
}

/** How many listed parties a stream has. A count: no member, no host, no name. */
async function count(agentStreamId) {
    if (!AGENT_STREAM_RE.test(String(agentStreamId || ''))) return { count: 0 };
    const row = await db.get('SELECT COUNT(*) AS n FROM room_parties p JOIN rooms r ON r.id = p.room_id WHERE p.agent_stream_id = ? AND p.listed IS TRUE AND p.ended_at IS NULL AND r.archived_at IS NULL', [String(agentStreamId)]);
    return { count: Number(row && row.n) || 0 };
}

async function end(row, party, user) {
    if (!user || Number(user.id) !== Number(party.host_user_id)) fail(403, 'party.not_host', 'Only the host ends the party');
    await db.run('UPDATE room_parties SET ended_at = now(), playing = false WHERE room_id = ? AND ended_at IS NULL', [party.room_id]);
    const fresh = await bySlug(row.slug);
    return view(fresh, partyOf(fresh));
}

module.exports = {
    AGENT_STREAM_RE, MAX_TITLE, PartyError,
    create, bySlug, partyOf, view, syncOf, mayView, joinWithLink, setSync, count, end, keyMatches,
};
