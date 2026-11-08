'use strict';
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('party radio');
const ID = 'rad_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const AUDIO = `https://openvibe.download/api/v1/radio/tracks/${ID}/audio`;
const TRACK = { id: ID, title: 'Friday Song', artist: 'Ann', source: 'creator', source_url: null,
    licence: 'creator_grant', licence_url: 'https://openvibe.download/radio/licence', ai_made: false, audio_url: AUDIO };
let service, h, ann, bob, cat, party, key;
const api = (method, path, u, body) => h.http(method, `/api/chat/parties${path}`, { token: u && u.token, body });

t('boot with the Radio catalogue', async () => {
    service = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/radio/tracks') return res.end(JSON.stringify({ tracks: [TRACK] }));
        if (req.url === `/api/v1/radio/tracks/${ID}`) return res.end(JSON.stringify({ track: TRACK }));
        res.writeHead(404); res.end('{}');
    });
    await new Promise((r) => service.listen(0, '127.0.0.1', r));
    process.env.CHAT_RADIO_URL = `http://127.0.0.1:${service.address().port}`;
    h = await boot({ env: { CHAT_PARTY_URL: 'https://openvibe.party' } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('a published track starts a listening party with rights on the stage', async () => {
    const made = await api('POST', '/', ann, { radio_track_id: ID });
    assert.strictEqual(made.status, 201, made.text);
    party = made.body.party;
    key = made.body.join_secret;
    assert.strictEqual(party.kind, 'radio');
    assert.strictEqual(party.media, AUDIO);
    const detail = await api('GET', `/${party.id}`, ann);
    assert.strictEqual(detail.body.party.radio.current.licence, 'creator_grant');
    assert.strictEqual(detail.body.party.clock.position_ms, 0);
    assert.strictEqual(detail.body.party.clock.paused, true);
    const guest = await api('GET', `/${party.id}?k=${made.body.join_secret}`, null);
    assert.strictEqual(guest.status, 200);
    assert.strictEqual(guest.body.party.radio.current.source, 'creator');
});

t('the host controls queue rights and a skip starts the next track at zero', async () => {
    const join = await h.http('POST', `/api/chat/rooms/${party.id}/party/join`, { token: bob.token, body: { k: key } });
    assert.strictEqual(join.status, 200, join.text);
    const forbidden = await api('POST', `/${party.id}/radio/queue`, bob, { track_id: ID });
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.code, 'radio.rights');
    assert.strictEqual((await api('POST', `/${party.id}/radio/queue`, ann, { track_id: 'https://example.org/song.mp3' })).body.code, 'radio.track');
    const queued = await api('POST', `/${party.id}/radio/queue`, ann, { track_id: ID });
    assert.strictEqual(queued.status, 200, queued.text);
    assert.strictEqual(queued.body.radio.queue.length, 1);
    assert.strictEqual((await api('POST', `/${party.id}/radio/allow`, bob, { allow_everyone: true })).status, 403);
    const allowed = await api('POST', `/${party.id}/radio/allow`, ann, { allow_everyone: true });
    assert.strictEqual(allowed.body.radio.allow_everyone, true);
    assert.strictEqual((await api('POST', `/${party.id}/radio/queue`, bob, { track_id: ID })).status, 200);
    const skipped = await api('POST', `/${party.id}/radio/skip`, bob, {});
    assert.strictEqual(skipped.status, 200, skipped.text);
    assert.strictEqual(skipped.body.radio.current.id, ID);
    const now = await api('GET', `/${party.id}`, ann);
    assert.strictEqual(now.body.party.clock.media, AUDIO);
    assert.strictEqual(now.body.party.clock.position_ms, 0);
    assert.strictEqual(now.body.party.clock.paused, false);
});

t('a late joiner receives the shared clock at the right second', async () => {
    const clock = require('../server/rooms/sync-clock');
    const row = await require('../server/rooms/parties').bySlug(party.id);
    const room = { id: row.id, slug: row.slug };
    await clock.set(room, ann.subject_id, { media: AUDIO, position_ms: 12000, paused: false, rate: 1 }, { now: Date.now() - 5000 });
    const joined = await h.http('POST', `/api/chat/rooms/${party.id}/party/join`, { token: cat.token, body: { k: key } });
    assert.strictEqual(joined.status, 200, joined.text);
    const ws = await h.ws({ token: cat.token, origin: 'https://openvibe.party' });
    ws.sendJson({ type: 'join_room', room: party.id });
    await ws.next((m) => m.type === 'room_joined');
    const sync = await ws.next((m) => m.type === 'sync');
    const position = sync.state.position_ms + (Date.now() - sync.state.at_ms) * sync.state.rate;
    assert.ok(position >= 17000 && position < 18500, `late joiner position ${position}`);
    const host = await h.ws({ token: ann.token, origin: 'https://openvibe.party' });
    host.sendJson({ type: 'join_room', room: party.id });
    await host.next((m) => m.type === 'room_joined');
    host.sendJson({ type: 'sync', media: 'https://openvibe.media/unlicensed.mp3', position_ms: 0 });
    assert.strictEqual((await host.next((m) => m.type === 'sync_error')).code, 'radio.licence');
    host.close();
    ws.close();
});

t('close', async () => { await h.close(); await new Promise((r) => service.close(r)); delete process.env.CHAT_RADIO_URL; });
t.run();
