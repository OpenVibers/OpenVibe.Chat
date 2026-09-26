/**
 * OpenVibe.Chat — the ONE adapter to OpenVibe.Live.
 *
 * Every piece of data Chat does not own (accounts and roles, streams and live state, channels,
 * channel moderation policy, bans and IP rules, follows, cosmetics and tags, site settings,
 * anon numbers) and every side effect chat triggers in Live (coins, AI viewers, arena, media
 * queue, hardware, pastes, translation, PowerChat, notifications, viewer counts, IP log) goes
 * through this module. Nothing else in Chat talks to Live.
 *
 * Transport: Live's internal endpoints, service token from OpenVibe.Network for audience
 * openvibe.live —
 *     GET/POST /internal/chat-context/*   capability live.chat_context.read
 *     POST     /internal/chat-effects/*   capability live.chat_effects.write
 *     POST     /internal/chat-effects/mirror  capability live.chat_mirror.write (bridge/live-mirror.js)
 *
 * Hot path rule: nothing a chat message touches makes a network call. Reads are answered from
 *   - SQLite projections (ctx_users, ctx_streams, ctx_managed_streams, ctx_channels), kept
 *     complete by paged syncs and fetched on a miss, so history SQL can join them; and
 *   - in-memory caches with a TTL that serve a stale value while refreshing in the background
 *     (channel policy, bans, follows, decor, IP approvals, settings, anon numbers).
 * warm() — awaited when a socket connects or joins a room — fills everything that socket's
 * messages will read. Explicit invalidation: invalidateUser/invalidateChannel/invalidateBans,
 * called after Chat's own effects and when Live pushes a change over the bridge.
 *
 * ── Interface ───────────────────────────────────────────────────────────────────────────────
 * lifecycle      start(), stop(), sync()                         (sync = one full projection pass)
 * identity       authenticate(token) → user|null                 (cached per token ≤60s)
 *                upsertUser(row), invalidateUser(id), subjectFor(id)
 * users          getUserById, getUserByUsername, getUserByDisplayName (sync, projection)
 *                ensureUsers(ids), ensureUserByUsername(name)    (async, fetch misses)
 * streams        getStreamById, latestStreamIdForUser, getLiveStreamsByUserId,
 *                getStreamsByUserId, getManagedStreamsByUserId   (sync) · ensureStream(id),
 *                refreshStream(id) (a fresh read past the cache)
 * channels       getChannelById, getChannelByUserId (sync) · ensureChannelForUser(uid),
 *                createChannel(uid) (effect)
 * policy         getChannelModerationSettings(channelId), isChannelModerator(uid, channelId),
 *                channelLanguage(channelUserId), getChannelAlertSoundsByUser(uid) · invalidateChannel,
 *                reloadPolicy(channelId) (a fresh read after a write), onChannelSettings(fn)
 *                (fn(channelId, settings) whenever a channel's settings are read anew)
 * bans           isUserBanned(uid, streamId), getIpBan(ip, streamId), isIpBanned(ip, streamId)
 * follows        isFollowing(followerId, streamerId)
 * subscriptions  isSubscriber(uid, streamerId), subscriberState(…) → true | false | null (unknown),
 *                ensureSubscriber(…) (sub-only chat; Live's active channel subscriptions)
 * approvals      isIpApproved(channelId, ip), approveIp(channelId, ip, by, source) (effect)
 * decor          getCosmeticProfile(uid), getTagProfile(uid), ensureDecor(ids)
 * settings       getSetting(key), ensureSettings(), setSettings(map, actor) (effect)
 * anon           resolveAnon(ip) → { num, first_seen }, getAnonFirstSeen(ip), anonFirstSeenByNum(num)
 * warm-up        warm({ user, streamId, channelUserId, ip })
 * effects        effects.* — see the list at the bottom of this file
 */
'use strict';

const crypto = require('crypto');
const net = require('net');
const config = require('./config');
const db = require('./db/database');
const serviceAuth = require('./net/service-auth');

const SCOPE_READ = 'live.chat_context.read';
const SCOPE_WRITE = 'live.chat_effects.write';

const TTL = {
    auth: 60_000,
    authNegative: 10_000,
    policy: 15_000,
    follows: 60_000,
    decor: 60_000,
    approval: 60_000,
    settings: 30_000,
    bans: 10_000,
    streamRow: 30_000,
    subs: 60_000,
};
// A subscription answer older than this is not used at all (sub-only fails closed while Live is away).
const SUB_MAX_STALE_MS = 10 * 60_000;
const WARM_TIMEOUT_MS = 2500;
const PAGE = 1000;

// Arena commands are Live's (server/arena/arena-chat.js); Chat only routes them there.
const ARENA_COMMANDS = ['!hype', '!beef', '!arena'];

// Channel moderation defaults — Live's getChannelModerationSettings() fallback row, verbatim.
function defaultModerationSettings(channelId) {
    return {
        channel_id: channelId,
        slow_mode_seconds: 0,
        followers_only: 0,
        emote_only: 0,
        allow_anonymous: 1,
        links_allowed: 1,
        gifs_enabled: 1,
        account_age_gate_hours: 0,
        caps_percentage_limit: 0,
        aggressive_filter: 0,
        max_message_length: 500,
        tts_max_length: 200,
        slur_filter_enabled: 0,
        slur_filter_use_builtin: 1,
        slur_filter_terms: '',
        slur_filter_regexes: '',
        slur_filter_nudge_message: '',
        slur_filter_disabled_categories: '[]',
        ip_approval_mode: 0,
        soundboard_enabled: 1,
        soundboard_allow_pitch: 1,
        soundboard_allow_speed: 1,
        soundboard_banned_ids: '',
        viewer_auto_delete_enabled: 1,
        viewer_delete_all_enabled: 1,
        custom_emotes_enabled: 1,
        custom_sounds_enabled: 1,
        max_sound_seconds: 10,
        uploads_mods_only: 0,
        mods_can_edit_about: 0,
        emote_scale: 100,
        emote_size_min: 50,
        emote_size_max: 200,
        sounds_mods_only: 0,
        sound_min_speed: 0.5,
        sound_max_speed: 3.0,
        sound_min_pitch_cents: -1200,
        sound_max_pitch_cents: 1200,
        sub_only: 0,
    };
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────

let _fetch = (...a) => globalThis.fetch(...a);
// lastSyncAt: the last sync pass, whatever its outcome. lastSuccessAt: the last pass in which every
// projection it ran came back from Live (what /ready judges freshness by).
const stats = { reads: 0, effects: 0, failures: 0, lastError: null, lastSyncAt: null, lastSuccessAt: null };

class LiveError extends Error {
    constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function call(method, path, body, scope, retried = false) {
    const url = `${config.live.internalUrl}${path}`;
    let res;
    try {
        res = await _fetch(url, {
            method,
            headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(await serviceAuth.headers(config.live.audience, scope)) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(config.live.requestTimeoutMs),
        });
    } catch (err) {
        stats.failures++; stats.lastError = err.message;
        throw new LiveError(0, `Live unreachable: ${err.message}`);
    }
    if (res.status === 401 && !retried) { serviceAuth.invalidate(config.live.audience, scope); return call(method, path, body, scope, true); }
    if (res.status === 304) return { notModified: true };
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        stats.failures++; stats.lastError = `${res.status} ${path}`;
        throw new LiveError(res.status, (data && (data.error || data.detail)) || `Live ${res.status}`, data);
    }
    return data;
}
const read = (path, body) => { stats.reads++; return call(body === undefined ? 'GET' : 'POST', `/internal/chat-context${path}`, body, SCOPE_READ); };
const effect = (name, body) => { stats.effects++; return call('POST', `/internal/chat-effects/${name}`, body || {}, SCOPE_WRITE); };
/** Fire-and-forget effect: logged, never thrown. */
function fire(name, body) { effect(name, body).catch((err) => console.warn(`[LiveContext] ${name}: ${err.message}`)); }

// ── TTL cache with stale-while-revalidate ─────────────────────────────────────────────────────

class Swr {
    constructor(ttl, loader, { max = 20000 } = {}) { this.ttl = ttl; this.loader = loader; this.max = max; this.map = new Map(); this.inflight = new Map(); }
    /** The cached value (possibly stale; a stale one triggers a background refresh), or undefined. */
    peek(key) {
        const hit = this.map.get(key);
        if (!hit) { this.refresh(key).catch(() => {}); return undefined; }
        if (Date.now() - hit.at > this.ttl) this.refresh(key).catch(() => {});
        return hit.value;
    }
    /** Resolves once a fresh value is cached (or the load failed — then the old value stays). */
    async ensure(key) {
        const hit = this.map.get(key);
        if (hit && Date.now() - hit.at <= this.ttl) return hit.value;
        try { return await this.refresh(key); } catch { return hit ? hit.value : undefined; }
    }
    refresh(key) {
        if (this.inflight.has(key)) return this.inflight.get(key);
        const p = Promise.resolve().then(() => this.loader(key)).then((value) => { this.set(key, value); return value; })
            .finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        return p;
    }
    set(key, value) {
        this.map.set(key, { value, at: Date.now() });
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    /** Mark stale and reload in the background; the old value keeps answering until then (no gap). */
    invalidate(key) {
        const hit = this.map.get(key);
        if (!hit) return;
        hit.at = 0;
        this.refresh(key).catch(() => {});
    }
    delete(key) { this.map.delete(key); }
    clear() { this.map.clear(); }
}

// ── Projections (SQLite) ────────────────────────────────────────────────────────────────────

const USER_COLS = ['id', 'username', 'display_name', 'avatar_url', 'profile_color', 'role', 'is_banned', 'ban_reason', 'is_owner', 'created_at', 'subject_id'];
const STREAM_COLS = ['id', 'user_id', 'channel_id', 'managed_stream_id', 'title', 'is_live', 'started_at', 'ended_at', 'created_at'];
const MS_COLS = ['id', 'user_id', 'slug', 'title', 'sort_order', 'created_at'];
const CHANNEL_COLS = ['id', 'user_id', 'title'];

function upsertRows(table, cols, rows) {
    if (!rows || !rows.length) return 0;
    const sql = `INSERT INTO ${table} (${cols.join(', ')}, synced_at) VALUES (${cols.map(() => '?').join(', ')}, ?)
        ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}, synced_at = excluded.synced_at`;
    const st = db.getDb().prepare(sql);
    const now = Date.now();
    db.transaction(() => {
        for (const r of rows) {
            if (!r || r.id == null) continue;
            st.run(...cols.map((c) => (r[c] === undefined ? null : (typeof r[c] === 'boolean' ? (r[c] ? 1 : 0) : r[c]))), now);
        }
    });
    return rows.length;
}

/** Store a user as Live sent it (only the projection columns are kept). */
function upsertUser(row) {
    if (!row || row.id == null) return;
    upsertRows('ctx_users', USER_COLS, [row]);
}

const userSelect = 'SELECT * FROM ctx_users';
function getUserById(id) { if (!id) return null; const u = db.get(`${userSelect} WHERE id = ?`, [id]) || null; if (!u) ensureUsers([id]).catch(() => {}); return u; }
function getUserByUsername(name) { return name ? (db.get(`${userSelect} WHERE username = ? COLLATE NOCASE`, [String(name)]) || null) : null; }
function getUserByDisplayName(name) { return name ? (db.get(`${userSelect} WHERE display_name = ? COLLATE NOCASE`, [String(name)]) || null) : null; }
function subjectFor(userId) { return db.subjectFor(userId); }

/** Fetch users the projection lacks. */
async function ensureUsers(ids) {
    const want = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const missing = want.filter((id) => !db.get('SELECT 1 FROM ctx_users WHERE id = ?', [id]));
    if (!missing.length) return 0;
    const data = await read('/users/lookup', { ids: missing.slice(0, 500) });
    return upsertRows('ctx_users', USER_COLS, data.users || []);
}
/** Look a user up by login (then display name) in the projection, asking Live on a miss. */
async function ensureUserByUsername(name) {
    const local = getUserByUsername(name);
    if (local) return local;
    try {
        const data = await read('/users/lookup', { usernames: [String(name)] });
        upsertRows('ctx_users', USER_COLS, data.users || []);
    } catch (err) { console.warn('[LiveContext] user lookup:', err.message); }
    return getUserByUsername(name);
}

const STREAM_SELECT = `SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
        ms.slug AS managed_stream_slug, ms.title AS managed_stream_title
    FROM ctx_streams s
    LEFT JOIN ctx_users u ON s.user_id = u.id
    LEFT JOIN ctx_managed_streams ms ON s.managed_stream_id = ms.id`;

function getStreamById(id) {
    const sid = parseInt(id, 10);
    if (!sid) return null;
    const row = db.get(`${STREAM_SELECT} WHERE s.id = ?`, [sid]) || null;
    if (!row) ensureStream(sid).catch(() => {});
    return row;
}
const _streamFetch = new Swr(TTL.streamRow, async (sid) => {
    const data = await read(`/streams/${sid}`);
    if (data.stream) {
        upsertRows('ctx_streams', STREAM_COLS, [data.stream]);
        if (data.owner) upsertUser(data.owner);
        if (data.managed_stream) upsertRows('ctx_managed_streams', MS_COLS, [data.managed_stream]);
        if (data.channel) upsertRows('ctx_channels', CHANNEL_COLS, [data.channel]);
    }
    return !!data.stream;
});
/** Make sure a stream (and its owner, slot and channel) is in the projection. */
async function ensureStream(id) {
    const sid = parseInt(id, 10);
    if (!sid) return null;
    if (!db.get('SELECT 1 FROM ctx_streams WHERE id = ?', [sid])) await _streamFetch.ensure(sid);
    return db.get(`${STREAM_SELECT} WHERE s.id = ?`, [sid]) || null;
}
/**
 * Read one stream from Live now, past the cache (a call hook or an ownership check wants its live
 * state this moment, not up to 10 s old). Falls back to the projection when Live does not answer.
 */
async function refreshStream(id) {
    const sid = parseInt(id, 10);
    if (!sid) return null;
    try { await _streamFetch.refresh(sid); } catch (err) { console.warn(`[LiveContext] stream ${sid}: ${err.message}`); }
    return db.get(`${STREAM_SELECT} WHERE s.id = ?`, [sid]) || null;
}
function latestStreamIdForUser(userId) {
    if (!userId) return null;
    return db.get('SELECT id FROM ctx_streams WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId])?.id || null;
}
function getLiveStreamsByUserId(userId) {
    return db.all(`${STREAM_SELECT} WHERE s.user_id = ? AND s.is_live = 1 ORDER BY s.started_at DESC`, [userId]);
}
function getStreamsByUserId(userId, limit = 50) {
    return db.all(`${STREAM_SELECT} WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ?`, [userId, limit]);
}
function getManagedStreamsByUserId(userId) {
    return db.all(`
        SELECT ms.*,
               (SELECT s.is_live FROM ctx_streams s WHERE s.managed_stream_id = ms.id AND s.is_live = 1 LIMIT 1) AS is_currently_live,
               (SELECT s.id FROM ctx_streams s WHERE s.managed_stream_id = ms.id AND s.is_live = 1 LIMIT 1) AS live_session_id
        FROM ctx_managed_streams ms
        WHERE ms.user_id = ?
        ORDER BY ms.sort_order ASC, ms.created_at ASC`, [userId]);
}

function getChannelById(id) { return id ? (db.get('SELECT * FROM ctx_channels WHERE id = ?', [id]) || null) : null; }
function getChannelByUserId(userId) { return userId ? (db.get('SELECT * FROM ctx_channels WHERE user_id = ?', [userId]) || null) : null; }
/** The channel row of a user, asking Live when the projection lacks it (null = the user has none). */
async function ensureChannelForUser(userId) {
    const local = getChannelByUserId(userId);
    if (local || !userId) return local;
    try {
        const data = await read(`/channels/by-user/${parseInt(userId, 10)}`);
        if (data.channel) upsertRows('ctx_channels', CHANNEL_COLS, [data.channel]);
    } catch (err) { console.warn('[LiveContext] channel lookup:', err.message); }
    return getChannelByUserId(userId);
}
/** Live's ensureChannel(userId): create the channel if the user has none (effect). */
async function createChannel(userId) {
    const data = await effect('ensure-channel', { user_id: userId });
    if (data.channel) upsertRows('ctx_channels', CHANNEL_COLS, [data.channel]);
    return getChannelByUserId(userId);
}

// ── Channel policy: moderation settings, moderators, language, alert sounds ──────────────────

// Everyone who wants to know when a channel's settings were read anew (the chat server announces a
// slow mode or sub-only mode the dashboard changed). Called with every fresh read; the listener
// compares with what it last saw.
const _settingsListeners = new Set();
function onChannelSettings(fn) { _settingsListeners.add(fn); return () => _settingsListeners.delete(fn); }
function _emitSettings(channelId, settings) {
    for (const fn of _settingsListeners) {
        try { fn(Number(channelId), settings || defaultModerationSettings(channelId)); } catch (err) { console.warn('[LiveContext] channel settings listener:', err.message); }
    }
}

const _policy = new Swr(TTL.policy, async (channelId) => {
    const data = await read(`/channels/${channelId}/policy`);
    if (data.channel) upsertRows('ctx_channels', CHANNEL_COLS, [data.channel]);
    // While Chat writes the settings itself, Live's copy is a mirror that may lag: not announced.
    if (!_chatWrites('channel_moderation_settings')) _emitSettings(channelId, data.settings || defaultModerationSettings(channelId));
    return {
        settings: data.settings || null,
        moderators: new Set((data.moderator_ids || []).map(Number)),
        language: data.language || 'en',
    };
});
function _policyFor(channelId) { return channelId ? _policy.peek(Number(channelId)) : undefined; }
// Once Chat writes a staged table (table_authority 'chat', roadmap C-04) its rows here are the truth:
// read in place, like Live's own readers (an indexed row, no network, no cache to go stale).
const _chatWrites = (table) => db.tableAuthority(table) === 'chat';
function getChannelModerationSettings(channelId) {
    if (_chatWrites('channel_moderation_settings')) {
        return (channelId && db.get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [Number(channelId)])) || defaultModerationSettings(channelId);
    }
    const p = _policyFor(channelId);
    return (p && p.settings) || defaultModerationSettings(channelId);
}
function isChannelModerator(userId, channelId) {
    if (_chatWrites('channel_moderators')) {
        return !!(userId && channelId && db.get('SELECT 1 FROM channel_moderators WHERE user_id = ? AND channel_id = ?', [Number(userId), Number(channelId)]));
    }
    const p = _policyFor(channelId);
    return !!(p && p.moderators.has(Number(userId)));
}
function channelLanguage(channelUserId) {
    const ch = getChannelByUserId(channelUserId);
    if (!ch) return 'en';
    const p = _policyFor(ch.id);
    return (p && p.language) || 'en';
}
function getChannelAlertSoundsByUser(userId) {
    const ch = getChannelByUserId(userId);
    if (!ch) return {};
    const s = getChannelModerationSettings(ch.id);
    const pick = { donation_sound_url: s.donation_sound_url || null, donation_sound_mime: s.donation_sound_mime || null, goal_sound_url: s.goal_sound_url || null, goal_sound_mime: s.goal_sound_mime || null };
    return pick;
}
function ensurePolicy(channelId) { return channelId ? _policy.ensure(Number(channelId)) : Promise.resolve(); }
function invalidateChannel(channelId) {
    if (!channelId) return;
    _policy.invalidate(Number(channelId));
    if (_chatWrites('channel_moderation_settings')) _emitSettings(channelId, getChannelModerationSettings(channelId));
}
/**
 * A fresh policy read that starts after the call (Chat just had Live write a setting): a load already
 * in flight may have left before the write, so it is waited for and followed by another.
 */
function reloadPolicy(channelId) {
    const k = Number(channelId);
    if (!k) return Promise.resolve();
    const inflight = _policy.inflight.get(k);
    return (inflight ? inflight.catch(() => {}) : Promise.resolve()).then(() => _policy.refresh(k));
}

// ── Bans (Live's `bans`: user, IP and CIDR rows) ────────────────────────────────────────────

let _bans = { rows: [], version: null, at: 0, cidr: [] };
let _bansLoading = null;

// A ban ends at expires_at, read as a UTC instant: /timeout stores an ISO string ('…T…Z'), other
// writers SQLite's 'YYYY-MM-DD HH:MM:SS'. Live compares the TEXT with CURRENT_TIMESTAMP, where
// 'T' sorts after ' ', so a 60-second timeout lasted until the end of that UTC day; Chat, which
// enforces chat bans, ends it on time (parity script, roadmap WS-I task 6). A value that is not a
// date keeps Live's TEXT comparison.
function sqliteNow() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
const BAN_END_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;
function banEndsAt(v) {
    const m = BAN_END_RE.exec(String(v).trim());
    return m ? Date.parse(`${m[1]}T${m[2]}${m[3] || 'Z'}`) : NaN;
}
function activeBan(r, nowMs) {
    if (r.expires_at == null) return true;
    const end = banEndsAt(r.expires_at);
    return Number.isFinite(end) ? end > nowMs : String(r.expires_at) > sqliteNow();
}

function _normalizeBanIp(ip) {
    let s = String(ip || '').trim();
    if (!s) return '';
    if (s === '::1') return '127.0.0.1';
    if (s.startsWith('::ffff:')) s = s.slice(7);
    return s;
}

async function refreshBans() {
    if (_bansLoading) return _bansLoading;
    _bansLoading = (async () => {
        try {
            const data = await read(`/bans${_bans.version ? `?version=${encodeURIComponent(_bans.version)}` : ''}`);
            if (data && !data.notModified && !data.unchanged) {
                const rows = data.bans || [];
                const cidr = [];
                for (const r of rows) {
                    if (!r.ip_address || !String(r.ip_address).includes('/')) continue;
                    const [addr, bitsStr] = String(r.ip_address).split('/');
                    const fam = net.isIP(addr), bits = parseInt(bitsStr, 10);
                    if (!fam || !Number.isFinite(bits)) continue;
                    const bl = new net.BlockList();
                    try { bl.addSubnet(addr, bits, fam === 6 ? 'ipv6' : 'ipv4'); } catch { continue; }
                    cidr.push({ bl, fam, row: r });
                }
                _bans = { rows, version: data.version || null, at: Date.now(), cidr };
            } else {
                _bans.at = Date.now();
            }
        } catch (err) {
            console.warn('[LiveContext] bans refresh:', err.message);
        } finally { _bansLoading = null; }
    })();
    return _bansLoading;
}
function _bansFresh() { if (Date.now() - _bans.at > TTL.bans) refreshBans().catch(() => {}); return _bans; }
// A fresh read that starts after the call: a load already in flight may have left before a ban
// was written, so it is waited for and followed by another.
function invalidateBans() {
    const reload = () => { _bans.version = null; _bans.at = 0; return refreshBans(); };
    return _bansLoading ? _bansLoading.then(reload) : reload();
}

function isUserBanned(userId, streamId) {
    if (!userId) return false;
    const now = Date.now();
    return _bansFresh().rows.some((r) => r.user_id != null && Number(r.user_id) === Number(userId)
        && (r.stream_id == null || Number(r.stream_id) === Number(streamId)) && activeBan(r, now));
}
/** The active site-wide (or this stream's) ban row for an IP, or null — Live's getIpBan(). */
function getIpBan(ip, streamId) {
    const norm = _normalizeBanIp(ip);
    if (!norm) return null;
    const now = Date.now();
    const b = _bansFresh();
    const exact = b.rows.find((r) => r.ip_address != null && (r.ip_address === String(ip) || r.ip_address === norm)
        && (r.stream_id == null || Number(r.stream_id) === Number(streamId)) && activeBan(r, now));
    if (exact) return exact;
    const fam = net.isIP(norm);
    if (!fam) return null;
    for (const e of b.cidr) {
        if (e.fam !== fam || !activeBan(e.row, now)) continue;
        if (e.row.stream_id !== null && e.row.stream_id !== undefined && e.row.stream_id !== streamId) continue;
        if (e.bl.check(norm, fam === 6 ? 'ipv6' : 'ipv4')) return e.row;
    }
    return null;
}
function isIpBanned(ip, streamId) { return !!getIpBan(ip, streamId); }

// ── Follows, IP approvals, decor ──────────────────────────────────────────────────────────────

const _follows = new Swr(TTL.follows, async (userId) => new Set(((await read(`/users/${userId}/follows`)).streamer_ids || []).map(Number)));
function isFollowing(followerId, streamerId) {
    const s = followerId ? _follows.peek(Number(followerId)) : undefined;
    return !!(s && s.has(Number(streamerId)));
}

// Sub-only chat: does this person hold an ACTIVE subscription to the streamer's channel (Live's
// subscriptions, GET /subscriber)? Network VIP does not count. Cached per (user, streamer) for a
// minute; an answer older than SUB_MAX_STALE_MS, or none yet, is unknown (null), which sub-only
// treats as "no": it fails closed when Live cannot be asked.
const subKey = (userId, streamerId) => `${Number(userId)}|${Number(streamerId)}`;
const _subs = new Swr(TTL.subs, async (key) => {
    const [userId, streamerId] = key.split('|');
    return !!(await read(`/subscriber?user_id=${userId}&streamer_id=${streamerId}`)).subscriber;
});
function subscriberState(userId, streamerId) {
    if (!userId || !streamerId) return false;
    const key = subKey(userId, streamerId);
    const hit = _subs.map.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (age > TTL.subs) _subs.refresh(key).catch(() => {});
    return age > SUB_MAX_STALE_MS ? null : hit.value;
}
function isSubscriber(userId, streamerId) { return subscriberState(userId, streamerId) === true; }
/** Ask Live when the cached answer is missing or older than `maxAgeMs`; waits at most `timeoutMs`. → true | false | null */
async function ensureSubscriber(userId, streamerId, { maxAgeMs = TTL.subs, timeoutMs = 2000 } = {}) {
    if (!userId || !streamerId) return false;
    const key = subKey(userId, streamerId);
    const hit = _subs.map.get(key);
    if (hit && Date.now() - hit.at <= maxAgeMs) return hit.value;
    let timer;
    await Promise.race([
        _subs.refresh(key).catch((err) => console.warn(`[LiveContext] subscriber ${key}: ${err.message}`)),
        new Promise((r) => { timer = setTimeout(r, timeoutMs); if (timer.unref) timer.unref(); }),
    ]);
    clearTimeout(timer);
    return subscriberState(userId, streamerId);
}

const _approvals = new Swr(TTL.approval, async (key) => {
    const [channelId, ip] = key.split('|');
    return !!(await read(`/channels/${channelId}/approved-ip?ip=${encodeURIComponent(ip)}`)).approved;
});
function isIpApproved(channelId, ip) { return !!_approvals.peek(`${channelId}|${ip}`); }
/** A channel's IP approvals changed in Live (review queue, revoke): reload the ones we hold. */
function invalidateApprovals(channelId) {
    for (const key of [..._approvals.map.keys()]) if (key.startsWith(`${channelId}|`)) _approvals.invalidate(key);
}
/** Live's approveIp (approved_ips): recorded here at once, written in Live in the background. */
function approveIp(channelId, ip, approvedBy = null, source = 'auto') {
    _approvals.set(`${channelId}|${ip}`, true);
    fire('approve-ip', { channel_id: channelId, ip, approved_by: approvedBy, source });
}

const _decor = new Swr(TTL.decor, async (userId) => {
    const data = await read('/decor', { user_ids: [userId] });
    return (data.decor || {})[userId] || { cosmetic: {}, tag: null };
});
async function ensureDecor(ids) {
    const want = [...new Set((ids || []).map(Number).filter(Boolean))];
    const stale = want.filter((id) => { const h = _decor.map.get(id); return !h || Date.now() - h.at > TTL.decor; });
    for (let i = 0; i < stale.length; i += 200) {
        const chunk = stale.slice(i, i + 200);
        try {
            const data = await read('/decor', { user_ids: chunk });
            for (const id of chunk) _decor.set(id, (data.decor || {})[id] || { cosmetic: {}, tag: null });
        } catch (err) { console.warn('[LiveContext] decor:', err.message); break; }
    }
}
/** cosmetics.getCosmeticProfile(userId): { nameFX, particleFX, hatFX, voiceFX } (empty until warm). */
function getCosmeticProfile(userId) { const d = _decor.peek(Number(userId)); return (d && d.cosmetic) || {}; }
/** tags.getTagProfile(userId): the equipped tag or null. */
function getTagProfile(userId) { const d = _decor.peek(Number(userId)); return (d && d.tag) || null; }

// ── Site settings (allow-listed keys Live shares with Chat) ───────────────────────────────────

let _settings = { values: {}, at: 0 };
let _settingsLoading = null;
function ensureSettings(force = false) {
    if (!force && Date.now() - _settings.at <= TTL.settings) return Promise.resolve(_settings.values);
    if (_settingsLoading) return _settingsLoading;
    _settingsLoading = read('/settings').then((data) => { _settings = { values: data.settings || {}, at: Date.now() }; return _settings.values; })
        .catch((err) => { console.warn('[LiveContext] settings:', err.message); return _settings.values; })
        .finally(() => { _settingsLoading = null; });
    return _settingsLoading;
}
/** Live's db.getSetting(key) for the keys chat reads (tts_*, gif_*_api_key, soundboard_101_api_key). */
function getSetting(key) {
    if (Date.now() - _settings.at > TTL.settings) ensureSettings().catch(() => {});
    const v = _settings.values[key];
    return v === undefined ? null : v;
}
/** Write site settings (TTS admin). Live re-checks the actor (admin; owner for secrets). */
async function setSettings(values, actorUserId) {
    const data = await effect('site-settings', { settings: values, actor_user_id: actorUserId });
    await ensureSettings(true);
    return data;
}

// ── Anonymous numbers (Live allocates: Network's unified resolve, else its local table) ──────

const _anon = new Map();     // ip → { num, first_seen }
const _anonPending = new Map();
function _tempAnonNum(ip) {
    // Live unreachable: a stable per-address number far above the sequential range, not cached,
    // so the next connection asks Live again.
    const h = crypto.createHash('sha256').update(String(ip)).digest();
    return 900000000 + (h.readUInt32BE(0) % 99999999);
}
async function resolveAnon(ip) {
    if (_anon.has(ip)) return _anon.get(ip);
    if (_anonPending.has(ip)) return _anonPending.get(ip);
    const p = effect('anon', { ip }).then((data) => {
        const v = { num: Number(data.anon_number), first_seen: data.first_seen || null };
        _anon.set(ip, v);
        if (_anon.size > 100000) _anon.delete(_anon.keys().next().value);
        return v;
    }).catch((err) => {
        console.warn(`[LiveContext] anon resolve failed for ${ip}: ${err.message}`);
        return { num: _tempAnonNum(ip), first_seen: null, temporary: true };
    }).finally(() => _anonPending.delete(ip));
    _anonPending.set(ip, p);
    return p;
}
function peekAnon(ip) { return _anon.get(ip) || null; }
// When an address first got an anon number, without allocating one (signed-in viewers).
const _anonSeen = new Swr(10 * 60_000, async (ip) => (await read(`/anon-first-seen?ip=${encodeURIComponent(ip)}`)).first_seen || null);
function getAnonFirstSeen(ip) {
    const known = _anon.get(ip);
    if (known) return known.first_seen || null;
    return _anonSeen.peek(ip) || null;
}
function ensureAnonFirstSeen(ip) { return ip ? _anonSeen.ensure(ip).catch(() => null) : Promise.resolve(null); }

/** A TTS clip Live stashed (arena voice cache), as { body, mimeType }, or null. */
async function fetchTtsAudio(file) {
    try {
        const res = await _fetch(`${config.live.internalUrl}/internal/chat-context/tts-audio/${encodeURIComponent(file)}`, {
            headers: { ...(await serviceAuth.headers(config.live.audience, SCOPE_READ)) },
            signal: AbortSignal.timeout(config.live.requestTimeoutMs),
        });
        if (!res.ok) return null;
        return { body: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'audio/mpeg' };
    } catch { return null; }
}
async function anonFirstSeenByNum(num) {
    try { return (await read(`/anon/${parseInt(num, 10)}`)).first_seen || null; } catch { return null; }
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────

const _auth = new Map();     // sha256(token) → { user, until, stale_until }
const _authPending = new Map();
const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/**
 * Resolve a browser/bot token (Network JWT or hbt_ API token) to a Live user, the way Live's
 * authenticateWs/requireAuth do — Live verifies it, keeps its account links, and answers with
 * the user projection, its subject and (API tokens) scopes. Cached per token for up to 60s and
 * never past the token's own expiry. Returns a fresh object each call (callers mutate it).
 */
async function authenticate(token) {
    if (!token) return null;
    const key = tokenKey(token);
    const now = Date.now();
    const hit = _auth.get(key);
    if (hit && hit.until > now) return hit.user ? { ...hit.user } : null;
    if (_authPending.has(key)) return _authPending.get(key).then((u) => (u ? { ...u } : null));
    const p = read('/auth', { token }).then((data) => {
        const user = data && data.user ? data.user : null;
        if (user) upsertUser(user);
        const exp = data && data.expires_at ? Date.parse(data.expires_at) : null;
        const ttl = user ? TTL.auth : TTL.authNegative;
        const until = Math.min(now + ttl, exp && Number.isFinite(exp) ? exp : Infinity);
        _auth.set(key, { user, until, userId: user ? user.id : null, reason: (data && data.reason) || null });
        if (_auth.size > 50000) _auth.delete(_auth.keys().next().value);
        return user;
    }).catch((err) => {
        // Live down: a recently verified token keeps working for its remaining lifetime.
        console.warn('[LiveContext] auth:', err.message);
        return hit && hit.user ? hit.user : null;
    }).finally(() => _authPending.delete(key));
    _authPending.set(key, p);
    const user = await p;
    return user ? { ...user } : null;
}
/** Why the last resolution of this token failed: 'invalid' (bad/expired) or 'unresolved' (no account). */
function authFailureReason(token) {
    const hit = token ? _auth.get(tokenKey(token)) : null;
    return (hit && !hit.user && hit.reason) || 'invalid';
}

/** Forget everything cached about a user (Live pushed a change, or Chat changed them). */
function invalidateUser(userId) {
    const id = Number(userId);
    for (const [k, v] of _auth) if (v.userId === id) _auth.delete(k);
    _decor.invalidate(id);
    _follows.invalidate(id);
    for (const k of [..._subs.map.keys()]) if (k.startsWith(`${id}|`)) _subs.delete(k);
}

// ── Warm-up (connect / join) ─────────────────────────────────────────────────────────────────

/**
 * Fill every cache the socket's messages will read: its stream (owner, slot, channel), the
 * channel's policy, the viewer's follows/decor, the IP-approval answer when the channel gates
 * by IP, the channel's latest stream for offline-room moderation. Bounded: a slow Live delays a
 * join by at most WARM_TIMEOUT_MS; anything still loading lands in the caches afterwards.
 */
async function warm({ user, streamId, channelUserId, ip } = {}) {
    const job = (async () => {
        const stream = streamId ? await ensureStream(streamId) : null;
        const ownerId = (stream && stream.user_id) || channelUserId || null;
        const tasks = [ensureSettings()];
        let channel = stream && stream.channel_id ? getChannelById(stream.channel_id) : null;
        if (!channel && ownerId) channel = await ensureChannelForUser(ownerId);
        if (channel) tasks.push(ensurePolicy(channel.id));
        // Live's chat server asks canModerateChannel(user, channelUserId) — the channel OWNER's user
        // id where a channel id belongs — for the AI-viewer / PowerChat "is mod" flag. Kept as it
        // was; that lookup is warmed too so a message never waits on it.
        if (ownerId && (!channel || channel.id !== ownerId)) tasks.push(ensurePolicy(ownerId));
        if (user && user.id) { tasks.push(_follows.ensure(Number(user.id))); tasks.push(ensureDecor([user.id])); if (ip) tasks.push(ensureAnonFirstSeen(ip)); }
        await Promise.all(tasks.map((t) => Promise.resolve(t).catch(() => {})));
        const policy = channel ? _policyFor(channel.id) : null;
        if (policy && policy.settings && policy.settings.ip_approval_mode && ip) await _approvals.ensure(`${channel.id}|${ip}`).catch(() => {});
        // Sub-only room: the viewer's subscription answer, so their first line does not wait for it.
        if (channel && user && user.id && ownerId && Number(ownerId) !== Number(user.id) && getChannelModerationSettings(channel.id).sub_only) {
            await ensureSubscriber(user.id, ownerId).catch(() => {});
        }
    })();
    await Promise.race([job.catch(() => {}), new Promise((r) => setTimeout(r, WARM_TIMEOUT_MS).unref?.())]);
}

// ── Projection sync ─────────────────────────────────────────────────────────────────────────

async function syncTable(kind, table, cols, { full = false } = {}) {
    let after = full ? 0 : (db.get(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)?.m || 0);
    let total = 0;
    for (let pages = 0; pages < 10000; pages++) {
        const data = await read(`/${kind}?after_id=${after}&limit=${PAGE}`);
        const rows = data.rows || [];
        total += upsertRows(table, cols, rows);
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].id;
    }
    return total;
}
async function syncActiveStreams() {
    const data = await read('/streams/active');
    upsertRows('ctx_streams', STREAM_COLS, data.rows || []);
    // Streams that were live here but are not in Live's active list any more ended between
    // polls (and were not "recently ended" either): mark them offline.
    const liveNow = new Set((data.rows || []).filter((r) => r.is_live).map((r) => Number(r.id)));
    for (const r of db.all('SELECT id FROM ctx_streams WHERE is_live = 1')) {
        if (!liveNow.has(Number(r.id))) db.run('UPDATE ctx_streams SET is_live = 0 WHERE id = ?', [r.id]);
    }
}

const SCHEDULE = [
    // [name, every ms, fn]
    ['users+', 30_000, () => syncTable('users', 'ctx_users', USER_COLS)],
    ['users*', 15 * 60_000, () => syncTable('users', 'ctx_users', USER_COLS, { full: true })],
    ['streams+', 10_000, () => syncTable('streams', 'ctx_streams', STREAM_COLS)],
    ['streams~', 10_000, syncActiveStreams],
    ['streams*', 30 * 60_000, () => syncTable('streams', 'ctx_streams', STREAM_COLS, { full: true })],
    ['managed*', 5 * 60_000, () => syncTable('managed-streams', 'ctx_managed_streams', MS_COLS, { full: true })],
    ['channels*', 5 * 60_000, () => syncTable('channels', 'ctx_channels', CHANNEL_COLS, { full: true })],
    // refreshBans and ensureSettings keep the cached value on a Live error instead of throwing
    // (callers want the stale value); for the schedule a refresh that did not land is a failure.
    ['bans', TTL.bans, async () => { const t0 = Date.now(); await refreshBans(); if (_bans.at < t0) throw new Error('bans not refreshed'); }],
    ['settings', TTL.settings, async () => { const t0 = Date.now(); await ensureSettings(true); if (_settings.at < t0) throw new Error('settings not refreshed'); }],
];
const _lastRun = new Map();
const _lastOk = new Map();   // step name -> ms of its last success
let _since = null;           // ms the sync loop began (a step that never succeeded is late from here)
let _timer = null;
let _running = false;

/** Run one scheduled step; true when it succeeded. */
async function runStep(name, fn, label) {
    try { await fn(); _lastOk.set(name, Date.now()); return true; } catch (err) { console.warn(`[LiveContext] ${label} ${name}: ${err.message}`); return false; }
}
function endPass(ran, failed) {
    stats.lastSyncAt = new Date().toISOString();
    if (ran && !failed) stats.lastSuccessAt = stats.lastSyncAt;
}

/**
 * How current the projections are, for /ready: the last clean pass and its age, and the steps
 * that have not succeeded for longer than their own interval plus `staleMs` (a step that fails
 * on every run of its own — say the 5-minute channel sync — never spoils a whole pass for long,
 * because the 10-second steps pass in between, so it is judged on its own).
 */
function syncStatus(staleMs, now = Date.now()) {
    const lastOk = stats.lastSuccessAt ? Date.parse(stats.lastSuccessAt) : null;
    const late = [];
    if (_since !== null) {
        for (const [name, every] of SCHEDULE) {
            const at = _lastOk.get(name) || _since;
            if (now - at > every + staleMs) late.push(name);
        }
    }
    return { last_success_at: stats.lastSuccessAt, age_ms: lastOk === null ? null : now - lastOk, late_steps: late };
}

async function tick() {
    if (_running) return;
    _running = true;
    try {
        let ran = 0, failed = 0;
        for (const [name, every, fn] of SCHEDULE) {
            if (Date.now() - (_lastRun.get(name) || 0) < every) continue;
            _lastRun.set(name, Date.now());
            ran++;
            if (!(await runStep(name, fn, 'sync'))) failed++;
        }
        endPass(ran, failed);
    } finally { _running = false; }
}

/** One full pass over every projection (boot, tests, `npm run` tools). */
async function sync() {
    if (_since === null) _since = Date.now();
    _lastRun.clear();
    let failed = 0;
    for (const [name, , fn] of SCHEDULE) if (!(await runStep(name, fn, 'initial sync'))) failed++;
    for (const [name] of SCHEDULE) _lastRun.set(name, Date.now());
    endPass(SCHEDULE.length, failed);
}

function start({ intervalMs = 2000 } = {}) {
    if (_timer) return;
    if (_since === null) _since = Date.now();
    _timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (_timer.unref) _timer.unref();
    _batchTimer = setInterval(flushBatches, 2000);
    if (_batchTimer.unref) _batchTimer.unref();
}
function stop() {
    if (_timer) clearInterval(_timer);
    if (_batchTimer) clearInterval(_batchTimer);
    _timer = null; _batchTimer = null;
}

// ── Effects ──────────────────────────────────────────────────────────────────────────────────
// Batched fire-and-forget writes (IP log, viewer counts, viewer snapshots) go out every 2s.

let _batchTimer = null;
const _ipLog = [];
const _viewerCounts = new Map();
const _snapshots = [];
function flushBatches() {
    if (_ipLog.length) fire('ip-log', { entries: _ipLog.splice(0, 500) });
    if (_viewerCounts.size) { const counts = Object.fromEntries(_viewerCounts); _viewerCounts.clear(); fire('viewer-counts', { counts }); }
    if (_snapshots.length) fire('viewer-snapshots', { snapshots: _snapshots.splice(0, 500) });
}

/** A chat client handle Live can reply to (sendToConn over the bridge) and read like chat-server's client. */
function clientHandle(client) {
    if (!client) return null;
    return {
        conn_id: client.connId || null,
        user: client.user ? { id: client.user.id, username: client.user.username, display_name: client.user.display_name, role: client.user.role } : null,
        anonId: client.anonId || null,
        ip: client.ip || null,
        streamId: client.streamId || null,
        channelUserId: client.channelUserId || null,
    };
}

const effects = {
    // Side effects Live used to run in-process from chat-server.js.
    logIp(entry) { if (entry && entry.ip && entry.ip !== 'unknown') { _ipLog.push(entry); if (_ipLog.length > 5000) _ipLog.splice(0, _ipLog.length - 5000); } },
    viewerCount(streamId, count) { if (streamId) _viewerCounts.set(String(streamId), count); },
    viewerSnapshot(streamId, count, chatActivity) { _snapshots.push({ stream_id: streamId, viewer_count: count, chat_messages_5m: chatActivity }); },
    setUserColor: (userId, color) => effect('user-color', { user_id: userId, color }).then((r) => { db.run('UPDATE ctx_users SET profile_color = ? WHERE id = ?', [color, userId]); return r; }),
    // The ban is in Chat's cache before the moderator is answered (and before their next check).
    ban: (body) => effect('ban', body).then((r) => invalidateBans().then(() => r)),
    // /slow and alert sounds: written by Live while it owns channel_moderation_settings, here once Chat
    // does (C-04; the callers already checked the moderator / the channel owner, as Live re-checks).
    // The saved value is what chat enforces: at 'live' the policy is read again (awaited) before the
    // caller answers, so the next line already follows it. Chat sets slow_mode_seconds and sub_only.
    updateChannelModerationSettings: (channelId, fields, actorUserId) => {
        const f = {};
        if (fields && fields.slow_mode_seconds !== undefined) f.slow_mode_seconds = Math.max(0, parseInt(fields.slow_mode_seconds, 10) || 0);
        if (fields && fields.sub_only !== undefined) f.sub_only = fields.sub_only ? 1 : 0;
        if (!channelId || !Object.keys(f).length) return Promise.reject(new LiveError(400, 'no chat-settable fields'));
        if (!_chatWrites('channel_moderation_settings')) {
            return effect('channel-settings', { channel_id: channelId, fields: f, actor_user_id: actorUserId })
                .then((r) => reloadPolicy(channelId).catch(() => {}).then(() => r));
        }
        return Promise.resolve().then(() => {
            db.upsertChannelModerationSettings(Number(channelId), f);
            return { ok: true };
        });
    },
    setChannelAlertSound: (channelId, kind, url, mime, actorUserId) => {
        if (!_chatWrites('channel_moderation_settings')) return effect('alert-sound', { channel_id: channelId, kind, url, mime, actor_user_id: actorUserId }).then((r) => { invalidateChannel(channelId); return r; });
        return Promise.resolve().then(() => {
            const file = url ? require('path').resolve(String(url)) : null;
            if (file) {
                // Live's rule: alert sounds are files in the shared sounds directory.
                const fs = require('fs');
                let inside = false;
                try { inside = require('path').dirname(fs.realpathSync(file)) === fs.realpathSync(require('path').resolve(config.sounds.path)); } catch { inside = false; }
                if (!inside) throw new LiveError(400, 'alert sounds live in the sounds directory');
            }
            db.setChannelAlertSound(Number(channelId), kind === 'goal' ? 'goal' : 'donation', file, file ? String(mime || 'audio/mpeg') : null);
            return { ok: true };
        });
    },
    // One call per real chat line: coins chat bonus, AI viewers, PowerChat relay (Live decides each).
    chatMessage: (body) => effect('chat-message', body),
    aiModCommand: (channelUserId, streamId, args, opts) => effect('ai/mod-command', { channel_user_id: channelUserId, stream_id: streamId, args, by: opts && opts.by }).then((r) => r.reply),
    arenaCommand: (client, cmd, parts) => fire('arena-command', { client: clientHandle(client), cmd, parts }),
    mediaQueue: (op, args) => effect('media-queue', { op, ...args }),
    hardwareCommand: (streamerUserId, command, fromUser) => effect('hardware', { streamer_user_id: streamerUserId, command, from_user: fromUser }),
    createPaste: (body) => effect('paste', body).then((r) => r.paste),
    translate: (text, channelUserId) => effect('translate', { text, channel_user_id: channelUserId }).then((r) => r.translation || null),
    notifyDm: (body) => fire('notify/dm', body),
    markDmRead: (userId, conversationId) => fire('notify/dm-read', { user_id: userId, conversation_id: conversationId }),
    // A call-user ring: Live's cross-site VC_CALL_INVITE notification (server/calls/routes.js).
    notifyCallInvite: (body) => fire('notify/call-invite', body),
    // Awaitable (a sound's Media copy is removed from Live's row before the row goes), never throws.
    assetSync: (op, assetId) => effect('asset-sync', { op, asset_id: assetId || null }).catch((err) => console.warn(`[LiveContext] asset-sync: ${err.message}`)),
    userProfile: (username, viewerId) => read(`/users/profile?username=${encodeURIComponent(username)}${viewerId ? `&viewer_id=${viewerId}` : ''}`),
};

module.exports = {
    ARENA_COMMANDS,
    LiveError,
    stats,
    // lifecycle
    start, stop, sync, tick, warm, syncStatus,
    // identity + users
    authenticate, authFailureReason, upsertUser, invalidateUser, subjectFor,
    getUserById, getUserByUsername, getUserByDisplayName, ensureUsers, ensureUserByUsername,
    // streams + channels
    getStreamById, ensureStream, refreshStream, latestStreamIdForUser, getLiveStreamsByUserId, getStreamsByUserId, getManagedStreamsByUserId,
    getChannelById, getChannelByUserId, ensureChannelForUser, createChannel,
    // policy
    getChannelModerationSettings, isChannelModerator, channelLanguage, getChannelAlertSoundsByUser, ensurePolicy, invalidateChannel,
    reloadPolicy, onChannelSettings, defaultModerationSettings,
    // subscriptions (sub-only chat)
    isSubscriber, subscriberState, ensureSubscriber,
    // bans, follows, approvals, decor
    isUserBanned, getIpBan, isIpBanned, invalidateBans, refreshBans,
    isFollowing, isIpApproved, approveIp, invalidateApprovals,
    getCosmeticProfile, getTagProfile, ensureDecor,
    // settings, anon
    getSetting, ensureSettings, setSettings,
    resolveAnon, peekAnon, getAnonFirstSeen, ensureAnonFirstSeen, anonFirstSeenByNum, fetchTtsAudio,
    // effects
    effects, clientHandle,
    // tests
    _setFetch(fn) { _fetch = fn; },
    _reset() {
        _policy.clear(); _follows.clear(); _approvals.clear(); _decor.clear(); _auth.clear(); _anon.clear(); _anonSeen.clear(); _streamFetch.clear(); _subs.clear();
        _bans = { rows: [], version: null, at: 0, cidr: [] }; _settings = { values: {}, at: 0 }; _lastRun.clear();
    },
};
