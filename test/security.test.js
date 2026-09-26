'use strict';
/**
 * Security regressions on the /ws/chat protocol and the client-address rules:
 *   - a moderator in an OFFLINE channel room bans/unbans in that channel, never site-wide;
 *   - command output (/me, /tts, /clear, /slow, ban notices) stays in the sender's room;
 *   - /me and /tts obey the channel's chat rules (followers-only, slur filter, IP approval);
 *   - joining the channel room without the stream id does not skip slow mode or IP approval;
 *   - CF-Connecting-IP / X-Forwarded-For are only believed when the request came from Cloudflare.
 */
const assert = require('assert');
const WebSocket = require('ws');
const { boot, suite } = require('./helpers');

const t = suite('security');
let h, streamer, other, mod, alice, bob, chanX, chanY, streamX;

async function joined(opts, join) {
    const ws = await h.ws(opts);
    ws.sendJson({ type: 'join', ...(join || {}), ...(opts.token ? { token: opts.token } : {}) });
    await ws.next((m) => m.type === 'auth');
    return ws;
}

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('xstreamer', { role: 'streamer' });
    other = h.addUser('ystreamer', { role: 'streamer' });
    mod = h.addUser('xmod');
    alice = h.addUser('alice');
    bob = h.addUser('bob');
    chanX = h.addChannel(streamer.id, { moderators: [mod.id] });
    chanY = h.addChannel(other.id);
    streamX = h.addStream(streamer.id, chanX);
    h.addStream(other.id, chanY, { is_live: 0 });
    await h.ctx.sync();
});

t('offline channel room: a streamer\'s /ban and /timeout stay in their channel (never a site ban)', async () => {
    const own = await joined({ ip: '198.51.100.1', token: streamer.token }, { channelUserId: streamer.id });
    own.sendJson({ type: 'chat', message: '/ban bob' });
    await own.next((m) => m.type === 'system' && m.message === 'bob has been banned.');
    const ban = h.live.effects.filter((e) => e.name === 'ban' && e.body.user_id === bob.id).pop();
    assert.strictEqual(ban.body.stream_id, streamX, 'channel-room ban is scoped to the channel\'s stream, not site-wide (null)');
    await h.sleep(1100);
    own.sendJson({ type: 'chat', message: '/timeout alice 60' });
    await own.next((m) => m.type === 'system' && /alice timed out/.test(m.message));
    const to = h.live.effects.filter((e) => e.name === 'ban' && e.body.user_id === alice.id).pop();
    assert.strictEqual(to.body.stream_id, streamX);
    // /unban from the channel room must not reach for site-wide rows either.
    await h.sleep(1100);
    own.sendJson({ type: 'chat', message: '/unban bob' });
    await own.next((m) => m.type === 'system' && m.message === 'bob has been unbanned.');
    const unban = h.live.effects.filter((e) => e.name === 'ban' && e.body.action === 'unban').pop();
    assert.strictEqual(unban.body.stream_id, streamX);
    h.live.clearBans();
    await h.ctx.invalidateBans();
    own.close();
});

t('/me, /clear and ban notices from global chat or a channel room stay in that room', async () => {
    const globalWs = await joined({ ip: '198.51.100.10' });
    const roomY = await joined({ ip: '198.51.100.11', token: bob.token }, { channelUserId: other.id });
    const fromGlobal = await joined({ ip: '198.51.100.12', token: alice.token });
    fromGlobal.sendJson({ type: 'chat', message: '/me waves from global' });
    await globalWs.next((m) => m.type === 'chat' && /waves from global/.test(m.message));
    assert.ok(await roomY.none((m) => /waves from global/.test(m.message || '')), '/me from global chat leaked into channel Y');

    const roomX = await joined({ ip: '198.51.100.13', token: streamer.token }, { channelUserId: streamer.id });
    const roomXviewer = await joined({ ip: '198.51.100.14', token: alice.token }, { channelUserId: streamer.id });
    await h.sleep(1100);
    roomX.sendJson({ type: 'chat', message: '/me says hi in X' });
    await roomXviewer.next((m) => m.type === 'chat' && /says hi in X/.test(m.message));
    assert.ok(await roomY.none((m) => /says hi in X/.test(m.message || '')), '/me leaked into channel Y');
    assert.ok(await globalWs.none((m) => /says hi in X/.test(m.message || '')), '/me leaked into global chat');
    await h.sleep(1100);
    roomX.sendJson({ type: 'chat', message: '/clear' });
    await roomXviewer.next((m) => m.type === 'clear');
    assert.ok(await roomY.none((m) => m.type === 'clear'), 'channel X\'s /clear cleared channel Y');
    assert.ok(await globalWs.none((m) => m.type === 'clear'), 'channel X\'s /clear cleared global chat');
    await h.sleep(1100);
    roomX.sendJson({ type: 'chat', message: '/ban bob' });
    await roomXviewer.next((m) => m.type === 'system' && m.message === 'bob has been banned.');
    assert.ok(await globalWs.none((m) => m.message === 'bob has been banned.'), 'ban notice leaked into global chat');
    h.live.clearBans();
    await h.ctx.invalidateBans();
    for (const w of [globalWs, roomY, fromGlobal, roomX, roomXviewer]) w.close();
});

t('/me and /tts obey followers-only and the slur filter', async () => {
    h.live.policies.get(chanX).settings = { followers_only: 1, slur_filter_enabled: 1, slur_filter_terms: 'bannedword' };
    h.ctx.invalidateChannel(chanX);
    const viewer = await joined({ ip: '198.51.100.20', token: streamer.token, stream: streamX }, { streamId: streamX });
    const bobWs = await joined({ ip: '198.51.100.21', token: bob.token, stream: streamX }, { streamId: streamX });
    bobWs.sendJson({ type: 'chat', message: 'plain line' });
    await bobWs.next((m) => m.type === 'system' && /followers-only/.test(m.message));
    await h.sleep(1100);
    bobWs.sendJson({ type: 'chat', message: '/me sneaks past followers-only' });
    await h.sleep(1100);
    bobWs.sendJson({ type: 'chat', message: '/tts sneaks past followers-only' });
    assert.ok(await viewer.none((m) => /sneaks past/.test(m.message || ''), 500), '/me or /tts bypassed followers-only');

    h.live.follows.set(bob.id, [streamer.id]);
    h.live.policies.get(chanX).settings = { slur_filter_enabled: 1, slur_filter_terms: 'bannedword' };
    h.ctx.invalidateChannel(chanX);
    const bob2 = await joined({ ip: '198.51.100.22', token: bob.token, stream: streamX }, { streamId: streamX });
    bob2.sendJson({ type: 'chat', message: '/me says bannedword' });
    await bob2.next((m) => m.type === 'slur-blocked');
    await h.sleep(1100);
    bob2.sendJson({ type: 'chat', message: '/tts bannedword' });
    await bob2.next((m) => m.type === 'slur-blocked');
    assert.ok(await viewer.none((m) => /bannedword/.test(m.message || ''), 300), 'slur filter bypassed by /me or /tts');
    h.live.policies.get(chanX).settings = null;
    h.ctx.invalidateChannel(chanX);
    for (const w of [viewer, bobWs, bob2]) w.close();
});

t('joining the channel room without the stream id does not skip slow mode or IP approval', async () => {
    const own = await joined({ ip: '198.51.100.30', token: streamer.token, stream: streamX }, { streamId: streamX });
    own.sendJson({ type: 'chat', message: '/slow 30' });
    await own.next((m) => m.type === 'slowmode');
    const sneaky = await joined({ ip: '198.51.100.31', token: alice.token }, { channelUserId: streamer.id });
    sneaky.sendJson({ type: 'chat', message: 'first' });
    await own.next((m) => m.type === 'chat' && m.message === 'first');
    await h.sleep(1100);
    sneaky.sendJson({ type: 'chat', message: 'second within slow mode' });
    await sneaky.next((m) => m.type === 'system' && /too fast/.test(m.message));
    assert.ok(await own.none((m) => m.message === 'second within slow mode'), 'slow mode bypassed from the channel room');
    // (/slow 30 is the channel's saved setting now; the policy set below replaces it)

    h.live.policies.get(chanX).settings = { ip_approval_mode: 1 };
    h.ctx.invalidateChannel(chanX);
    const fresh = await joined({ ip: '198.51.100.32' }, { channelUserId: streamer.id });
    fresh.sendJson({ type: 'chat', message: 'unapproved hello' });
    await fresh.next((m) => m.type === 'system' && /IP approval mode/.test(m.message));
    assert.ok(await own.none((m) => m.message === 'unapproved hello'), 'IP approval bypassed from the channel room');
    assert.ok(h.db.get("SELECT 1 FROM pending_ip_messages WHERE message = 'unapproved hello'"), 'held for review');
    await h.sleep(1100);
    fresh.sendJson({ type: 'chat', message: '/me unapproved action' });
    assert.ok(await own.none((m) => /unapproved action/.test(m.message || ''), 400), '/me bypassed IP approval');
    h.live.policies.get(chanX).settings = null;
    h.ctx.invalidateChannel(chanX);
    for (const w of [own, sneaky, fresh]) w.close();
});

t('a catastrophic custom slur regex cannot freeze the chat server', async () => {
    h.live.policies.get(chanX).settings = { slur_filter_enabled: 1, slur_filter_use_builtin: 0, slur_filter_regexes: '^(a|a)*$' };
    h.ctx.invalidateChannel(chanX);
    const viewer = await joined({ ip: '198.51.100.40', token: streamer.token, stream: streamX }, { streamId: streamX });
    const bobWs = await joined({ ip: '198.51.100.41', token: bob.token, stream: streamX }, { streamId: streamX });
    const line = 'a'.repeat(30) + 'b';
    const started = Date.now();
    bobWs.sendJson({ type: 'chat', message: line });
    await viewer.next((m) => m.type === 'chat' && m.message === line, 20000);
    assert.ok(Date.now() - started < 1500, `chat blocked for ${Date.now() - started}ms by a streamer regex`);
    h.live.policies.get(chanX).settings = null;
    h.ctx.invalidateChannel(chanX);
    for (const w of [viewer, bobWs]) w.close();
});

function rawWs(headers) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat`, { headers: { origin: 'https://openvibe.live', ...headers } });
        ws.on('open', () => setTimeout(() => resolve({ ws, open: ws.readyState === WebSocket.OPEN }), 400));
        ws.on('close', () => resolve({ ws, open: false }));
        ws.on('error', () => resolve({ ws, open: false }));
    });
}

t('CF-Connecting-IP / X-Forwarded-For are believed only from Cloudflare', async () => {
    // The attacker reaches nginx directly (a DNS-only host such as ingest.openvibe.live): nginx
    // sets X-Real-IP / appends X-Forwarded-For with the real peer; CF-Connecting-IP is forged.
    h.live.addBan({ ip_address: '192.0.2.66' });
    await h.ctx.invalidateBans();
    const direct = await rawWs({ 'x-real-ip': '192.0.2.66', 'x-forwarded-for': '203.0.113.200, 192.0.2.66', 'cf-connecting-ip': '203.0.113.200' });
    assert.strictEqual(direct.open, false, 'banned address evaded the ban with a forged CF-Connecting-IP');
    // Through Cloudflare (peer in Cloudflare's ranges) the header is the visitor.
    const viaCf = await rawWs({ 'x-real-ip': '104.16.0.9', 'x-forwarded-for': '203.0.113.201, 104.16.0.9', 'cf-connecting-ip': '203.0.113.201' });
    assert.strictEqual(viaCf.open, true);
    const ips = [...h.chatServer.clients.values()].map((c) => c.ip);
    assert.ok(ips.includes('203.0.113.201'), `Cloudflare visitor address used (${ips})`);
    viaCf.ws.close();
    // REST: the ban middleware and the rate limiter key on the same rule.
    const r = await h.http('GET', '/api/chat/filters/friendly', { headers: { 'X-Forwarded-For': '203.0.113.200, 192.0.2.66', 'X-Real-IP': '192.0.2.66' } });
    assert.strictEqual(r.status, 403, 'REST IP ban evaded with a forged X-Forwarded-For');
    const ok = await h.http('GET', '/api/chat/filters/friendly', { headers: { 'X-Forwarded-For': '203.0.113.202, 104.16.0.9', 'X-Real-IP': '104.16.0.9' } });
    assert.strictEqual(ok.status, 200);
    h.live.clearBans();
    await h.ctx.invalidateBans();
});

t.run(() => h && h.close());
