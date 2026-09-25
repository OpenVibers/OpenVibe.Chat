'use strict';
/**
 * Calls (WS-I task 1, server/calls/): Live's /ws/call protocol, voice-channel REST routes and stream
 * hooks, served by Chat. Signalling between two signed-in sockets, the limits (8 per channel, 3 per
 * address), kick with its cooldown, bans, private calls, the same-account replacement, auth-update;
 * the REST routes with Live's shapes (list/create/delete, call-user ringing → accept → active,
 * decline, busy, missed after the ring timeout, a failed invite); stream channels through
 * /internal/calls (service token, capability, loopback only) and PUT/GET /:id/call; the `calls`
 * rows of each; and CHAT_CALLS off = nothing answers.
 */
const assert = require('assert');
const WebSocket = require('ws');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('calls');
let h, config, callServer, lifecycle;
let ann, bob, cat, dan, eve, kay, staff, streamer, liveStream, offStream;

/** Open /ws/call as a browser would (through nginx: the address in CF-Connecting-IP). */
function callWs({ channelId, token = null, ip = '203.0.113.20', origin = 'https://openvibe.live', onOpen = null } = {}) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams();
        if (channelId != null) qs.set('channelId', channelId);
        if (token) qs.set('token', token);
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/call?${qs}`, { headers: { 'cf-connecting-ip': ip, origin } });
        const all = [];
        const waiters = [];
        ws.on('message', (d) => {
            let m; try { m = JSON.parse(d.toString()); } catch { return; }
            all.push(m);
            for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
        });
        ws.all = all;
        ws.next = (pred, ms = 3000) => {
            const hit = all.find((m) => pred(m) && !m.__taken);
            if (hit) { hit.__taken = true; return Promise.resolve(hit); }
            return new Promise((res, rej) => {
                const w = { pred: (m) => { if (pred(m)) { m.__taken = true; return true; } return false; }, resolve: res };
                w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timed out waiting (got: ${JSON.stringify(all.map((x) => [x.type, x.message]).slice(-12))})`)); }, ms);
                waiters.push(w);
            });
        };
        ws.none = async (pred, ms = 300) => { await new Promise((r) => setTimeout(r, ms)); return !all.some(pred); };
        ws.sendJson = (o) => ws.send(JSON.stringify(o));
        ws.closed = new Promise((r) => ws.on('close', () => r(true)));
        ws.on('open', () => { if (onOpen) onOpen(ws); resolve(ws); });
        ws.on('error', (e) => reject(e));
        ws.on('unexpected-response', (req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
    });
}
/** Join a channel: resolves with the socket once it has its welcome (ws.welcome) or error (ws.error). */
async function join(opts) {
    const ws = await callWs(opts);
    const m = await ws.next((x) => x.type === 'welcome' || x.type === 'error');
    ws.welcome = m.type === 'welcome' ? m : null;
    ws.error = m.type === 'error' ? m.message : null;
    return ws;
}
const bye = async (...sockets) => { for (const ws of sockets) { if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); await ws.closed; } } await h.sleep(30); };
const api = (method, path, u, body) => h.http(method, `/api/streams${path}`, { token: u && u.token, body });
const rows = (where = {}) => lifecycle.list(where);
async function until(fn, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('condition not met in time');
        await h.sleep(20);
    }
}

t('boot (CHAT_CALLS=1, a short ring timeout)', async () => {
    h = await boot({ env: { CHAT_CALLS: '1', CALL_RING_TIMEOUT_MS: '1200' } });
    config = require('../server/config');
    callServer = require('../server/calls/call-server');
    lifecycle = require('../server/calls/lifecycle');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    dan = h.addUser('dan', { subject: ids.newId('user') });
    eve = h.addUser('eve', { subject: ids.newId('user') });
    kay = h.addUser('kay', { subject: ids.newId('user') });
    staff = h.addUser('staffer', { subject: ids.newId('user'), role: 'global_mod' });
    streamer = h.addUser('streamy', { subject: ids.newId('user'), role: 'streamer' });
    const ch = h.addChannel(streamer.id);
    liveStream = h.addStream(streamer.id, ch, { title: 'Late show' });
    offStream = h.addStream(streamer.id, ch, { title: 'Yesterday', is_live: 0 });
    for (const u of [ann, bob, cat, dan, eve, kay, staff, streamer]) h.ctx.upsertUser(h.live.users.get(u.id));
    await h.ctx.sync();
    assert.strictEqual(config.calls.enabled, true);
});

t('CHAT_CALLS off: no route, no socket, internal hooks answer 409', async () => {
    config.calls.enabled = false;
    try {
        assert.strictEqual((await api('GET', '/voice-channels', ann)).status, 404);
        assert.strictEqual((await api('GET', `/${liveStream}/call`, ann)).status, 404);
        await assert.rejects(callWs({ channelId: 'public', token: ann.token }).then((ws) => new Promise((res, rej) => { ws.on('close', () => rej(new Error('closed'))); setTimeout(res, 300); })));
        const r = await h.http('POST', '/internal/calls/stream-channel', { token: h.serviceToken(['chat.live_bridge.write']), body: { stream_id: liveStream, mode: 'mic', user_id: streamer.id } });
        assert.deepStrictEqual([r.status, r.body.code], [409, 'calls.off']);
        assert.ok(!callServer.channels.has(`stream-${liveStream}`));
    } finally { config.calls.enabled = true; }
});

t('upgrade guard: an origin outside the allow-list is refused; a missing or unknown channel is an error', async () => {
    await assert.rejects(callWs({ channelId: 'public', token: ann.token, origin: 'https://evil.example' }));
    const none = await join({ token: ann.token });
    assert.strictEqual(none.error, 'Missing channelId');
    const unknown = await join({ channelId: 'user-0-nope', token: ann.token });
    assert.strictEqual(unknown.error, 'Voice channel not found');
    await Promise.all([none.closed, unknown.closed]);
});

t('public lobby: join, peer-joined, participant info, the list pushed to chat sockets, leave', async () => {
    const chat = await h.ws({ token: dan.token });
    const a = await join({ channelId: 'public', token: ann.token, ip: '198.51.100.1' });
    assert.ok(a.welcome, a.error);
    assert.deepStrictEqual([a.welcome.channelId, a.welcome.channelName, a.welcome.callMode, a.welcome.isStreamer, a.welcome.canModerate], ['public', 'Public', 'mic+cam', false, false]);
    assert.deepStrictEqual(a.welcome.participants.map((p) => p.username), ['ann']);
    const p = a.welcome.participants[0];
    for (const k of ['peerId', 'username', 'anonId', 'displayName', 'userId', 'avatarUrl', 'profileColor', 'isChannelCreator', 'isStreamer', 'muted', 'cameraOff', 'forceMuted', 'forceCameraOff', 'speaking', 'nameFX', 'particleFX', 'hatFX']) assert.ok(k in p, `participant has ${k}`);
    assert.deepStrictEqual([p.userId, p.displayName, p.cameraOff, p.muted, p.nameFX], [ann.id, 'Ann', true, false, null]);

    // Cosmetics are Live's, read through live-context (warmed at join).
    h.live.decor.set(bob.id, { cosmetic: { nameFX: 'glow', hatFX: 'crown' }, tag: null });
    const b = await join({ channelId: 'public', token: bob.token, ip: '198.51.100.2' });
    const joined = await a.next((m) => m.type === 'peer-joined');
    assert.deepStrictEqual([joined.username, joined.peerId, joined.nameFX, joined.hatFX, joined.particleFX], ['bob', b.welcome.peerId, 'glow', 'crown', null]);
    assert.strictEqual((await a.next((m) => m.type === 'participant-count' && m.count === 2)).channelId, 'public');
    const list = await chat.next((m) => m.type === 'voice-channels' && m.channels.some((c) => c.id === 'public' && c.participantCount === 2));
    assert.ok(list.channels.find((c) => c.id === 'public').participants.some((x) => x.username === 'bob'), 'Chat\'s chat sockets get the voice-channel list');

    const anon = await join({ channelId: 'public', ip: '198.51.100.3' });
    assert.ok(anon.welcome, anon.error);
    const me = anon.welcome.participants.find((x) => x.peerId === anon.welcome.peerId);
    assert.ok(/^anon\d+$/.test(me.anonId) && me.userId === null && me.displayName === me.anonId, 'signed out = anonymous, as on Live');

    let session = rows({ channelId: 'public' })[0];
    assert.deepStrictEqual([session.kind, session.state, session.end_reason], ['channel', 'active', null]);
    await bye(b);
    const left = await a.next((m) => m.type === 'peer-left');
    assert.deepStrictEqual([left.peerId, left.reason, left.username], [b.welcome.peerId, 'disconnect', 'bob']);
    await bye(a, anon, chat);
    session = lifecycle.get(session.id);
    assert.deepStrictEqual([session.state, session.end_reason], ['ended', 'empty'], 'the session ends when the channel empties');
    assert.ok(session.started_at && session.ended_at >= session.started_at);
    assert.strictEqual(callServer.getParticipantCount('public'), 0);
});

t('signalling: offer / answer / ice-candidate relayed between two signed-in sockets; state frames', async () => {
    const a = await join({ channelId: 'public', token: ann.token, ip: '198.51.100.1' });
    const b = await join({ channelId: 'public', token: bob.token, ip: '198.51.100.2' });
    const A = a.welcome.peerId;
    const B = b.welcome.peerId;
    const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
    a.sendJson({ type: 'offer', targetPeerId: B, sdp });
    assert.deepStrictEqual(await b.next((m) => m.type === 'offer'), { type: 'offer', fromPeerId: A, sdp, __taken: true });
    b.sendJson({ type: 'answer', targetPeerId: A, sdp: { type: 'answer', sdp: 'v=0\r\n' } });
    assert.strictEqual((await a.next((m) => m.type === 'answer')).fromPeerId, B);
    const candidate = { candidate: 'candidate:1 1 udp 2122260223 10.0.0.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    a.sendJson({ type: 'ice-candidate', targetPeerId: B, candidate });
    const ice = await b.next((m) => m.type === 'ice-candidate');
    assert.deepStrictEqual([ice.fromPeerId, ice.candidate], [A, candidate]);
    a.sendJson({ type: 'offer', targetPeerId: B, sdp: { type: 'offer', sdp: 'x'.repeat(16385) } });
    a.sendJson({ type: 'ice-candidate', targetPeerId: B, candidate: { candidate: 7 } });
    assert.ok(await b.none((m) => (m.type === 'offer' || m.type === 'ice-candidate') && !m.__taken), 'oversized or malformed signalling is dropped');

    a.sendJson({ type: 'mute', muted: true });
    assert.deepStrictEqual(await b.next((m) => m.type === 'peer-muted'), { type: 'peer-muted', peerId: A, muted: true, __taken: true });
    a.sendJson({ type: 'camera-off', cameraOff: false });
    assert.strictEqual((await b.next((m) => m.type === 'peer-camera')).cameraOff, false);
    a.sendJson({ type: 'speaking', speaking: true });
    assert.strictEqual((await b.next((m) => m.type === 'peer-speaking')).speaking, true);
    assert.deepStrictEqual(callServer.getParticipants('public').find((x) => x.peerId === A).muted, true);

    // The same account again replaces its older socket.
    const a2 = await join({ channelId: 'public', token: ann.token, ip: '198.51.100.9' });
    assert.ok(a2.welcome);
    await a.next((m) => m.type === 'replaced');
    await a.closed;
    assert.deepStrictEqual(callServer.getParticipants('public').map((x) => x.username).sort(), ['ann', 'bob']);
    await bye(a2, b);
});

t('auth-update: an anonymous socket signs in (sent before its welcome, handled after, in order)', async () => {
    const other = await join({ channelId: 'public', token: bob.token, ip: '198.51.100.2' });
    const s = await callWs({ channelId: 'public', ip: '198.51.100.4', onOpen: (ws) => ws.sendJson({ type: 'auth-update', token: cat.token }) });
    const w = await s.next((m) => m.type === 'welcome');
    assert.ok(w.participants.find((x) => x.peerId === w.peerId).anonId, 'joined as anon');
    const self = await s.next((m) => m.type === 'self-updated');
    assert.deepStrictEqual([self.participant.username, self.participant.userId, self.participant.anonId, self.canModerate], ['cat', cat.id, null, false]);
    const upd = await other.next((m) => m.type === 'peer-updated');
    assert.deepStrictEqual([upd.peerId, upd.username], [w.peerId, 'cat']);
    s.sendJson({ type: 'auth-update', token: dan.token });
    const again = await s.next((m) => m.type === 'self-updated');
    assert.strictEqual(again.participant.username, 'cat', 'a different account cannot take over the socket');
    await bye(s, other);
});

t('limits: 3 sockets per address, 8 per channel', async () => {
    const sockets = [];
    for (let i = 0; i < 3; i++) sockets.push(await join({ channelId: 'public', ip: '192.0.2.10' }));
    assert.ok(sockets.every((s) => s.welcome));
    const fourth = await join({ channelId: 'public', ip: '192.0.2.10' });
    assert.strictEqual(fourth.error, 'Too many connections from your network');
    await fourth.closed;
    for (let i = 0; i < 3; i++) sockets.push(await join({ channelId: 'public', ip: '192.0.2.11' }));
    for (let i = 0; i < 2; i++) sockets.push(await join({ channelId: 'public', ip: '192.0.2.12' }));
    assert.strictEqual(callServer.getParticipantCount('public'), 8);
    const ninth = await join({ channelId: 'public', token: dan.token, ip: '192.0.2.13' });
    assert.strictEqual(ninth.error, 'Channel full (max 8)');
    await bye(...sockets);

    // A channel's own maximum (2..8).
    const r = await api('POST', '/voice-channels', eve, { name: 'Tiny', mode: 'mic', maxParticipants: 2 });
    assert.deepStrictEqual([r.status, r.body.channel.maxParticipants, r.body.channel.mode], [201, 2, 'mic']);
    const e1 = await join({ channelId: r.body.channel.id, token: eve.token, ip: '192.0.2.20' });
    const e2 = await join({ channelId: r.body.channel.id, token: bob.token, ip: '192.0.2.21' });
    const e3 = await join({ channelId: r.body.channel.id, token: cat.token, ip: '192.0.2.22' });
    assert.ok(e1.welcome && e2.welcome);
    assert.strictEqual(e3.error, 'Channel full (max 2)');
    await bye(e1, e2);
    assert.strictEqual((await api('DELETE', `/voice-channels/${r.body.channel.id}`, eve)).status, 200);
});

let kayChannel;
t('kick: the target leaves, may not come back for a minute, then may', async () => {
    const r = await api('POST', '/voice-channels', kay, { name: 'Kay\'s room' });
    kayChannel = r.body.channel.id;
    const k = await join({ channelId: kayChannel, token: kay.token, ip: '198.51.100.30' });
    assert.deepStrictEqual([k.welcome.isStreamer, k.welcome.canModerate], [true, true], 'the creator runs the room');
    const b = await join({ channelId: kayChannel, token: bob.token, ip: '198.51.100.31' });
    assert.strictEqual(b.welcome.canModerate, false);
    b.sendJson({ type: 'kick', targetPeerId: k.welcome.peerId });
    assert.ok(await k.none((m) => m.type === 'kicked'), 'only moderators kick');
    k.sendJson({ type: 'kick', targetPeerId: b.welcome.peerId });
    await b.next((m) => m.type === 'kicked');
    await b.closed;
    const left = await k.next((m) => m.type === 'peer-left');
    assert.deepStrictEqual([left.peerId, left.reason], [b.welcome.peerId, 'kicked']);
    const back = await join({ channelId: kayChannel, token: bob.token, ip: '198.51.100.31' });
    assert.strictEqual(back.error, 'You were removed from this channel; try again in a minute');
    // The cooldown runs out.
    callServer.kickCooldown.set(`${kayChannel}:u:${bob.id}`, Date.now() - 1);
    const later = await join({ channelId: kayChannel, token: bob.token, ip: '198.51.100.31' });
    assert.ok(later.welcome, later.error);
    k.sendJson({ type: 'force-mute', targetPeerId: later.welcome.peerId, forceMuted: true });
    assert.strictEqual((await later.next((m) => m.type === 'force-muted')).forceMuted, true);
    assert.strictEqual((await k.next((m) => m.type === 'peer-force-muted')).peerId, later.welcome.peerId);
    await bye(later, k);
});

t('ban and unban', async () => {
    const k = await join({ channelId: kayChannel, token: kay.token, ip: '198.51.100.30' });
    const c = await join({ channelId: kayChannel, token: cat.token, ip: '198.51.100.32' });
    k.sendJson({ type: 'ban', targetPeerId: c.welcome.peerId });
    await c.next((m) => m.type === 'banned');
    assert.strictEqual((await k.next((m) => m.type === 'peer-left')).reason, 'banned');
    assert.ok(callServer.getCallBans(kayChannel).includes(`u:${cat.id}`));
    const again = await join({ channelId: kayChannel, token: cat.token, ip: '198.51.100.33' });
    assert.strictEqual(again.error, 'You are banned from this voice channel');
    k.sendJson({ type: 'unban', userId: cat.id });
    await h.sleep(50);
    const back = await join({ channelId: kayChannel, token: cat.token, ip: '198.51.100.33' });
    assert.ok(back.welcome, back.error);
    // The creator ends the call: everyone gets call-ended, the channel is gone.
    k.sendJson({ type: 'end-call' });
    await back.next((m) => m.type === 'call-ended');
    await k.next((m) => m.type === 'call-ended');
    assert.ok(!callServer.channels.has(kayChannel));
    const session = rows({ channelId: kayChannel })[0];
    assert.deepStrictEqual([session.kind, session.state, session.end_reason], ['channel', 'ended', 'ended']);
    await bye(back, k);
});

t('REST: list, get, create (one each), delete (creator or staff)', async () => {
    let r = await api('GET', '/voice-channels', null);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const pub = r.body.channels.find((c) => c.id === 'public');
    assert.deepStrictEqual([pub.permanent, pub.participantCount, pub.maxParticipants], [true, 0, 8]);
    assert.strictEqual((await api('POST', '/voice-channels', null, { name: 'x' })).status, 401);
    r = await api('POST', '/voice-channels', dan, { name: 'Dan\'s den', mode: 'weird', maxParticipants: 99 });
    assert.strictEqual(r.status, 201);
    const den = r.body.channel;
    assert.deepStrictEqual([den.mode, den.maxParticipants, den.createdBy, den.private, den.permanent, 'invited' in den], ['mic+cam', 8, dan.id, false, false, false]);
    assert.ok(den.id.startsWith(`user-${dan.id}-`));
    r = await api('POST', '/voice-channels', dan, { name: 'Second' });
    assert.deepStrictEqual([r.status, r.body.error], [400, 'You already have a voice channel. Delete it first.']);
    assert.strictEqual((await api('GET', `/voice-channels/${den.id}`, null)).body.channel.name, 'Dan\'s den');
    assert.strictEqual((await api('GET', '/voice-channels/nope', null)).status, 404);
    assert.deepStrictEqual([(await api('DELETE', `/voice-channels/${den.id}`, bob)).status], [403]);
    assert.strictEqual((await api('DELETE', '/voice-channels/public', staff)).status, 403, 'the lobby stays');
    assert.deepStrictEqual((await api('DELETE', `/voice-channels/${den.id}`, staff)).body, { deleted: true }, 'staff may delete any');
    assert.strictEqual((await api('GET', `/voice-channels/${den.id}`, null)).status, 404);
});

let annCall;
t('call-user: ringing → accepted → active → ended; private call; Live asked for the notification', async () => {
    const annChat = await h.ws({ token: ann.token });
    const catChat = await h.ws({ token: cat.token });
    await h.sleep(100);
    let r = await api('POST', '/voice-channels/call-user', ann, { username: 'cat' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.invited, r.body.reusedChannel, r.body.channel.private, r.body.channel.name], [true, false, true, 'Ann\'s call']);
    annCall = r.body.channel.id;
    const invite = await catChat.next((m) => m.type === 'vc-call-invite');
    assert.deepStrictEqual([invite.channelId, invite.channelName, invite.fromUserId, invite.fromUsername, invite.fromDisplayName], [annCall, 'Ann\'s call', ann.id, 'ann', 'Ann']);
    let ring = rows({ kind: 'direct' })[0];
    assert.deepStrictEqual([ring.state, ring.created_by, ring.target_user_id, ring.channel_id, ring.created_by_subject, ring.target_subject], ['ringing', ann.id, cat.id, annCall, ann.subject_id, cat.subject_id]);
    const note = await until(() => h.live.effects.find((e) => e.name === 'notify/call-invite'));
    assert.deepStrictEqual(note.body, { caller_id: ann.id, target_id: cat.id, channel_id: annCall, channel_name: 'Ann\'s call' });

    // Private: listed and joinable for the caller, the invitee and staff only.
    assert.ok(!(await api('GET', '/voice-channels', dan)).body.channels.some((c) => c.id === annCall));
    assert.ok((await api('GET', '/voice-channels', cat)).body.channels.some((c) => c.id === annCall));
    assert.strictEqual((await api('GET', `/voice-channels/${annCall}`, dan)).status, 404);
    const anon = await join({ channelId: annCall, ip: '198.51.100.40' });
    assert.strictEqual(anon.error, 'This is a private call', 'an unauthenticated socket is refused from a private call');
    const outsider = await join({ channelId: annCall, token: dan.token, ip: '198.51.100.41' });
    assert.strictEqual(outsider.error, 'This is a private call');

    // Only the invitee answers, and only to that caller.
    assert.strictEqual((await api('POST', '/voice-channels/call-user/respond', dan, { caller_user_id: ann.id, channel_id: annCall, status: 'accepted' })).status, 403);
    assert.strictEqual((await api('POST', '/voice-channels/call-user/respond', cat, { caller_user_id: ann.id, channel_id: annCall, status: 'maybe' })).status, 400);

    const a = await join({ channelId: annCall, token: ann.token, ip: '198.51.100.42' });
    r = await api('POST', '/voice-channels/call-user/respond', cat, { caller_user_id: ann.id, channel_id: annCall, channel_name: 'Ann\'s call', status: 'accepted' });
    assert.deepStrictEqual(r.body, { ok: true });
    const answer = await annChat.next((m) => m.type === 'vc-call-response');
    assert.deepStrictEqual([answer.status, answer.channelId, answer.fromUserId, answer.fromUsername], ['accepted', annCall, cat.id, 'cat']);
    ring = lifecycle.get(ring.id);
    assert.deepStrictEqual([ring.state, ring.end_reason], ['active', null]);
    assert.ok(ring.answered_at >= ring.started_at);
    const c = await join({ channelId: annCall, token: cat.token, ip: '198.51.100.43' });
    assert.ok(c.welcome, c.error);
    await h.sleep(1400);
    assert.strictEqual(lifecycle.get(ring.id).state, 'active', 'an answered call is not missed');
    await bye(a, c, annChat, catChat, anon, outsider);
    ring = lifecycle.get(ring.id);
    assert.deepStrictEqual([ring.state, ring.end_reason], ['ended', 'empty']);
});

t('call-user: declined, busy, missed after the ring timeout (the caller hears "no-answer"), rate limit', async () => {
    const annChat = await h.ws({ token: ann.token });
    await h.sleep(100);
    // declined
    let r = await api('POST', '/voice-channels/call-user', ann, { user_id: dan.id });
    assert.deepStrictEqual([r.status, r.body.reusedChannel, r.body.channel.id], [200, true, annCall], 'the caller\'s channel is reused');
    await api('POST', '/voice-channels/call-user/respond', dan, { caller_user_id: ann.id, channel_id: annCall, status: 'declined' });
    assert.strictEqual((await annChat.next((m) => m.type === 'vc-call-response')).status, 'declined');
    const declined = rows({ kind: 'direct' })[0];
    assert.deepStrictEqual([declined.target_user_id, declined.state, declined.end_reason], [dan.id, 'declined', 'declined']);
    assert.ok(declined.ended_at);
    // busy
    await api('POST', '/voice-channels/call-user', ann, { username: 'eve' });
    await api('POST', '/voice-channels/call-user/respond', eve, { caller_user_id: ann.id, channel_id: annCall, status: 'busy' });
    assert.deepStrictEqual([rows({ kind: 'direct' })[0].state, rows({ kind: 'direct' })[0].end_reason], ['declined', 'busy']);
    // missed: bob never answers
    r = await api('POST', '/voice-channels/call-user', ann, { username: 'bob' });
    const ringing = rows({ kind: 'direct' })[0];
    assert.strictEqual(ringing.state, 'ringing');
    // Ringing again re-rings the same call.
    await api('POST', '/voice-channels/call-user', ann, { username: 'bob' });
    assert.strictEqual(rows({ kind: 'direct' })[0].id, ringing.id);
    const noAnswer = await annChat.next((m) => m.type === 'vc-call-response' && m.status === 'no-answer', 4000);
    assert.deepStrictEqual([noAnswer.fromUserId, noAnswer.fromUsername, noAnswer.channelId], [bob.id, 'bob', annCall]);
    const missed = lifecycle.get(ringing.id);
    assert.deepStrictEqual([missed.state, missed.end_reason], ['missed', 'timeout']);
    // bob's late "accepted" finds no ring to answer (the relay still goes, as on Live)
    assert.strictEqual((await api('POST', '/voice-channels/call-user/respond', bob, { caller_user_id: ann.id, channel_id: annCall, status: 'accepted' })).status, 200);
    assert.strictEqual(lifecycle.get(ringing.id).state, 'missed');
    // Six rings a minute (ann has used five).
    await api('POST', '/voice-channels/call-user', ann, { username: 'kay' });
    r = await api('POST', '/voice-channels/call-user', ann, { username: 'kay' });
    assert.deepStrictEqual([r.status, r.body.error], [429, 'Slow down — try again in a minute']);
    // Errors of the request itself.
    assert.strictEqual((await api('POST', '/voice-channels/call-user', eve, { username: 'nobody-here' })).status, 404);
    assert.strictEqual((await api('POST', '/voice-channels/call-user', eve, { username: 'eve' })).status, 400);
    await bye(annChat);
});

t('call-user: an invite that cannot be delivered is failed, with the reason', async () => {
    const orig = h.chatServer.sendDm;
    h.chatServer.sendDm = () => { throw new Error('socket layer down'); };
    let r;
    try { r = await api('POST', '/voice-channels/call-user', eve, { username: 'dan' }); } finally { h.chatServer.sendDm = orig; }
    assert.deepStrictEqual([r.status, r.body.error], [500, 'Failed to call user']);
    const row = rows({ kind: 'direct' })[0];
    assert.deepStrictEqual([row.created_by, row.state, row.end_reason], [eve.id, 'failed', 'invite_failed: socket layer down']);
    // Deleting a channel ends the rings still waiting on it (canceled).
    r = await api('POST', '/voice-channels/call-user', eve, { username: 'dan' });
    assert.strictEqual(rows({ kind: 'direct' })[0].state, 'ringing');
    await api('DELETE', `/voice-channels/${r.body.channel.id}`, eve);
    assert.deepStrictEqual([rows({ kind: 'direct' })[0].state, rows({ kind: 'direct' })[0].end_reason], ['ended', 'canceled']);
});

t('stream channel through /internal/calls: guard, create, join (legacy id), mode change, removal', async () => {
    const token = h.serviceToken(['chat.live_bridge.write']);
    const body = { stream_id: liveStream, mode: 'mic', user_id: streamer.id };
    const post = (b, opts = {}) => h.http('POST', '/internal/calls/stream-channel', { token, body: b, ...opts });
    assert.strictEqual((await h.http('POST', '/internal/calls/stream-channel', { body })).status, 401);
    assert.strictEqual((await h.http('POST', '/internal/calls/stream-channel', { token: h.serviceToken(['chat.presence.read']), body })).status, 403);
    assert.strictEqual((await h.http('POST', '/internal/calls/stream-channel', { token: h.serviceToken(['chat.live_bridge.write'], { aud: 'openvibe.live' }), body })).status, 401);
    assert.strictEqual((await post(body, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, 'loopback only');
    assert.strictEqual((await post({ ...body, mode: 'loud' })).status, 400);
    assert.strictEqual((await post({ ...body, stream_id: 'x' })).status, 400);

    let r = await post(body);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.channel.id, r.body.channel.name, r.body.channel.mode, r.body.channel.streamId, r.body.channel.createdBy], [`stream-${liveStream}`, 'Late show', 'mic', liveStream, streamer.id]);
    r = await api('GET', `/${liveStream}/call`, null);
    assert.deepStrictEqual(r.body, { call_mode: 'mic', channelId: `stream-${liveStream}`, participants: [], participant_count: 0 });

    const viewer = await join({ channelId: String(liveStream), token: bob.token, ip: '198.51.100.50' });
    assert.deepStrictEqual([viewer.welcome.channelId, viewer.welcome.callMode, viewer.welcome.isStreamer, viewer.welcome.canModerate], [`stream-${liveStream}`, 'mic', false, false]);
    const host = await join({ channelId: `stream-${liveStream}`, token: streamer.token, ip: '198.51.100.51' });
    assert.deepStrictEqual([host.welcome.isStreamer, host.welcome.canModerate], [true, true]);
    assert.strictEqual(host.welcome.participants.find((p) => p.username === 'streamy').isStreamer, true);
    r = await api('GET', `/${liveStream}/call`, null);
    assert.strictEqual(r.body.participant_count, 2);
    let session = rows({ channelId: `stream-${liveStream}` })[0];
    assert.deepStrictEqual([session.kind, session.state, session.stream_id, session.created_by], ['stream', 'active', liveStream, streamer.id]);

    // A new mode ends the call in progress (Live's createStreamChannel).
    r = await post({ ...body, mode: 'cam+mic' });
    assert.strictEqual(r.body.channel.mode, 'cam+mic');
    await viewer.next((m) => m.type === 'call-ended');
    await host.next((m) => m.type === 'call-ended');
    assert.deepStrictEqual([lifecycle.get(session.id).state, lifecycle.get(session.id).end_reason], ['ended', 'ended']);
    await bye(viewer, host);

    const v2 = await join({ channelId: `stream-${liveStream}`, token: bob.token, ip: '198.51.100.50' });
    assert.strictEqual(v2.welcome.callMode, 'cam+mic');
    session = rows({ channelId: `stream-${liveStream}` })[0];
    r = await h.http('DELETE', `/internal/calls/stream-channel/${liveStream}`, { token });
    assert.deepStrictEqual(r.body, { ok: true, removed: true });
    await v2.next((m) => m.type === 'call-ended');
    assert.deepStrictEqual([lifecycle.get(session.id).state, lifecycle.get(session.id).end_reason], ['ended', 'stream_ended']);
    assert.deepStrictEqual((await api('GET', `/${liveStream}/call`, null)).body, { call_mode: null, channelId: null, participants: [], participant_count: 0 });
    assert.deepStrictEqual((await h.http('DELETE', `/internal/calls/stream-channel/${liveStream}`, { token })).body, { ok: true, removed: false });
    const gone = await join({ channelId: `stream-${liveStream}`, token: bob.token, ip: '198.51.100.50' });
    assert.strictEqual(gone.error, 'Voice channel not found');
    await bye(v2);

    // A stream that is not live has a channel nobody can join.
    await post({ stream_id: offStream, mode: 'mic', user_id: streamer.id });
    const off = await join({ channelId: `stream-${offStream}`, token: bob.token, ip: '198.51.100.52' });
    assert.strictEqual(off.error, 'Stream not live');
    await h.http('DELETE', `/internal/calls/stream-channel/${offStream}`, { token });
});

t('PUT /api/streams/:id/call: the streamer only, a live stream only, a known mode', async () => {
    assert.strictEqual((await api('PUT', `/${liveStream}/call`, null, { call_mode: 'mic' })).status, 401);
    assert.deepStrictEqual([(await api('PUT', `/${liveStream}/call`, bob, { call_mode: 'mic' })).status], [403]);
    assert.strictEqual((await api('PUT', '/999999/call', streamer, { call_mode: 'mic' })).status, 404);
    assert.strictEqual((await api('PUT', `/${offStream}/call`, streamer, { call_mode: 'mic' })).status, 400);
    assert.strictEqual((await api('PUT', `/${liveStream}/call`, streamer, { call_mode: 'loud' })).status, 400);
    let r = await api('PUT', `/${liveStream}/call`, streamer, { call_mode: 'mic+cam' });
    assert.deepStrictEqual(r.body, { call_mode: 'mic+cam', channelId: `stream-${liveStream}`, participants: [], participant_count: 0 });
    assert.strictEqual((await api('GET', `/${liveStream}/call`, null)).body.call_mode, 'mic+cam');
    r = await api('PUT', `/${liveStream}/call`, streamer, { call_mode: null });
    assert.deepStrictEqual(r.body, { call_mode: null, channelId: null, participants: [], participant_count: 0 });
    assert.ok(!callServer.channels.has(`stream-${liveStream}`));
    assert.strictEqual((await api('GET', '/999999/call', null)).status, 404);
});

t('lifecycle: transitions are one-way; a restart closes what was left open', async () => {
    const d = lifecycle.openDirect({ callerId: ann.id, targetId: kay.id, channelId: 'user-x' });
    assert.strictEqual(d.state, 'pending');
    assert.strictEqual(lifecycle.transition(d.id, 'active'), null, 'pending cannot become active without ringing');
    assert.strictEqual(lifecycle.transition(d.id, 'declined'), null);
    lifecycle.ring(d.id, { timeoutMs: 60000 });
    const declined = lifecycle.respond({ callerId: ann.id, targetId: kay.id, channelId: 'user-x', status: 'declined' });
    assert.strictEqual(declined.state, 'declined');
    assert.strictEqual(lifecycle.transition(d.id, 'active'), null, 'a final state stays final');
    assert.strictEqual(lifecycle.respond({ callerId: ann.id, targetId: kay.id, channelId: 'user-x', status: 'accepted' }), null);

    const pending = lifecycle.openDirect({ callerId: bob.id, targetId: kay.id, channelId: 'user-y' });
    const ringing = lifecycle.ring(lifecycle.openDirect({ callerId: cat.id, targetId: kay.id, channelId: 'user-z' }).id, { timeoutMs: 60000 });
    const active = lifecycle.sessionStarted({ channelId: 'user-z' });
    assert.strictEqual(lifecycle.sessionStarted({ channelId: 'user-z' }).id, active.id, 'one session per channel');
    const out = lifecycle.recover();
    assert.ok(out.failed >= 1 && out.missed >= 1 && out.ended >= 1, JSON.stringify(out));
    assert.deepStrictEqual([lifecycle.get(pending.id).state, lifecycle.get(pending.id).end_reason], ['failed', 'restart']);
    assert.deepStrictEqual([lifecycle.get(ringing.id).state, lifecycle.get(ringing.id).end_reason], ['missed', 'restart']);
    assert.deepStrictEqual([lifecycle.get(active.id).state, lifecycle.get(active.id).end_reason], ['ended', 'restart']);
    assert.strictEqual(h.db.get("SELECT COUNT(*) AS n FROM calls WHERE state IN ('pending', 'ringing', 'active')").n, 0);
});

t.run(async () => {
    try { if (callServer) callServer.close(); } catch { /* */ }
    if (h && h.close) await h.close();
});
