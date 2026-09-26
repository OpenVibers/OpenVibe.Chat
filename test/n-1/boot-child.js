'use strict';
/**
 * Runs inside a Chat release (its directory is the cwd): boots it with that release's own
 * test/helpers.js (a stub Network and a stub Live, Chat in-process) on the database in N1_DB, seeds it,
 * and prints one line `{"n1": { url, token, ids }}`. SIGTERM stops it (Chat's own shutdown).
 */
const path = require('path');

(async () => {
    const dir = process.cwd();
    const quiet = () => {};
    console.warn = quiet;
    const helpers = require(path.join(dir, 'test', 'helpers'));
    const h = await helpers.boot({ env: { CHAT_DB_PATH: process.env.N1_DB } });
    process.on('exit', () => { try { require('fs').rmSync(h.tmp, { recursive: true, force: true }); } catch { /* */ } });
    const star = h.addUser('n1star', { role: 'streamer' });
    const fan = h.addUser('n1fan');
    const channel = h.addChannel(star.id);
    const stream = h.addStream(star.id, channel, { title: 'N-1 live stream' });
    const db = require(path.join(dir, 'server', 'db', 'database'));
    db.saveChatMessage({ stream_id: stream, channel_user_id: star.id, user_id: fan.id, username: 'n1fan', message: 'hello from N-1' });
    db.saveChatMessage({ user_id: fan.id, username: 'n1fan', message: 'global hello from N-1', is_global: 1 });
    let room = null;
    try {
        const rooms = require(path.join(dir, 'server', 'rooms', 'rooms'));
        room = rooms.create(star, { name: 'N-1 room', slug: 'n1-room' });
        rooms.post(rooms.bySlug('n1-room'), star, 'first post from N-1');
    } catch (err) { process.stderr.write(`[n-1] room seed: ${err.message}\n`); }
    let conversation = null;
    try {
        const dm = require(path.join(dir, 'server', 'chat', 'dm'));
        const c = dm.getOrCreateDirect(star.id, fan.id);
        conversation = c && (c.id || c.conversation_id || c);
        dm.sendMessage(conversation, fan.id, 'a direct hello from N-1');
    } catch (err) { process.stderr.write(`[n-1] dm seed: ${err.message}\n`); }
    process.stdout.write(`${JSON.stringify({ n1: { url: h.base, token: star.token, ids: { star: star.id, fan: fan.id, channel, stream, room: room && room.slug, conversation } } })}\n`);
})().catch((err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exit(1); });
