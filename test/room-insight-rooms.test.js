'use strict';
/**
 * Part 2 of the room insight (plan 2026-11-10): a server's channels and the rooms people make read the
 * same endpoint as Global. A public room is summarised; a private one is off until its owner turns it on;
 * a chat with Vibe is never; a Live channel chat is keyed `channel:<broadcaster user id>`.
 */
const assert = require('assert');
const { boot, suite, sqliteNow } = require('./helpers');

const t = suite('room-insight-rooms');
let h, db, rooms, chatAi, aiClient, owner, alice, pub, priv, streamer, channelId, streamId;

async function roomMsg(roomId, user, text) {
    return (await db.run(
        `INSERT INTO room_messages (room_id, user_id, subject_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [roomId, user.id, user.subject_id || null, text, sqliteNow()]
    )).lastInsertRowid;
}
async function chatMsg({ user, message, channelUserId }) {
    return (await db.run(
        `INSERT INTO chat_messages (stream_id, channel_user_id, user_id, subject_id, username, message, message_type, is_global, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, 'chat', 0, ?)`,
        [streamId, channelUserId, user.id, user.subject_id || null, user.username, message, sqliteNow()]
    )).lastInsertRowid;
}
function aiStub(text) {
    aiClient._setClient({ runs: { create: async () => ({ run: { status: 'succeeded', output: {
        recent_overview: text, memory: 'memory line',
        timeline: [{ label: 'a moment', detail: 'detail', mins_ago: 2 }],
    } } }) } });
}

t('boot', async () => {
    h = await boot({ env: { CHAT_AI_ENABLED: '1' } });
    db = require('../server/db/database');
    rooms = require('../server/rooms/rooms');
    chatAi = require('../server/ai/chat-ai');
    aiClient = require('../server/ai/client');
    owner = h.addUser('roomowner', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B1' });
    alice = h.addUser('roomalice', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2' });
    streamer = h.addUser('roomstreamer', { subject: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B3' });
    h.consent.allowed.add(owner.subject_id);
    h.consent.allowed.add(alice.subject_id);
    h.consent.allowed.add(streamer.subject_id);
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
    pub = await rooms.create(owner, { name: 'Builders Room', slug: 'builders-room', visibility: 'public' });
    priv = await rooms.create(owner, { name: 'Secret Room', slug: 'secret-room', visibility: 'private' });
    assert.strictEqual(pub.insight, true, 'a public room is on by default');
    assert.strictEqual(priv.insight, false, 'a private room is off by default');
    await rooms.join(pub, alice);
    await db.run("INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')", [priv.id, alice.id]);
});

t('a public room is summarised and answers the same shape publicly', async () => {
    aiStub('the builders are planning the Friday stream');
    const id = await roomMsg(pub.id, alice, 'the friday stream needs a capture card capture card');
    await chatAi._refreshRoom({ id: pub.id, slug: pub.slug, max_id: id });

    const row = await db.getChatAiSummary('room', pub.id, 'rolling');
    assert.ok(row, 'a room summary row was written');
    assert.strictEqual(row.overview, 'the builders are planning the Friday stream');
    assert.ok(Number(row.people) >= 1);
    assert.ok(JSON.parse(row.topics_json).some((x) => x.label === 'capture'));

    const r = await h.http('GET', '/api/v1/rooms/builders-room/insight');   // no token
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'ready');
    assert.strictEqual(r.body.overview.text, 'the builders are planning the Friday stream');
    assert.ok(r.body.timeline.some((e) => e.title === 'a moment'));
});

t('a private room is off for its members and 404 for everyone else; its owner turns it on', async () => {
    let r = await h.http('GET', '/api/v1/rooms/secret-room/insight');
    assert.strictEqual(r.status, 404, 'not readable without a session');

    r = await h.http('GET', '/api/v1/rooms/secret-room/insight', { token: owner.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'off');
    assert.strictEqual(r.body.overview.text, '');
    assert.deepStrictEqual(r.body.timeline, []);

    // The owner's setting through the API the settings page uses.
    r = await h.http('PATCH', '/api/chat/rooms/secret-room', { token: owner.token, body: { ai_insight: true } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.room.insight, true);

    aiStub('the secret room decided on a date');
    const id = await roomMsg(priv.id, alice, 'secret date decided');
    await chatAi._refreshRoom({ id: priv.id, slug: priv.slug, max_id: id });

    r = await h.http('GET', '/api/v1/rooms/secret-room/insight', { token: owner.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'ready');
    assert.strictEqual(r.body.overview.text, 'the secret room decided on a date');
    r = await h.http('GET', '/api/v1/rooms/secret-room/insight');
    assert.strictEqual(r.status, 404, 'still not readable signed out');
});

t('a chat with Vibe never answers, and the settings page offers the switch', async () => {
    const vibe = await db.run("INSERT INTO rooms (slug, name, kind, visibility, owner_id, owner_subject, assistant) VALUES ('vibechat', 'Vibe', 'community', 'private', ?, ?, 1)", [owner.id, owner.subject_id]);
    const r = await h.http('GET', '/api/v1/rooms/vibechat/insight', { token: owner.token });
    assert.strictEqual(r.status, 404);
    assert.ok(vibe.lastInsertRowid);

    const page = await fetch(`${h.base}/r/builders-room/settings`, { headers: { cookie: `ov_token=${owner.token}` } }).then((x) => x.text());
    assert.ok(page.includes('AI insight'), 'the room settings offer the switch');
    assert.ok(page.includes('name="ai_insight"'));
});

t('a Live channel chat answers under channel:<broadcaster id>', async () => {
    aiStub('the channel is talking about the new patch');
    const id = await chatMsg({ user: alice, message: 'the patch notes are wild', channelUserId: streamer.id });
    await chatAi._refreshChannel({ channel_id: streamer.id, max_id: id });

    const row = await db.getChatAiSummary('channel', streamer.id, 'rolling');
    assert.ok(row, 'a channel summary row was written');
    const r = await h.http('GET', `/api/v1/rooms/channel:${streamer.id}/insight`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'ready');
    assert.strictEqual(r.body.overview.text, 'the channel is talking about the new patch');
});

t('a server channel is a room and answers the same way', async () => {
    const serverId = (await db.run("INSERT INTO chat_servers (slug, name, visibility, owner_id, owner_subject) VALUES ('buildsrv', 'Build Server', 'public', ?, ?)", [owner.id, owner.subject_id])).lastInsertRowid;
    await db.run("INSERT INTO chat_server_members (server_id, user_id, role) VALUES (?, ?, 'owner')", [serverId, owner.id]);
    const roomId = (await db.run("INSERT INTO rooms (slug, name, kind, visibility, owner_id, owner_subject, server_id, channel_slug) VALUES ('general', 'general', 'community', 'public', ?, ?, ?, 'general')", [owner.id, owner.subject_id, serverId])).lastInsertRowid;
    aiStub('the channel is picking a launch date');
    const id = await roomMsg(roomId, alice, 'launch date talk');
    await chatAi._refreshRoom({ id: roomId, slug: 'general', max_id: id });
    const r = await h.http('GET', '/api/v1/rooms/general/insight');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'ready');
    assert.strictEqual(r.body.overview.text, 'the channel is picking a launch date');
});

t('the room job discovers rooms with new messages, not the ones switched off', async () => {
    await roomMsg(pub.id, alice, 'one more line so the room has news');
    const candidates = await db.getRoomsNeedingInsight({
        threshold: 1, staleCutoffIso: sqliteNow(24 * 3600e3), sinceTs: sqliteNow(-14 * 86400e3), limit: 10,
    });
    const slugs = candidates.map((c) => c.slug);
    assert.ok(slugs.includes('builders-room'), JSON.stringify(slugs));
    assert.ok(!slugs.includes('vibechat'), 'a chat with Vibe is never a candidate');
});

t.run(async () => { try { chatAi.stop(); } catch { /* */ } });
