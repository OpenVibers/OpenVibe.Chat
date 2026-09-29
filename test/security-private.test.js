'use strict';
/**
 * Private rooms and direct messages reach nobody outside them, on any path (roadmap WS-R task 5, the
 * private-room class). rooms.test.js, room-kinds.test.js and dm-inbox.test.js pin the rules route
 * by route; this suite covers the class: it seeds a private community room, a private call room and
 * a DM, each with words found nowhere else, then GETs EVERY route the booted app has (listed from
 * Express's router stack, test/security-crawl.js), with the private rooms' slugs and message ids,
 * the DM's id and its participants' names in every parameter, plus the pages, as anonymous, a
 * signed-in stranger and someone the room blocked. None of those words may appear. Chat staff may
 * look into private rooms (the moderation rule) but are strangers to DMs.
 *
 * Then the paths the crawl cannot reach: the WebSocket (joining the private room, and a message
 * posted while a stranger listens on every room they can), the events outbox (nothing about a
 * private room or a DM leaves Chat), and message ids swapped into a room the stranger owns.
 *
 *   node test/security-private.test.js
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { ids } = require('openvibe-contracts');
const { getPaths, crawl, noNetwork } = require('./security-crawl');

noNetwork();

const t = suite('security: private rooms and DMs');
let h, ann, bob, cat, dan, mod;
const rooms = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const dms = (method, path, u, body) => h.http(method, `/api/dm${path}`, { token: u && u.token, body });
const SECRET = { roomName: 'Hidden Den', roomWords: 'whisper-in-the-den', callWords: 'backstage-secret-line', dmWords: 'dm-secret-words', topic: 'den-topic-words' };
const seeded = {};

t('boot and seed: a private room, a private call room, a DM', async () => {
    // The crawl GETs every route as the same few people, far past one person's per-actor read budget
    // (server/net/actor-limits.js); this suite reads privacy, test/actor-limits.test.js the limits.
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat', CHAT_LIMITS_MINUTE: '100000', CHAT_LIMITS_HOUR: '100000' } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    dan = h.addUser('dan', { subject: ids.newId('user') });
    mod = h.addUser('staffmod', { subject: ids.newId('user'), role: 'global_mod' });
    for (const u of [ann, bob, cat, dan, mod]) { await h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); }

    let r = await rooms('POST', '/', ann, { name: SECRET.roomName, visibility: 'private', topic: SECRET.topic });
    assert.strictEqual(r.status, 201, r.text);
    seeded.slug = r.body.room.slug;
    assert.strictEqual((await rooms('POST', `/${seeded.slug}/members`, ann, { username: 'bob', role: 'member' })).status, 200);
    assert.strictEqual((await rooms('POST', `/${seeded.slug}/members`, ann, { username: 'dan', role: 'blocked' })).status, 200);
    r = await rooms('POST', `/${seeded.slug}/messages`, bob, { message: SECRET.roomWords });
    assert.strictEqual(r.status, 201, r.text);
    seeded.msg = r.body.message.id;

    r = await rooms('POST', '/', ann, { name: 'Back Stage Call', kind: 'call', visibility: 'private' });
    assert.strictEqual(r.status, 201, r.text);
    seeded.call = r.body.room.slug;
    r = await rooms('POST', `/${seeded.call}/messages`, ann, { message: SECRET.callWords });
    assert.strictEqual(r.status, 201, r.text);
    seeded.callMsg = r.body.message.id;

    // Cat owns a public room of her own (for the id-swap checks).
    r = await rooms('POST', '/', cat, { name: 'Open Lounge', visibility: 'public' });
    seeded.open = r.body.room.slug;
    r = await rooms('POST', `/${seeded.open}/messages`, cat, { message: 'hello lounge' });
    seeded.openMsg = r.body.message.id;

    r = await dms('POST', '/conversations', ann, { user_ids: [bob.id] });
    assert.ok([200, 201].includes(r.status), r.text);
    seeded.conv = r.body.conversation ? r.body.conversation.id : (r.body.id || r.body.conversation_id);
    assert.ok(seeded.conv, r.text);
    r = await dms('POST', `/conversations/${seeded.conv}/messages`, bob, { message: SECRET.dmWords });
    assert.ok([200, 201].includes(r.status), r.text);
    seeded.dmMsg = (r.body.message && r.body.message.id) || r.body.id;
});

t('control: members see all of it (the seeded words are live)', async () => {
    assert.ok((await rooms('GET', `/${seeded.slug}/messages`, bob)).text.includes(SECRET.roomWords));
    assert.ok((await rooms('GET', `/${seeded.call}/messages`, ann)).text.includes(SECRET.callWords));
    assert.ok((await dms('GET', `/conversations/${seeded.conv}/messages`, ann)).text.includes(SECRET.dmWords));
    assert.ok((await rooms('GET', `/${seeded.slug}/messages`, mod)).text.includes(SECRET.roomWords), 'chat staff may look into a private room');
});

t('every GET route and page: nothing of the private rooms or the DM reaches anonymous, a stranger, a blocked person; staff get no DM', async () => {
    const values = (name) => {
        if (/slug|room/i.test(name)) return [seeded.slug, seeded.call, seeded.open];
        if (/user(name)?$|^name$|handle/i.test(name)) return ['ann', 'bob', ann.id, bob.id];
        if (/userId|user_id/.test(name)) return [ann.id, bob.id];
        return [seeded.msg, seeded.conv, seeded.callMsg, seeded.dmMsg, ann.id, 1];
    };
    const paths = getPaths(h.server, values, {
        query: `q=${SECRET.roomWords}&room=${seeded.slug}&conversation=${seeded.conv}&user=ann&before=999999&after=0`,
        extra: ['/', '/rooms', `/r/${seeded.slug}`, `/r/${seeded.call}`, `/r/${seeded.slug}/settings`, `/messages/${seeded.conv}`, '/messages',
            '/sitemap.xml', '/robots.txt', '/updates', `/api/chat/search?q=${SECRET.roomWords}`, `/api/chat/search?q=${SECRET.dmWords}`,
            '/api/chat/rooms?q=Hidden', '/api/chat/rooms?visibility=private', '/api/chat/global/history', '/api/chat/online'],
    });
    const everything = { roomName: SECRET.roomName, roomWords: SECRET.roomWords, callWords: SECRET.callWords, dmWords: SECRET.dmWords, topic: SECRET.topic };
    const r = await crawl(h, paths, { anonymous: null, stranger: cat, blocked: dan, staff: mod }, (who) => (who === 'staff' ? { dmWords: SECRET.dmWords } : everything));
    process.stdout.write(`    (${paths.length} paths × 4 people; answers ${JSON.stringify(r.statuses)})\n`);
    assert.ok(r.answered >= paths.length * 3, `${r.answered} answers`);
    assert.deepStrictEqual(r.found, []);
});

t('WebSocket: a stranger cannot join the private room, and hears nothing posted in it', async () => {
    const strangerWs = await h.ws({ token: cat.token });
    strangerWs.sendJson = (o) => strangerWs.send(JSON.stringify(o));
    strangerWs.sendJson({ type: 'join', token: cat.token });
    await strangerWs.next((m) => m.type === 'auth');
    strangerWs.sendJson({ type: 'join_room', room: seeded.slug });
    strangerWs.sendJson({ type: 'join_room', room: seeded.call });
    strangerWs.sendJson({ type: 'join_room', room: seeded.open });
    await strangerWs.next((m) => m.type === 'room_joined' && m.room === seeded.open);
    const bobWs = await h.ws({ token: bob.token });
    bobWs.send(JSON.stringify({ type: 'join_room', room: seeded.slug }));
    await bobWs.next((m) => m.type === 'room_joined');
    bobWs.send(JSON.stringify({ type: 'room_message', message: 'live-private-words' }));
    await bobWs.next((m) => m.type === 'room_message' && m.message && m.message.message === 'live-private-words');
    await dms('POST', `/conversations/${seeded.conv}/messages`, ann, { message: 'live-dm-words' });
    await h.sleep(300);
    const heard = JSON.stringify(strangerWs.all);
    assert.ok(!strangerWs.all.some((m) => m.type === 'room_joined' && (m.room === seeded.slug || m.room === seeded.call)), 'joined a private room');
    for (const w of ['live-private-words', 'live-dm-words', SECRET.roomWords, SECRET.callWords, SECRET.dmWords, SECRET.roomName]) assert.ok(!heard.includes(w), `the stranger's socket heard "${w}"`);
    strangerWs.close(); bobWs.close();
});

t('events outbox: nothing about a private room or a DM leaves Chat', async () => {
    // (The staff member's own log searches above are audited with the words they typed: their query, not the room's content.)
    const rows = JSON.stringify((await h.db.all('SELECT * FROM events_outbox')).filter((r) => !/"action_type":"chat_log_search"/.test(r.event)));
    for (const w of ['live-private-words', 'live-dm-words', SECRET.roomWords, SECRET.callWords, SECRET.dmWords, SECRET.roomName, SECRET.topic]) assert.ok(!rows.includes(w), `outbox carries "${w}"`);
});

t('ids swapped into the stranger\'s own room reach nothing of the private room', async () => {
    const before = await h.db.all('SELECT id, is_deleted FROM room_messages ORDER BY id');
    let r = await rooms('DELETE', `/${seeded.open}/messages/${seeded.msg}`, cat);
    assert.strictEqual(r.status, 404, r.text);
    r = await rooms('DELETE', `/${seeded.open}/messages/${seeded.callMsg}`, cat);
    assert.strictEqual(r.status, 404, r.text);
    r = await rooms('GET', `/${seeded.open}/messages?after=${seeded.msg - 1}&limit=100`, cat);
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes(SECRET.roomWords) && !r.text.includes(SECRET.callWords));
    r = await dms('DELETE', `/conversations/${seeded.conv}/messages/${seeded.dmMsg}`, cat);
    assert.ok([403, 404].includes(r.status), r.text);
    assert.deepStrictEqual(await h.db.all('SELECT id, is_deleted FROM room_messages ORDER BY id'), before);
    assert.ok((await dms('GET', `/conversations/${seeded.conv}/messages`, ann)).text.includes(SECRET.dmWords), 'the DM is intact');
});

t('a stranger\'s every write to the private room or the DM is refused and changes nothing', async () => {
    const snap = async () => JSON.stringify([await h.db.all('SELECT * FROM rooms ORDER BY id'), await h.db.all('SELECT room_id, user_id, role FROM room_members ORDER BY room_id, user_id'),
        await h.db.all('SELECT id, is_deleted FROM room_messages ORDER BY id'), await h.db.all('SELECT * FROM dm_participants ORDER BY conversation_id, user_id')]);
    const before = await snap();
    for (const [m, p, body] of [
        ['PATCH', `/${seeded.slug}`, { name: 'pwned', visibility: 'public' }], ['POST', `/${seeded.slug}/join`], ['POST', `/${seeded.slug}/messages`, { message: 'x' }],
        ['DELETE', `/${seeded.slug}/messages/${seeded.msg}`], ['POST', `/${seeded.slug}/members`, { username: 'cat', role: 'mod' }], ['POST', `/${seeded.slug}/read`],
        ['GET', `/${seeded.slug}/members`], ['GET', `/${seeded.slug}/attachments`], ['POST', `/${seeded.slug}/attachments`, { service: 'community', resource: 'x' }],
    ]) {
        for (const who of [cat, dan]) {
            const r = await rooms(m, p, who, body);
            assert.ok([401, 403, 404].includes(r.status), `${who.username}: ${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
            assert.ok(!r.text.includes(SECRET.roomWords) && !r.text.includes(SECRET.roomName), `${m} ${p} carries the room`);
        }
    }
    for (const [m, p, body] of [
        ['GET', `/conversations/${seeded.conv}`], ['GET', `/conversations/${seeded.conv}/messages`], ['POST', `/conversations/${seeded.conv}/messages`, { message: 'x' }],
        ['POST', `/conversations/${seeded.conv}/read`], ['PATCH', `/conversations/${seeded.conv}`, { name: 'x' }],
        ['POST', `/conversations/${seeded.conv}/participants`, { user_id: cat.id }], ['DELETE', `/conversations/${seeded.conv}/participants/${bob.id}`],
    ]) {
        for (const who of [cat, mod]) {
            const r = await dms(m, p, who, body);
            assert.ok([401, 403, 404].includes(r.status), `${who.username}: ${m} /api/dm${p} → ${r.status} ${r.text.slice(0, 120)}`);
            assert.ok(!r.text.includes(SECRET.dmWords), `${m} ${p} carries the DM`);
        }
    }
    assert.strictEqual(await snap(), before);
});

t.run(() => h && h.close());
