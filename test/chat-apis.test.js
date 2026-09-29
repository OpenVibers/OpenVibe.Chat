'use strict';
/**
 * Plan T3 step 1 — the APIs Chat serves for the six staged tables:
 *   - Live's internal read API (/internal/moderation/*, capability chat.moderation.read)
 *   - the public emote API (/api/emotes, Live's paths and shapes; bytes on OpenVibe.Media)
 *   - channel moderators & moderation settings (/api/chat/channels/:id/…)
 *   - the bridge alert-sound op (Live says "play the alert", Chat resolves the sound)
 * The authority-not-flipped refusal (503 { ok:false, error:'not yet' }) is checked for every writer.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('chat-apis');
let h, RO, BRIDGE, streamer, other, admin, mod, stranger, channelId, streamId;
const STAGED_TABLES = ['channel_moderators', 'channel_moderation_settings', 'emotes'];
const deletedAssets = [];
let assets = { upload: null, delete: null };

function checkContract(ref, body) {
    const r = validate(ref, body);
    assert.ok(r.valid, `${ref} invalid: ${JSON.stringify(r.errors)} (${JSON.stringify(body)})`);
}
const asChat = (table) => h.db.setTableAuthority(table, 'chat');

t('boot', async () => {
    // 3 emotes per channel, so both the clash check and the cap can be exercised.
    h = await boot({ env: { MAX_EMOTES_PER_CHANNEL: '3' } });
    RO = h.serviceToken(['chat.moderation.read']);
    BRIDGE = h.serviceToken(['chat.live_bridge.write']);
    streamer = h.addUser('streamer', { role: 'streamer' });
    other = h.addUser('otherstreamer', { role: 'streamer' });
    admin = h.addUser('adminny', { role: 'admin' });
    mod = h.addUser('moddy');
    stranger = h.addUser('stranger');
    channelId = h.addChannel(streamer.id, { moderators: [mod.id], settings: { channel_id: 0, custom_emotes_enabled: 1 } });
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
    // The Media mock: uploads answer a public object, deletes are recorded.
    assets.upload = async (buf, opts) => ({ id: 777, public_url: `https://openvibe.media/chat/${(opts && opts.filename) || 'emote.png'}` });
    assets.delete = async (id) => { deletedAssets.push(id); return true; };
    require('../server/media/client')._setClient({ upload: assets.upload, delete: assets.delete });
});

// ── Internal read API ────────────────────────────────────────
t('internal read API: loopback + service token (401 / 403 / forwarded)', async () => {
    let r = await h.http('GET', `/internal/moderation/channels/${channelId}`);
    assert.strictEqual(r.status, 401, r.text);
    r = await h.http('GET', `/internal/moderation/channels/${channelId}`, { token: BRIDGE, headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(r.status, 403, 'a forwarded request is refused (loopback only)');
    r = await h.http('GET', `/internal/moderation/channels/${channelId}`, { token: BRIDGE });
    assert.strictEqual(r.status, 403, 'wrong capability');
    r = await h.http('GET', `/api/internal/moderation/channels/${channelId}`, { token: RO });
    assert.strictEqual(r.status, 404, 'not a public path');
});

t('internal read API: settings + moderator_ids validate, defaults for a channel with no row', async () => {
    const r = await h.http('GET', `/internal/moderation/channels/${channelId}`, { token: RO });
    assert.strictEqual(r.status, 200, r.text);
    checkContract('chat.channel-moderation-result', r.body);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.settings.channel_id, channelId);
    // Live's defaults when the channel has no settings row.
    const d = await h.http('GET', '/internal/moderation/channels/999999', { token: RO });
    checkContract('chat.channel-moderation-result', d.body);
    assert.strictEqual(d.body.settings.channel_id, 999999);
    assert.strictEqual(d.body.settings.max_message_length, 500);
    assert.strictEqual(d.body.settings.allow_anonymous, 1);
    assert.deepStrictEqual(d.body.moderator_ids, []);
});

t('internal read API: moderator_ids oldest first; the channels a user moderates validate', async () => {
    asChat('channel_moderators');
    h.db.addChannelModerator(channelId, mod.id, streamer.id);
    h.db.run('UPDATE channel_moderators SET created_at = ? WHERE user_id = ?', ['2026-01-01 00:00:00', mod.id]);
    h.db.addChannelModerator(channelId, stranger.id, streamer.id);
    h.db.run('UPDATE channel_moderators SET created_at = ? WHERE user_id = ?', ['2026-02-01 00:00:00', stranger.id]);
    const r = await h.http('GET', `/internal/moderation/channels/${channelId}`, { token: RO });
    checkContract('chat.channel-moderation-result', r.body);
    assert.deepStrictEqual(r.body.moderator_ids, [mod.id, stranger.id]);

    // other moderates nothing; mod moderates one channel (title/owner from the projection).
    let c = await h.http('GET', `/internal/moderation/users/${mod.id}/channels`, { token: RO });
    checkContract('chat.moderated-channels-result', c.body);
    assert.strictEqual(c.body.channels.length, 1);
    assert.strictEqual(c.body.channels[0].channel_id, channelId);
    assert.strictEqual(c.body.channels[0].owner_user_id, streamer.id);
    assert.strictEqual(c.body.channels[0].owner_username, 'streamer');
    assert.strictEqual(c.body.channels[0].title, 'Channel');
    c = await h.http('GET', `/internal/moderation/users/${other.id}/channels`, { token: RO });
    checkContract('chat.moderated-channels-result', c.body);
    assert.deepStrictEqual(c.body.channels, []);
});

t('internal read API: emote count validates; channels.id resolves to its owner', async () => {
    const r = await h.http('GET', `/internal/moderation/channels/${channelId}/emote-count`, { token: RO });
    assert.strictEqual(r.status, 200, r.text);
    checkContract('chat.emote-count-result', r.body);
    assert.strictEqual(r.body.count, 0);
});

// ── Emote API ────────────────────────────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
async function upload(userId, token, fields = {}, bytes = PNG, type = 'image/png') {
    const form = new FormData();
    form.append('image', new Blob([bytes], { type }), 'emote.png');
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    const res = await fetch(`${h.base}/api/emotes`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
}

t('emote API: the authority-not-flipped refusal (503 not yet, nothing written)', async () => {
    const r = await upload(streamer.id, streamer.token, { code: 'refused' });
    assert.strictEqual(r.status, 503, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { ok: false, error: 'not yet' });
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM emotes').n, 0);
});

t('emote API: create uploads to Media, lists in Live\'s shapes, clash and cap', async () => {
    asChat('emotes');
    // Public list shapes need no auth.
    let r = await h.http('GET', '/api/emotes/defaults');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.emotes.length, 25);

    const up = await upload(streamer.id, streamer.token, { code: 'hype', size: 150 });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.emote.code, 'hype');
    assert.strictEqual(up.body.emote.url, 'https://openvibe.media/chat/emote.png');
    const row = h.db.get('SELECT * FROM emotes WHERE code = ?', ['hype']);
    assert.strictEqual(row.media_asset_id, 777);
    assert.strictEqual(row.media_url, 'https://openvibe.media/chat/emote.png');
    assert.strictEqual(row.size, 150);

    // Channel list uses media_url.
    const ch = await h.http('GET', `/api/emotes/channel/${streamer.id}`);
    assert.strictEqual(ch.status, 200);
    assert.strictEqual(ch.body.emotes[0].url, 'https://openvibe.media/chat/emote.png');
    assert.strictEqual(ch.body.emotes[0].source, 'channel');

    // mine: authenticated, count/max.
    const mine = await h.http('GET', '/api/emotes/mine', { token: streamer.token });
    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual([mine.body.count, mine.body.max], [1, 3]);

    // Clash within the channel.
    const lie = await upload(streamer.id, streamer.token, { code: 'fakeimg' }, Buffer.from('<html><script>x</script></html>'), 'image/png');
    assert.strictEqual(lie.status, 400, 'bytes that are not the declared image type are refused');
    const clash = await upload(streamer.id, streamer.token, { code: 'hype' });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));

    // Cap: 3 per channel (already 1), the third is refused.
    assert.strictEqual((await upload(streamer.id, streamer.token, { code: 'two' })).status, 200);
    assert.strictEqual((await upload(streamer.id, streamer.token, { code: 'three' })).status, 200);
    const full = await upload(streamer.id, streamer.token, { code: 'four' });
    assert.strictEqual(full.status, 400, JSON.stringify(full.body));
    assert.match(full.body.error, /full/);

    // Code validation + bad type.
    const bad = await upload(streamer.id, streamer.token, { code: 'x' });
    assert.strictEqual(bad.status, 400);
    const r2 = await h.http('GET', '/api/emotes/file/whatever.png');
    assert.strictEqual(r2.status, 404);
});

t('emote API: rename/resize, delete removes the Media object', async () => {
    const row = h.db.get('SELECT * FROM emotes WHERE code = ?', ['hype']);
    let r = await h.http('PATCH', `/api/emotes/${row.id}`, { token: streamer.token, body: { code: 'hype2', size: 300 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.code, r.body.size], ['hype2', 200], 'size clamped to the channel max (200)');

    r = await h.http('DELETE', `/api/emotes/${row.id}`, { token: streamer.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(h.db.get('SELECT COUNT(*) AS n FROM emotes WHERE id = ?', [row.id]).n, 0);
    assert.deepStrictEqual(deletedAssets, [777], 'the Media object is removed');
});

t('emote API: not-mine is refused, sources round-trip through the Live-context effect', async () => {
    const row = h.db.get('SELECT id FROM emotes WHERE code = ?', ['two']);
    const r = await h.http('PATCH', `/api/emotes/${row.id}`, { token: other.token, body: { code: 'nope' } });
    assert.strictEqual(r.status, 403, r.text);

    const s = await h.http('GET', '/api/emotes/sources', { token: streamer.token });
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(s.body.sources, { defaults: true, custom: true, ffz: true, bttv: true, '7tv': true });
    const p = await h.http('PUT', '/api/emotes/sources', { token: streamer.token, body: { ffz: false } });
    assert.strictEqual(p.status, 200, p.text);
    assert.strictEqual(p.body.sources.ffz, false);
    assert.ok(h.live.effects.some((e) => e.name === 'channel-emote-sources'), 'the write reaches Live');
    const s2 = await h.http('GET', '/api/emotes/sources', { token: streamer.token });
    assert.strictEqual(s2.body.sources.ffz, false);
});

// ── Moderators & moderation settings ─────────────────────────
t('moderators: owner and admin add/remove, a stranger is refused', async () => {
    asChat('channel_moderators');
    let r = await h.http('POST', `/api/chat/channels/${channelId}/mods`, { token: stranger.token, body: { username: 'moddy' } });
    assert.strictEqual(r.status, 403, r.text);
    r = await h.http('POST', `/api/chat/channels/${channelId}/mods`, { token: streamer.token, body: { username: 'moddy' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.moderators.some((m) => m.user_id === mod.id));
    r = await h.http('DELETE', `/api/chat/channels/${channelId}/mods/${mod.id}`, { token: admin.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.body.moderators.some((m) => m.user_id === mod.id));
    r = await h.http('POST', `/api/chat/channels/${channelId}/mods`, { token: streamer.token, body: { username: 'nobodyhere' } });
    assert.strictEqual(r.status, 404, r.text);
});

t('moderators: list is public to any signed-in reader; moderation settings are mod-only', async () => {
    const list = await h.http('GET', `/api/chat/channels/${channelId}/mods`, { token: other.token });
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.body.channel_id, channelId);

    let s = await h.http('GET', `/api/chat/channels/${channelId}/moderation`, { token: other.token });
    assert.strictEqual(s.status, 403, s.text);
    s = await h.http('GET', `/api/chat/channels/${channelId}/moderation`, { token: streamer.token });
    assert.strictEqual(s.status, 200, s.text);
    assert.strictEqual(s.body.settings.custom_emotes_enabled, 1);
    const mine = await h.http('GET', '/api/chat/channels/moderation/mine', { token: streamer.token });
    assert.strictEqual(mine.status, 200, mine.text);
    assert.ok(mine.body.channels.some((c) => c.id === channelId));
});

t('moderation settings: owner writes, a mod cannot change policy keys, authority gate first', async () => {
    // While Live writes the settings, the write refuses.
    h.db.setTableAuthority('channel_moderation_settings', 'live');
    let r = await h.http('PUT', `/api/chat/channels/${channelId}/moderation`, { token: streamer.token, body: { slow_mode_seconds: 5 } });
    assert.strictEqual(r.status, 503, r.text);
    assert.deepStrictEqual(r.body, { ok: false, error: 'not yet' });

    asChat('channel_moderation_settings');
    asChat('channel_moderators');
    h.db.addChannelModerator(channelId, mod.id, streamer.id);
    r = await h.http('PUT', `/api/chat/channels/${channelId}/moderation`, { token: streamer.token, body: { slow_mode_seconds: 12, ip_approval_mode: 1 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.settings.slow_mode_seconds, 12);
    assert.strictEqual(r.body.settings.ip_approval_mode, 1);

    // A mod passing an owner-policy key: ignored, not refused.
    r = await h.http('PUT', `/api/chat/channels/${channelId}/moderation`, { token: mod.token, body: { slow_mode_seconds: 3, allow_anonymous: 0 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.settings.slow_mode_seconds, 3);
    assert.strictEqual(r.body.settings.allow_anonymous, 1, 'owner policy stayed');

    const s = await h.http('GET', `/api/chat/channels/${channelId}/moderation`, { token: mod.token });
    assert.strictEqual(s.status, 200, s.text);

    const logs = await h.http('GET', `/api/chat/channels/${channelId}/moderation/logs`, { token: streamer.token });
    assert.strictEqual(logs.status, 200, logs.text);
    assert.ok(Array.isArray(logs.body.actions));
    const search = await h.http('GET', `/api/chat/channels/${channelId}/moderation/chat-search?q=hi`, { token: streamer.token });
    assert.strictEqual(search.status, 200, search.text);
    assert.ok(Array.isArray(search.body.messages));
});

// ── Alert-sound op ───────────────────────────────────────────
t('alert op: Chat resolves the sound from its own row and broadcasts it', async () => {
    asChat('channel_moderation_settings');
    const snd = path.join(h.tmp, 'sounds', 'donation.mp3');
    fs.writeFileSync(snd, 'ID3alert');
    h.db.setChannelAlertSound(channelId, 'donation', snd, 'audio/mpeg');

    const ws = await h.ws({ ip: '198.51.100.7', stream: streamId });
    ws.sendJson({ type: 'join', streamId, channelUserId: streamer.id, anonId: null });
    await ws.next((m) => m.type === 'auth' || m.type === 'connected');

    const calls = (ops) => h.http('POST', '/internal/live/calls', { token: BRIDGE, body: { boot: 'live-boot-alerts', ops: ops.map((o, i) => ({ seq: i + 1, ...o })) } });
    let r = await calls([{ op: 'playAlertSound', args: [streamer.id, streamId, 'donation'] }]);
    assert.strictEqual(r.status, 200, r.text);
    const res = r.body.results[0];
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.deepStrictEqual(res.result, { played: true, source: 'donation-alert' });
    const frame = await ws.next((m) => m.type === 'soundboard-audio');
    assert.strictEqual(frame.source, 'donation-alert');
    assert.strictEqual(Buffer.from(frame.audio, 'base64').toString(), 'ID3alert');
    ws.close();

    // No goal sound set: goal falls back to the donation sound; a channel with none does not play.
    r = await calls([{ op: 'playAlertSound', args: [streamer.id, streamId, 'goal'] }]);
    assert.deepStrictEqual(r.body.results[0].result, { played: true, source: 'goal-alert' });
    r = await calls([{ op: 'playAlertSound', args: [other.id, streamId, 'donation'] }]);
    assert.deepStrictEqual(r.body.results[0].result, { played: false, source: 'donation-alert' });
});

t.run(async () => { if (h) await h.close(); });
