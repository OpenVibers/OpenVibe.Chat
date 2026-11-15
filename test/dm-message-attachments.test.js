'use strict';
/**
 * A direct message carries files (the owner, 11-15: the messaging "needs to use our custom multi-purpose composer with
 * file support and images and all the others, like all file types … you're allowed to attach files"): the shared
 * composer puts each file in Media as it is picked, the message names its att_ id, and Chat asks Media (its own
 * service token, the sender named) whether it is there and the sender's, stores what Media answered beside the message
 * (dm_message_attachments) and keeps it with the message (dm:<id>). Any kind Media keeps may go (Media refuses
 * programs; its "code" is a file here), unlike a room's pictures, videos, sounds, PDFs and texts.
 *
 * A file alone is a message; another person's file is a 404 like one that is not there; at most four; a file Media
 * will not keep takes the message with it; the conversation's reads (the page, and after an id) carry each message's
 * files, and only what Media serves under openvibe.media/a/ is ever named.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('dm-message-attachments');
let h, ann, bob, media, conv;
const sent = {};   // this run's messages (the test database may hold earlier runs')
const send = (u, body) => h.http('POST', `/api/dm/conversations/${conv}/messages`, { token: u.token, body });
const att = () => `att_${ids.newId('user').slice(4)}`;

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const files = new Map();
    const keeps = [];
    let refuseKeep = false;
    require('../server/media/attachments')._setFetch(async (url, opts) => {
        const u = new URL(url);
        const headers = opts.headers || {};
        const subject = headers['X-OV-Subject'] || headers['x-ov-subject'] || null;
        const m = /^\/api\/v1\/attachments\/(att_[0-9A-HJKMNP-TV-Z]{26})(\/keep)?$/.exec(u.pathname);
        const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
        if (!m) return answer(404, {});
        const one = files.get(m[1]);
        if (!one || (subject && one.subject !== subject)) return answer(404, { code: 'media.attachment.not_found' });
        if (opts.method === 'POST' && m[2] === '/keep') {
            if (refuseKeep) return answer(500, { detail: 'down' });
            const body = JSON.parse(opts.body || '{}');
            keeps.push({ id: m[1], subject, message_id: body.message_id });
            return answer(200, { id: m[1], message_id: body.message_id, kept_for: [body.message_id] });
        }
        return answer(200, { id: one.id, kind: one.kind, name: one.name, size: one.size, mime: one.mime, url: one.url, poster: one.poster || null, playback: one.playback || null });
    });
    media = { files, keeps, add: (a) => { files.set(a.id, a); return a; }, refuse: (v) => { refuseKeep = v; } };
    const r = await h.http('POST', '/api/dm/conversations', { token: ann.token, body: { user_ids: [bob.id] } });
    assert.ok(r.status < 300, r.text);
    conv = r.body.conversation.id;
});

t('a picture alone is a message, kept with it, and the answer draws it', async () => {
    const pic = media.add({ id: att(), subject: ann.subject_id, kind: 'image', name: 'beach.jpg', size: 1234, mime: 'image/jpeg', url: 'https://openvibe.media/a/x/beach.jpg' });
    const r = await send(ann, { message: '', attachments: [pic.id] });
    assert.strictEqual(r.status, 200, r.text);
    const m = r.body.message;
    sent.picture = Number(m.id);
    assert.deepStrictEqual(m.attachments.map((a) => [a.kind, a.name, a.url]), [['image', 'beach.jpg', 'https://openvibe.media/a/x/beach.jpg']]);
    assert.deepStrictEqual(media.keeps.at(-1), { id: pic.id, subject: ann.subject_id, message_id: `dm:${m.id}` }, 'kept with the message');
});

t('any kind Media keeps may go: a zip and a code file are files', async () => {
    const zip = media.add({ id: att(), subject: ann.subject_id, kind: 'file', name: 'site.zip', size: 9, mime: 'application/zip', url: 'https://openvibe.media/a/y/site.zip' });
    const code = media.add({ id: att(), subject: ann.subject_id, kind: 'code', name: 'app.js', size: 9, mime: 'text/javascript', url: 'https://openvibe.media/a/z/app.js' });
    const r = await send(ann, { message: 'the files', attachments: [zip.id, code.id] });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.message.attachments.map((a) => [a.kind, a.name]), [['file', 'site.zip'], ['file', 'app.js']]);
    sent.files = Number(r.body.message.id);
});

t('another person\'s file is not there; five is too many; a bad id is refused', async () => {
    const bobs = media.add({ id: att(), subject: bob.subject_id, kind: 'image', name: 'b.png', size: 1, mime: 'image/png', url: 'https://openvibe.media/a/b/b.png' });
    let r = await send(ann, { message: 'x', attachments: [bobs.id] });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'dm.attachment_not_found']);
    const five = Array.from({ length: 5 }, () => media.add({ id: att(), subject: ann.subject_id, kind: 'image', name: 'p.png', size: 1, mime: 'image/png', url: 'https://openvibe.media/a/p/p.png' }).id);
    r = await send(ann, { message: 'x', attachments: five });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'dm.attachments_too_many']);
    r = await send(ann, { message: 'x', attachments: ['../etc/passwd'] });
    assert.strictEqual(r.status, 400);
});

t('a file Media will not keep takes the message with it', async () => {
    const pic = media.add({ id: att(), subject: ann.subject_id, kind: 'image', name: 'lost.png', size: 1, mime: 'image/png', url: 'https://openvibe.media/a/l/lost.png' });
    media.refuse(true);
    const before = (await h.http('GET', `/api/dm/conversations/${conv}/messages?limit=50`, { token: ann.token })).body.messages.length;
    const r = await send(ann, { message: 'will it stay', attachments: [pic.id] });
    media.refuse(false);
    assert.deepStrictEqual([r.status, r.body.code], [502, 'dm.attachment_keep_failed']);
    const after = (await h.http('GET', `/api/dm/conversations/${conv}/messages?limit=50`, { token: ann.token })).body.messages;
    assert.strictEqual(after.length, before, 'no message is left without its file');
});

t('the reads carry each message\'s files: the page, and after an id', async () => {
    const page = (await h.http('GET', `/api/dm/conversations/${conv}/messages?limit=50`, { token: bob.token })).body.messages;
    const byId = (id) => page.find((m) => Number(m.id) === id);
    assert.deepStrictEqual([byId(sent.picture).attachments.length, byId(sent.files).attachments.length], [1, 2], 'the picture and the two files');
    assert.ok(page.every((m) => Array.isArray(m.attachments)), 'every message says its files, [] when none');
    const first = Math.min(...page.map((m) => Number(m.id)));
    const after = (await h.http('GET', `/api/dm/conversations/${conv}/messages?after=${first - 1}`, { token: bob.token })).body.messages;
    assert.ok(after.some((m) => (m.attachments || []).some((a) => a.name === 'beach.jpg')));
    assert.ok(page.every((m) => (m.attachments || []).every((a) => a.url.startsWith('https://openvibe.media/a/'))), 'only Media\'s own addresses');
});

t('openvibe.chat\'s DM page: its box takes files, and a message draws its picture', async () => {
    const html = await fetch(`${h.base}/messages/${conv}`, { headers: { cookie: `ov_token=${ann.token}` } }).then((r) => r.text());
    assert.match(html, /<form class="oc-compose"[^>]*data-ovc-media="1"/, 'the box sends files to Media as they are picked');
    assert.match(html, /class="oc-attach-item oc-attach-image" href="https:\/\/openvibe\.media\/a\/x\/beach\.jpg"/, 'the picture is drawn');
    assert.match(html, /oc-attach-file[^>]*>site\.zip</, 'a file is a link');
});

t.run(async () => { if (h) await h.close(); });
