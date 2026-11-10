'use strict';
/**
 * Watch parties (Agent Streams S7, design 2026-11-06 §4; media parties, plan R1 2026-11-07): a Chat room of kind
 * 'party' where friends watch something in sync, with their own chat beside it.
 *
 *   - An agent-stream party watches a public agent stream or its VOD: on a VOD the position follows the host's; on a
 *     live stream it follows the live edge (no position).
 *   - A media party watches a Media ref, an https URL on an OpenVibe host, or an official YouTube/Twitch watch URL,
 *     exactly as the room's shared clock accepts media (server/rooms/sync-clock.js). Its timeline is the room's clock
 *     (paused at 0 when it starts) and its remote is the room's control lease, granted to the person who started it.
 *   - Joining is by the party's link. The link carries a secret, the row stores its sha256 only, and a stranger
 *     without it sees the same 404 as a missing room.
 *   - Private by default: rooms.visibility is 'private', the party is never in the directory, and `listed` only lets
 *     the stream's page count it ("3 parties watching"). The count query never reads a member or a name.
 *
 * The room itself is rooms.js's (name, members, messages, moderation); this module owns only the party facts.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db/database');
const rooms = require('./rooms');
const syncClock = require('./sync-clock');
const controlLease = require('./control-lease');
const pool = require('./party-pool');

const AGENT_STREAM_RE = /^ags_[0-9A-HJKMNP-TV-Z]{26}$/;
const VOD_RE = /^\d{1,16}$/;
const MAX_TITLE = 200;
const BASE_URL = () => String(process.env.OV_CHAT_PUBLIC_URL || 'https://openvibe.chat').replace(/\/+$/, '');
const PARTY_BASE_URL = () => String(config.party.baseUrl || 'https://openvibe.party').replace(/\/+$/, '');

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

/**
 * A media party's media: a Media ref, an OpenVibe URL, or an official YouTube/Twitch URL, validated by the shared clock's own rules
 * (server/rooms/sync-clock.js). A refusal is the party API's 422, not the clock's.
 */
function mediaOf(value) {
    try {
        return syncClock._mediaOf(value);
    } catch (err) {
        if (err instanceof syncClock.SyncError) fail(422, 'party.media', err.message);
        throw err;
    }
}

/** The OpenVibe page a party was started from: an https page on an OpenVibe host, or null. */
function sourceUrlOf(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !syncClock.onOpenVibe(value)) fail(422, 'party.source_url', 'source_url is an https page on an OpenVibe site');
    return value;
}

/** The party row's media, as stored (jsonb comes back as an object; older drivers may give text). */
function mediaFromRow(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value.startsWith('https://') ? value : null; }
}

const kindOfParty = (party) => (party && ['media', 'radio', 'desktop'].includes(party.party_kind) ? party.party_kind : 'agent_stream');

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

function joinUrl(row, kind, rawSecret = null) {
    const slug = encodeURIComponent(row.slug);
    const base = kind === 'media' || kind === 'radio' || kind === 'desktop' ? `${PARTY_BASE_URL()}/p/${slug}` : `${BASE_URL()}/rooms/${slug}`;
    return rawSecret ? `${base}?k=${encodeURIComponent(rawSecret)}` : base;
}

/** The plain line a Link-hosted party's page shows for where it runs. */
const LINK_WHERE = Object.freeze({
    state: 'link', machine: null, queue_position: null,
    line: "Runs on the host's computer through OpenVibe Link.",
});

function view(row, party, { rawSecret = null, now = Date.now(), where } = {}) {
    const kind = kindOfParty(party);
    return {
        id: row.slug,
        kind,
        agent_stream_id: party.agent_stream_id || null,
        vod_id: party.vod_id == null ? null : String(party.vod_id),
        ...(kind === 'media' || kind === 'radio' ? { media: mediaFromRow(party.media), source_url: party.source_url || null } : {}),
        ...(kind === 'radio' ? { radio_track: mediaFromRow(party.radio_track) } : {}),
        ...(kind === 'desktop' ? { desktop: {
            hosting: party.desktop_hosting, state: party.desktop_state, layout: party.desktop_layout || 'watch',
            url: party.desktop_state === 'ready' ? party.desktop_share_url : null,
            // Where this party's computer runs: the pool's hold (named machine, or its place in line), or the
            // host's own Link machine. The page draws one plain line from it; the data is here for the API/SDK.
            where: where || (party.desktop_hosting === 'link' ? LINK_WHERE : null),
        } } : {}),
        host: party.host_subject,
        title: row.name,
        ...(kind === 'agent_stream' ? { sync: syncOf(party, now) } : {}),
        visibility: 'private',
        listed: !!party.listed,
        join_url: joinUrl(row, kind, rawSecret),
        created_at: new Date(party.created_at instanceof Date ? party.created_at.getTime() : Date.parse(String(party.created_at).includes('T') ? party.created_at : `${String(party.created_at).replace(' ', 'T')}Z`)).toISOString(),
        ...(party.ended_at ? { ended_at: new Date(party.ended_at).toISOString() } : {}),
    };
}

/**
 * What a viewer sees of a party: the view, the host's name, and — for a media party — the room's clock. A member also
 * gets the members (their subjects and names) and the remote's state; someone holding only the link's secret gets
 * neither, because the lease's watchers are live presence and the members are the room's people.
 * → null when the caller may not view it at all (the caller answers the missing-room 404).
 */
async function detail(row, party, { user = null, key = null, now = Date.now() } = {}) {
    const access = await rooms.access(row, user || null);
    const member = !!access.read;
    if (!member && !keyMatches(party, key)) return null;
    const host = await db.get('SELECT username, display_name FROM ctx_users WHERE subject_id = ? LIMIT 1', [party.host_subject]);
    const out = {
        ...view(row, party, { now, ...(kindOfParty(party) === 'desktop' ? { where: await pool.where(party.room_id) } : {}) }),
        host_name: host ? (host.display_name || host.username) : null,
        member,
    };
    if (kindOfParty(party) === 'media' || kindOfParty(party) === 'radio' || kindOfParty(party) === 'desktop') {
        const room = { id: row.id, slug: row.slug };
        if (kindOfParty(party) !== 'desktop') out.clock = await syncClock.get(room);
        if (member) {
            out.lease = await controlLease.state(room);
            out.members = (await rooms.members(row, { subjects: true }))
                .filter((m) => m.role !== 'blocked')
                .map((m) => ({ subject: m.subject_id || null, name: m.display_name || m.username, role: m.role }));
        }
    }
    if (kindOfParty(party) === 'radio') out.radio = await require('./radio').state(row, party, { user, key });
    // A watch party or a shared computer can play OpenVibe Radio beside what it watches: the room's own music
    // timeline (server/rooms/party-music.js), visible to every member and to a holder of the link's secret.
    if (kindOfParty(party) === 'media' || kindOfParty(party) === 'desktop') {
        out.music = await require('./party-music').state(row, { now });
    }
    return out;
}

/**
 * Start a party on a public agent stream or its VOD. The room is private; only the link (with its secret) opens it.
 * Returns the party and the one time its raw join secret exists.
 */
async function create(user, input = {}) {
    if (input && input.desktop_hosting) return await createDesktop(user, input);
    if (input && input.radio_track_id) return await require('./radio').start(user, input);
    if (input && input.media !== undefined && input.media !== null && input.media !== '') return await createMedia(user, input);
    return await createAgentStream(user, input);
}

async function createDesktop(user, { title = 'Shared computer', desktop_hosting: hosting, desktop_node_id: nodeId } = {}) {
    if (!user) fail(401, 'party.sign_in', 'Sign in to start a shared computer');
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(user.subject_id || ''))) fail(409, 'party.no_subject', 'This account has no OpenVibe subject yet; sign in again');
    if (hosting !== 'link' && hosting !== 'openvibe') fail(422, 'party.hosting', 'Choose your computer or an OpenVibe computer');
    if (hosting === 'link' && !/^lnk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(nodeId || ''))) fail(422, 'party.machine', 'Choose one of your Link computers');
    const name = titleOf(title);
    const raw = secret();
    const slug = `party-${crypto.randomBytes(4).toString('hex')}`;
    // An OpenVibe party asks the pool before the room exists: a machine is held for this slug, or the party is
    // given a place in line. A failure here (the switch is off, no machine is registered, the person's own limit)
    // starts no room at all. A Link party never touches the pool.
    const placed = hosting === 'openvibe' ? await pool.place({ actor: user.subject_id, slug }) : null;
    let room;
    try {
        room = await rooms.create(user, { name: name.slice(0, 40), slug, kind: 'party', visibility: 'private', topic: name, party: true });
        await db.run(`INSERT INTO room_parties (room_id, agent_stream_id, vod_id, host_user_id, host_subject, mode, playing, listed, join_secret_hash, party_kind, desktop_hosting, desktop_state, desktop_node_id)
            VALUES (?, NULL, NULL, ?, ?, 'live', false, false, ?, 'desktop', ?, 'waiting', ?)`,
            [room.id, user.id, user.subject_id, sha256(raw), hosting, hosting === 'link' ? nodeId : null]);
        if (placed) await pool.bind(placed.hold.id, room.id);
        await controlLease.take({ id: room.id, slug }, user.subject_id, { watchers: [] });
    } catch (err) {
        if (placed) await pool.cancel(placed.hold.id, 'room_failed').catch(() => {});
        throw err;
    }
    const row = await bySlug(slug);
    return {
        party: view(row, partyOf(row), { rawSecret: raw, ...(placed ? { where: await pool.where(room.id) } : {}) }),
        roomId: room.id,
        join_secret: raw,
    };
}

async function createAgentStream(user, { agent_stream_id: agentStreamId, vod_id: vodId = null, title, listed = false } = {}) {
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

/**
 * Start a party on OpenVibe media: the room, the party row, the room's clock seeded paused at 0 with that media, and
 * the remote granted to the person who started it. The join link is openvibe.party/p/<slug>?k=…, and the secret is
 * in this answer only.
 */
async function createMedia(user, { media, source_url: sourceUrl = null, title, listed = false, partyKind = 'media', radioTrack = null } = {}) {
    if (!user) fail(401, 'party.sign_in', 'Sign in to start a watch party');
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(user.subject_id || ''))) fail(409, 'party.no_subject', 'This account has no OpenVibe subject yet; sign in again');
    const chosen = mediaOf(media);
    const source = sourceUrlOf(sourceUrl);
    const name = titleOf(title);
    const raw = secret();
    const roomName = (name.length < 3 ? `Party: ${name}` : name).slice(0, 40);
    const slug = `party-${crypto.randomBytes(4).toString('hex')}`;
    const room = await rooms.create(user, { name: roomName, slug, kind: 'party', visibility: 'private', topic: name, party: true });
    const id = room.id;
    await db.run(
        `INSERT INTO room_parties (room_id, agent_stream_id, vod_id, host_user_id, host_subject, mode, playing, listed, join_secret_hash, party_kind, media, source_url, radio_track)
         VALUES (?, NULL, NULL, ?, ?, 'vod', false, ?, ?, ?, ?, ?, ?)`,
        [id, user.id, user.subject_id || '', !!listed, sha256(raw), partyKind, JSON.stringify(chosen), source, radioTrack ? JSON.stringify(radioTrack) : null]
    );
    const shared = { id, slug: room.slug };
    await syncClock.set(shared, user.subject_id, { media: chosen, position_ms: 0, rate: 1, paused: true });
    await controlLease.take(shared, user.subject_id, { watchers: [] });
    const row = await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
    const party = await db.get('SELECT * FROM room_parties WHERE room_id = ?', [id]);
    return { party: view(row, party, { rawSecret: raw }), roomId: id, join_secret: raw };
}

async function bySlug(slug) {
    const row = await db.get('SELECT r.*, p.room_id AS party_room_id, p.agent_stream_id, p.vod_id, p.host_user_id, p.host_subject, p.mode, p.position_s, p.playing, p.position_at, p.listed, p.join_secret_hash, p.ended_at, p.created_at AS party_created_at, p.party_kind, p.media, p.source_url, p.radio_track, p.music_state, p.music_version, p.desktop_hosting, p.desktop_state, p.desktop_layout, p.desktop_node_id, p.desktop_share_id, p.desktop_share_url FROM rooms r JOIN room_parties p ON p.room_id = r.id WHERE r.slug = ?', [String(slug || '').toLowerCase()]);
    return row || null;
}

function partyOf(row) {
    return row && row.party_room_id ? {
        room_id: row.party_room_id, agent_stream_id: row.agent_stream_id, vod_id: row.vod_id,
        host_user_id: row.host_user_id, host_subject: row.host_subject, mode: row.mode,
        position_s: row.position_s, playing: row.playing, position_at: row.position_at, listed: row.listed,
        join_secret_hash: row.join_secret_hash, ended_at: row.ended_at, created_at: row.party_created_at,
        party_kind: row.party_kind || 'agent_stream', media: row.media, source_url: row.source_url, radio_track: row.radio_track,
        music_state: row.music_state, music_version: row.music_version,
        desktop_hosting: row.desktop_hosting, desktop_state: row.desktop_state, desktop_layout: row.desktop_layout, desktop_node_id: row.desktop_node_id,
        desktop_share_id: row.desktop_share_id, desktop_share_url: row.desktop_share_url,
    } : null;
}

function keyMatches(party, key) {
    if (!key || !party || !party.join_secret_hash) return false;
    const a = Buffer.from(sha256(key));
    const b = Buffer.from(String(party.join_secret_hash));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The media parties a person is in that have not ended (started in the last two weeks), newest first: the party home's
 * "Your parties", so a person gets back into a party without its link. Membership is what lets them in (rooms.access).
 */
async function mine(user, { limit = 6 } = {}) {
    if (!user || !user.id) return [];
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    const rows = await db.all(`SELECT r.slug, r.name, p.host_user_id, p.created_at
        FROM room_members m JOIN rooms r ON r.id = m.room_id JOIN room_parties p ON p.room_id = r.id
        WHERE m.user_id = ? AND p.party_kind IN ('media', 'radio', 'desktop') AND p.ended_at IS NULL AND r.archived_at IS NULL AND p.created_at > ?
        ORDER BY p.created_at DESC LIMIT ?`, [user.id, since, Math.max(1, Math.min(12, Number(limit) || 6))]);
    return (rows || []).map((x) => ({
        id: x.slug, title: x.name, hosting: Number(x.host_user_id) === Number(user.id),
        started_at: new Date(x.created_at instanceof Date ? x.created_at : String(x.created_at)).toISOString(),
    }));
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
    if (kindOfParty(party) === 'media' || kindOfParty(party) === 'radio') fail(409, 'party.clock', 'A media party follows the room\'s shared clock; the remote moves it');
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
    await db.run("UPDATE room_parties SET ended_at = now(), playing = false, music_state = NULL, music_version = music_version + 1, desktop_state = CASE WHEN party_kind = 'desktop' THEN 'stopped' ELSE desktop_state END WHERE room_id = ? AND ended_at IS NULL", [party.room_id]);
    if (party.party_kind === 'desktop') await pool.releaseRoom(party.room_id, 'ended');
    const fresh = await bySlug(row.slug);
    return view(fresh, partyOf(fresh), { where: await pool.where(party.room_id) });
}

async function setDesktopLayout(row, party, user, layout) {
    if (!row || !party || party.party_kind !== 'desktop' || party.ended_at) fail(404, 'rooms.not_found', 'No such room');
    if (!user || user.subject_id !== party.host_subject) fail(403, 'party.not_host', 'Only the host changes the party layout');
    if (layout !== 'watch' && layout !== 'listen') fail(422, 'party.layout', 'Choose Watch or Listen');
    await db.run('UPDATE room_parties SET desktop_layout = ? WHERE room_id = ? AND ended_at IS NULL', [layout, party.room_id]);
    const fresh = await bySlug(row.slug);
    return view(fresh, partyOf(fresh), { where: await pool.where(party.room_id) });
}

module.exports = {
    AGENT_STREAM_RE, MAX_TITLE, PartyError,
    create, createMedia, createDesktop, createAgentStream, bySlug, partyOf, view, detail, syncOf, mayView, joinWithLink, setSync, setDesktopLayout, count, end, keyMatches, mine,
};
