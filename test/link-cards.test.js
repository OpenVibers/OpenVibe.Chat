'use strict';
/**
 * A known OpenVibe link in a message shows a card under it (server/chat/link-cards.js, plan HO):
 *
 *   - openvibe.video's watch pages resolve through Video's own /api/v1/video/watchable (a private one is no card);
 *   - an openvibe.party invite shows its title and who started it, and its "Join the party", only with its k=;
 *   - an openvibe.actor shared voice (/voices/<id>.json) and skill (/skills/<slug>.json) show their name and one
 *     line, with Borrow / Install; a failed scan has no Install button;
 *   - an unknown host or path, or a known one with nothing behind it, is no card;
 *   - one card per message; the text is cut and escaped where HTML is drawn, and a picture is only openvibe.media;
 *   - the same URL is fetched once a minute, and the card is stored on the message (room, DM, global, inbox) and
 *     shown by the page and the JSON API.
 *
 * Video and Actor are local stand-ins here: nothing in this file touches the network.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('link cards');
const SITE = 'https://openvibe.chat';
const VOICE = 'shv_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
let h, ann, bob, videoServer, actorServer, videoHits = 0, actorHits = 0, conv, room, inbox, visitorToken;

const start = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
});
const cookie = (u) => ({ cookie: `ov_token=${u.token}` });
const page = async (p, u) => {
    const r = await fetch(`${h.base}${p}`, { headers: u ? cookie(u) : {} });
    return { status: r.status, text: await r.text() };
};
const dmSend = (u, text) => h.http('POST', `/api/dm/conversations/${conv}/messages`, { token: u.token, body: { message: text } });
const globalSend = (u, text) => h.http('POST', '/api/chat/send', { token: u.token, body: { message: text } });
const cardIn = (html) => /<div class="oc-card" data-kind="([a-z]+)">([\s\S]*?)<\/div><\/div>/.exec(html);

t('boot', async () => {
    videoServer = await start((req, res) => {
        videoHits++;
        const u = new URL(req.url, 'http://stand-in');
        const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (u.pathname !== '/api/v1/video/watchable') return send(404, { error: 'not found' });
        const watched = String(u.searchParams.get('url') || '');
        // A private item, and anything that is not a Video page: Video's own 404.
        if (!/^https:\/\/openvibe\.video\//.test(watched) || /\/v\/777$/.test(watched)) return send(404, { error: 'not watchable' });
        const escaping = watched.includes('escaping001');
        send(200, {
            kind: 'upload',
            title: escaping ? `<img src=x onerror=alert(1)>${'x'.repeat(200)}` : 'Friday film',
            page_url: watched,
            thumbnail_url: escaping ? 'https://evil.example/pic.png' : 'https://openvibe.media/vod/friday.jpg',
            duration_s: 3725,
            channel: 'ann',
        });
    });
    actorServer = await start((req, res) => {
        actorHits++;
        const u = new URL(req.url, 'http://stand-in');
        const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (u.pathname === `/voices/${VOICE}.json`) {
            return send(200, { name: 'The Researcher', bio: 'Reads the sources before it answers, and says what it read.' });
        }
        if (u.pathname === '/skills/good-skill.json') {
            return send(200, { skill: { slug: 'good-skill', name: 'Good skill', description: 'Sums a thread up in three lines.' }, scan: { state: 'passed' } });
        }
        if (u.pathname === '/skills/flagged-skill.json') {
            return send(200, { skill: { slug: 'flagged-skill', name: 'Flagged skill', description: 'Reaches one site.' }, scan: { state: 'flagged' } });
        }
        if (u.pathname === '/skills/bad-skill.json') {
            return send(200, { skill: { slug: 'bad-skill', name: 'Bad skill', description: 'Asks for more than it says.' }, scan: { state: 'failed' } });
        }
        return send(404, { error: 'No such voice.' });
    });
    h = await boot({ env: {
        CHAT_WEB_URL: SITE,
        CHAT_PARTY_URL: 'https://openvibe.party',
        CHAT_LINK_VIDEO_URL: `http://127.0.0.1:${videoServer.address().port}`,
        CHAT_LINK_ACTOR_URL: `http://127.0.0.1:${actorServer.address().port}`,
    } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) { await h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); }
    const made = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [bob.id] } });
    assert.strictEqual(made.status, 200, made.text);
    conv = made.body.conversation.id;
});

t('a video watch page is a card with Watch together, and the stored card comes back on read', async () => {
    const r = await dmSend(ann, 'Watch this https://openvibe.video/watch?v=dQw4w9WgXcQ tonight');
    assert.strictEqual(r.status, 200, r.text);
    const card = r.body.message.card;
    assert.strictEqual(card.kind, 'video');
    assert.strictEqual(card.title, 'Friday film');
    assert.strictEqual(card.image, 'https://openvibe.media/vod/friday.jpg');
    assert.match(card.line, /1:02:05/);
    assert.match(card.line, /ann/);
    assert.strictEqual(card.action.label, 'Watch together');
    assert.strictEqual(card.action.href, 'https://openvibe.party/new?media=' + encodeURIComponent('https://openvibe.video/watch?v=dQw4w9WgXcQ'));

    const read = await h.http('GET', `/api/dm/conversations/${conv}/messages`, { token: bob.token });
    const again = read.body.messages.find((m) => m.id === r.body.message.id);
    assert.deepStrictEqual(again.card, card, 'the card is stored on the message and read back');
    const html = await page(`/messages/${conv}`, bob);
    assert.ok(html.text.includes('Watch together'), 'the conversation page draws the move');
    assert.match(html.text, /<div class="oc-card" data-kind="video">/);
    assert.ok(html.text.includes('oc-card-pic'), 'the picture');
});

t('a private video and a page Video does not vouch for are no card', async () => {
    const priv = await dmSend(bob, 'https://openvibe.video/v/777');
    assert.strictEqual(priv.status, 200, priv.text);
    assert.strictEqual(priv.body.message.card, null);
    const notv = await dmSend(bob, 'https://openvibe.video/not-a-watch-page');
    assert.strictEqual(notv.body.message.card, null);
});

t('a party invite shows its title and who started it, only with its k=', async () => {
    const made = await h.http('POST', '/api/chat/parties', { token: ann.token, body: {
        media: { media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ', role: 'video' }, title: 'Friday film night',
    } });
    assert.strictEqual(made.status, 201, made.text);
    const join = made.body.party.join_url;
    const withKey = await dmSend(ann, `Come watch ${join}`);
    assert.strictEqual(withKey.body.message.card.kind, 'party');
    assert.strictEqual(withKey.body.message.card.title, 'Friday film night');
    assert.strictEqual(withKey.body.message.card.line, 'Started by Ann');
    assert.strictEqual(withKey.body.message.card.action.label, 'Join the party');
    assert.strictEqual(withKey.body.message.card.action.href, join);
    assert.ok(!/members|chat/i.test(withKey.body.message.card.line), 'a card never names the members or the chat');

    const noKey = await dmSend(bob, `Come watch ${join.split('?')[0]}`);
    assert.strictEqual(noKey.body.message.card, null, 'a party link without k= is no card');
    const wrongKey = await dmSend(bob, `Come watch ${join.replace(/k=.*/, 'k=nope')}`);
    assert.strictEqual(wrongKey.body.message.card, null, 'a wrong k= is no card either');
});

t('a shared voice is a card with Borrow this agent; a stopped one is no card', async () => {
    const r = await dmSend(ann, `Borrow https://openvibe.actor/voices/${VOICE} for this`);
    assert.strictEqual(r.body.message.card.kind, 'voice');
    assert.strictEqual(r.body.message.card.title, 'The Researcher');
    assert.match(r.body.message.card.line, /Reads the sources/);
    assert.strictEqual(r.body.message.card.action.label, 'Borrow this agent');
    assert.strictEqual(r.body.message.card.action.href, `https://openvibe.actor/voices/${VOICE}`);

    const gone = await dmSend(bob, `Borrow https://openvibe.actor/voices/shv_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4 for this`);
    assert.strictEqual(gone.body.message.card, null);
});

t('a skill is a card with its scan state in words; a failed scan has no Install button', async () => {
    const passed = await dmSend(ann, 'https://openvibe.actor/skills/good-skill');
    assert.strictEqual(passed.body.message.card.kind, 'skill');
    assert.strictEqual(passed.body.message.card.title, 'Good skill');
    assert.match(passed.body.message.card.note, /^The scan found nothing/);
    assert.strictEqual(passed.body.message.card.action.label, 'Install');

    const flagged = await dmSend(bob, 'https://openvibe.actor/skills/flagged-skill');
    assert.match(flagged.body.message.card.note, /read before you install/);
    assert.strictEqual(flagged.body.message.card.action.label, 'Install', 'Actor asks the person to read it first');

    const failed = await dmSend(bob, 'https://openvibe.actor/skills/bad-skill');
    assert.match(failed.body.message.card.note, /stops this skill/);
    assert.strictEqual(failed.body.message.card.action, null, 'a failed scan shows no button');
    const html = await page(`/messages/${conv}`, ann);
    assert.ok(html.text.includes('The scan found something that stops this skill from being installed.'));

    const missing = await dmSend(bob, 'https://openvibe.actor/skills/no-such-skill');
    assert.strictEqual(missing.body.message.card, null);
});

t('an unknown link is no card, and only the first known link gets one', async () => {
    const unknown = await dmSend(bob, 'https://example.com/watch?v=dQw4w9WgXcQ');
    assert.strictEqual(unknown.body.message.card, null);
    const two = await dmSend(ann, 'https://openvibe.video/v/123 then https://openvibe.video/v/456');
    assert.strictEqual(two.body.message.card.kind, 'video');
    assert.strictEqual(two.body.message.card.url, 'https://openvibe.video/v/123');
});

t('the card text is cut and escaped, and the picture only comes from openvibe.media', async () => {
    const r = await dmSend(ann, 'https://openvibe.video/watch?v=escaping001');
    const card = r.body.message.card;
    assert.strictEqual(card.image, null, 'a picture on another host is dropped');
    assert.ok(Array.from(card.title).length <= 120, 'the title is cut to size');
    const html = await page(`/messages/${conv}`, bob);
    assert.ok(html.text.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the title is escaped as text');
    assert.ok(!html.text.includes('<img src=x onerror='), 'never markup');
    assert.ok(!html.text.includes('evil.example'), 'never the other host');
});

t('a room message stores and draws its card too', async () => {
    const made = await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Link room' } });
    assert.strictEqual(made.status, 201, made.text);
    room = made.body.room;
    const posted = await h.http('POST', `/api/chat/rooms/${room.slug}/messages`, { token: ann.token, body: { message: 'https://openvibe.video/v/123' } });
    assert.strictEqual(posted.status, 201, posted.text);
    assert.strictEqual(posted.body.message.card.kind, 'video');
    const list = await h.http('GET', `/api/chat/rooms/${room.slug}/messages`, { token: bob.token });
    assert.strictEqual(list.body.messages.find((m) => m.id === posted.body.message.id).card.kind, 'video');
    const html = await page(`/r/${room.slug}`, bob);
    assert.match(html.text, /<div class="oc-card" data-kind="video">/);
    assert.ok(html.text.includes('Watch together'));
});

t('global chat stores and draws its card, and the card is one per message', async () => {
    const text = 'https://openvibe.video/v/456';
    assert.strictEqual((await globalSend(ann, text)).status, 200);
    const history = await h.http('GET', '/api/chat/global/history?limit=50', { token: bob.token });
    const mine = history.body.messages.find((m) => m.message === text);
    assert.ok(mine && mine.card && mine.card.kind === 'video', JSON.stringify(mine));
    const html = await page('/', bob);
    assert.match(html.text, /<div class="oc-card" data-kind="video">/);
});

t('a support inbox message stores its card and the inbox draws it', async () => {
    const made = await h.http('POST', '/api/chat/inboxes', { token: ann.token, body: { name: 'Link support', ai_enabled: 0, handoff: 1 } });
    assert.strictEqual(made.status, 201, made.text);
    inbox = made.body.inbox;
    const visit = await fetch(`${h.base}/api/chat/widget/inbox/${inbox.id}/visit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const seen = await visit.json();
    visitorToken = seen.token;
    const post = await fetch(`${h.base}/api/chat/widget/inbox/${inbox.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-visitor-token': visitorToken },
        body: JSON.stringify({ message: 'I saw https://openvibe.video/v/123' }),
    });
    const answer = await post.json();
    assert.strictEqual(post.status, 201, JSON.stringify(answer));
    assert.strictEqual(answer.message.card.kind, 'video');
    const html = await page(`/inbox/${inbox.id}?c=${answer.conversation.id}`, ann);
    assert.match(html.text, /<div class="oc-card" data-kind="video">/);
    assert.ok(html.text.includes('Watch together'));
});

t('the same URL is fetched once a minute', async () => {
    const link = 'https://openvibe.video/watch?v=cachetest01';
    const before = videoHits;
    assert.strictEqual((await dmSend(ann, `one ${link}`)).body.message.card.kind, 'video');
    assert.strictEqual((await dmSend(ann, `two ${link}`)).body.message.card.kind, 'video');
    assert.strictEqual(videoHits - before, 1, `Video was asked ${videoHits - before} times`);
});

t.run(async () => {
    if (h && h.close) await h.close();
    if (videoServer) videoServer.close();
    if (actorServer) actorServer.close();
});
