/**
 * OpenVibe.Chat — Voice Channel WebSocket Server (/ws/call)
 *
 * Moved from OpenVibe.Live server/streaming/call-server.js (roadmap WS-I task 1) with the same
 * protocol: query parameters, every message type and payload, the limits (8 participants, 3 sockets
 * per address, the kick cooldown, per-channel bans), the permanent 'public' lobby, stream-linked and
 * temporary channels and the inactivity cleanup are Live's. What changed is only where Live-owned
 * data comes from — accounts, streams and cosmetics are read through ../live-context.js, the chat
 * pushes (the voice-channel list, call invites) go through Chat's own chat server — that sign-in is
 * Chat's cached token resolution (so a socket's setup is async; messages that arrive meanwhile wait,
 * in order), and that every call is a row of `calls` (./lifecycle.js).
 *
 * Discord-style voice/video channels accessible from the Chat tab.
 * Uses full-mesh WebRTC peer connections (each participant ↔ every other).
 * Signaling only — no media passes through the server.
 *
 * A permanent "Public" lobby channel always exists. Users can create
 * temporary channels. Stream-linked channels are auto-created when a
 * streamer enables voice on their stream (Live asks: POST /internal/calls/stream-channel).
 *
 * WebSocket path: /ws/call?channelId=<id> (session cookie or Authorization bearer)
 *
 * Channel modes:
 *   'mic'      — Microphone only
 *   'mic+cam'  — Mic + optional camera
 *   'cam+mic'  — Both mic and camera
 *
 * Call rooms (roadmap WS-I task 4, ../rooms/rooms.js): a room of kind `call` has the channel
 * `room-<slug>`, made when someone first connects to it and kept (permanent) while the room exists.
 * The room decides who is in: a person who may not read the room is refused (a private room looks
 * missing), blocked people are refused, and the room's roles decide who talks: owner, mods and
 * speakers talk; participants, viewers and people without a role (public rooms, anonymous too) join
 * listen-only — force-muted with the camera forced off, and their own unmute is ignored. The room's
 * owner and mods (and chat staff) moderate the call. A role change reaches the call at once
 * (applyRoomAccess: a `room-role` frame, then the force-mute state); a ban in the call also blocks the
 * person in the room. Room channels are not in the voice-channel list (Live's sidebar): openvibe.chat
 * lists rooms. Signalling only: media is peer to peer, so listen-only is enforced by the clients
 * honouring force-mute (as for every force-mute here), and every peer sees who may talk.
 */
'use strict';

const WebSocket = require('ws');
const config = require('../config');
const ctx = require('../live-context');
const { extractWsToken, authenticateWs } = require('../auth/auth');
const permissions = require('../auth/permissions');
const chatServer = require('../chat/chat-server');
const lifecycle = require('./lifecycle');
const rooms = require('../rooms/rooms');
// Cosmetics are Live's (monetization/cosmetics); read through live-context, warmed when a socket joins.
const cosmetics = { getCosmeticProfile: (userId) => ctx.getCosmeticProfile(userId) };

const WS_HEARTBEAT_MS = 30000;
const MAX_PARTICIPANTS = 8;
const MAX_SOCKETS_PER_IP = 3;          // one household in one channel; never one host filling it
const MAX_EARLY_MESSAGES = 200;       // pre-admission buffer cap; past it the socket is closed (same as the 200/s rate limit)
const FIRST_TOKEN_WAIT_MS = 1000;    // how long a refused anonymous socket waits for its auth-update
const KICK_COOLDOWN_MS = 60 * 1000;
const PUBLIC_CHANNEL_ID = 'public';
const MODES = ['mic', 'mic+cam', 'cam+mic'];
const ROOM_CHANNEL = /^room-([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))$/;

class CallServer {
    constructor() {
        this.wss = null;
        /** channelId → Map<peerId, clientInfo> */
        this.rooms = new Map();
        /** ws → { channelId, peerId } */
        this.clients = new Map();
        /** channelId → Set<userId> */
        this.callBans = new Map();
        /** channelId → channel metadata { id, name, mode, createdBy, streamId?, permanent, createdAt, maxParticipants } */
        this.channels = new Map();
        this._nextPeerId = 1;
        this._heartbeatInterval = null;
        this._inactivityTimer = null;
        /** `${channelId}:${identity}` → until (ms): a kicked participant waits before rejoining */
        this.kickCooldown = new Map();
        this._notifyTimer = null;

        // Seed the permanent Public channel
        this.channels.set(PUBLIC_CHANNEL_ID, {
            id: PUBLIC_CHANNEL_ID, name: 'Public', mode: 'mic+cam', createdBy: null,
            streamId: null, permanent: true, createdAt: Date.now(), maxParticipants: MAX_PARTICIPANTS,
        });
    }

    async init(server) {
        this.wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = setInterval(() => {
            if (!this.wss) return;
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
                ws.isAlive = false;
                try { ws.ping(); } catch {}
            });
        }, WS_HEARTBEAT_MS);
        if (this._heartbeatInterval.unref) this._heartbeatInterval.unref();
        this.wss.on('connection', async (ws, req) => await this._handleConnection(ws, req));

        // Cleanup user-created channels that have been empty for over an hour
        if (this._inactivityTimer) clearInterval(this._inactivityTimer);
        this._inactivityTimer = setInterval(async () => await this._cleanupInactiveChannels(), 5 * 60 * 1000);
        if (this._inactivityTimer.unref) this._inactivityTimer.unref();

        // Rooms are memory: calls the previous process left open are over.
        try { await lifecycle.recover(); } catch (err) { console.warn('[Calls] recover failed:', err.message); }

        console.log(`[CallServer] Voice channels initialized (${config.calls.enabled ? 'serving' : 'off: CHAT_CALLS is not set'})`);
        return this.wss;
    }

    async _cleanupInactiveChannels() {
        const ONE_HOUR = 60 * 60 * 1000;
        const now = Date.now();
        for (const [k, until] of this.kickCooldown) if (until <= now) this.kickCooldown.delete(k);
        for (const [channelId, ch] of this.channels) {
            if (ch.permanent || ch.streamId) continue;
            const room = this.rooms.get(channelId);
            const isEmpty = !room || room.size === 0;
            if (isEmpty && ch.lastEmptiedAt && (now - ch.lastEmptiedAt) >= ONE_HOUR) {
                console.log(`[CallServer] Auto-deleting inactive channel "${ch.name}" (${channelId}) — empty for ${Math.round((now - ch.lastEmptiedAt) / 60000)}m`);
                this.channels.delete(channelId);
                this.callBans.delete(channelId);
                await lifecycle.channelClosed(channelId, 'inactive');
            }
        }
    }

    handleUpgrade(req, socket, head) {
        if (!req.url.startsWith('/ws/call')) return false;
        this.wss.handleUpgrade(req, socket, head, (ws) => { this.wss.emit('connection', ws, req); });
        return true;
    }

    /* ── Channel management ──────────────────────────────────── */

    /** Channels a viewer may see: a private call only for its creator, its invitees and staff. */
    async listChannels(viewer = null) {
        const result = [];
        for (const [id, ch] of this.channels) {
            if (ch.roomSlug) continue;   // call rooms are listed as rooms (openvibe.chat), not in the voice sidebar
            if (ch.private && !await this._canSeePrivate(ch, viewer)) continue;
            const room = this.rooms.get(id);
            const participants = [];
            if (room) { for (const [pid, info] of room) participants.push(this._buildParticipantInfo(pid, info)); }
            result.push({ ...this._publicChannel(ch), participantCount: room ? room.size : 0, participants });
        }
        return result;
    }
    _publicChannel(ch) { const { invited, ...rest } = ch; return rest; }
    async _canSeePrivate(ch, viewer) {
        if (ch.roomSlug) { const room = await this._roomOf(ch.id); return !!room && (await rooms.access(room, viewer)).read; }
        if (!ch.private) return true;
        if (!viewer) return false;
        if (permissions.can(viewer, 'staff.moderation.calls')) return true;
        return ch.createdBy === viewer.id || !!(ch.invited && ch.invited.has(viewer.id));
    }
    /** A caller invited this user to their call (POST /voice-channels/call-user). */
    invite(channelId, userId) {
        const ch = this.channels.get(channelId);
        if (!ch) return false;
        if (!ch.invited) ch.invited = new Set();
        ch.invited.add(userId);
        return true;
    }
    hasInvite(channelId, userId) {
        const ch = this.channels.get(channelId);
        return !!(ch && ch.invited && ch.invited.has(userId));
    }
    /** Debounced "the list changed" for every chat socket (the sidebar used to poll every 4 s). */
    _notifyChannelsChanged() {
        if (this._notifyTimer) return;
        this._notifyTimer = setTimeout(async () => {
            this._notifyTimer = null;
            try { await chatServer.broadcastAll({ type: 'voice-channels', channels: await this.listChannels(null) }); } catch { /* */ }
        }, 400);
        if (this._notifyTimer.unref) this._notifyTimer.unref();
    }

    /** The call room behind a `room-<slug>` channel id, or null. */
    async _roomOf(channelId) {
        const m = ROOM_CHANNEL.exec(String(channelId || ''));
        if (!m) return null;
        const room = await rooms.bySlug(m[1]);
        return room && room.kind === 'call' ? room : null;
    }

    /** The channel of a call room, made on first use and named after the room. → channel | null */
    async ensureRoomChannel(channelId) {
        const room = await this._roomOf(channelId);
        if (!room) return null;
        let ch = this.channels.get(channelId);
        if (!ch) {
            ch = {
                id: channelId, name: room.name, mode: 'mic+cam', createdBy: room.owner_id, streamId: null, permanent: true,
                roomSlug: room.slug, createdAt: Date.now(), maxParticipants: MAX_PARTICIPANTS,
            };
            this.channels.set(channelId, ch);
        } else { ch.name = room.name; ch.createdBy = room.owner_id; }
        return ch;
    }

    async getChannel(channelId, viewer = null) {
        const ch = this.channels.get(channelId);
        if (!ch || !await this._canSeePrivate(ch, viewer)) return null;
        const room = this.rooms.get(channelId);
        const participants = [];
        if (room) { for (const [pid, info] of room) participants.push(this._buildParticipantInfo(pid, info)); }
        return { ...this._publicChannel(ch), participantCount: room ? room.size : 0, participants };
    }

    createChannel({ name, mode, createdBy, maxParticipants, isPrivate = false }) {
        // One user-created channel per user
        for (const [, ch] of this.channels) {
            if (!ch.permanent && !ch.streamId && ch.createdBy === createdBy) {
                throw Object.assign(new Error('You already have a voice channel. Delete it first.'), { code: 'CHANNEL_LIMIT' });
            }
        }
        const id = `user-${createdBy}-${Date.now().toString(36)}`;
        const ch = {
            id, name: String(name || 'Voice Channel').slice(0, 40),
            mode: MODES.includes(mode) ? mode : 'mic+cam',
            createdBy, streamId: null, permanent: false, createdAt: Date.now(),
            maxParticipants: Math.min(Math.max(Number(maxParticipants) || MAX_PARTICIPANTS, 2), MAX_PARTICIPANTS),
            lastEmptiedAt: Date.now(), // starts empty; inactivity timer tracks from creation
            private: !!isPrivate,
        };
        this.channels.set(id, ch);
        this._notifyChannelsChanged();
        return this._publicChannel(ch);
    }

    /** Live's go-live / call-mode hook. `stream` is the stream row when the caller has it (its title). */
    async createStreamChannel(streamId, mode, streamerId, stream = null) {
        const id = `stream-${streamId}`;
        const existing = this.channels.get(id);
        if (existing) { const old = existing.mode; existing.mode = mode; if (old !== mode) await this.endCall(id); return existing; }
        if (!stream) stream = await ctx.getStreamById(streamId);
        const ch = {
            id, name: stream ? (stream.title || `Stream ${streamId}`) : `Stream ${streamId}`,
            mode: MODES.includes(mode) ? mode : 'mic',
            createdBy: streamerId, streamId, permanent: false, createdAt: Date.now(), maxParticipants: MAX_PARTICIPANTS,
        };
        this.channels.set(id, ch);
        return ch;
    }

    async removeStreamChannel(streamId) {
        const id = `stream-${streamId}`;
        const had = this.channels.has(id);
        await this.endCall(id, 'stream_ended');
        this.channels.delete(id);
        this.callBans.delete(id);
        await lifecycle.channelClosed(id, 'stream_ended');
        return had;
    }

    /** `user` is the requester (Live passed an id and looked the account up; Chat's routes have it). */
    async deleteChannel(channelId, user) {
        const ch = this.channels.get(channelId);
        if (!ch || ch.permanent || !user) return false;
        if (ch.createdBy !== user.id) {
            if (!permissions.can(user, 'staff.moderation.calls')) return false;
        }
        await this.endCall(channelId, 'closed');
        this.channels.delete(channelId);
        this.callBans.delete(channelId);
        await lifecycle.channelClosed(channelId, 'closed');
        this._notifyChannelsChanged();
        return true;
    }

    /* ── WebRTC signaling ──────────────────────────────────────── */

    _generatePeerId() { return `call-peer-${this._nextPeerId++}-${Date.now().toString(36)}`; }

    _buildParticipantInfo(peerId, info) {
        let cosmeticProfile = {};
        // From live-context's decor cache (warmed at join, refreshed in the background).
        if (info.user?.id) { try { cosmeticProfile = cosmetics.getCosmeticProfile(info.user.id) || {}; } catch {} }
        return {
            peerId, username: info.user ? info.user.username : null,
            anonId: info.anonId || null,
            displayName: info.user ? (info.user.display_name || info.user.username) : info.anonId,
            userId: info.user ? info.user.id : null,
            avatarUrl: info.user ? info.user.avatar_url : null,
            profileColor: info.user ? info.user.profile_color : null,
            isChannelCreator: info.isChannelCreator || false,
            isStreamer: info.isStreamer || false,
            muted: info.muted, cameraOff: info.cameraOff,
            forceMuted: info.forceMuted || false, forceCameraOff: info.forceCameraOff || false,
            speaking: info.speaking || false,
            nameFX: cosmeticProfile.nameFX || null, particleFX: cosmeticProfile.particleFX || null, hatFX: cosmeticProfile.hatFX || null, badgeFX: cosmeticProfile.badgeFX || null,
            ...(info.inRoom ? { roomRole: info.roomRole || null, canTalk: !info.listenOnly } : {}),
        };
    }

    async _handleConnection(ws, req) {
        const url = new URL(req.url, 'http://localhost');
        const channelId = url.searchParams.get('channelId') || url.searchParams.get('streamId');
        // A bot's bearer; a browser's socket is anonymous until its auth-update (admission counts it).
        const token = extractWsToken(req);
        // CF-Connecting-IP / X-Forwarded-For only when nginx's peer is Cloudflare (net/client-ip.js), as on /ws/chat.
        const ip = chatServer.getClientIp(req);

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        try { ws._socket?.setNoDelay(true); } catch {}

        if (!channelId) { ws.send(JSON.stringify({ type: 'error', message: 'Missing channelId' })); ws.close(); return; }

        // Legacy: bare number → stream-<N>
        const resolvedId = /^\d+$/.test(channelId) ? `stream-${channelId}` : channelId;

        if (!this.channels.get(resolvedId)) await this.ensureRoomChannel(resolvedId);
        if (!this.channels.get(resolvedId)) { ws.send(JSON.stringify({ type: 'error', message: 'Voice channel not found' })); ws.close(); return; }

        // Sign-in, the anon number and the stream are (cached) calls to Live now. Messages that arrive
        // meanwhile wait, in order, and are handled once the socket is in the room.
        const early = [];
        let closedEarly = false;
        const onEarlyMessage = (data) => { if (early.length >= MAX_EARLY_MESSAGES) { try { ws.close(1008, 'Too many messages'); } catch {} return; } early.push(data); };
        const onEarlyClose = () => { closedEarly = true; };
        ws.on('message', onEarlyMessage);
        ws.on('close', onEarlyClose);
        ws.on('error', onEarlyClose);
        (async () => {
            const first = this.channels.get(resolvedId);
            let stream = null;
            if (first && first.streamId) stream = await ctx.getStreamById(first.streamId) || await ctx.ensureStream(first.streamId).catch(() => null);
            const user = await authenticateWs(token).catch(() => null);
            if (!user) await chatServer._resolveUnifiedAnonNum(chatServer.normalizeIp(ip)).catch(() => {});
            await ctx.warm({ user, streamId: first && first.streamId ? first.streamId : null, ip }).catch(() => {});
            ws.off('close', onEarlyClose);
            ws.off('error', onEarlyClose);
            if (closedEarly || ws.readyState !== WebSocket.OPEN) return;
            // Messages keep buffering until _admit attaches the socket's handler: none falls in between.
            await this._admit(ws, { resolvedId, ip, user, stream, early, stopBuffering: () => ws.off('message', onEarlyMessage) });
        })().catch((err) => {
            console.warn('[Call] connection setup failed:', err.message);
            try { ws.close(1011, 'setup failed'); } catch {}
        });
    }

    /** The rest of Live's _handleConnection, once the socket's identity is known. */
    async _admit(ws, { resolvedId, ip, user, stream, early, stopBuffering }) {
        // The channel may have gone while the socket signed in.
        const channel = this.channels.get(resolvedId);
        if (!channel) { ws.send(JSON.stringify({ type: 'error', message: 'Voice channel not found' })); ws.close(); return; }

        // If stream-linked, verify stream is live
        if (channel.streamId) {
            if (!stream || Number(stream.id) !== Number(channel.streamId)) stream = await ctx.getStreamById(channel.streamId);
            if (!stream || !stream.is_live) { ws.send(JSON.stringify({ type: 'error', message: 'Stream not live' })); ws.close(); return; }
        }

        // Admission counts the token the client presents in its first message (auth-update) too: a
        // browser's upgrade is anonymous, and a private call or a members-only room must still let it
        // in. A socket refused while anonymous waits briefly for that message.
        user = await this._presentedUser(early, user);
        let admission = await this._admission(channel, resolvedId, user);
        if (admission.error) {
            // Admission may have awaited Live while an auth-update arrived in the buffer. A newly
            // presented identity (anonymous upgrade only: auth-update cannot switch an already
            // signed-in socket to another account) gets a second admission attempt.
            const presented = await this._presentedUser(early, user);
            if (presented && presented.id !== (user && user.id)) {
                user = presented;
                admission = await this._admission(channel, resolvedId, user);
            }
        }
        if (admission.error && !user) {
            await this._firstAuthMessage(ws, FIRST_TOKEN_WAIT_MS);
            if (ws.readyState !== WebSocket.OPEN) return;
            user = await this._presentedUser(early, user);
            if (user) admission = await this._admission(channel, resolvedId, user);
        }
        if (admission.error) { ws.send(JSON.stringify({ type: 'error', message: admission.error })); ws.close(); return; }
        const roomAccess = admission.roomAccess;
        const listenOnly = !!(roomAccess && !roomAccess.talk);

        const peerId = this._generatePeerId();
        const anonId = user ? null : chatServer.getAnonIdForConnection(ip, resolvedId);
        const identity = user ? `u:${user.id}` : (anonId ? `a:${anonId}` : `ip:${ip}`);
        const cooled = this.kickCooldown.get(`${resolvedId}:${identity}`);
        if (cooled && cooled > Date.now()) { ws.send(JSON.stringify({ type: 'error', message: 'You were removed from this channel; try again in a minute' })); ws.close(); return; }
        const isChannelCreator = user && channel.createdBy === user.id;
        const isStreamer = channel.streamId ? (user && (await ctx.getStreamById(channel.streamId))?.user_id === user.id) : false;
        const canModerate = await this._canModerate(user, resolvedId);

        const bans = this.callBans.get(resolvedId);
        if (bans) {
            const banned = user
                ? bans.has(user.id) || bans.has(`u:${user.id}`)
                : bans.has(`a:${anonId}`) || bans.has(`ip:${ip}`);
            if (banned) {
                ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this voice channel' })); ws.close(); return;
            }
        }

        if (!this.rooms.has(resolvedId)) this.rooms.set(resolvedId, new Map());
        const room = this.rooms.get(resolvedId);
        // The same account again (a second tab, or a reconnect before the old socket timed out)
        // replaces its older socket instead of standing next to it as a ghost for a minute.
        if (user) {
            for (const [pid, info] of room) {
                if (info.user && info.user.id === user.id) {
                    try { info.ws.send(JSON.stringify({ type: 'replaced' })); } catch { /* */ }
                    await this._handleDisconnect(info.ws, resolvedId, pid);
                    try { info.ws.close(); } catch { /* */ }
                }
            }
        }
        // Replacing the only socket emptied the room and dropped it from this.rooms: put it back, or
        // this socket would sit in a room nobody else can reach.
        if (!this.rooms.has(resolvedId)) this.rooms.set(resolvedId, room);
        let fromIp = 0;
        for (const [, info] of room) if (info.ip === ip) fromIp++;
        if (fromIp >= MAX_SOCKETS_PER_IP && !permissions.can(user, 'staff.limits.exempt')) { ws.send(JSON.stringify({ type: 'error', message: 'Too many connections from your network' })); ws.close(); return; }
        const maxP = channel.maxParticipants || MAX_PARTICIPANTS;
        if (room.size >= maxP) { ws.send(JSON.stringify({ type: 'error', message: `Channel full (max ${maxP})` })); ws.close(); return; }

        const clientInfo = {
            ws, user, anonId, ip, peerId, identity, muted: listenOnly, cameraOff: true, forceMuted: listenOnly, forceCameraOff: listenOnly, speaking: false,
            isChannelCreator, isStreamer, listenOnly, inRoom: !!channel.roomSlug, roomRole: roomAccess ? roomAccess.role : null, _msgCount: 0, _msgResetTime: Date.now(),
        };
        this.clients.set(ws, { channelId: resolvedId, peerId });
        room.set(peerId, clientInfo);

        // Mark channel as active (reset inactivity timer)
        if (channel && !channel.permanent && !channel.streamId) {
            channel.lastEmptiedAt = null;
        }
        // The lifecycle: the channel's session is active; an invitee joining answers the ring.
        try {
            if (room.size === 1) await lifecycle.sessionStarted({ channelId: resolvedId, streamId: channel.streamId || null, createdBy: channel.createdBy || null });
            if (user) await lifecycle.answeredByJoin(resolvedId, user.id);
        } catch (err) { console.warn('[Calls] lifecycle:', err.message); }

        const participants = [];
        for (const [pid, info] of room) participants.push(this._buildParticipantInfo(pid, info));

        ws.send(JSON.stringify({
            type: 'welcome',
            peerId,
            channelId: resolvedId,
            channelName: channel.name,
            callMode: channel.mode,
            participants,
            isStreamer: isStreamer || isChannelCreator,
            canModerate,
            ...(channel.roomSlug ? { room: channel.roomSlug, roomRole: clientInfo.roomRole, canTalk: !listenOnly } : {}),
        }));
        if (listenOnly) {
            ws.send(JSON.stringify({ type: 'force-muted', forceMuted: true }));
            ws.send(JSON.stringify({ type: 'force-camera-off', forceCameraOff: true }));
        }

        const joinMsg = JSON.stringify({ type: 'peer-joined', ...this._buildParticipantInfo(peerId, clientInfo) });
        for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(joinMsg); }
        this._broadcastParticipantCount(resolvedId);
        this._notifyChannelsChanged();

        // One message at a time per socket, in arrival order (auth-update resolves a token first).
        let queue = Promise.resolve();
        const onMessage = (data) => {
            // Rate limit: 200/s. A newcomer to a full room sends seven offers and their candidates in
            // a burst; the old 50/s silently dropped some of them and the join stalled.
            const now = Date.now();
            if (now - clientInfo._msgResetTime > 1000) { clientInfo._msgCount = 0; clientInfo._msgResetTime = now; }
            if (++clientInfo._msgCount > 200) return;
            let msg;
            try { msg = JSON.parse(data); } catch (err) { console.warn('[Call] Message error for peer', peerId, ':', err.message); return; }
            queue = queue.then(async () => { await this._handleMessage(ws, msg, resolvedId, peerId); })
                .catch((err) => { console.warn('[Call] Message error for peer', peerId, ':', err.message); });
        };
        stopBuffering();
        ws.on('message', onMessage);
        ws.on('close', async () => await this._handleDisconnect(ws, resolvedId, peerId));
        ws.on('error', async () => await this._handleDisconnect(ws, resolvedId, peerId));
        for (const data of early) onMessage(data);
    }

    /** Whether `user` may enter `channel`: { error } or { roomAccess } (null outside call rooms). */
    async _admission(channel, channelId, user) {
        if (channel.private && !await this._canSeePrivate(channel, user)) return { error: 'This is a private call' };
        // A call room: the room's roles decide who is in and who talks.
        if (!channel.roomSlug) return { roomAccess: null };
        const room = await this._roomOf(channelId);
        const roomAccess = room ? await rooms.access(room, user) : null;
        if (!roomAccess || !roomAccess.read) return { error: 'Voice channel not found' };
        if (!roomAccess.join) return { error: 'You cannot join this call' };
        return { roomAccess };
    }

    /**
     * The account of the token in the socket's first message when that is an auth-update carrying
     * one, else `user`. As auth-update: an invalid token changes nothing, and it never replaces the
     * upgrade's account with another.
     */
    async _presentedUser(early, user) {
        let first = null;
        for (const data of early) {
            let msg;
            try { msg = JSON.parse(data); } catch { continue; }
            if (msg?.type === 'auth-update') { first = msg; break; }
        }
        if (!first || typeof first.token !== 'string' || !first.token.trim()) return user;
        const next = await authenticateWs(first.token).catch(() => null);
        if (!next || (user && user.id !== next.id)) return user;
        await ctx.ensureDecor([next.id]).catch(() => {});
        return next;
    }

    /** Resolves on the next auth-update (buffered by then), close, or timeout. */
    _firstAuthMessage(ws, ms) {
        return new Promise((resolve) => {
            const done = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', done); resolve(); };
            const onMessage = (data) => {
                try { if (JSON.parse(data)?.type === 'auth-update') done(); } catch { /* wait */ }
            };
            const timer = setTimeout(done, ms);
            ws.on('message', onMessage);
            ws.on('close', done);
        });
    }

    async _canModerate(user, channelId) {
        if (!user) return false;
        if (permissions.can(user, 'staff.moderation.calls')) return true;
        const ch = this.channels.get(channelId);
        if (ch?.roomSlug) { const room = await this._roomOf(channelId); return !!room && (await rooms.access(room, user)).moderate; }
        if (ch?.createdBy === user.id) return true;
        if (ch?.streamId) return await permissions.canModerateCall(user, ch.streamId);
        return false;
    }

    async _handleMessage(ws, msg, channelId, peerId) {
        const room = this.rooms.get(channelId);
        if (!room) return;

        switch (msg.type) {
            case 'offer': case 'answer': case 'ice-candidate': {
                // Validate SDP/candidate size to prevent abuse
                if (msg.sdp && (typeof msg.sdp.sdp !== 'string' || msg.sdp.sdp.length > 16384)) break;
                if (msg.candidate && (typeof msg.candidate.candidate !== 'string' || msg.candidate.candidate.length > 2048)) break;
                const tp = room.get(msg.targetPeerId);
                if (tp && tp.ws.readyState === WebSocket.OPEN) tp.ws.send(JSON.stringify({ type: msg.type, fromPeerId: peerId, sdp: msg.sdp, candidate: msg.candidate }));
                break;
            }
            case 'mute': {
                const c = room.get(peerId); if (!c) break;
                if (c.listenOnly && !msg.muted) break;   // a listener in a call room stays muted
                c.muted = !!msg.muted;
                const m = JSON.stringify({ type: 'peer-muted', peerId, muted: c.muted });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                this._notifyChannelsChanged();
                break;
            }
            case 'camera-off': {
                const c = room.get(peerId); if (!c) break;
                if (c.listenOnly && !msg.cameraOff) break;
                c.cameraOff = !!msg.cameraOff;
                const m = JSON.stringify({ type: 'peer-camera', peerId, cameraOff: c.cameraOff });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'speaking': {
                const c = room.get(peerId); if (!c) break;
                const s = !!msg.speaking; if (c.speaking === s) break; c.speaking = s;
                const m = JSON.stringify({ type: 'peer-speaking', peerId, speaking: s });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'auth-update': {
                const c = room.get(peerId); if (!c) break;
                let user = c.user || null;
                let acceptedToken = false;
                if (typeof msg.token === 'string' && msg.token.trim()) {
                    const nextUser = await authenticateWs(msg.token).catch(() => null);
                    if (!nextUser) {
                        console.warn('[Call] auth-update rejected for peer', peerId, '(invalid or expired token)');
                    } else if (user && user.id !== nextUser.id) {
                        console.warn(`[Call] auth-update identity mismatch for peer ${peerId}: keeping existing user ${user.username}, ignoring ${nextUser.username}`);
                    } else {
                        user = nextUser;
                        acceptedToken = true;
                    }
                    if (user) await ctx.ensureDecor([user.id]).catch(() => {});
                    // The socket may have left while the token was resolved.
                    if (this.rooms.get(channelId) !== room || room.get(peerId) !== c) break;
                }
                if (user && this.callBans.has(channelId) && this.callBans.get(channelId).has(user.id)) {
                    if (c.ws.readyState === WebSocket.OPEN) { c.ws.send(JSON.stringify({ type: 'error', message: 'Banned' })); c.ws.close(); } break;
                }
                const ch = this.channels.get(channelId);
                if (ch?.roomSlug) {
                    const callRoom = await this._roomOf(channelId);
                    const a = callRoom ? await rooms.access(callRoom, user) : null;
                    if (!a || !a.read || !a.join) { if (c.ws.readyState === WebSocket.OPEN) { c.ws.send(JSON.stringify({ type: 'error', message: 'You cannot join this call' })); c.ws.close(); } break; }
                }
                c.user = user; c.anonId = user ? null : chatServer.getAnonIdForConnection(c.ip, channelId);
                c.isChannelCreator = !!(user && ch?.createdBy === user.id);
                c.isStreamer = ch?.streamId ? !!(user && (await ctx.getStreamById(ch.streamId))?.user_id === user.id) : false;
                if (user) { try { await lifecycle.answeredByJoin(channelId, user.id); } catch { /* */ } }
                if (ch?.roomSlug) { await this._applyRoomAccessTo(channelId, peerId, c); if (room.get(peerId) !== c) break; }
                const pInfo = this._buildParticipantInfo(peerId, c);
                if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({
                    type: 'self-updated',
                    isStreamer: c.isStreamer || c.isChannelCreator,
                    canModerate: await this._canModerate(user, channelId),
                    participant: pInfo,
                }));
                const u = JSON.stringify({ type: 'peer-updated', ...pInfo });
                for (const [pid, info] of room) { if (pid !== peerId && info.ws.readyState === WebSocket.OPEN) info.ws.send(u); }
                return acceptedToken;
            }
            case 'force-mute': {
                const sender = room.get(peerId); if (!sender || !await this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                if (target.listenOnly && !msg.forceMuted) break;   // make them a speaker in the room instead
                target.forceMuted = !!msg.forceMuted;
                if (target.ws.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify({ type: 'force-muted', forceMuted: target.forceMuted }));
                const m = JSON.stringify({ type: 'peer-force-muted', peerId: msg.targetPeerId, forceMuted: target.forceMuted });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'force-camera-off': {
                const sender = room.get(peerId); if (!sender || !await this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                if (target.listenOnly && !msg.forceCameraOff) break;
                target.forceCameraOff = !!msg.forceCameraOff;
                if (target.ws.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify({ type: 'force-camera-off', forceCameraOff: target.forceCameraOff }));
                const m = JSON.stringify({ type: 'peer-force-camera-off', peerId: msg.targetPeerId, forceCameraOff: target.forceCameraOff });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                break;
            }
            case 'kick': {
                const sender = room.get(peerId); if (!sender || !await this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                if (target.identity) this.kickCooldown.set(`${channelId}:${target.identity}`, Date.now() + KICK_COOLDOWN_MS);
                if (target.ws.readyState === WebSocket.OPEN) { target.ws.send(JSON.stringify({ type: 'kicked' })); target.ws.close(); }
                room.delete(msg.targetPeerId); this.clients.delete(target.ws);
                const m = JSON.stringify({ type: 'peer-left', peerId: msg.targetPeerId, reason: 'kicked' });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                this._broadcastParticipantCount(channelId);
                break;
            }
            case 'ban': {
                const sender = room.get(peerId); if (!sender || !await this._canModerate(sender.user, channelId)) break;
                const target = room.get(msg.targetPeerId); if (!target || target.isChannelCreator || target.isStreamer) break;
                if (!this.callBans.has(channelId)) this.callBans.set(channelId, new Set());
                const banSet = this.callBans.get(channelId);
                if (target.user?.id) {
                    banSet.add(target.user.id);      // backward compatibility with existing entries
                    banSet.add(`u:${target.user.id}`);
                    // In a call room the ban is the room's block, so it outlives this process.
                    const callRoom = await this._roomOf(channelId);
                    if (callRoom && sender.user) {
                        try { await rooms.setRole(callRoom, sender.user, target.user.id, 'blocked'); await chatServer.refreshRoomAccess(callRoom); } catch (err) { console.warn('[Call] room block:', err.message); }
                    }
                } else {
                    if (target.anonId) banSet.add(`a:${target.anonId}`);
                    if (target.ip) banSet.add(`ip:${target.ip}`);
                }
                if (target.ws.readyState === WebSocket.OPEN) { target.ws.send(JSON.stringify({ type: 'banned' })); target.ws.close(); }
                room.delete(msg.targetPeerId); this.clients.delete(target.ws);
                const m = JSON.stringify({ type: 'peer-left', peerId: msg.targetPeerId, reason: 'banned' });
                for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
                this._broadcastParticipantCount(channelId);
                break;
            }
            case 'unban': {
                const sender = room.get(peerId); if (!sender || !await this._canModerate(sender.user, channelId)) break;
                const uid = parseInt(msg.userId);
                if (uid && this.callBans.has(channelId)) {
                    this.callBans.get(channelId).delete(uid);
                    this.callBans.get(channelId).delete(`u:${uid}`);
                }
                break;
            }
            case 'end-call': case 'end-channel': {
                const c = room.get(peerId); if (!c) break;
                const ch = this.channels.get(channelId);
                const canEnd = (ch?.createdBy && c.user?.id === ch.createdBy) || c.isStreamer || permissions.can(c.user, 'staff.moderation.calls');
                if (canEnd) {
                    // The channel leaves memory before the database is written, as when the write was synchronous.
                    const closing = ch && !ch.permanent;
                    if (closing) this.channels.delete(channelId);
                    await this.endCall(channelId, 'ended');
                    if (closing) await lifecycle.channelClosed(channelId, 'ended');
                }
                break;
            }
        }
    }

    async _handleDisconnect(ws, channelId, peerId) {
        if (!this.clients.has(ws)) return; // already handled (error+close fire back-to-back)
        this.clients.delete(ws);
        const room = this.rooms.get(channelId);
        if (!room) return;
        const leaving = room.get(peerId);
        const leftInfo = leaving ? this._buildParticipantInfo(peerId, leaving) : { peerId };
        room.delete(peerId);
        const m = JSON.stringify({ type: 'peer-left', ...leftInfo, reason: 'disconnect' });
        for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); }
        this._broadcastParticipantCount(channelId);
        this._notifyChannelsChanged();
        if (room.size === 0) {
            this.rooms.delete(channelId);
            const ch = this.channels.get(channelId);
            // For user-created channels: don't delete immediately; track when they
            // became empty so the inactivity timer can clean up after 1 hour.
            if (ch && !ch.permanent && !ch.streamId) {
                ch.lastEmptiedAt = Date.now();
            }
            try { await lifecycle.channelEmptied(channelId, 'empty'); } catch (err) { console.warn('[Calls] lifecycle:', err.message); }
        }
    }

    _broadcastParticipantCount(channelId) {
        const room = this.rooms.get(channelId);
        const count = room ? room.size : 0;
        const m = JSON.stringify({ type: 'participant-count', count, channelId });
        if (room) { for (const [pid, info] of room) { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(m); } }
    }

    /* ── Public helpers ────────────────────────────────────────── */

    getParticipantCount(channelId) { const r = this.rooms.get(channelId); return r ? r.size : 0; }

    getParticipants(channelId) {
        const r = this.rooms.get(channelId); if (!r) return [];
        const l = []; for (const [pid, info] of r) l.push(this._buildParticipantInfo(pid, info)); return l;
    }

    getCallBans(channelId) { const b = this.callBans.get(channelId); return b ? [...b] : []; }

    /**
     * A call room's roles or visibility changed (../rooms/routes.js, the site): everyone in its call gets
     * what they may do now. A new speaker may talk, a demoted one is muted, someone who may no longer
     * read the room (blocked, removed from a private room) is dropped. → peers changed
     */
    async applyRoomAccess(room) {
        if (!room || room.kind !== 'call') return 0;
        const channelId = `room-${room.slug}`;
        const ch = this.channels.get(channelId);
        if (ch) { ch.name = room.name; ch.createdBy = room.owner_id; }
        const r = this.rooms.get(channelId);
        if (!r) return 0;
        let changed = 0;
        for (const [pid, info] of [...r]) if (await this._applyRoomAccessTo(channelId, pid, info, room)) changed++;
        return changed;
    }

    /** One peer of a call room against the room's current roles. → whether anything changed */
    async _applyRoomAccessTo(channelId, peerId, info, room = null) {
        const callRoom = room || await this._roomOf(channelId);
        const a = callRoom ? await rooms.access(callRoom, info.user || null) : null;
        const send = (o) => { if (info.ws.readyState === WebSocket.OPEN) info.ws.send(JSON.stringify(o)); };
        if (!a || !a.read || !a.join) {
            send({ type: 'error', message: 'You can no longer join this call' });
            await this._handleDisconnect(info.ws, channelId, peerId);
            try { info.ws.close(); } catch { /* */ }
            return true;
        }
        const listenOnly = !a.talk;
        if (info.listenOnly === listenOnly && info.roomRole === a.role) return false;
        info.roomRole = a.role;
        info.listenOnly = listenOnly;
        info.isChannelCreator = !!(info.user && callRoom.owner_id === info.user.id);
        info.forceMuted = listenOnly;
        info.forceCameraOff = listenOnly;
        if (listenOnly) { info.muted = true; info.cameraOff = true; info.speaking = false; }
        send({ type: 'room-role', room: callRoom.slug, role: a.role, canTalk: a.talk, canModerate: await this._canModerate(info.user, channelId) });
        send({ type: 'force-muted', forceMuted: info.forceMuted });
        send({ type: 'force-camera-off', forceCameraOff: info.forceCameraOff });
        const r = this.rooms.get(channelId);
        if (r) {
            const m1 = JSON.stringify({ type: 'peer-force-muted', peerId, forceMuted: info.forceMuted });
            const m2 = JSON.stringify({ type: 'peer-force-camera-off', peerId, forceCameraOff: info.forceCameraOff });
            const m3 = JSON.stringify({ type: 'peer-updated', ...this._buildParticipantInfo(peerId, info) });
            for (const [pid, other] of r) {
                if (other.ws.readyState !== WebSocket.OPEN) continue;
                other.ws.send(m1); other.ws.send(m2);
                if (pid !== peerId) other.ws.send(m3);
            }
        }
        this._notifyChannelsChanged();
        return true;
    }

    async endCall(channelId, reason = 'ended') {
        const r = this.rooms.get(channelId); if (!r) return;
        const entries = [...r.values()];
        this.rooms.delete(channelId);
        for (const info of entries) this.clients.delete(info.ws);
        // The session row ends before anyone hears call-ended (the order it had when the write was synchronous).
        try { await lifecycle.channelEmptied(channelId, reason); } catch (err) { console.warn('[Calls] lifecycle:', err.message); }
        const m = JSON.stringify({ type: 'call-ended' });
        for (const info of entries) {
            if (info.ws.readyState === WebSocket.OPEN) { info.ws.send(m); info.ws.close(); }
        }
    }

    /** Legacy compat: end call by stream ID */
    async endStreamCall(streamId) { await this.endCall(`stream-${streamId}`); }

    async close() {
        for (const [cid] of this.rooms) await this.endCall(cid, 'restart');
        if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
        if (this._inactivityTimer) { clearInterval(this._inactivityTimer); this._inactivityTimer = null; }
        if (this._notifyTimer) { clearTimeout(this._notifyTimer); this._notifyTimer = null; }
        lifecycle.stop();
        if (this.wss) this.wss.close();
    }
}

module.exports = new CallServer();
module.exports.CallServer = CallServer;
module.exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
module.exports.MAX_SOCKETS_PER_IP = MAX_SOCKETS_PER_IP;
module.exports.KICK_COOLDOWN_MS = KICK_COOLDOWN_MS;
module.exports.PUBLIC_CHANNEL_ID = PUBLIC_CHANNEL_ID;
