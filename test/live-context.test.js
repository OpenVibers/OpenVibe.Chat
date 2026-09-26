'use strict';
/**
 * The Live adapter's promises: a chat message makes no read call to Live (only its one effect),
 * warm caches answer while Live is slow or down (stale values, no gaps on invalidation), and ban
 * evaluation matches Live's SQL, except that a ban ends at its expires_at instant: Live's TEXT
 * comparison kept an ISO timeout ('…T…Z') active until the end of that UTC day.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('live-context');
let h, streamer, alice, mod, channelId, streamId, aliceWs, watcher;

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('streamer', { role: 'streamer' });
    alice = h.addUser('alice');
    mod = h.addUser('moddy');
    channelId = h.addChannel(streamer.id, { moderators: [mod.id], settings: { max_message_length: 60 } });
    streamId = h.addStream(streamer.id, channelId);
    h.live.follows.set(alice.id, [streamer.id]);
    await h.ctx.sync();
});

t('no read call to Live per chat message (only the one effect)', async () => {
    aliceWs = await h.ws({ ip: '198.51.100.70', token: alice.token, stream: streamId });
    aliceWs.sendJson({ type: 'join', streamId, token: alice.token });
    await aliceWs.next((m) => m.type === 'auth');
    watcher = await h.ws({ ip: '198.51.100.71', stream: streamId });
    watcher.sendJson({ type: 'join', streamId });
    await watcher.next((m) => m.type === 'auth');
    await h.sleep(300);
    const mark = h.live.requests.length;
    for (let i = 0; i < 3; i++) {
        aliceWs.sendJson({ type: 'chat', message: `msg ${i}` });
        await watcher.next((m) => m.type === 'chat' && m.message === `msg ${i}`);
        await h.sleep(1050);
    }
    const during = h.live.requests.slice(mark);
    const reads = during.filter((p) => p.startsWith('/internal/chat-context/') && !/\/(streams|users|managed-streams|channels|bans|settings)(\/active)?$/.test(p.replace(/\?.*$/, '')));
    assert.deepStrictEqual(reads, [], `per-message reads: ${JSON.stringify(reads)}`);
    assert.strictEqual(during.filter((p) => p === '/internal/chat-effects/chat-message').length, 3, 'one effect per message');
});

t('channel rules come from the warm policy: message length', async () => {
    aliceWs.sendJson({ type: 'chat', message: 'x'.repeat(61) });
    await aliceWs.next((m) => m.type === 'system' && m.message === 'Message too long. Max 60 characters.');
});

t('Live down: chat keeps flowing from caches; new tokens fall back to anonymous', async () => {
    h.live.down = true;
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: 'while Live is down' });
    await watcher.next((m) => m.type === 'chat' && m.message === 'while Live is down');
    const late = h.addUser('late');
    const ws = await h.ws({ ip: '198.51.100.72', token: late.token });
    ws.sendJson({ type: 'join', token: late.token });
    const auth = await ws.next((m) => m.type === 'auth', 8000);
    assert.strictEqual(auth.authenticated, false);
    assert.match(auth.username, /^anon9\d{8}$/, 'a temporary anon number while Live cannot allocate one');
    ws.close();
    h.live.down = false;
});

t('invalidation never leaves a gap: a moderator stays a moderator while the policy reloads', async () => {
    h.ctx.invalidateChannel(channelId);
    assert.strictEqual(h.ctx.isChannelModerator(mod.id, channelId), true);
    await h.sleep(100);
    assert.strictEqual(h.ctx.isChannelModerator(mod.id, channelId), true);
    // A moderator removed in Live loses the power after the reload.
    h.live.policies.get(channelId).moderator_ids = [];
    h.ctx.invalidateChannel(channelId);
    await h.sleep(150);
    assert.strictEqual(h.ctx.isChannelModerator(mod.id, channelId), false);
});

t('bans: user/stream/site scope, CIDR, and expires_at read as an instant (ISO or SQLite format)', async () => {
    const past = h.sqliteNow(-60e3);
    const future = h.sqliteNow(3600e3);
    h.live.addBan({ user_id: alice.id, stream_id: streamId, expires_at: future });
    h.live.addBan({ user_id: mod.id, expires_at: past });
    h.live.addBan({ ip_address: '2001:db8:1::/48' });
    // A timeout written as ISO (what /timeout stores) a minute AGO sorts after today's
    // 'YYYY-MM-DD HH:MM:SS' ('T' > ' '), so Live's TEXT comparison kept it active until the day
    // ended. Chat reads the instant: it is over. One ending in a minute is still on.
    const isoPast = new Date(Date.now() - 60e3).toISOString();
    const other = h.addUser('other');
    h.live.addBan({ user_id: other.id, expires_at: isoPast });
    const third = h.addUser('third');
    h.live.addBan({ user_id: third.id, expires_at: new Date(Date.now() + 60e3).toISOString() });
    const weird = h.addUser('weird');
    h.live.addBan({ user_id: weird.id, expires_at: 'not a date' });
    await h.ctx.invalidateBans();
    assert.strictEqual(h.ctx.isUserBanned(alice.id, streamId), true);
    assert.strictEqual(h.ctx.isUserBanned(alice.id, 999), false, 'stream ban stays in its stream');
    assert.strictEqual(h.ctx.isUserBanned(mod.id, streamId), false, 'expired');
    assert.strictEqual(h.ctx.isIpBanned('2001:db8:1:ffff::1', null), true);
    assert.strictEqual(h.ctx.isIpBanned('::ffff:10.0.0.1', null), false);
    assert.strictEqual(h.ctx.isUserBanned(other.id, null), false, 'an ISO timeout that ended a minute ago is over (Live kept it until midnight UTC)');
    assert.strictEqual(h.ctx.isUserBanned(third.id, null), true, 'an ISO timeout ending in a minute is on');
    assert.strictEqual(h.ctx.isUserBanned(weird.id, null), true, 'a value that is not a date keeps Live’s TEXT comparison');
    h.live.clearBans();
    await h.ctx.invalidateBans();
    assert.strictEqual(h.ctx.isUserBanned(alice.id, streamId), false);
});

t('a ban written through Live is in Chat’s cache when the effect answers, even with a refresh in flight', async () => {
    const target = h.addUser('target');
    const inFlight = h.ctx.refreshBans();   // left before the ban is written: it cannot have it
    await h.ctx.effects.ban({ action: 'ban', user_id: target.id, stream_id: streamId, actor_user_id: mod.id, moderation_stream_id: streamId, reason: 'test', banned_by: mod.id });
    assert.strictEqual(h.ctx.isUserBanned(target.id, streamId), true, 'in effect by the time the moderator is answered');
    await inFlight;
    h.live.clearBans();
    await h.ctx.invalidateBans();
    assert.strictEqual(h.ctx.isUserBanned(target.id, streamId), false);
});

t('followers-only uses the viewer’s warm follow list', async () => {
    h.live.policies.get(channelId).settings = { followers_only: 1 };
    h.ctx.invalidateChannel(channelId);
    await h.sleep(150);
    const stranger = h.addUser('stranger');
    await h.ctx.sync();
    const ws = await h.ws({ ip: '198.51.100.73', token: stranger.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: stranger.token });
    await ws.next((m) => m.type === 'auth');
    ws.sendJson({ type: 'chat', message: 'let me talk' });
    await ws.next((m) => m.type === 'system' && m.message === 'This chat is currently followers-only.');
    await h.sleep(1100);
    aliceWs.sendJson({ type: 'chat', message: 'I follow' });
    await watcher.next((m) => m.type === 'chat' && m.message === 'I follow');
    ws.close();
});

t.run(async () => { for (const w of [aliceWs, watcher]) { try { w.close(); } catch { /* */ } } if (h) await h.close(); });
