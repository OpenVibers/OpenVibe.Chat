'use strict';
/**
 * Room kinds and roles (WS-I task 4, server/rooms/rooms.js): community, call and system rooms; the
 * roles owner, mod, speaker, participant, member, viewer and blocked with what each may do per kind
 * (the whole matrix, public and private, signed out, staff, a site ban); roles belong to their kind and
 * mods are the owner's; joining gives the kind's role. Call rooms (server/calls/call-server.js): the
 * room decides who is in the call (private rooms look missing, blocked people are refused) and who
 * talks (listeners are force-muted and cannot unmute); a role change reaches a running call at once;
 * a ban in the call blocks the person in the room; room calls stay out of the voice-channel list.
 * Attachments: a room's manager attaches it to a Community space with their own token, idempotently,
 * and detaches it; nobody else can, and a private room stays a 404 to outsiders.
 */
const assert = require('assert');
const WebSocket = require('ws');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('room kinds');
let h, rooms;
let own, md, spk, par, mem, vw, blk, out, staff, banned, bot;
const api = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });

function callWs({ channelId, token = null, ip = '203.0.113.30' } = {}) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams({ channelId });
        if (token) qs.set('token', token);
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/call?${qs}`, { headers: { 'cf-connecting-ip': ip, origin: 'https://openvibe.live' } });
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
                w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timed out waiting (got: ${JSON.stringify(all.map((x) => x.type).slice(-12))})`)); }, ms);
                waiters.push(w);
            });
        };
        ws.none = async (pred, ms = 300) => { await new Promise((r) => setTimeout(r, ms)); return !all.some(pred); };
        ws.sendJson = (o) => ws.send(JSON.stringify(o));
        ws.closed = new Promise((r) => ws.on('close', () => r(true)));
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}
async function joinCall(opts) {
    const ws = await callWs(opts);
    const m = await ws.next((x) => x.type === 'welcome' || x.type === 'error');
    ws.welcome = m.type === 'welcome' ? m : null;
    ws.error = m.type === 'error' ? m.message : null;
    return ws;
}
const bye = async (...sockets) => { for (const ws of sockets) if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); await ws.closed; } await h.sleep(30); };

t('boot (CHAT_CALLS=1)', async () => {
    h = await boot({ env: { CHAT_CALLS: '1' } });
    rooms = require('../server/rooms/rooms');
    const mk = (name, extra = {}) => h.addUser(name, { subject: ids.newId('user'), ...extra });
    own = mk('owner1'); md = mk('mod1'); spk = mk('speaker1'); par = mk('part1'); mem = mk('member1'); vw = mk('viewer1');
    blk = mk('blocked1'); out = mk('outsider1'); staff = mk('staff1', { role: 'global_mod' }); banned = mk('banned1');
    bot = h.addUser('bot1', { apiScopes: ['chat'] });
    for (const u of [own, md, spk, par, mem, vw, blk, out, staff, banned, bot]) h.ctx.upsertUser(h.live.users.get(u.id));
});

t('the matrix: what every role may do in every kind, public and private', async () => {
    // read, post, call join, talk, moderate, manage
    const EXPECT = {
        community: { owner: 'rp--mM', mod: 'rp--m-', member: 'rp----', viewer: 'r-----', blocked: '------' },
        call: { owner: 'rpjtmM', mod: 'rpjtm-', speaker: 'rpjt--', participant: 'rpj---', viewer: 'r-j---', blocked: '------' },
        system: { owner: 'rp--mM', mod: 'rp--m-', viewer: 'r-----', blocked: '------' },
    };
    const byRole = { mod: md, speaker: spk, participant: par, member: mem, viewer: vw, blocked: blk };
    const flags = (a) => ['read', 'post', 'join', 'talk', 'moderate', 'manage'].map((k, i) => (a[k] ? 'rpjtmM'[i] : '-')).join('');
    for (const kind of ['community', 'call', 'system']) {
        for (const visibility of ['public', 'private']) {
            const owner = kind === 'system' ? staff : own;
            const room = rooms.bySlug(rooms.create(owner, { name: `M ${kind} ${visibility}`, kind, visibility }).slug);
            assert.deepStrictEqual(rooms.KIND_ROLES[kind], Object.keys(EXPECT[kind]), `${kind}: its roles`);
            for (const role of Object.keys(EXPECT[kind])) if (role !== 'owner') rooms.setRole(room, owner, byRole[role].id, role);
            for (const [role, want] of Object.entries(EXPECT[kind])) {
                const who = role === 'owner' ? owner : byRole[role];
                const a = rooms.access(room, who);
                assert.strictEqual(a.role, role, `${kind}/${visibility}: ${who.username} is ${role}`);
                // A system room's owner is chat staff: they may post and manage anyway.
                assert.strictEqual(flags(a), want, `${kind}/${visibility}/${role}`);
            }
            const pub = visibility === 'public';
            const listen = kind === 'call' && pub ? 'j' : '-';
            assert.strictEqual(flags(rooms.access(room, out)), pub ? `r-${listen}---` : '------', `${kind}/${visibility}: signed in, no role`);
            assert.strictEqual(flags(rooms.access(room, null)), pub ? `r-${listen}---` : '------', `${kind}/${visibility}: signed out`);
            if (kind !== 'system') assert.strictEqual(flags(rooms.access(room, staff)), `r-${kind === 'call' ? 'jt' : '--'}mM`, `${kind}/${visibility}: chat staff without a role`);
            else assert.strictEqual(flags(rooms.access(room, staff)), 'rp--mM', 'system: staff post');
        }
    }
    // A site ban: reading stays, posting and talking go, whatever the role.
    const room = rooms.bySlug(rooms.create(own, { name: 'Banned Test', kind: 'call' }).slug);
    rooms.setRole(room, own, banned.id, 'speaker');
    assert.strictEqual(flags(rooms.access(room, banned)), 'rpjt--');
    h.live.addBan({ user_id: banned.id });
    await h.ctx.invalidateBans();
    assert.strictEqual(flags(rooms.access(room, banned)), 'r-j---', 'banned: reads and listens only');
    h.live.clearBans();
    await h.ctx.invalidateBans();
});

t('roles belong to their kind, mods are the owner\'s, and joining gives the kind\'s role', async () => {
    let r = await api('POST', '/', own, { name: 'Open Stage', kind: 'call' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.room.kind, r.body.room.join_role, r.body.room.call_channel], ['call', 'participant', 'room-open-stage']);
    assert.deepStrictEqual([(await api('POST', '/', own, { name: 'My News', kind: 'system' })).status, (await api('POST', '/', own, { name: 'My News', kind: 'system' })).body.code], [403, 'rooms.kind'], 'people do not make system rooms');
    assert.strictEqual((await api('POST', '/', staff, { name: 'OpenVibe News', kind: 'system' })).status, 201);
    assert.strictEqual((await api('POST', '/', own, { name: 'Odd Join', join_role: 'speaker' })).body.code, 'rooms.join_role', 'join_role is for call rooms');
    assert.strictEqual((await api('POST', '/', own, { name: 'Tea Talk' })).status, 201);

    r = await api('POST', '/tea-talk/members', own, { username: 'speaker1', role: 'speaker' });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'rooms.role_kind'], 'no speakers in a community room');
    assert.strictEqual((await api('POST', '/open-stage/members', own, { username: 'member1', role: 'member' })).body.code, 'rooms.role_kind', 'no members in a call room');
    assert.strictEqual((await api('POST', '/openvibe-news/members', staff, { username: 'part1', role: 'participant' })).body.code, 'rooms.role_kind');

    // Joining: community → member, call → the room's join role, system → viewer.
    assert.strictEqual((await api('POST', '/tea-talk/join', mem)).body.role, 'member');
    assert.strictEqual((await api('POST', '/open-stage/join', par)).body.role, 'participant');
    assert.strictEqual((await api('POST', '/openvibe-news/join', out)).body.role, 'viewer');
    r = await api('PATCH', '/open-stage', own, { join_role: 'speaker' });
    assert.strictEqual(r.body.room.join_role, 'speaker');
    assert.strictEqual((await api('POST', '/open-stage/join', spk)).body.role, 'speaker');
    assert.strictEqual((await api('PATCH', '/tea-talk', own, { join_role: 'speaker' })).body.code, 'rooms.join_role');
    await api('PATCH', '/open-stage', own, { join_role: 'participant' });

    // Mods: the owner appoints them; a mod sets the other roles but not mods.
    assert.strictEqual((await api('POST', '/open-stage/members', own, { username: 'mod1', role: 'mod' })).body.role, 'mod');
    r = await api('POST', '/open-stage/members', md, { username: 'part1', role: 'speaker' });
    assert.deepStrictEqual([r.status, r.body.role], [200, 'speaker'], 'a mod makes speakers');
    assert.strictEqual((await api('POST', '/open-stage/members', md, { username: 'member1', role: 'mod' })).status, 403, 'only the owner appoints mods');
    assert.strictEqual((await api('POST', '/open-stage/members', par, { username: 'member1', role: 'viewer' })).status, 403, 'a speaker is not a moderator');
    await api('POST', '/open-stage/members', md, { username: 'part1', role: 'participant' });
    const log = h.db.all("SELECT action_type, details FROM moderation_actions WHERE scope_type = 'room' AND scope_id = 'open-stage' ORDER BY id").map((x) => x.action_type);
    assert.deepStrictEqual(log, ['room_mod_add', 'room_speaker_add', 'room_speaker_remove']);

    // Posting follows the role: viewers and system-room viewers read only; staff post in system rooms.
    assert.strictEqual((await api('POST', '/openvibe-news/messages', out, { message: 'can I?' })).body.code, 'rooms.read_only');
    assert.strictEqual((await api('POST', '/openvibe-news/messages', staff, { message: 'Maintenance tonight at 22:00 UTC.' })).status, 201);
    await api('POST', '/tea-talk/members', own, { username: 'viewer1', role: 'viewer' });
    assert.strictEqual((await api('POST', '/tea-talk/messages', vw, { message: 'hello' })).body.code, 'rooms.read_only');
    assert.strictEqual((await api('POST', '/open-stage/messages', par, { message: 'participants write' })).status, 201);
    assert.strictEqual((await api('POST', '/open-stage/join', vw)).status, 200);
    await api('POST', '/open-stage/members', own, { username: 'viewer1', role: 'viewer' });
    assert.strictEqual((await api('POST', '/open-stage/messages', vw, { message: 'viewers do not' })).body.code, 'rooms.read_only');

    // What the room page reads: the caller's powers and the call.
    r = await api('GET', '/open-stage', par);
    assert.deepStrictEqual(r.body.can, { read: true, post: true, join: true, talk: false, moderate: false, manage: false });
    assert.deepStrictEqual([r.body.call.enabled, r.body.call.channel, r.body.call.participants], [true, 'room-open-stage', 0]);
    assert.strictEqual((await api('GET', '/tea-talk', null)).body.call, undefined, 'community rooms have no call');

    // last_seen_at: moderators see it, others do not.
    const seenMod = (await api('GET', '/open-stage/members', own)).body.members.find((m) => m.username === 'part1');
    assert.ok(seenMod.last_seen_at, 'posting counts as seen');
    assert.ok(!('last_seen_at' in (await api('GET', '/open-stage/members', par)).body.members[0]), 'presence is for moderators');
});

t('call rooms: the room decides who is in the call and who talks', async () => {
    const ownWs = await joinCall({ channelId: 'room-open-stage', token: own.token });
    assert.ok(ownWs.welcome, ownWs.error);
    assert.deepStrictEqual([ownWs.welcome.room, ownWs.welcome.roomRole, ownWs.welcome.canTalk, ownWs.welcome.canModerate], ['open-stage', 'owner', true, true]);

    const parWs = await joinCall({ channelId: 'room-open-stage', token: par.token, ip: '203.0.113.31' });
    assert.deepStrictEqual([parWs.welcome.roomRole, parWs.welcome.canTalk, parWs.welcome.canModerate], ['participant', false, false]);
    await parWs.next((m) => m.type === 'force-muted' && m.forceMuted === true);
    const joined = await ownWs.next((m) => m.type === 'peer-joined');
    assert.deepStrictEqual([joined.roomRole, joined.canTalk, joined.forceMuted], ['participant', false, true], 'everyone sees who may talk');

    // Signalling works both ways; a listener's own unmute is ignored.
    parWs.sendJson({ type: 'offer', targetPeerId: ownWs.welcome.peerId, sdp: { type: 'offer', sdp: 'v=0 listener' } });
    assert.strictEqual((await ownWs.next((m) => m.type === 'offer')).sdp.sdp, 'v=0 listener');
    parWs.sendJson({ type: 'mute', muted: false });
    assert.ok(await ownWs.none((m) => m.type === 'peer-muted' && m.peerId === parWs.welcome.peerId), 'a listener stays muted');

    // Anyone may listen in a public call room; a moderator cannot lift a listener's mute (make them a speaker instead).
    const anonWs = await joinCall({ channelId: 'room-open-stage', ip: '203.0.113.32' });
    assert.deepStrictEqual([anonWs.welcome.canTalk, anonWs.welcome.roomRole], [false, null]);
    ownWs.sendJson({ type: 'force-mute', targetPeerId: anonWs.welcome.peerId, forceMuted: false });
    assert.ok(await anonWs.none((m) => m.type === 'force-muted' && m.forceMuted === false));

    // Room calls are not in Live's voice-channel list, but the room's own page shows them.
    const list = await h.http('GET', '/api/streams/voice-channels');
    assert.ok(!JSON.stringify(list.body).includes('room-open-stage'), 'not in the voice sidebar');
    assert.strictEqual((await api('GET', '/open-stage', null)).body.call.participants, 3);

    // Private call rooms look missing to outsiders; invited people get in; blocked people never do.
    await api('POST', '/', own, { name: 'Back Stage', kind: 'call', visibility: 'private' });
    let ws = await joinCall({ channelId: 'room-back-stage', token: out.token, ip: '203.0.113.33' });
    assert.strictEqual(ws.error, 'Voice channel not found');
    await api('POST', '/back-stage/members', own, { username: 'outsider1', role: 'participant' });
    ws = await joinCall({ channelId: 'room-back-stage', token: out.token, ip: '203.0.113.33' });
    assert.ok(ws.welcome, 'invited');
    await bye(ws);
    await api('POST', '/back-stage/members', own, { username: 'outsider1', role: 'blocked' });
    ws = await joinCall({ channelId: 'room-back-stage', token: out.token, ip: '203.0.113.33' });
    assert.strictEqual(ws.error, 'Voice channel not found');
    ws = await joinCall({ channelId: 'room-tea-talk', token: own.token, ip: '203.0.113.34' });
    assert.strictEqual(ws.error, 'Voice channel not found', 'only call rooms have a call');
    await bye(anonWs);
    h._stage = { ownWs, parWs };
});

t('a role change reaches the running call at once; a ban in the call blocks in the room', async () => {
    const { ownWs, parWs } = h._stage;
    let r = await api('POST', '/open-stage/members', own, { username: 'part1', role: 'speaker' });
    assert.strictEqual(r.body.role, 'speaker');
    const role = await parWs.next((m) => m.type === 'room-role');
    assert.deepStrictEqual([role.role, role.canTalk], ['speaker', true]);
    await parWs.next((m) => m.type === 'force-muted' && m.forceMuted === false);
    const upd = await ownWs.next((m) => m.type === 'peer-updated' && m.peerId === parWs.welcome.peerId);
    assert.deepStrictEqual([upd.roomRole, upd.canTalk], ['speaker', true]);
    parWs.sendJson({ type: 'mute', muted: false });
    assert.strictEqual((await ownWs.next((m) => m.type === 'peer-muted' && m.peerId === parWs.welcome.peerId)).muted, false, 'a speaker unmutes');

    await api('POST', '/open-stage/members', md, { username: 'part1', role: 'viewer' });
    assert.strictEqual((await parWs.next((m) => m.type === 'room-role')).canTalk, false, 'demoted: listening again');
    await parWs.next((m) => m.type === 'force-muted' && m.forceMuted === true);

    await api('POST', '/open-stage/members', own, { username: 'part1', role: 'blocked' });
    await parWs.closed;
    assert.ok(parWs.all.some((m) => m.type === 'error'), 'told before being dropped');
    await ownWs.next((m) => m.type === 'peer-left' && m.peerId === parWs.welcome.peerId);

    // A ban from inside the call is the room's block.
    await api('POST', '/open-stage/members', own, { username: 'speaker1', role: 'speaker' });
    const spkWs = await joinCall({ channelId: 'room-open-stage', token: spk.token, ip: '203.0.113.35' });
    assert.strictEqual(spkWs.welcome.canTalk, true);
    ownWs.sendJson({ type: 'ban', targetPeerId: spkWs.welcome.peerId });
    await spkWs.closed;
    const room = rooms.bySlug('open-stage');
    assert.strictEqual(rooms.access(room, spk).role, 'blocked');
    assert.strictEqual((await api('GET', '/open-stage', spk)).status, 404, 'blocked: the room is gone for them');

    // Turning the room private drops people who are not members (a guest listening).
    const guest = await joinCall({ channelId: 'room-open-stage', ip: '203.0.113.36' });
    assert.ok(guest.welcome);
    r = await api('PATCH', '/open-stage', own, { visibility: 'private' });
    assert.strictEqual(r.status, 200, r.text);
    await guest.closed;
    assert.ok(ownWs.readyState === WebSocket.OPEN, 'the owner stays');
    await bye(ownWs);
});

t('attachments: a manager attaches with their own token, idempotently; detach; nobody else can', async () => {
    let r = await api('POST', '/tea-talk/attachments', own, { service: 'community', resource: 'general', title: 'General' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.created, r.body.attachment.service, r.body.attachment.resource, r.body.room.slug], [true, 'community', 'general', 'tea-talk']);
    r = await api('POST', '/tea-talk/attachments', own, { service: 'community', resource: 'general', title: 'General' });
    assert.deepStrictEqual([r.status, r.body.created], [200, false], 'the same attachment again is a no-op');
    assert.strictEqual(h.db.get("SELECT COUNT(*) AS n FROM room_attachments WHERE resource = 'general'").n, 1);
    assert.strictEqual((await api('POST', '/tea-talk/attachments', mem, { service: 'community', resource: 'help' })).status, 403, 'members do not attach');
    assert.strictEqual((await api('POST', '/back-stage/attachments', out, { service: 'community', resource: 'help' })).status, 404, 'a private room stays missing');
    assert.strictEqual((await api('POST', '/tea-talk/attachments', bot, { service: 'community', resource: 'help' })).status, 403, 'API tokens do not attach');
    assert.strictEqual((await api('POST', '/tea-talk/attachments', own, { service: 'discord', resource: 'x' })).body.code, 'rooms.attach_service');
    assert.strictEqual((await api('POST', '/tea-talk/attachments', own, { service: 'community', resource: '../evil' })).body.code, 'rooms.attach_resource');
    assert.strictEqual((await api('POST', '/tea-talk/attachments', null, { service: 'community', resource: 'help' })).status, 401);
    r = await api('GET', '/tea-talk/attachments', own);
    assert.deepStrictEqual(r.body.attachments.map((a) => [a.service, a.resource, a.title]), [['community', 'general', 'General']]);
    assert.strictEqual((await api('GET', '/tea-talk/attachments', mem)).status, 403);
    assert.strictEqual((await api('DELETE', '/tea-talk/attachments/community/general', mem)).status, 403, 'nor detach');
    r = await api('DELETE', '/tea-talk/attachments/community/general', own);
    assert.deepStrictEqual([r.status, r.body.removed], [200, true]);
    r = await api('DELETE', '/tea-talk/attachments/community/general', own);
    assert.deepStrictEqual([r.status, r.body.removed], [200, false], 'detaching twice is fine');
    // Chat staff manage every room, so they may attach one too; whoever attached may detach.
    assert.strictEqual((await api('POST', '/tea-talk/attachments', staff, { service: 'community', resource: 'help' })).status, 201);
    assert.strictEqual((await api('DELETE', '/tea-talk/attachments/community/help', staff)).body.removed, true);
});

t('the site: kinds on the rooms page, the call panel, roles and attachments in settings', async () => {
    const page = async (path, u) => { const r = await fetch(`${h.base}${path}`, { headers: u ? { cookie: `ov_token=${u.token}` } : {}, redirect: 'manual' }); return { status: r.status, text: await r.text() }; };
    let r = await page('/rooms', own);
    assert.match(r.text, /name="kind" value="call"/);
    assert.ok(!r.text.includes('value="system"'), 'people are not offered system rooms');
    assert.match((await page('/rooms', staff)).text, /name="kind" value="system"/);
    assert.match((await page('/rooms', null)).text, /<span class="oc-badge oc-kind-system">announcements<\/span>/);

    r = await page('/r/open-stage', own);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /<span class="oc-badge oc-kind-call">call<\/span>/);
    assert.match(r.text, /id="oc-call-join" hidden>Join the call</);
    assert.match(r.text, /\/web\/call\.js\?v=/);
    const cfg = JSON.parse(r.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
    assert.deepStrictEqual(cfg.chat.call, { channel: 'room-open-stage', join: true, talk: true });
    assert.strictEqual((await page('/r/open-stage', out)).status, 404, 'private now: not there for outsiders');
    await api('POST', '/open-stage/members', own, { username: 'member1', role: 'participant' });
    r = await page('/r/open-stage', mem);
    assert.match(r.text, /id="oc-call-join" hidden>Listen in</);
    assert.match(r.text, /you are a participant/);

    r = await page('/r/open-stage/settings', own);
    for (const role of ['moderator', 'speaker', 'participant', 'viewer', 'blocked']) assert.ok(r.text.includes(`>${role}</option>`), role);
    assert.ok(!r.text.includes('>member</option>'), 'call rooms have no members, they have participants');
    assert.match(r.text, /name="join_role"/);
    assert.match(r.text, /Speakers, moderators and the owner talk in the call/);
    assert.match(r.text, /· seen <time/, 'moderators see when people were last here');
    await api('POST', '/tea-talk/attachments', own, { service: 'community', resource: 'general', title: 'General <b>' });
    r = await page('/r/tea-talk/settings', own);
    assert.match(r.text, /<a href="https:\/\/openvibe\.community\/s\/general">General &lt;b&gt;<\/a>/);
    assert.match(r.text, /action="\/r\/tea-talk\/attachments\/community\/general\/detach"/);
    assert.ok(!(await page('/r/tea-talk', own)).text.includes('openvibe.community/s/general'), 'the room page itself makes no claim about the space');

    r = await page('/r/openvibe-news', out);
    assert.match(r.text, /Announcements from OpenVibe staff/);
    assert.ok(!r.text.includes('id="oc-compose"'));
    assert.match((await page('/r/openvibe-news', staff)).text, /placeholder="Post an announcement"/);
});

t('chat sockets following a room learn their new role at once, or leave', async () => {
    const ws = await h.ws({ token: vw.token });
    ws.sendJson({ type: 'join_room', room: 'tea-talk' });
    const joined = await ws.next((m) => m.type === 'room_joined');
    assert.deepStrictEqual([joined.kind, joined.role, joined.can.post], ['community', 'viewer', false]);
    ws.sendJson({ type: 'room_message', message: 'viewers cannot' });
    assert.strictEqual((await ws.next((m) => m.type === 'room_error')).code, 'rooms.read_only');
    await api('POST', '/tea-talk/members', own, { username: 'viewer1', role: 'member' });
    const acc = await ws.next((m) => m.type === 'room_access');
    assert.deepStrictEqual([acc.role, acc.can.post], ['member', true]);
    ws.sendJson({ type: 'room_message', message: 'members can' });
    await ws.next((m) => m.type === 'room_message' && m.message.message === 'members can');
    await api('PATCH', '/tea-talk', own, { visibility: 'private' });
    assert.strictEqual((await ws.next((m) => m.type === 'room_access')).role, 'member', 'private now, but a member: still reading');
    await api('POST', '/tea-talk/members', own, { username: 'viewer1', role: 'none' });
    await ws.next((m) => m.type === 'room_left');
    ws.close();
});

t('ICE servers for calls: STUN, and TURN only with credentials (short-lived with TURN_AUTH_SECRET)', async () => {
    const crypto = require('crypto');
    const turn = require('../server/net/turn');
    assert.deepStrictEqual((await h.http('GET', '/api/chat/ice-servers')).body.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }], 'no TURN configured: STUN only');
    const at = Date.UTC(2026, 8, 26, 12);
    const eph = turn.iceServers('u7', turn.turnConfig({ TURN_URL: 'turn:turn.example.org:3478', TURN_AUTH_SECRET: 's3cret' }), at);
    const user = `${Math.floor(at / 1000) + turn.TTL_SECONDS}:u7`;
    assert.deepStrictEqual(eph.iceServers.slice(1), [
        { urls: 'turn:turn.example.org:3478', username: user, credential: crypto.createHmac('sha1', 's3cret').update(user).digest('base64') },
        { urls: 'turn:turn.example.org:3478?transport=tcp', username: user, credential: crypto.createHmac('sha1', 's3cret').update(user).digest('base64') },
    ]);
    assert.strictEqual(eph.ephemeral, true);
    assert.strictEqual(turn.iceServers('anon', turn.turnConfig({ TURN_URL: 'turn://turn.example.org' })).iceServers.length, 1, 'a turn: URL without credentials is left out');
    assert.strictEqual(turn.iceServers('anon', turn.turnConfig({ TURN_URL: 'turn:turn.example.org', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' })).iceServers[1].username, 'u');
    assert.strictEqual(turn.normalizeTurnUrl('turn:user:pw@evil.example'), '', 'no credentials inside the URL');
    assert.strictEqual(turn.normalizeTurnUrl('https://turn.example.org'), '');
});

t.run(async () => { if (h && h.close) await h.close(); });
