'use strict';
// The Vibe composer attaches any file: it uploads to Media as the person (unlisted), the message keeps
// the ai.file@1 reference, and Vibe's turn carries it to OpenVibe.AI (which reads it for the model).
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let aiClient, media, h, ann;
const turns = [];
const uploads = [];

const t = suite('vibe files');

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiClient = require('../server/ai/client');
    media = require('../server/media/client');
    media._setClient({
        upload: async (data, opts) => {
            uploads.push({ data, opts });
            return { id: 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV', filename: opts.filename, mime_type: opts.mimeType, size_bytes: Buffer.byteLength(data) };
        },
    });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    aiClient._setClient({ runs: { create: async (workflow, input) => {
        turns.push({ workflow, input });
        return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'Two rows: Ada 10, Grace 9.' } }] } } };
    } } });
});

const rawPost = (path, body, headers) => fetch(`${h.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${ann.token}`, ...headers }, body })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

t('POST /api/chat/vibe/files stores an unlisted Media file as the person and returns ai.file@1', async () => {
    const r = await rawPost('/api/chat/vibe/files', 'name,score\nAda,10\nGrace,9\n', {
        'Content-Type': 'text/csv', 'X-Filename': encodeURIComponent('scores.csv'),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.file.id, 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    assert.equal(r.body.file.name, 'scores.csv');
    assert.equal(r.body.file.media_type, 'text/csv');
    assert.equal(r.body.file.storage.provider, 'media');
    assert.deepEqual(r.body.file.access.readers, [ann.subject_id]);
    assert.equal(r.body.file.read.method, 'not_readable');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].opts.visibility, 'unlisted', 'AI reads it by its public Media id');
    assert.equal(uploads[0].opts.subject, ann.subject_id);
});

t('POST /api/vibe/ask carries files too (the messenger on every site, through the Frame), words or not', async () => {
    const file = (await rawPost('/api/chat/vibe/files', 'x,y\n1,2\n', { 'Content-Type': 'text/csv', 'X-Filename': 'pair.csv' })).body.file;
    const ask = (body) => fetch(`${h.base}/api/vibe/ask`, { method: 'POST', headers: { authorization: `Bearer ${ann.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json() }));
    const started = await ask({ message: 'What is in it?', files: [file], fresh: true });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const history = await h.http('GET', `/api/chat/rooms/${started.body.chat.slug}/messages`, { token: ann.token });
    assert.ok(history.body.messages.some((m) => (m.files || []).some((f) => f.id === file.id)), 'the reference is on the message');
    const alone = await ask({ message: '', files: [file], slug: started.body.chat.slug });
    assert.equal(alone.status, 201, 'a file alone is a message');
    assert.match(alone.body.message.text, /pair\.csv/, 'it says which file');
    const bad = await ask({ message: 'x', files: [{ id: 'not-media' }], slug: started.body.chat.slug });
    assert.equal(bad.status, 422, 'only stored Media objects');
});

t('a message with a file stores the reference and Vibe\'s turn carries it to AI', async () => {
    const file = (await rawPost('/api/chat/vibe/files', 'a,b\n1,2\n', { 'Content-Type': 'text/csv', 'X-Filename': 'rows.csv' })).body.file;
    const started = await fetch(`${h.base}/api/chat/vibe`, {
        method: 'POST', headers: { authorization: `Bearer ${ann.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'How many rows?', files: [file] }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const slug = started.body.room.slug;
    for (let i = 0; i < 100 && !turns.length; i++) await new Promise((r) => setTimeout(r, 30));
    assert.ok(turns.length, 'AI was called');
    assert.equal(turns[0].workflow, 'chat.member.turn');
    assert.equal(turns[0].input.files.length, 1);
    assert.equal(turns[0].input.files[0].id, file.id);
    const history = await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token });
    const withFile = history.body.messages.find((m) => (m.files || []).some((f) => f.id === file.id));
    assert.ok(withFile, 'the message keeps the reference');
});

t('the composer page carries the attachment tray and the shared upload kit', async () => {
    const res = await fetch(`${h.base}/vibe`, { headers: { cookie: `ov_token=${ann.token}` } });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /id="vb-files"/);
    assert.match(page, /data-vb-upload-dialog/);
    assert.match(page, /data-vb-upload/);
    assert.match(page, /data-vb-attach/);
    assert.match(page, /ov-upload\.(?:js|css)/);
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (media) media._reset(); if (h && h.close) await h.close(); });
