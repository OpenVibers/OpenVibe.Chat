'use strict';
/**
 * Watch parties (Agent Streams S7, design 2026-11-06 §4): a private Chat room of kind 'party' on a public agent
 * stream or its VOD.
 *
 *   - private by default: without the link a stranger sees the same 404 as a missing room, and the party is not listed;
 *   - joining is by the link's secret, and membership is remembered after it;
 *   - on a VOD the host's position is what everyone sees; a live party follows the live edge and takes no position;
 *   - a listed party reaches the stream's page as a count only, never names, and disappears when the host ends it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('parties');
let h, ann, bob, cat;
const AGENT = 'ags_01JAB2C3D4E5F6G7H8J9K0MNPS';
const api = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

t('a party is private by default and joins by its link', async () => {
    const r = await api('POST', '/parties', ann, { agent_stream_id: AGENT, vod_id: '4242', title: 'Friday watch', listed: true });
    assert.strictEqual(r.status, 201, r.text);
    const { party, join_secret: key } = r.body;
    assert.match(party.id, /^party-[0-9a-f]{8}$/);
    assert.strictEqual(party.agent_stream_id, AGENT);
    assert.strictEqual(party.vod_id, '4242');
    assert.strictEqual(party.visibility, 'private');
    assert.strictEqual(party.sync.mode, 'vod');
    assert.strictEqual(party.sync.playing, false);
    assert.match(party.join_url, /\/rooms\/party-[0-9a-f]{8}\?k=/);
    assert.ok(key && key.length >= 20);
    assert.ok(!('join_secret' in party), 'the secret lives in the link, not as its own field');

    assert.strictEqual((await api('GET', `/rooms/${party.id}`, bob)).status, 404, 'the room itself is private');
    assert.strictEqual((await api('GET', `/${party.id}/party`, bob)).status, 404, 'without the link it is a missing room');
    assert.strictEqual((await api('POST', `/${party.id}/join`, bob)).status, 404, 'a plain join is refused');
    const wrong = await api('GET', `/${party.id}/party?k=not-the-link`, bob);
    assert.strictEqual(wrong.status, 404);
    const opened = await api('GET', `/${party.id}/party?k=${encodeURIComponent(key)}`, bob);
    assert.strictEqual(opened.status, 200, opened.text);
    assert.strictEqual(opened.body.party.id, party.id);
    const joined = await api('POST', `/${party.id}/party/join`, bob, { k: key });
    assert.strictEqual(joined.status, 200, joined.text);
    assert.strictEqual(joined.body.role, 'member');
    const listed = (await api('GET', '/', bob)).body;
    assert.ok(!listed.public.some((x) => x.slug === party.id), 'a party is never in the directory');
});

t('on a VOD the host moves it and everyone follows', async () => {
    const made = await api('POST', '/parties', ann, { agent_stream_id: AGENT, vod_id: '4242', title: 'Host position', listed: true });
    assert.strictEqual(made.status, 201, made.text);
    const { party, join_secret: key } = made.body;
    const moved = await api('PUT', `/${party.id}/party`, ann, { position_s: 312, playing: true });
    assert.strictEqual(moved.status, 200, moved.text);
    assert.strictEqual(moved.body.party.sync.position_s, 312);
    assert.strictEqual(moved.body.party.sync.playing, true);
    const bobSees = await api('GET', `/${party.id}/party?k=${encodeURIComponent(key)}`, bob);
    assert.strictEqual(bobSees.status, 200);
    assert.ok(bobSees.body.party.sync.position_s >= 312, 'the guest is at the host position');
    assert.ok(bobSees.body.party.sync.position_s <= 315, 'the clock moved it, not a guess');
    assert.strictEqual((await api('POST', `/${party.id}/party/join`, bob, { k: key })).status, 200);
    assert.strictEqual((await api('PUT', `/${party.id}/party`, bob, { position_s: 0 })).status, 403, 'only the host moves it');
    const paused = await api('PUT', `/${party.id}/party`, ann, { position_s: 400, playing: false });
    assert.strictEqual(paused.body.party.sync.position_s, 400);
    const still = await api('GET', `/${party.id}/party?k=${encodeURIComponent(key)}`, bob);
    assert.strictEqual(still.body.party.sync.position_s, 400, 'paused: the position does not move');
});

t('a live party follows the live edge and takes no position', async () => {
    const made = await api('POST', '/parties', ann, { agent_stream_id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNPV', title: 'Live edge' });
    assert.strictEqual(made.status, 201, made.text);
    assert.deepStrictEqual(made.body.party.sync, { mode: 'live', playing: true });
    const refused = await api('PUT', `/${made.body.party.id}/party`, ann, { position_s: 10 });
    assert.strictEqual(refused.status, 409, refused.text);
    assert.strictEqual(refused.body.code, 'party.live_edge');
});

t('the stream page gets a count, never a name, and it drops when the party ends', async () => {
    const count = await api('GET', `/parties/count?agent_stream=${AGENT}`, null);
    assert.strictEqual(count.status, 200, count.text);
    assert.strictEqual(count.body.count, 2, 'the two listed VOD parties');
    const text = JSON.stringify(count.body);
    assert.ok(!/ann|bob|cat|host|member/.test(text), 'a count carries no name');
    const unlisted = await api('POST', '/parties', ann, { agent_stream_id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNPW', title: 'Quiet party' });
    assert.strictEqual(unlisted.status, 201, unlisted.text);
    const quiet = await api('GET', `/parties/count?agent_stream=ags_01JAB2C3D4E5F6G7H8J9K0MNPW`, null);
    assert.strictEqual(quiet.body.count, 0, 'unlisted parties are not counted');
    const first = await api('GET', `/parties/count?agent_stream=${AGENT}`, null);
    assert.strictEqual(first.body.count, 2);
    const ended = await api('POST', '/parties/count', null, {});
    assert.ok(ended.status === 404 || ended.status === 405, 'the count is a read');
});

t('the host ends a party and the count drops', async () => {
    const made = await api('POST', '/parties', ann, { agent_stream_id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNPX', vod_id: '9', title: 'Ending soon', listed: true });
    const { party, join_secret: key } = made.body;
    assert.strictEqual((await api('GET', `/parties/count?agent_stream=ags_01JAB2C3D4E5F6G7H8J9K0MNPX`, null)).body.count, 1);
    assert.strictEqual((await api('POST', `/${party.id}/party/end`, bob)).status, 403, 'only the host ends it');
    const ended = await api('POST', `/${party.id}/party/end`, ann);
    assert.strictEqual(ended.status, 200, ended.text);
    assert.ok(ended.body.party.ended_at);
    assert.strictEqual((await api('GET', `/parties/count?agent_stream=ags_01JAB2C3D4E5F6G7H8J9K0MNPX`, null)).body.count, 0);
    const gone = await api('GET', `/${party.id}/party?k=${encodeURIComponent(key)}`, bob);
    assert.strictEqual(gone.status, 200, 'the room stays readable with its chat');
    assert.ok(gone.body.party.ended_at);
});

t('the host needs an OpenVibe subject and a real agent stream id', async () => {
    const noSubject = h.addUser('dave', { subject: null });
    await h.ctx.upsertUser(h.live.users.get(noSubject.id));
    const r = await api('POST', '/parties', noSubject, { agent_stream_id: AGENT, title: 'No subject' });
    assert.strictEqual(r.status, 409, r.text);
    const bad = await api('POST', '/parties', ann, { agent_stream_id: 'not-a-stream', title: 'Bad id' });
    assert.strictEqual(bad.status, 422, bad.text);
    assert.strictEqual((await api('POST', '/', ann, { name: 'A party room', kind: 'party' })).status, 422, 'a party room is made by starting a party');
});

t.run(async () => { if (h && h.close) await h.close(); });
