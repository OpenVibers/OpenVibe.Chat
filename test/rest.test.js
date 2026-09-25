'use strict';
/**
 * REST parity for the routes nginx sends to Chat: /api/dm/* (conversations, messages, read,
 * participants, blocks, unread, user search), /api/chat/* history (global page + cursor delta,
 * stream scopes, replay, search/logs gates), profile card and anon info through Live, GIF
 * provider flags from Live's settings, /api/tts settings, and Live's auth answers (401/403 shapes,
 * API-token scopes).
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('rest');
let h, streamer, alice, bob, carol, staff, apiBot, channelId, streamId;

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('streamer', { role: 'streamer' });
    alice = h.addUser('alice');
    bob = h.addUser('bob');
    carol = h.addUser('carol');
    staff = h.addUser('staff', { role: 'global_mod' });
    apiBot = h.addUser('botowner', { apiScopes: ['read'] });
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    h.live.settings.gif_tenor_api_key = 'tenor-key';
    await h.ctx.sync();
});

t('auth errors keep Live’s shapes', async () => {
    assert.deepStrictEqual((await h.http('GET', '/api/dm/conversations')).body, { error: 'Authentication required' });
    const bad = await h.http('GET', '/api/dm/conversations', { token: 'nope' });
    assert.strictEqual(bad.status, 401);
    assert.deepStrictEqual(bad.body, { error: 'Invalid or expired token' });
    // An API token with only a read scope can read but not write chat.
    assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: apiBot.token })).status, 200);
    const w = await h.http('POST', '/api/dm/conversations', { token: apiBot.token, body: { user_ids: [alice.id] } });
    assert.strictEqual(w.status, 403);
    assert.deepStrictEqual(w.body, { error: 'This API token\'s scopes do not allow this request' });
});

let convId, groupId;
t('DMs: create 1:1 (idempotent), send, list with unread, read, delete own message', async () => {
    const a = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(a.status, 200, a.text);
    convId = a.body.conversation.id;
    const again = await h.http('POST', '/api/dm/conversations', { token: bob.token, body: { user_ids: [alice.id] } });
    assert.strictEqual(again.body.conversation.id, convId, 'the same 1:1 conversation');
    const sent = await h.http('POST', `/api/dm/conversations/${convId}/messages`, { token: alice.token, body: { message: '  hi bob  ' } });
    assert.strictEqual(sent.body.message.message, 'hi bob');
    assert.strictEqual(sent.body.message.username, 'alice');
    assert.strictEqual(sent.body.message.display_name, 'Alice');
    const list = await h.http('GET', '/api/dm/conversations', { token: bob.token });
    const c = list.body.conversations.find((x) => x.id === convId);
    assert.strictEqual(c.unread_count, 1);
    assert.strictEqual(c.last_message, 'hi bob');
    assert.deepStrictEqual(c.participants.map((p) => p.username).sort(), ['alice', 'bob']);
    assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: bob.token })).body.unread, 1);
    assert.deepStrictEqual((await h.http('POST', `/api/dm/conversations/${convId}/read`, { token: bob.token })).body, { ok: true });
    assert.strictEqual((await h.http('GET', '/api/dm/unread', { token: bob.token })).body.unread, 0);
    assert.ok(h.live.effects.some((e) => e.name === 'notify/dm-read' && e.body.user_id === bob.id && e.body.conversation_id === convId));
    const msgs = await h.http('GET', `/api/dm/conversations/${convId}/messages`, { token: bob.token });
    assert.strictEqual(msgs.body.messages.length, 1);
    assert.ok(!('sender_subject_id' in msgs.body.messages[0]));
    const mid = msgs.body.messages[0].id;
    assert.strictEqual((await h.http('DELETE', `/api/dm/conversations/${convId}/messages/${mid}`, { token: bob.token })).status, 403, 'only the sender deletes');
    assert.strictEqual((await h.http('DELETE', `/api/dm/conversations/${convId}/messages/${mid}`, { token: alice.token })).status, 200);
});

t('DMs: participant checks on every conversation route', async () => {
    for (const [m, p, body] of [
        ['GET', `/api/dm/conversations/${convId}`],
        ['GET', `/api/dm/conversations/${convId}/messages`],
        ['POST', `/api/dm/conversations/${convId}/messages`, { message: 'x' }],
        ['POST', `/api/dm/conversations/${convId}/read`],
        ['POST', `/api/dm/conversations/${convId}/participants`, { user_id: carol.id }],
        ['PATCH', `/api/dm/conversations/${convId}`, { name: 'x' }],
    ]) {
        const r = await h.http(m, p, { token: carol.token, body });
        assert.strictEqual(r.status, 403, `${m} ${p}`);
        assert.deepStrictEqual(r.body, { error: 'Not a participant' });
    }
    // A 1:1 stays private: nobody can be added to it.
    const add = await h.http('POST', `/api/dm/conversations/${convId}/participants`, { token: alice.token, body: { user_id: carol.id } });
    assert.strictEqual(add.status, 400);
    assert.deepStrictEqual(add.body, { error: 'Start a group conversation to add people' });
});

t('DMs: groups, blocks, banned users, user search', async () => {
    const g = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [bob.id, carol.id], name: 'The <b>Crew</b>' } });
    groupId = g.body.conversation.id;
    assert.strictEqual(g.body.conversation.is_group, 1);
    assert.strictEqual(g.body.conversation.name, 'The Crew', 'HTML and odd characters stripped as before');
    // Blocks: bob blocks carol → carol cannot start a 1:1 with bob, bob no longer finds carol.
    assert.deepStrictEqual((await h.http('POST', `/api/dm/blocks/${carol.id}`, { token: bob.token })).body, { ok: true });
    assert.strictEqual((await h.http('GET', `/api/dm/blocks/check/${carol.id}`, { token: bob.token })).body.blocked, true);
    assert.deepStrictEqual((await h.http('GET', '/api/dm/blocks', { token: bob.token })).body.blocked.map((u) => u.username), ['carol']);
    const blocked = await h.http('POST', '/api/dm/conversations', { token: carol.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(blocked.status, 403);
    assert.deepStrictEqual((await h.http('GET', '/api/dm/users/search?q=car', { token: bob.token })).body.users, []);
    assert.deepStrictEqual((await h.http('GET', '/api/dm/users/search?q=car', { token: alice.token })).body.users.map((u) => u.username), ['carol']);
    await h.http('DELETE', `/api/dm/blocks/${carol.id}`, { token: bob.token });
    // A banned account cannot be messaged.
    h.live.users.get(carol.id).is_banned = 1;
    await h.ctx.sync();
    const toBanned = await h.http('POST', '/api/dm/conversations', { token: alice.token, body: { user_ids: [carol.id, streamer.id, bob.id, staff.id] } });
    assert.deepStrictEqual(toBanned.body, { error: 'Cannot message banned users' });
    h.live.users.get(carol.id).is_banned = 0;
    await h.ctx.sync();
    // Leave the group; only the creator removes others.
    assert.strictEqual((await h.http('DELETE', `/api/dm/conversations/${groupId}/participants/${alice.id}`, { token: bob.token })).status, 403);
    assert.deepStrictEqual((await h.http('DELETE', `/api/dm/conversations/${groupId}/participants/${bob.id}`, { token: bob.token })).body, { ok: true });
});

t('chat history: global page and cursor delta, deleted and expired rows hidden', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(Number(h.db.saveChatMessage({ stream_id: null, user_id: alice.id, username: 'Alice', message: `g${i}`, message_type: 'chat', is_global: true }).lastInsertRowid));
    h.db.deleteChatMessage(ids[1], staff.id);
    h.db.run("UPDATE chat_messages SET auto_delete_at = '2000-01-01 00:00:00' WHERE id = ?", [ids[2]]);
    const page = await h.http('GET', '/api/chat/global/history?limit=10');
    const got = page.body.messages.map((m) => m.message);
    assert.deepStrictEqual(got.filter((x) => /^g\d$/.test(x)), ['g0', 'g3', 'g4']);
    assert.strictEqual(page.body.latest_id, ids[4]);
    const delta = await h.http('GET', `/api/chat/global/history?after_id=${ids[3]}`);
    assert.deepStrictEqual(delta.body.messages.map((m) => m.message), ['g4']);
    assert.strictEqual(delta.body.complete, true);
    const small = await h.http('GET', `/api/chat/global/history?after_id=0&limit=1`);
    assert.strictEqual(small.body.complete, false, 'bigger gap than the limit → take a fresh page');
    // Channel filter by username (the owner of the source stream or the channel room).
    h.db.saveChatMessage({ stream_id: streamId, user_id: bob.id, username: 'Bob', message: 'in the stream', message_type: 'chat' });
    const byChan = await h.http('GET', '/api/chat/global/history?username=streamer');
    assert.deepStrictEqual(byChan.body.messages.map((m) => m.message), ['in the stream']);
    assert.strictEqual(byChan.body.messages[0].stream_channel, 'streamer');
});

t('chat logs and search are gated like Live', async () => {
    assert.strictEqual((await h.http('GET', `/api/chat/user/${bob.id}/history`, { token: alice.token })).status, 403);
    const own = await h.http('GET', `/api/chat/user/${alice.id}/history`, { token: alice.token });
    assert.ok(own.body.total >= 3);
    assert.ok(own.body.messages.every((m) => !('subject_id' in m)));
    const staffView = await h.http('GET', `/api/chat/user/${bob.id}/history`, { token: staff.token });
    assert.strictEqual(staffView.status, 200);
    // Search: non-staff only see their own lines whatever user_id they ask for.
    // (`total` is 0 in Live's search whatever matches — its count regex does not cross the
    // SELECT's line break — and stays so: parity, not a fix in this wave.)
    const s = await h.http('GET', `/api/chat/search?q=stream&user_id=${bob.id}`, { token: alice.token });
    assert.strictEqual(s.body.messages.length, 0);
    const s2 = await h.http('GET', `/api/chat/search?q=stream&user_id=${bob.id}`, { token: staff.token });
    assert.deepStrictEqual(s2.body.messages.map((m) => m.message), ['in the stream']);
    assert.strictEqual(s2.body.messages[0].u_username, 'bob');
    // Admin logs: a non-owner of the stream is refused.
    assert.strictEqual((await h.http('GET', `/api/chat/admin/logs?streamId=${streamId}`, { token: alice.token })).status, 403);
    const logs = await h.http('GET', `/api/chat/admin/logs?streamId=${streamId}`, { token: streamer.token });
    assert.strictEqual(logs.body.total, 1);
    // Anon logs need staff.
    assert.strictEqual((await h.http('GET', '/api/chat/anon/anon5/logs', { token: alice.token })).status, 403);
});

t('staff reading other people\'s logs is audited; your own chat exports; CSV cells are never formulas', async () => {
    const audits = () => h.db.all("SELECT action_type, actor_user_id, target_user_id FROM moderation_actions WHERE action_type LIKE 'chat_log_%' ORDER BY id");
    const before = audits().length;
    await h.http('GET', `/api/chat/search?q=stream&user_id=${alice.id}`, { token: alice.token });
    await h.http('GET', `/api/chat/user/${alice.id}/history`, { token: alice.token });
    await h.http('GET', `/api/chat/admin/logs?streamId=${streamId}`, { token: streamer.token });
    assert.strictEqual(audits().length, before, 'your own lines and your own stream are not audited');
    await h.http('GET', `/api/chat/search?q=stream&user_id=${bob.id}`, { token: staff.token });
    await h.http('GET', `/api/chat/user/${bob.id}/history`, { token: staff.token });
    await h.http('GET', `/api/chat/user/${bob.id}/history?offset=50`, { token: staff.token });
    h.db.saveChatMessage({ stream_id: streamId, user_id: bob.id, username: 'Bob', message: '=HYPERLINK("x")', message_type: 'chat' });
    const admin = h.addUser('exporter', { role: 'admin' });
    await h.ctx.sync();
    const ex = await h.http('GET', `/api/chat/admin/logs/export?streamId=${streamId}&format=csv`, { token: admin.token });
    assert.strictEqual(ex.status, 200);
    assert.ok(ex.text.includes(`"'=HYPERLINK(""x"")"`), 'a formula-looking message is text');
    const got = audits().slice(before);
    assert.deepStrictEqual(got.map((a) => a.action_type), ['chat_log_search', 'chat_log_view', 'chat_log_export'], 'search, first page viewed, export');
    assert.deepStrictEqual(got.map((a) => a.actor_user_id), [staff.id, staff.id, admin.id]);
    assert.deepStrictEqual(got.slice(0, 2).map((a) => a.target_user_id), [bob.id, bob.id]);

    const mine = await h.http('GET', '/api/chat/me/export', { token: alice.token });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.username, 'alice');
    assert.ok(mine.body.messages.length >= 3 && mine.body.messages.every((m) => typeof m.message === 'string'));
    assert.ok(!mine.body.messages.some((m) => m.message === 'in the stream'), 'only your own lines');
    assert.strictEqual(mine.body.truncated, false);
    const csv = await h.http('GET', '/api/chat/me/export?format=csv', { token: alice.token });
    assert.ok(csv.text.startsWith('id,timestamp,message,message_type,stream_id,stream_title,is_global\n'));
    assert.strictEqual((await h.http('GET', '/api/chat/me/export')).status, 401);
});

t('profile card and anon info come from Live', async () => {
    const p = await h.http('GET', '/api/chat/user/alice/profile', { token: bob.token });
    assert.strictEqual(p.body.username, 'alice');
    assert.ok(!('last_seen' in p.body), 'presence only for the user themselves');
    const own = await h.http('GET', '/api/chat/user/alice/profile', { token: alice.token });
    assert.ok('last_seen' in own.body);
    assert.strictEqual((await h.http('GET', '/api/chat/user/nobody/profile')).status, 404);
    h.live.anon.set('203.0.113.99', { num: 42, first_seen: '2026-01-01 00:00:00' });
    h.db.saveChatMessage({ stream_id: null, anon_id: 'anon42', username: 'anon42', message: 'hi', message_type: 'chat', is_global: true });
    const a = await h.http('GET', '/api/chat/anon/anon42');
    assert.deepStrictEqual({ ...a.body.anon, first_chat: !!a.body.anon.first_chat }, { anon_id: 'anon42', anon_num: 42, first_seen: '2026-01-01 00:00:00', first_chat: true, message_count: 1 });
    assert.strictEqual((await h.http('GET', '/api/chat/anon/bob')).status, 400);
});

t('settings-driven routes: GIF providers, TTS settings, friendly filters, unknown paths', async () => {
    const g = await h.http('GET', '/api/chat/gif/providers');
    assert.deepStrictEqual(g.body, { providers: { tenor: true, giphy: false }, defaultProvider: 'tenor' });
    const tts = await h.http('GET', '/api/tts/settings');
    assert.strictEqual(tts.body.enabled, true);
    assert.ok(!('googleApiKey' in tts.body), 'no credentials to the browser');
    assert.strictEqual((await h.http('GET', '/api/tts/admin/settings', { token: alice.token })).status, 403);
    const f = await h.http('GET', '/api/chat/filters/friendly');
    assert.ok(Array.isArray(f.body.categories) && f.body.categories.length);
    assert.deepStrictEqual((await h.http('GET', '/api/chat/nope/nope/nope')).body, { error: 'Not found' });
    // TTS clips: Live's stashed clips are served under the same URL.
    const clip = await h.http('GET', '/api/tts/audio/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3');
    assert.strictEqual(clip.status, 200);
    assert.strictEqual(clip.text, 'ID3live');
});

t('CORS: Live’s origins allowed with credentials, others refused', async () => {
    const ok = await h.http('GET', '/api/chat/filters/friendly', { headers: { Origin: 'https://openvibe.network' } });
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://openvibe.network');
    assert.strictEqual(ok.headers.get('access-control-allow-credentials'), 'true');
    const bad = await h.http('GET', '/api/chat/filters/friendly', { headers: { Origin: 'https://evil-openvibe.tools' } });
    assert.strictEqual(bad.status, 403);
});

t('CORS: no *.openvibe.tools wildcard — only exact origins get credentialed CORS; ALLOWED_ORIGINS adds one', async () => {
    const { createApp } = require('../server/app');
    const probe = (origin, method = 'GET') => h.http(method, '/api/dm/conversations', { headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    for (const origin of ['https://pastes.openvibe.tools', 'https://anything.openvibe.tools', 'https://a.b.openvibe.tools', 'http://pastes.openvibe.tools']) {
        for (const method of ['GET', 'OPTIONS']) {
            const r = await probe(origin, method);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), null, `${method} ${origin} got CORS`);
            assert.strictEqual(r.headers.get('access-control-allow-credentials'), null, `${method} ${origin} got credentials`);
            assert.strictEqual(r.status, 403, `${method} ${origin}`);
        }
    }
    const apex = await probe('https://openvibe.tools');
    assert.strictEqual(apex.headers.get('access-control-allow-origin'), 'https://openvibe.tools', 'the listed apex keeps working');
    // The same list decides the exported check (and the WebSocket upgrade).
    const stub = { chatServer: { getTotalConnections: () => 0 }, bridge: (q, s, n) => n() };
    const { isAllowedOrigin, allowedOrigins } = createApp(stub);
    assert.strictEqual(isAllowedOrigin('https://pastes.openvibe.tools'), false);
    assert.strictEqual(isAllowedOrigin('https://openvibe.live'), true);
    assert.ok(![...allowedOrigins].some((o) => o.includes('*')));
    const config = require('../server/config');
    const saved = config.extraOrigins;
    config.extraOrigins = ['https://embed.openvibe.tools/'];
    try {
        const withExtra = createApp(stub);
        assert.strictEqual(withExtra.isAllowedOrigin('https://embed.openvibe.tools'), true, 'ALLOWED_ORIGINS lists a satellite exactly');
        assert.strictEqual(withExtra.isAllowedOrigin('https://other.openvibe.tools'), false);
    } finally { config.extraOrigins = saved; }
});

t('scripts/parity-check.js: two identical services answer the same', async () => {
    const { spawn } = require('child_process');
    const path = require('path');
    const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'parity-check.js'), '--live', h.base, '--chat', h.base, '--stream', String(streamId), '--channel', String(streamer.id), '--token', alice.token]);
        let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
    });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /all paths answer the same/);
});

t.run(async () => { if (h) await h.close(); });
