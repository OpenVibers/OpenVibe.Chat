'use strict';
/**
 * A room message carries a file Media stored for the sender (composer.attachment@1, plan §Z.9): the room's box
 * sends the file to Media as it is picked, the message names it, Chat asks Media (with its own service token
 * and the sender named) whether it exists, is the sender's and may be carried, keeps it with the message and
 * stores what Media answered. The room then draws it: a video in the network's player, a picture, a sound, a
 * file link — never an address off openvibe.media.
 *
 * Another person's file is a 404, exactly like one that is not there; a file nobody may carry is refused; a
 * video whose web copy Media is still making is asked again on a read, so it plays as soon as it is there.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('room-message-attachments');
let h, ann, bob, media;
const api = (method, path, u, body) => h.http(method, `/api/chat/rooms${path}`, { token: u && u.token, body });
const page = async (path, u) => await fetch(`${h.base}${path}`, { headers: { cookie: `ov_token=${u.token}` } }).then((r) => r.text());
// A room of its own for every step: a room's rate limit (six messages in ten seconds) would stop the next step.
const newRoom = async (name) => {
    const r = await api('POST', '/', ann, { name });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.room.slug;
};

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    // The stand-in for OpenVibe.Media: the composer attachments, the person each belongs to, and the keeps.
    const files = new Map();
    const keeps = [];
    const deletes = [];
    const calls = [];
    const attachments = require('../server/media/attachments');
    attachments._setFetch(async (url, opts) => {
        const u = new URL(url);
        const headers = opts.headers || {};
        const subject = headers['X-OV-Subject'] || headers['x-ov-subject'] || null;
        const auth = headers.authorization || headers.Authorization || '';
        const m = /^\/api\/v1\/attachments\/(att_[0-9A-HJKMNP-TV-Z]{26})(\/keep)?$/.exec(u.pathname);
        calls.push({ method: opts.method, path: u.pathname, subject, auth });
        const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
        if (!m) return answer(404, { detail: 'not found' });
        const one = files.get(m[1]);
        if (!one || (subject && one.subject !== subject)) return answer(404, { code: 'media.attachment.not_found', detail: 'no such attachment for this person' });
        if (opts.method === 'DELETE') { files.delete(m[1]); deletes.push(m[1]); return answer(204, {}); }
        if (opts.method === 'POST' && m[2] === '/keep') {
            const body = JSON.parse(opts.body || '{}');
            keeps.push({ id: m[1], subject, message_id: body.message_id });
            return answer(200, { id: m[1], message_id: body.message_id, kept_for: [body.message_id] });
        }
        return answer(200, {
            id: one.id, kind: one.kind, name: one.name, size: one.size, mime: one.mime, url: one.url,
            poster: one.poster || null, playback: one.playback || null,
            duration_s: one.duration_s != null ? one.duration_s : null,
            width: one.width != null ? one.width : null, height: one.height != null ? one.height : null,
        });
    });
    media = { files, keeps, deletes, calls, add: (a) => { files.set(a.id, a); return a; } };
});

t('the kinds a message may carry, and at most four files', async () => {
    const room = await newRoom('Owls One');
    const kinds = [
        { kind: 'video', name: 'clip.mp4', mime: 'video/mp4', url: 'https://openvibe.media/a/att_x/clip.mp4' },
        { kind: 'image', name: 'look.png', mime: 'image/png', url: 'https://openvibe.media/a/att_y/look.png' },
        { kind: 'audio', name: 'hello.mp3', mime: 'audio/mpeg', url: 'https://openvibe.media/a/att_z/hello.mp3' },
        { kind: 'file', name: 'notes.txt', mime: 'text/plain', url: 'https://openvibe.media/a/att_w/notes.txt' },
    ];
    const picked = [];
    for (const one of kinds) {
        const id = `att_${ids.ulid()}`;
        picked.push(id);
        media.add({ id, subject: ann.subject_id, size: 12, poster: null, playback: null, ...one });
    }
    const r = await api('POST', `/${room}/messages`, ann, { message: 'here they are', attachments: picked.map((id) => ({ media_attachment_id: id })) });
    assert.strictEqual(r.status, 201, r.text);
    const files = r.body.message.media_attachments;
    assert.strictEqual(files.length, 4, 'four files go with one message');
    assert.deepStrictEqual(files.map((f) => f.kind).sort(), ['audio', 'file', 'image', 'video']);
    // A file nobody may carry (code, an executable) is refused.
    const code = `att_${ids.ulid()}`;
    media.add({ id: code, subject: ann.subject_id, kind: 'code', name: 'run.sh', mime: 'text/x-sh', size: 12, url: `https://openvibe.media/a/${code}/run.sh` });
    const refused = await api('POST', `/${room}/messages`, ann, { message: 'no', attachments: [{ media_attachment_id: code }] });
    assert.strictEqual(refused.status, 415, refused.text);
    assert.strictEqual(refused.body.code, 'rooms.attachment_type');
    // Five files are too many.
    const five = [];
    for (let i = 0; i < 5; i++) {
        const id = `att_${ids.ulid()}`;
        five.push(id);
        media.add({ id, subject: ann.subject_id, kind: 'image', name: 'p.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${id}/p.png` });
    }
    const many = await api('POST', `/${room}/messages`, ann, { message: 'many', attachments: five.map((id) => ({ media_attachment_id: id })) });
    assert.strictEqual(many.status, 400, many.text);
    assert.strictEqual(many.body.code, 'rooms.attachments_too_many');
});

t("another person's file is refused, exactly like one that is not there", async () => {
    const room = await newRoom('Owls Two');
    const id = `att_${ids.ulid()}`;
    media.add({ id, subject: ann.subject_id, kind: 'image', name: 'mine.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${id}/mine.png` });
    await api('POST', `/${room}/join`, bob);
    const other = await api('POST', `/${room}/messages`, bob, { message: 'not mine', attachments: [{ media_attachment_id: id }] });
    assert.strictEqual(other.status, 404, other.text);
    const missing = await api('POST', `/${room}/messages`, ann, { message: 'nobody\'s', attachments: [{ media_attachment_id: `att_${ids.ulid()}` }] });
    assert.strictEqual(missing.status, 404, missing.text);
    assert.strictEqual(missing.body.code, other.body.code, 'the same answer either way');
});

t('the file is kept with the message, in Media', async () => {
    const room = await newRoom('Owls Three');
    const id = `att_${ids.ulid()}`;
    media.add({ id, subject: ann.subject_id, kind: 'video', name: '7224.mp4', mime: 'video/mp4', size: 24819344,
        url: `https://openvibe.media/a/${id}/7224.mp4`, poster: `https://openvibe.media/a/${id}/thumb.jpg`,
        playback: { url: `https://openvibe.media/a/${id}/playback.mp4`, mime: 'video/mp4', ready: true },
        duration_s: 73.4, width: 1920, height: 1080 });
    const r = await api('POST', `/${room}/messages`, ann, { message: 'here it is', attachments: [{ media_attachment_id: id }] });
    assert.strictEqual(r.status, 201, r.text);
    const file = r.body.message.media_attachments[0];
    assert.strictEqual(file.id, id);
    assert.strictEqual(file.kind, 'video');
    assert.strictEqual(file.media_type, 'video/mp4');
    assert.strictEqual(file.size, 24819344);
    assert.deepStrictEqual(file.playback, { url: `https://openvibe.media/a/${id}/playback.mp4`, mime: 'video/mp4', ready: true });
    assert.strictEqual(file.poster, `https://openvibe.media/a/${id}/thumb.jpg`);
    assert.strictEqual(file.duration_s, 73.4);
    assert.deepStrictEqual([file.width, file.height], [1920, 1080]);
    const keep = media.keeps.find((k) => k.id === id);
    assert.ok(keep, 'Media was asked to keep the file');
    assert.strictEqual(keep.subject, ann.subject_id, 'as the sender');
    assert.strictEqual(keep.message_id, String(r.body.message.id), 'it is kept with the message');
    const row = await h.db.get('SELECT * FROM room_message_attachments WHERE message_id = ? AND attachment_id = ?', [r.body.message.id, id]);
    assert.strictEqual(row.kind, 'video');
    assert.strictEqual(Number(row.playback_ready), 1);
    // The service token Chat used carries the capability Media asks for, and the sender is named.
    const call = media.calls.find((c) => c.path === `/api/v1/attachments/${id}` && c.method === 'GET');
    assert.ok(call, 'Media was asked about the file');
    assert.match(String(call.auth), /^Bearer /, 'with a service token');
    assert.strictEqual(call.subject, ann.subject_id, 'naming the sender');
});

t('a video whose web copy became ready plays on the next read', async () => {
    const room = await newRoom('Owls Four');
    const id = `att_${ids.ulid()}`;
    const one = media.add({ id, subject: ann.subject_id, kind: 'video', name: 'clip.mkv', mime: 'video/x-matroska', size: 900,
        url: `https://openvibe.media/a/${id}/clip.mkv`, poster: `https://openvibe.media/a/${id}/thumb.jpg`,
        playback: { url: `https://openvibe.media/a/${id}/clip.mkv`, mime: 'video/x-matroska', ready: false } });
    const r = await api('POST', `/${room}/messages`, ann, { message: 'still copying', attachments: [{ media_attachment_id: id }] });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.message.media_attachments[0].playback.ready, false, 'the copy is not there yet');
    // Media finishes the copy.
    one.playback = { url: `https://openvibe.media/a/${id}/playback.mp4`, mime: 'video/mp4', ready: true };
    const list = await api('GET', `/${room}/messages`, ann);
    const found = list.body.messages.find((m) => m.message === 'still copying');
    assert.deepStrictEqual(found.media_attachments[0].playback, { url: `https://openvibe.media/a/${id}/playback.mp4`, mime: 'video/mp4', ready: true });
    const row = await h.db.get('SELECT playback_ready, playback_url FROM room_message_attachments WHERE message_id = ? AND attachment_id = ?', [found.id, id]);
    assert.strictEqual(Number(row.playback_ready), 1, 'kept, so the next read does not ask again');
    assert.strictEqual(row.playback_url, `https://openvibe.media/a/${id}/playback.mp4`);
});

t("the room's box asks Media for its files", async () => {
    const room = await newRoom('Owls Five');
    const html = await page(`/r/${room}`, ann);
    assert.match(html, /data-ovc-media="1"/, 'the box sends its files to Media');
    assert.match(html, /data-ovc-max-files="4"/, 'at most four');
});

t('a ready video draws the player, a copy still being made draws the link', async () => {
    const room = await newRoom('Owls Six');
    const ready = `att_${ids.ulid()}`;
    media.add({ id: ready, subject: ann.subject_id, kind: 'video', name: 'ready.mp4', mime: 'video/mp4', size: 900,
        url: `https://openvibe.media/a/${ready}/ready.mp4`, poster: `https://openvibe.media/a/${ready}/thumb.jpg`,
        playback: { url: `https://openvibe.media/a/${ready}/playback.mp4`, mime: 'video/mp4', ready: true },
        duration_s: 12, width: 1280, height: 720 });
    const waiting = `att_${ids.ulid()}`;
    media.add({ id: waiting, subject: ann.subject_id, kind: 'video', name: 'waiting.mkv', mime: 'video/x-matroska', size: 900,
        url: `https://openvibe.media/a/${waiting}/waiting.mkv`, poster: `https://openvibe.media/a/${waiting}/thumb.jpg`,
        playback: { url: `https://openvibe.media/a/${waiting}/waiting.mkv`, mime: 'video/x-matroska', ready: false } });
    const r = await api('POST', `/${room}/messages`, ann, { message: 'watch this', attachments: [{ media_attachment_id: ready }, { media_attachment_id: waiting }] });
    assert.strictEqual(r.status, 201, r.text);
    const html = await page(`/r/${room}`, ann);
    assert.match(html, /<video data-ov-player[^>]*src="https:\/\/openvibe\.media\/a\/[^"]*\/playback\.mp4"/, 'the ready copy plays in the network\'s player');
    assert.ok(html.includes(`poster="https://openvibe.media/a/${ready}/thumb.jpg"`), 'the poster is its first frame');
    assert.match(html, /is-preparing/, 'a copy still being made is a link');
    assert.ok(html.includes(`href="https://openvibe.media/a/${waiting}/waiting.mkv"`), 'the link is the file itself');
    assert.match(html, /Getting the video ready to play here/, 'and it says so');
});

t('nothing is drawn off openvibe.media', async () => {
    const room = await newRoom('Owls Seven');
    const id = `att_${ids.ulid()}`;
    media.add({ id, subject: ann.subject_id, kind: 'image', name: 'elsewhere.png', mime: 'image/png', size: 3, url: 'https://evil.example/a/elsewhere.png' });
    const r = await api('POST', `/${room}/messages`, ann, { message: 'not here', attachments: [{ media_attachment_id: id }] });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.message.media_attachments, [], 'an address off openvibe.media is no address');
    const html = await page(`/r/${room}`, ann);
    assert.ok(!html.includes('evil.example'), 'the room never points at another host');
});

t('the files go when the message is deleted', async () => {
    const room = await newRoom('Owls Eight');
    const id = `att_${ids.ulid()}`;
    media.add({ id, subject: ann.subject_id, kind: 'image', name: 'gone.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${id}/gone.png` });
    const r = await api('POST', `/${room}/messages`, ann, { message: 'delete me', attachments: [{ media_attachment_id: id }] });
    assert.strictEqual(r.status, 201, r.text);
    const del = await api('DELETE', `/${room}/messages/${r.body.message.id}`, ann);
    assert.strictEqual(del.status, 200, del.text);
    assert.ok(media.deletes.includes(id), 'Media was asked to remove the file');
    const row = await h.db.get('SELECT * FROM room_message_attachments WHERE message_id = ?', [r.body.message.id]);
    assert.ok(!row, 'and the room keeps nothing of it');
});

t('the room hears a message with its files over the socket', async () => {
    const room = await newRoom('Owls Nine');
    const id = `att_${ids.ulid()}`;
    media.add({ id, subject: ann.subject_id, kind: 'image', name: 'live.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${id}/live.png` });
    const annWs = await h.ws({ token: ann.token });
    annWs.sendJson({ type: 'join_room', room });
    await annWs.next((m) => m.type === 'room_joined');
    annWs.sendJson({ type: 'room_message', message: 'over the socket', attachments: [id] });
    const got = await annWs.next((m) => m.type === 'room_message' && m.message.message === 'over the socket');
    assert.strictEqual(got.message.media_attachments.length, 1);
    assert.strictEqual(got.message.media_attachments[0].id, id);
});

t('the plain form may name the files too', async () => {
    const room = await newRoom('Owls Ten');
    const id = `att_${ids.ulid()}`;
    media.add({ id, subject: ann.subject_id, kind: 'image', name: 'form.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${id}/form.png` });
    const body = new URLSearchParams();
    body.set('message', 'from the form');
    body.append('attachments', id);
    const r = await fetch(`${h.base}/r/${room}`, { method: 'POST', redirect: 'manual', headers: { cookie: `ov_token=${ann.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    assert.strictEqual(r.status, 303, await r.text());
    const list = await api('GET', `/${room}/messages`, ann);
    const found = list.body.messages.find((m) => m.message === 'from the form');
    assert.ok(found, 'the message is there');
    assert.strictEqual(found.media_attachments[0].id, id, 'with its file');
});
t('the body\'s list of files is read as a list of Media attachments', () => {
    const { namedAttachments, allowedKind, mediaUrl } = require('../server/rooms/attachments');
    const one = `att_${ids.ulid()}`;
    const two = `att_${ids.ulid()}`;
    assert.deepStrictEqual(namedAttachments(one), [{ media_attachment_id: one }]);
    assert.deepStrictEqual(namedAttachments([one, two]), [{ media_attachment_id: one }, { media_attachment_id: two }]);
    assert.deepStrictEqual(namedAttachments(JSON.stringify([{ media_attachment_id: one }])), [{ media_attachment_id: one }]);
    assert.deepStrictEqual(namedAttachments(''), []);
    assert.deepStrictEqual(namedAttachments(undefined), []);
    assert.throws(() => namedAttachments('not json'), { status: 400, code: 'rooms.attachment_invalid' });
    // The kinds a message may carry: a picture, a video, a sound, and a file that is a PDF or text.
    assert.strictEqual(allowedKind('video', 'video/mp4'), 'video');
    assert.strictEqual(allowedKind('image', 'image/png'), 'image');
    assert.strictEqual(allowedKind('audio', 'audio/mpeg'), 'audio');
    assert.strictEqual(allowedKind('file', 'application/pdf'), 'file');
    assert.strictEqual(allowedKind('file', 'text/plain'), 'file');
    assert.strictEqual(allowedKind('file', 'application/octet-stream'), null);
    assert.strictEqual(allowedKind('code', 'text/x-sh'), null);
    // Only an address on openvibe.media, under /a/, is ever used.
    assert.strictEqual(mediaUrl(`https://openvibe.media/a/${one}/clip.mp4`), `https://openvibe.media/a/${one}/clip.mp4`);
    assert.strictEqual(mediaUrl('https://evil.example/a/clip.mp4'), null);
    assert.strictEqual(mediaUrl('http://openvibe.media/a/clip.mp4'), null);
    assert.strictEqual(mediaUrl('https://openvibe.media/o/med_x'), null);
});

t("the room's box is mounted with Media's files", () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'composer.js'), 'utf8');
    assert.match(source, /data-ovc-media/, 'the box asks for Media\'s files');
    assert.match(source, /media: !!media/, 'and the shared composer is mounted with them');
});
t.run(async () => {
    try { require('../server/media/attachments')._setFetch(null); } catch { /* */ }
    await h.close();
});
