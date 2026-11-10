'use strict';
/**
 * Listening together in a party room (openvibe.party): the room's remote holder starts OpenVibe Radio in a shared
 * computer or a watch party, the room's state carries the track, who started it and the second the timeline was
 * measured from, a late joiner follows at that second, and the change reaches the room's socket.
 *
 * The Radio catalogue is a local stand-in, exactly as Radio publishes it; no audio is fetched here.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('party music');
const T1 = 'rad_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const T2 = 'rad_01JAB2C3D4E5F6G7H8J9K0MNRR';
const AUDIO1 = `https://openvibe.download/api/v1/radio/tracks/${T1}/audio`;
const AUDIO2 = `https://openvibe.download/api/v1/radio/tracks/${T2}/audio`;
const track = (id, title, artist, audio) => ({ id, title, artist, source: 'creator', source_url: null,
    licence: 'creator_grant', licence_url: 'https://openvibe.download/radio/licence', ai_made: false, audio_url: audio });
const TRACKS = [track(T1, 'Friday Song', 'Ann', AUDIO1), track(T2, 'Saturday Song', 'Bob', AUDIO2)];
let service, h, ann, bob, cat, party, key;

const api = (method, path, u, body) => h.http(method, `/api/chat/parties${path}`, { token: u && u.token, body });
/** The party host page: its own Host header, so the Host-based party router answers. */
function raw(method, path, { cookie = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: h.port, path, method,
            headers: { host: 'openvibe.party', ...(cookie ? { cookie } : {}) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end();
    });
}
const dataOf = (html) => {
    const m = /<script type="application\/json" id="party-data">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'the page carries its party data');
    return JSON.parse(m[1]);
};

t('boot with the Radio catalogue', async () => {
    service = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/radio/tracks') return res.end(JSON.stringify({ tracks: TRACKS }));
        const one = /^\/api\/v1\/radio\/tracks\/([^/]+)$/.exec(req.url || '');
        if (one) {
            const found = TRACKS.find((x) => x.id === one[1]);
            if (found) return res.end(JSON.stringify({ track: found }));
        }
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

t('a shared computer starts empty, and only the room’s remote holder can start its music', async () => {
    const made = await api('POST', '/', ann, { desktop_hosting: 'link', title: 'Music room' });
    assert.strictEqual(made.status, 201, made.text);
    party = made.body.party;
    key = made.body.join_secret;
    assert.strictEqual(party.kind, 'desktop');

    const before = await api('GET', `/${party.id}`, ann);
    assert.strictEqual(before.status, 200, before.text);
    assert.strictEqual(before.body.party.music, null, 'nothing plays until someone starts it');

    // Bob joins by the link; he is a member but does not hold the remote.
    const joined = await h.http('POST', `/api/chat/rooms/${party.id}/party/join`, { token: bob.token, body: { k: key } });
    assert.strictEqual(joined.status, 200, joined.text);
    const denied = await api('POST', `/${party.id}/music/play`, bob, { station: true });
    assert.strictEqual(denied.status, 403, denied.text);
    assert.strictEqual(denied.body.code, 'music.not_holder');

    const started = await api('POST', `/${party.id}/music/play`, ann, { station: true, volume: 0.1 });
    assert.strictEqual(started.status, 200, started.text);
    const music = started.body.music;
    assert.strictEqual(music.track.id, T1, 'the station starts with the first published track');
    assert.strictEqual(music.station, true);
    assert.strictEqual(music.paused, false);
    assert.strictEqual(music.started_by, ann.subject_id);
    assert.strictEqual(music.started_by_name, 'Ann', 'who started it is in the room state');
    assert.ok(music.started_at && Number.isFinite(Date.parse(music.started_at)));
    assert.ok(music.position_ms >= 0 && music.position_ms < 1000, 'the clock starts at the beginning');
    assert.strictEqual(music.up_next, 1, 'the station queued the other licensed track');
    assert.strictEqual(music.volume, undefined, 'volume is each person’s own, never the room’s');

    const seen = await api('GET', `/${party.id}`, bob);
    assert.strictEqual(seen.body.party.music.track.id, T1, 'every member sees what is playing');
    assert.strictEqual(seen.body.party.music.started_by_name, 'Ann');
    const guest = await api('GET', `/${party.id}?k=${encodeURIComponent(key)}`, null);
    assert.strictEqual(guest.status, 200);
    assert.strictEqual(guest.body.party.music.track.id, T1, 'the link’s holder sees it too');
});

t('the room hears every change, and a late joiner starts at the room’s second', async () => {
    const host = await h.ws({ token: ann.token, origin: 'https://openvibe.party' });
    host.sendJson({ type: 'join_room', room: party.id });
    await host.next((m) => m.type === 'room_joined');
    const listener = await h.ws({ token: bob.token, origin: 'https://openvibe.party' });
    listener.sendJson({ type: 'join_room', room: party.id });
    await listener.next((m) => m.type === 'room_joined');
    // The join itself carries the room's music: nothing has to change for a late joiner to hear it.
    const atJoin = await listener.next((m) => m.type === 'music');
    assert.strictEqual(atJoin.state.track.id, T1);

    const paused = await api('POST', `/${party.id}/music/pause`, ann, {});
    assert.strictEqual(paused.status, 200, paused.text);
    assert.strictEqual(paused.body.music.paused, true);
    const heard = await listener.next((m) => m.type === 'music');
    assert.strictEqual(heard.state.paused, true, 'the room socket hears the pause');

    // Put the timeline five seconds back in time (a room that started before this joiner arrived), then join late.
    const music = require('../server/rooms/party-music');
    const parties = require('../server/rooms/parties');
    const row = await parties.bySlug(party.id);
    await music.change(row, parties.partyOf(row), ann, 'play', { track_id: T1 }, { now: Date.now() - 5000 });
    const late = await api('GET', `/${party.id}`, bob);
    const lateMusic = late.body.party.music;
    assert.ok(lateMusic.position_ms >= 5000 && lateMusic.position_ms < 8000, `late position ${lateMusic.position_ms}`);
    assert.ok(Math.abs(Date.parse(lateMusic.started_at) - (Date.now() - 5000)) < 2000, 'the state says from when');

    // A new socket gets the same timeline on join.
    await h.http('POST', `/api/chat/rooms/${party.id}/party/join`, { token: cat.token, body: { k: key } });
    const lateSocket = await h.ws({ token: cat.token, origin: 'https://openvibe.party' });
    lateSocket.sendJson({ type: 'join_room', room: party.id });
    await lateSocket.next((m) => m.type === 'room_joined');
    const lateHeard = await lateSocket.next((m) => m.type === 'music');
    assert.strictEqual(lateHeard.state.track.id, T1);
    assert.ok(lateHeard.state.position_ms >= 5000, `socket late position ${lateHeard.state.position_ms}`);
    host.close(); listener.close(); lateSocket.close();
});

t('only a published, licensed Radio track can enter the room; the station advances and stops', async () => {
    const bad = await api('POST', `/${party.id}/music/play`, ann, { track_id: 'https://example.org/song.mp3' });
    assert.strictEqual(bad.status, 422, bad.text);
    assert.strictEqual(bad.body.code, 'radio.track');
    const unpublished = await api('POST', `/${party.id}/music/play`, ann, { track_id: 'rad_01JAB2C3D4E5F6G7H8J9K0MZZZ' });
    assert.strictEqual(unpublished.status, 422);
    assert.strictEqual(unpublished.body.code, 'radio.track');

    const started = await api('POST', `/${party.id}/music/play`, ann, { track_id: T1, station: true });
    assert.strictEqual(started.status, 200, started.text);
    assert.strictEqual(started.body.music.track.id, T1);
    const next = await api('POST', `/${party.id}/music/next`, ann, { expected_id: T1 });
    assert.strictEqual(next.status, 200, next.text);
    assert.strictEqual(next.body.music.track.id, T2, 'the station moves to the next licensed track');
    assert.ok(next.body.music.position_ms < 1000, 'the next track starts at zero');
    assert.strictEqual(next.body.music.started_by, ann.subject_id);

    const ended = await api('POST', `/${party.id}/music/ended`, ann, { expected_id: 'rad_01JAB2C3D4E5F6G7H8J9K0MZZZ' });
    assert.strictEqual(ended.status, 200, ended.text);
    assert.strictEqual(ended.body.music.track.id, T2, 'a repeated end for another track changes nothing');

    const stopped = await api('POST', `/${party.id}/music/stop`, ann, {});
    assert.strictEqual(stopped.status, 200, stopped.text);
    assert.strictEqual(stopped.body.music, null);
    assert.strictEqual((await api('GET', `/${party.id}`, ann)).body.party.music, null);
});

t('a single track ends at the end, and the page carries the room’s music and its control', async () => {
    const started = await api('POST', `/${party.id}/music/play`, ann, { track_id: T2 });
    assert.strictEqual(started.status, 200, started.text);
    assert.strictEqual(started.body.music.station, false);
    const page = await raw('GET', `/p/${party.id}`, { cookie: `ov_token=${ann.token}` });
    assert.strictEqual(page.status, 200, page.text.slice(0, 300));
    assert.ok(page.text.includes('data-party-music'), 'the page has the music control’s region');
    const pageData = dataOf(page.text);
    assert.strictEqual(pageData.party.music.track.id, T2);
    assert.strictEqual(pageData.party.music.started_by, ann.subject_id);
    assert.strictEqual(pageData.party.music.started_by_name, 'Ann');
    // The link's holder can hear the room without an account: the page still carries the now-playing state.
    const guestPage = await raw('GET', `/p/${party.id}?k=${encodeURIComponent(key)}`);
    assert.strictEqual(guestPage.status, 200, guestPage.text.slice(0, 300));
    assert.ok(guestPage.text.includes('data-party-music'));
    assert.strictEqual(dataOf(guestPage.text).party.music.track.id, T2);

    const ended = await api('POST', `/${party.id}/music/ended`, ann, { expected_id: T2 });
    assert.strictEqual(ended.status, 200, ended.text);
    assert.strictEqual(ended.body.music, null, 'a single track leaves the room quiet when it ends');
});

t('close', async () => {
    await h.close();
    await new Promise((r) => service.close(r));
    delete process.env.CHAT_RADIO_URL;
});
t.run();
