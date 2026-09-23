'use strict';
/**
 * /api/sounds (upload → MP3, list, serve, !command playback in chat, delete rules, alert sounds
 * written to Live's channel settings) and /api/tts admin settings (admins; credentials owner-only;
 * written through Live).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, suite } = require('./helpers');

const t = suite('sounds-tts');
let h, streamer, viewer, other, admin, owner, channelId, streamId;

function wav(seconds = 0.4) {
    const rate = 8000, n = Math.floor(rate * seconds);
    const b = Buffer.alloc(44 + n);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
    b.fill(128, 44);
    return b;
}
async function upload(p, token, fields, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    fd.append('sound', new Blob([file], { type: 'audio/wav' }), 'clip.wav');
    const res = await fetch(`${h.base}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    return { status: res.status, body: await res.json().catch(() => null) };
}

t('boot', async () => {
    h = await boot();
    streamer = h.addUser('streamer', { role: 'streamer' });
    viewer = h.addUser('viewer');
    other = h.addUser('other');
    admin = h.addUser('admin2', { role: 'admin' });
    owner = h.addUser('owner', { role: 'admin', is_owner: 1 });
    channelId = h.addChannel(streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
});

let soundId, soundUrl;
t('upload a channel sound: converted to MP3 in the shared sounds dir, listed, served', async () => {
    const r = await upload('/api/sounds', viewer.token, { command: '!Honk', channel_id: streamer.id }, wav());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    soundId = r.body.sound.id;
    soundUrl = r.body.sound.url;
    assert.strictEqual(r.body.sound.command, 'honk');
    assert.match(soundUrl, /^\/api\/sounds\/file\/snd-.*\.mp3$/);
    const row = h.db.getChannelSoundById(soundId);
    assert.ok(row.url.startsWith(path.resolve(process.env.SOUNDS_PATH)) && fs.existsSync(row.url));
    await h.sleep(150);
    assert.ok(h.live.effects.some((e) => e.name === 'asset-sync' && e.body.op === 'syncSoon'), 'Live mirrors it to Media');
    const list = await h.http('GET', `/api/sounds/channel/${streamer.id}`);
    assert.deepStrictEqual(list.body.sounds.map((s) => s.command), ['honk']);
    assert.strictEqual((await h.http('GET', `/api/sounds/all/${streamId}`)).body.sounds.length, 1);
    const file = await fetch(`${h.base}${soundUrl}`);
    assert.strictEqual(file.headers.get('content-type'), 'audio/mpeg');
    assert.ok(Buffer.from(await file.arrayBuffer()).length > 100);
    const reserved = await upload('/api/sounds', viewer.token, { command: 'skip', channel_id: streamer.id }, wav());
    assert.strictEqual(reserved.status, 400);
});

t('!honk in the stream chat plays it (rich announce + audio), persisted', async () => {
    const ws = await h.ws({ ip: '198.51.100.80', token: other.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: other.token });
    await ws.next((m) => m.type === 'auth');
    ws.sendJson({ type: 'chat', message: '!honk 0.5' });
    const ann = await ws.next((m) => m.type === 'chat' && m.message_type === 'channel-sound');
    assert.strictEqual(ann.message, 'played !honk');
    assert.strictEqual(ann.sound.speed, 0.5);
    const audio = await ws.next((m) => m.type === 'soundboard-audio');
    assert.strictEqual(audio.title, '!honk');
    assert.ok(audio.audio.length > 100);
    assert.strictEqual(h.db.getChatMessageById(ann.id).message_type, 'channel-sound');
    ws.close();
});

t('delete: not someone else’s sound; the uploader can; Live drops the Media copy first', async () => {
    assert.strictEqual((await h.http('DELETE', `/api/sounds/${soundId}`, { token: other.token })).status, 403);
    const row = h.db.getChannelSoundById(soundId);
    const del = await h.http('DELETE', `/api/sounds/${soundId}`, { token: viewer.token });
    assert.deepStrictEqual(del.body, { message: 'Sound deleted' });
    assert.ok(!fs.existsSync(row.url));
    assert.ok(h.live.effects.some((e) => e.name === 'asset-sync' && e.body.op === 'remove-sound' && e.body.asset_id === soundId));
    assert.strictEqual(h.db.getChannelSoundById(soundId), undefined);
});

t('alert sounds: the streamer’s own channel, stored through Live', async () => {
    const r = await upload('/api/sounds/alert/donation', streamer.token, {}, wav());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.kind, 'donation');
    const fx = h.live.effects.find((e) => e.name === 'alert-sound');
    assert.strictEqual(fx.body.channel_id, channelId);
    assert.strictEqual(fx.body.actor_user_id, streamer.id);
    assert.ok(fx.body.url.startsWith(path.resolve(process.env.SOUNDS_PATH)));
});

t('TTS admin settings: admins only; credentials only the owner; written by Live', async () => {
    assert.strictEqual((await h.http('PUT', '/api/tts/admin/settings', { token: viewer.token, body: { tts_enabled: false } })).status, 403);
    const a = await h.http('PUT', '/api/tts/admin/settings', { token: admin.token, body: { tts_max_length: 300, tts_google_api_key: 'nope', bogus: 1 } });
    assert.deepStrictEqual(a.body, { success: true, updated: 1 });
    let fx = h.live.effects.filter((e) => e.name === 'site-settings').pop();
    assert.deepStrictEqual(fx.body.settings, { tts_max_length: 300 });
    const o = await h.http('PUT', '/api/tts/admin/settings', { token: owner.token, body: { tts_google_api_key: 'real-key', tts_aws_secret_access_key: '••••1234' } });
    assert.deepStrictEqual(o.body, { success: true, updated: 1 }, 'a masked placeholder never overwrites a secret');
    fx = h.live.effects.filter((e) => e.name === 'site-settings').pop();
    assert.deepStrictEqual(fx.body.settings, { tts_google_api_key: 'real-key' });
    const ownerView = await h.http('GET', '/api/tts/admin/settings', { token: owner.token });
    assert.strictEqual(ownerView.body.settings.googleApiKey, 'real-key');
    const view = await h.http('GET', '/api/tts/admin/settings', { token: admin.token });
    assert.strictEqual(view.body.settings.googleApiKey, '••••••••', 'admins see credentials masked');
    // (Live masks the engine's cached settings object in place, so for up to 30s after an admin
    // looks, the owner — and Google synthesis — see the mask too. Moved as it is; see docs/cutover.md.)
});

t.run(async () => { if (h) await h.close(); });
