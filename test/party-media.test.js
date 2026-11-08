'use strict';
/**
 * Watch Together v1, the media party and its host (plan R1, 2026-11-07):
 *
 *   - a media party is a private Chat room whose row carries the media (a Media ref or an OpenVibe https URL) and the
 *     page it was started from; the room's clock starts paused at 0 on that media and the creator holds the remote;
 *   - the join link is openvibe.party/p/<slug>?k=…, and the secret is in the create answer only;
 *   - a stranger without the key (or with a wrong one) gets the missing-room 404; a member gets the members, and a
 *     holder of just the link does not;
 *   - agent-stream parties keep their stream, VOD position and /rooms/ link;
 *   - openvibe.party is served by Host: the start form, /new (sign-in when signed out, the party when signed in) and
 *     the page shell with its data hooks and no key in the HTML.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('party media');
let h, ann, bob, cat;
const MEDIA = { media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ', role: 'video' };
const MEDIA_URL = 'https://openvibe.media/vod/friday.webm';
const api = (method, path, u, body) => h.http(method, `/api/chat${path}`, { token: u && u.token, body });

/** A request with its own Host header (the party host is chosen by it, not by the port we reached). */
function raw(method, path, { host = 'openvibe.party', cookie = null, form = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const body = form ? new URLSearchParams(form).toString() : null;
        const req = http.request({
            host: '127.0.0.1', port: h.port, path, method,
            headers: { host, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}), ...headers },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        req.end(body || undefined);
    });
}
const cookieOf = (u) => `ov_token=${u.token}`;
const dataOf = (html) => {
    const m = /<script type="application\/json" id="party-data">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'the page carries its party data');
    return JSON.parse(m[1]);
};

t('boot', async () => {
    h = await boot({ env: { CHAT_PARTY_URL: 'https://openvibe.party', CHAT_PARTY_OAUTH_REDIRECT_URI: 'https://openvibe.party/auth/callback' } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
});

let party, key;

t('a media party starts paused at 0, on the media, with the remote to the person who started it', async () => {
    const r = await api('POST', '/parties', ann, { media: MEDIA, source_url: 'https://openvibe.live/v/abc123', title: 'Friday film' });
    assert.strictEqual(r.status, 201, r.text);
    party = r.body.party;
    key = r.body.join_secret;
    assert.strictEqual(party.kind, 'media');
    assert.strictEqual(party.title, 'Friday film');
    assert.deepStrictEqual(party.media, MEDIA);
    assert.strictEqual(party.source_url, 'https://openvibe.live/v/abc123');
    assert.match(party.id, /^party-[0-9a-f]{8}$/);
    assert.strictEqual(party.join_url, `https://openvibe.party/p/${party.id}?k=${encodeURIComponent(key)}`);
    assert.ok(key && key.length >= 20, 'the secret appears in the create answer');
    assert.ok(!('sync' in party), 'a media party has no VOD position of its own');
    assert.strictEqual(party.visibility, 'private');

    const seen = await api('GET', `/parties/${party.id}`, ann);
    assert.strictEqual(seen.status, 200, seen.text);
    const view = seen.body.party;
    assert.strictEqual(view.member, true);
    assert.strictEqual(view.host, ann.subject_id);
    assert.strictEqual(view.host_name, 'Ann');
    assert.deepStrictEqual(view.clock && view.clock.media, MEDIA);
    assert.strictEqual(view.clock.position_ms, 0);
    assert.strictEqual(view.clock.paused, true, 'the clock is seeded paused');
    assert.deepStrictEqual(view.lease.holder, { kind: 'person', subject: ann.subject_id }, 'the creator has the remote');
    assert.deepStrictEqual(view.members.map((m) => [m.subject, m.name]), [[ann.subject_id, 'Ann']]);
});

t('the media must be OpenVibe media, and the source page on an OpenVibe host', async () => {
    for (const media of ['https://youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk', 'https://youtube.com/shorts/abcdefghijk', 'https://twitch.tv/videos/12345', 'https://twitch.tv/some_channel']) {
        const provider = await api('POST', '/parties', ann, { media, title: 'Provider watch' });
        assert.strictEqual(provider.status, 201, provider.text);
        const view = await api('GET', `/parties/${provider.body.party.id}`, ann);
        assert.strictEqual(view.body.party.clock.media, media);
    }
    const outside = await api('POST', '/parties', ann, { media: 'https://tracker.example.com/film.webm', title: 'Elsewhere' });
    assert.strictEqual(outside.status, 422, outside.text);
    assert.strictEqual(outside.body.code, 'party.media');
    const notHttps = await api('POST', '/parties', ann, { media: { media_id: 'not-a-ref' }, title: 'Bad ref' });
    assert.strictEqual(notHttps.status, 422, notHttps.text);
    assert.strictEqual(notHttps.body.code, 'party.media');
    const source = await api('POST', '/parties', ann, { media: MEDIA, source_url: 'https://example.com/page', title: 'Wrong page' });
    assert.strictEqual(source.status, 422, source.text);
    assert.strictEqual(source.body.code, 'party.source_url');
    assert.strictEqual((await api('POST', '/parties', null, { media: MEDIA, title: 'Signed out' })).status, 401);
});

t('a stranger without the key, or with a wrong one, sees the missing-room 404', async () => {
    for (const path of [`/parties/${party.id}`, `/parties/${party.id}?k=not-the-link`, `/rooms/${party.id}/party`]) {
        const r = await api('GET', path, bob);
        assert.strictEqual(r.status, 404, `${path}: ${r.text}`);
        assert.strictEqual(r.body.code, 'rooms.not_found');
    }
    // One character off (never the same character: a key that already ends in x would be the right key).
    const wrongKey = key.slice(0, -1) + (key.endsWith('x') ? 'y' : 'x');
    const wrongRoom = await api('GET', `/parties/${party.id}?k=${encodeURIComponent(wrongKey)}`, bob);
    assert.strictEqual(wrongRoom.status, 404);
});

t('the link invites (the members see the people), and joining keeps the seat', async () => {
    const invited = await api('GET', `/parties/${party.id}?k=${encodeURIComponent(key)}`, cat);
    assert.strictEqual(invited.status, 200, invited.text);
    assert.strictEqual(invited.body.party.member, false, 'holding the link is not membership');
    assert.ok(!('members' in invited.body.party), 'a key holder is not shown the room\'s people');
    assert.ok(!('lease' in invited.body.party), 'nor the remote\'s watchers');
    assert.deepStrictEqual(invited.body.party.clock.media, MEDIA, 'but the clock is there');

    const joined = await api('POST', `/rooms/${party.id}/party/join`, bob, { k: key });
    assert.strictEqual(joined.status, 200, joined.text);
    assert.strictEqual(joined.body.role, 'member');
    const seen = await api('GET', `/parties/${party.id}`, bob);
    assert.strictEqual(seen.status, 200, seen.text);
    assert.strictEqual(seen.body.party.member, true);
    assert.deepStrictEqual(seen.body.party.members.map((m) => m.subject).sort(), [ann.subject_id, bob.subject_id].sort());
    assert.ok(seen.body.party.lease, 'a member sees the remote');
    const again = await api('POST', `/rooms/${party.id}/party/join`, bob, { k: key });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.role, 'member', 'a member keeps their seat');
});

t('agent-stream parties are unchanged', async () => {
    const AGENT = 'ags_01JAB2C3D4E5F6G7H8J9K0MNPS';
    const r = await api('POST', '/parties', ann, { agent_stream_id: AGENT, vod_id: '4242', title: 'Stream party', listed: true });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.party.kind, 'agent_stream');
    assert.strictEqual(r.body.party.agent_stream_id, AGENT);
    assert.strictEqual(r.body.party.vod_id, '4242');
    assert.match(r.body.party.join_url, /\/rooms\/party-[0-9a-f]{8}\?k=/);
    assert.deepStrictEqual(r.body.party.sync.mode, 'vod');
    assert.strictEqual(r.body.party.sync.playing, false);
    assert.ok(!('media' in r.body.party));
    assert.strictEqual((await api('PUT', `/rooms/${party.id}/party`, ann, { position_s: 10 })).body.code, 'party.clock');
});

t('openvibe.party: the start form, sign-in, and /new', async () => {
    const signedOut = await raw('GET', '/');
    assert.strictEqual(signedOut.status, 200, signedOut.text.slice(0, 200));
    assert.match(signedOut.text, /Start a party/);
    assert.match(signedOut.text, /\/auth\/login\?next=%2F/);
    assert.ok(!/name="media"/.test(signedOut.text), 'a signed-out visitor gets sign-in, not the form');

    const signedIn = await raw('GET', '/', { cookie: cookieOf(ann) });
    assert.strictEqual(signedIn.status, 200);
    assert.match(signedIn.text, /action="\/new"/);
    assert.match(signedIn.text, /name="media"/);

    const signIn = await raw('GET', `/new?media=${encodeURIComponent(MEDIA_URL)}&title=${encodeURIComponent('Friday film')}`);
    assert.strictEqual(signIn.status, 303);
    assert.match(String(signIn.headers.location), /^\/auth\/login\?next=%2Fnew%3Fmedia%3D/);

    // A link never starts a party by itself: GET /new asks, and only the page's own POST starts it.
    const asks = await raw('GET', `/new?media=${encodeURIComponent(MEDIA_URL)}&title=${encodeURIComponent('Movie night')}`, { cookie: cookieOf(ann) });
    assert.strictEqual(asks.status, 200, asks.text.slice(0, 200));
    assert.match(asks.text, /Start a watch party\?/);
    assert.match(asks.text, /<form method="post" action="\/new">/);
    assert.match(asks.text, /name="media" value="https:\/\/openvibe\.media\/vod\/friday\.webm"/);
    const crossSite = await raw('POST', '/new', { cookie: cookieOf(ann), form: { media: MEDIA_URL, title: 'Evil' }, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.strictEqual(crossSite.status, 403, 'a cross-site POST starts nothing');
    const made = await raw('POST', '/new', { cookie: cookieOf(ann), form: { media: MEDIA_URL, title: 'Movie night' }, headers: { origin: 'https://openvibe.party', 'sec-fetch-site': 'same-origin' } });
    assert.strictEqual(made.status, 303, made.text.slice(0, 200));
    const loc = String(made.headers.location);
    assert.match(loc, /^\/p\/party-[0-9a-f]{8}\?k=/);
    const slug = loc.slice('/p/'.length).split('?')[0];
    const madeKey = decodeURIComponent(loc.split('k=')[1]);

    // The chat site still answers on its own host.
    const chatSite = await raw('GET', '/', { host: 'openvibe.chat' });
    assert.strictEqual(chatSite.status, 200);
    assert.match(chatSite.text, /Global chat/);

    // A stranger on the party host: the same 404 as a missing room.
    const stranger = await raw('GET', `/p/${slug}`);
    assert.strictEqual(stranger.status, 404);
    const bobOutsider = await raw('GET', `/p/${slug}`, { cookie: cookieOf(bob) });
    assert.strictEqual(bobOutsider.status, 404, 'bob joined the other party, not this one');

    // The host's shell: the data hooks, the party JSON, and never the key in the HTML.
    const shell = await raw('GET', `/p/${slug}?k=${encodeURIComponent(madeKey)}`, { cookie: cookieOf(ann) });
    assert.strictEqual(shell.status, 200, shell.text.slice(0, 300));
    for (const hook of ['data-party-stage', 'data-party-people', 'data-party-chat', 'data-party-remote', 'data-party-invite']) {
        assert.ok(shell.text.includes(hook), `${hook} is in the shell`);
    }
    assert.match(shell.text, new RegExp(`<main id="main"[^>]*data-party="${slug}"`));
    const data = dataOf(shell.text);
    assert.strictEqual(data.party.id, slug);
    assert.strictEqual(data.party.title, 'Movie night');
    assert.deepStrictEqual(data.party.clock.media, MEDIA_URL);
    assert.strictEqual(data.party.clock.paused, true);
    assert.strictEqual(data.party.lease.holder.subject, ann.subject_id);
    assert.ok(!shell.text.includes(madeKey), 'the link\'s secret is not echoed into the page');
    // The navbar's Messages count calls Chat's DM API from this host: the page's CSP lets it.
    const csp = String(shell.headers['content-security-policy'] || '');
    assert.match(csp, /connect-src[^;]*https:\/\/openvibe\.chat(\s|;|$)/, 'connect-src names https://openvibe.chat');
    assert.match(csp, /script-src[^;]*https:\/\/www\.youtube\.com/);
    assert.match(csp, /script-src[^;]*https:\/\/embed\.twitch\.tv/);
    assert.match(csp, /frame-src[^;]*https:\/\/www\.youtube-nocookie\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/player\.twitch\.tv/);
    // The page loads Opus's page and Shared's player and clock.
    for (const file of ['/web/party.js', '/web/party.css', '/web/party-providers.js', '/web/party-provider-sync.js', '/shared/ov-sync.js', '/shared/player.js', '/shared/player.css']) {
        assert.ok(shell.text.includes(file), `${file} is on the page`);
    }

    // A member who joined through the API without k sees the shell and still gets no key.
    const joined = await api('POST', `/rooms/${slug}/party/join`, cat, { k: madeKey });
    assert.strictEqual(joined.status, 200, joined.text);
    const member = await raw('GET', `/p/${slug}`, { cookie: cookieOf(cat) });
    assert.strictEqual(member.status, 200);
    assert.ok(!member.text.includes(madeKey), 'no key leak for a member who joined without k');
    assert.deepStrictEqual(dataOf(member.text).party.members.map((m) => m.subject).sort(), [ann.subject_id, cat.subject_id].sort());

    // A stranger opens the link: the page joins them (the link is the invitation), and the shell carries no key.
    const invited = await raw('GET', `/p/${slug}?k=${encodeURIComponent(madeKey)}`, { cookie: cookieOf(bob) });
    assert.strictEqual(invited.status, 200);
    assert.ok(!invited.text.includes(madeKey));
    const bobNow = await api('GET', `/parties/${slug}`, bob);
    assert.strictEqual(bobNow.body.party.member, true, 'opening the link makes the person a member');
});

t('the home offers OpenVibe.Video\'s latest, and a pasted watch page plays its file', async () => {
    // A stand-in for OpenVibe.Video's /api/v1/video/watchable (MediaHub): one public recording, one private page.
    const PAGE = 'https://openvibe.video/watch?v=AbCdEfGhIjK';
    const PRIVATE = 'https://openvibe.video/watch?v=PrIvAtEpAgE';
    const FILE = 'https://openvibe.media/v/4242';
    let up = true;
    const video = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (!up) { res.writeHead(503); return res.end(); }
        res.setHeader('content-type', 'application/json');
        if (u.pathname === '/api/v1/video/watchable/latest') {
            return res.end(JSON.stringify({ items: [
                { kind: 'vod', title: 'Robots <3 paint', page_url: PAGE, thumbnail_url: 'https://openvibe.media/thumb/4242.jpg', duration_s: 3725, channel: 'ann' },
                { kind: 'clip', title: 'Elsewhere', page_url: 'https://evil.example/watch?v=x', thumbnail_url: null, duration_s: 9, channel: null },
            ] }));
        }
        if (u.pathname === '/api/v1/video/watchable' && u.searchParams.get('url') === PAGE) {
            return res.end(JSON.stringify({ kind: 'vod', title: 'Robots <3 paint', page_url: PAGE, file_url: FILE, thumbnail_url: 'https://openvibe.media/thumb/4242.jpg', duration_s: 3725 }));
        }
        res.writeHead(404); res.end('{}');
    });
    await new Promise((r) => video.listen(0, '127.0.0.1', r));
    process.env.CHAT_PARTY_VIDEO_URL = `http://127.0.0.1:${video.address().port}`;
    try {
        const home = await raw('GET', '/', { cookie: cookieOf(ann) });
        assert.strictEqual(home.status, 200);
        assert.match(home.text, /Pick something to watch/);
        assert.match(home.text, /Robots &lt;3 paint/, 'the title, escaped');
        assert.match(home.text, /href="\/new\?media=https%3A%2F%2Fopenvibe\.video%2Fwatch%3Fv%3DAbCdEfGhIjK&amp;title=/, 'a card starts a party on its page');
        assert.match(home.text, /1:02:05/, 'its length');
        assert.ok(!home.text.includes('evil.example'), 'a page on another site is never offered');
        assert.match(home.text, /\/web\/party-home\.css/, 'the home\'s styles');
        assert.match(home.text, /How it works/);

        // A pasted watch page: the confirmation names it, and the party plays its file with the page as its source.
        const asks = await raw('GET', `/new?media=${encodeURIComponent(PAGE)}`, { cookie: cookieOf(ann) });
        assert.strictEqual(asks.status, 200, asks.text.slice(0, 300));
        assert.match(asks.text, /Robots &lt;3 paint/, 'the title from Video');
        assert.match(asks.text, /name="media" value="https:\/\/openvibe\.media\/v\/4242"/, 'the file, not the page');
        const made = await raw('POST', '/new', { cookie: cookieOf(ann), form: { media: PAGE }, headers: { origin: 'https://openvibe.party', 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(made.status, 303, made.text.slice(0, 200));
        const slug = String(made.headers.location).match(/\/p\/([^?]+)/)[1];
        const shell = await raw('GET', made.headers.location, { cookie: cookieOf(ann) });
        const data = JSON.parse(shell.text.match(/<script type="application\/json" id="party-data">([\s\S]*?)<\/script>/)[1]);
        assert.strictEqual(data.party.clock.media, FILE, 'the party plays the file');
        assert.strictEqual(data.party.source_url, PAGE, 'and keeps the page it came from');
        assert.ok(slug);

        // Your parties: Ann gets back in from the home without the link; Cat, who is not in it, never sees it.
        const back = await raw('GET', '/', { cookie: cookieOf(ann) });
        assert.match(back.text, /Your parties/);
        assert.ok(back.text.includes(`href="/p/${slug}"`), 'the party, by its page, no key in it');
        assert.match(back.text, /You started it/);
        const other = await raw('GET', '/', { cookie: cookieOf(cat) });
        assert.ok(!other.text.includes(`/p/${slug}`), 'someone who is not in it never sees it');

        // A private (or unknown) page is not made into a party.
        const refused = await raw('GET', `/new?media=${encodeURIComponent(PRIVATE)}`, { cookie: cookieOf(ann) });
        assert.strictEqual(refused.status, 303);
        assert.match(String(refused.headers.location), /^\/\?error=That%20link%20is%20not%20a%20video/);

        // Video down: the home still answers, without the grid.
        up = false;
        await new Promise((r) => setTimeout(r, 10));
        const quiet = await raw('GET', '/?fresh=1', { cookie: cookieOf(bob) });
        assert.strictEqual(quiet.status, 200);
    } finally {
        delete process.env.CHAT_PARTY_VIDEO_URL;
        await new Promise((r) => video.close(r));
    }
});

t('close', async () => {
    await h.close();
});

t.run();
