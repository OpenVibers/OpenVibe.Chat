'use strict';
/**
 * One person cannot act on another's things in Chat by swapping ids (roadmap WS-R task 5, the IDOR
 * class). Two streamers, Ann and Bob, and a viewer; Bob tries every write that takes someone
 * else's id: Ann's room (settings, her messages, its members and roles, its attachments), Ann's
 * messages in a group DM they share (delete, remove people), Ann's channel sounds and sound
 * command, Ann's TTS/sound queue (list, skip, clear, report — and Ann's request id through Bob's
 * own queue), Ann's stream call settings and voice channel, a chat purge of Ann's stream, and
 * preferences written with Ann's ids in the body. Every refusal leaves the rows as they were;
 * positive controls show the same routes work for their owners.
 *
 *   node test/security-idor.test.js
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { ids } = require('openvibe-contracts');

const t = suite('security: idor');
let h, ann, bob, cat, annStream, bobStream;
const s = {};
const rooms = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const api = (method, path, u, body) => h.http(method, path, { token: u && u.token, body });
const refused = (r, what) => assert.ok([401, 403, 404].includes(r.status), `${what}: ${r.status} ${r.text.slice(0, 160)}`);

t('boot and seed', async () => {
    h = await boot({ env: { CHAT_CALLS: '1', CHAT_WEB_URL: 'https://openvibe.chat' } });
    const mk = (name, opts = {}) => { const u = h.addUser(name, { subject: ids.newId('user'), ...opts }); h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); return u; };
    ann = mk('ann', { role: 'streamer' }); bob = mk('bob', { role: 'streamer' }); cat = mk('cat');
    annStream = h.addStream(ann.id, h.addChannel(ann.id), { title: 'Ann live', is_live: 1 });
    bobStream = h.addStream(bob.id, h.addChannel(bob.id), { title: 'Bob live', is_live: 1 });

    let r = await rooms('POST', '/', ann, { name: 'Ann Room', visibility: 'public' });
    assert.strictEqual(r.status, 201, r.text);
    s.room = r.body.room.slug;
    assert.strictEqual((await rooms('POST', `/${s.room}/join`, bob)).status, 200);
    assert.strictEqual((await rooms('POST', `/${s.room}/join`, cat)).status, 200);
    s.annMsg = (await rooms('POST', `/${s.room}/messages`, ann, { message: 'ann speaks' })).body.message.id;
    s.catMsg = (await rooms('POST', `/${s.room}/messages`, cat, { message: 'cat speaks' })).body.message.id;

    r = await api('POST', '/api/dm/conversations', ann, { user_ids: [bob.id, cat.id], name: 'Trio' });
    s.conv = r.body.conversation ? r.body.conversation.id : (r.body.id || r.body.conversation_id);
    assert.ok(s.conv, r.text);
    r = await api('POST', `/api/dm/conversations/${s.conv}/messages`, ann, { message: 'ann in the trio' });
    s.dmMsg = (r.body.message && r.body.message.id) || r.body.id;

    s.sound = Number(h.db.createChannelSound({ channel_owner_id: ann.id, command: 'annhorn', url: '/api/sounds/file/none.mp3', created_by: ann.id, created_by_name: 'ann' }).lastInsertRowid);
    const audioQueue = require('../server/chat/audio-queue');
    audioQueue.stop();   // nothing plays here: Ann's request stays queued, so any change to it is Bob's doing
    s.annReq = audioQueue.enqueue({ kind: 'tts', streamId: annStream, requestedBy: cat.id, label: 'hello', payload: { text: 'hello' } });
    s.annReqId = s.annReq && (s.annReq.id || (s.annReq.request && s.annReq.request.id));
    assert.ok(s.annReqId, JSON.stringify(s.annReq));
});

const same = (a, b) => {
    if (a === b) return;
    const [x, y] = [JSON.parse(a), JSON.parse(b)];
    const i = x.findIndex((v, k) => JSON.stringify(v) !== JSON.stringify(y[k]));
    assert.fail(`table #${i} changed:\n  before ${JSON.stringify(x[i]).slice(0, 600)}\n  after  ${JSON.stringify(y[i]).slice(0, 600)}`);
};
const snapshot = () => JSON.stringify([
    h.db.all('SELECT * FROM rooms ORDER BY id'), h.db.all('SELECT room_id, user_id, role FROM room_members ORDER BY room_id, user_id'),
    h.db.all('SELECT id, is_deleted FROM room_messages ORDER BY id'), h.db.all('SELECT * FROM room_attachments ORDER BY 1'),
    h.db.all('SELECT conversation_id, user_id FROM dm_participants ORDER BY conversation_id, user_id'), h.db.all('SELECT id, message FROM dm_messages ORDER BY id'),
    h.db.all('SELECT id, channel_owner_id, command FROM channel_sounds ORDER BY id'), h.db.all('SELECT id, state FROM audio_requests ORDER BY id'),
]);

t('rooms: Bob, a member of Ann\'s room, cannot change it, delete her or Cat\'s messages, or hand out roles', async () => {
    const before = snapshot();
    refused(await rooms('PATCH', `/${s.room}`, bob, { name: 'Bob Room', visibility: 'private', slow_seconds: 600 }), 'PATCH room');
    refused(await rooms('DELETE', `/${s.room}/messages/${s.annMsg}`, bob), 'delete Ann\'s message');
    refused(await rooms('DELETE', `/${s.room}/messages/${s.catMsg}`, bob), 'delete Cat\'s message');
    for (const [username, role] of [['bob', 'mod'], ['cat', 'mod'], ['cat', 'blocked'], ['ann', 'blocked'], ['ann', 'member']]) {
        refused(await rooms('POST', `/${s.room}/members`, bob, { username, role }), `members ${username}=${role}`);
    }
    refused(await rooms('POST', `/${s.room}/attachments`, bob, { service: 'community', resource: 'bobs-space' }), 'attach');
    refused(await rooms('DELETE', `/${s.room}/attachments/community/anything`, bob), 'detach');
    same(before, snapshot());
});

t('group DM: Bob cannot delete Ann\'s message or remove Cat (only the creator removes others)', async () => {
    const before = snapshot();
    refused(await api('DELETE', `/api/dm/conversations/${s.conv}/messages/${s.dmMsg}`, bob), 'delete Ann\'s DM');
    refused(await api('DELETE', `/api/dm/conversations/${s.conv}/participants/${cat.id}`, bob), 'remove Cat');
    refused(await api('DELETE', `/api/dm/conversations/${s.conv}/participants/${ann.id}`, bob), 'remove Ann');
    same(before, snapshot());
});

t('sounds: Bob cannot delete Ann\'s channel sound or rename her sound command', async () => {
    const before = snapshot();
    refused(await api('DELETE', `/api/sounds/${s.sound}`, bob), 'delete sound');
    refused(await api('PATCH', '/api/sounds/command', bob, { channel_id: ann.id, command: 'annhorn', new_command: 'pwned', emote_code: 'x' }), 'rename command (channel)');
    refused(await api('PATCH', '/api/sounds/command', bob, { stream_id: annStream, command: 'annhorn', new_command: 'pwned' }), 'rename command (stream)');
    same(before, snapshot());
});

t('TTS/sound queue: Bob cannot read, skip, clear or report in Ann\'s room, nor reach her request through his own', async () => {
    const before = snapshot();
    refused(await api('GET', `/api/tts/queue?stream_id=${annStream}`, bob), 'list Ann\'s queue');
    refused(await api('GET', `/api/tts/queue?channel_user_id=${ann.id}`, bob), 'list Ann\'s channel queue');
    refused(await api('POST', '/api/tts/queue/skip', bob, { stream_id: annStream, id: s.annReqId }), 'skip in Ann\'s room');
    refused(await api('POST', '/api/tts/queue/clear', bob, { stream_id: annStream }), 'clear Ann\'s room');
    refused(await api('POST', '/api/tts/queue/clear', bob, { channel_user_id: ann.id }), 'clear Ann\'s channel');
    const through = await api('POST', '/api/tts/queue/skip', bob, { stream_id: bobStream, id: s.annReqId });
    assert.ok([404, 409].includes(through.status), `Ann's request through Bob's room: ${through.status} ${through.text}`);
    const report = await api('POST', `/api/tts/queue/${s.annReqId}/report`, bob, { stream_id: bobStream, state: 'failed', error: 'x' });
    assert.ok([400, 403, 404, 409].includes(report.status), `report Ann's request from Bob's room: ${report.status} ${report.text}`);
    same(before, snapshot());
});

t('calls: Bob cannot change Ann\'s stream call settings or delete her voice channel', async () => {
    refused(await api('PUT', `/api/streams/${annStream}/call`, bob, { mode: 'open', enabled: true }), 'call settings');
    const made = await api('POST', '/api/streams/voice-channels', ann, { name: 'Ann Voice' });
    if ([200, 201].includes(made.status)) {
        const id = (made.body.channel && made.body.channel.id) || made.body.id;
        refused(await api('DELETE', `/api/streams/voice-channels/${encodeURIComponent(id)}`, bob), 'delete voice channel');
        const list = await api('GET', '/api/streams/voice-channels', ann);
        assert.ok(list.text.includes('Ann Voice'), 'Ann\'s voice channel is still there');
    }
});

t('moderation: Bob cannot purge Ann\'s stream chat', async () => {
    h.db.saveChatMessage({ stream_id: annStream, channel_user_id: ann.id, user_id: cat.id, username: 'cat', message: 'cat chats on ann' });
    const count = () => h.db.all('SELECT count(*) AS n FROM chat_messages WHERE stream_id = ? AND COALESCE(is_deleted, 0) = 0', [annStream])[0].n;
    const before = count();
    assert.ok(before >= 1);
    const range = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };
    for (const key of ['streamId', 'stream_id']) {
        const r = await api('DELETE', '/api/chat/admin/purge', bob, { [key]: annStream, ...range });
        if (key === 'streamId') refused(r, 'purge Ann\'s stream');
        const p = await api('POST', '/api/chat/admin/purge/preview', bob, { [key]: annStream, ...range });
        if (key === 'streamId') refused(p, 'preview Ann\'s stream');
    }
    assert.strictEqual(count(), before, 'Ann\'s chat is intact');
});

t('preferences: a body naming Ann writes Bob\'s own record only', async () => {
    const annKey = h.netModules.key('chat.preferences', ann.subject_id);
    const before = JSON.stringify(h.netModules.records.get(annKey) || null);
    for (const mount of ['preferences', 'tts-settings', 'dm-settings', 'presence']) {
        await api('PUT', `/api/${mount}`, bob, { subject_id: ann.subject_id, user_id: ann.id, subject: ann.subject_id, preferences: { theme: 'pwned' }, settings: { enabled: false } });
    }
    for (const [k, v] of h.netModules.records) if (k.endsWith(`|${ann.subject_id}`)) assert.ok(!JSON.stringify(v).includes('pwned'), `Ann's ${k} was written`);
    assert.strictEqual(JSON.stringify(h.netModules.records.get(annKey) || null), before);
});

t('controls: the owners can do what Bob could not', async () => {
    assert.strictEqual((await rooms('DELETE', `/${s.room}/messages/${s.catMsg}`, ann)).status, 200, 'the room owner deletes Cat\'s message');
    assert.strictEqual((await rooms('PATCH', `/${s.room}`, ann, { slow_seconds: 0 })).status, 200);
    assert.strictEqual((await api('GET', `/api/tts/queue?stream_id=${annStream}`, ann)).status, 200);
    assert.strictEqual((await api('DELETE', `/api/sounds/${s.sound}`, ann)).status, 200);
    assert.strictEqual((await api('DELETE', `/api/dm/conversations/${s.conv}/participants/${cat.id}`, ann)).status, 200, 'the creator removes Cat');
});

t.run(() => h && h.close());
