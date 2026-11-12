'use strict';
/**
 * Times leave with their zone (openvibe.design rule 148): Chat's SQLite-era text timestamps are UTC
 * but a browser reads `YYYY-MM-DD HH:MM:SS` as local time. The JSON edge renders time fields as ISO
 * 8601 with Z; stored text, cursors and every query that compares it stay unchanged. Internal service
 * routes (Live's reads) keep their documented SQL shape.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');
const { isoTime, normalizeTimes, storedTime } = require('../server/iso-times');

// A cursor sent back as ISO is compared in the stored shape (an ISO string sorts after every row of its own day).
assert.strictEqual(storedTime('2026-11-12T10:00:05.123Z'), '2026-11-12 10:00:05', 'ISO with Z → stored text');
assert.strictEqual(storedTime('2026-11-12T12:00:05+02:00'), '2026-11-12 10:00:05', 'an offset is moved to UTC');
assert.strictEqual(storedTime('2026-11-12 10:00:05'), '2026-11-12 10:00:05', 'the stored shape is read as UTC and kept');
assert.strictEqual(storedTime('not a time'), null, 'not a time');
assert.strictEqual(storedTime(''), null, 'empty');
assert.ok(storedTime('2026-11-12T10:00:05Z') < '2026-11-12 10:00:06' && storedTime('2026-11-12T10:00:05Z') > '2026-11-12 10:00:04', 'and it orders against the column');

assert.strictEqual(isoTime('2026-11-12 05:01:02'), '2026-11-12T05:01:02Z');
assert.strictEqual(isoTime('2026-11-12T05:01:02.123Z'), '2026-11-12T05:01:02.123Z', 'ISO with Z is left alone');
assert.strictEqual(isoTime('2026-11-12T05:01:02+02:00'), '2026-11-12T05:01:02+02:00', 'ISO with an offset is left alone');
assert.strictEqual(isoTime('2026-11-12'), '2026-11-12', 'a date is not a time');
assert.strictEqual(isoTime(null), null);
assert.deepStrictEqual(
    normalizeTimes({ id: 1, created_at: '2026-11-12 05:01:02', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12 05:01:02' }, tags: [{ expires_at: '2026-11-12 05:01:02' }] }),
    { id: 1, created_at: '2026-11-12T05:01:02Z', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12T05:01:02Z' }, tags: [{ expires_at: '2026-11-12T05:01:02Z' }] },
    'time-named fields are rendered; body text that looks like a time is not',
);

const t = suite('iso-times');
let h;

t('boot', async () => { h = await boot(); });

t('a public room\'s created_at is ISO 8601 with Z in the JSON API', async () => {
    await h.db.run("INSERT INTO rooms (id, slug, name, kind, visibility, owner_id, created_at) OVERRIDING SYSTEM VALUE VALUES (901, 'zone-room', 'Zoned room', 'community', 'public', 1, '2026-10-01 10:00:00')");
    const r = await h.http('GET', '/api/chat/rooms');
    assert.strictEqual(r.status, 200, r.text);
    const room = (r.body.public || []).find((x) => x.slug === 'zone-room');
    assert.ok(room, 'the room is listed');
    assert.strictEqual(room.created_at, '2026-10-01T10:00:00Z');
    assert.match(room.created_at, /Z$/);
    const stored = await h.db.get("SELECT created_at FROM rooms WHERE slug = 'zone-room'");
    assert.strictEqual(stored.created_at, '2026-10-01 10:00:00', 'the stored text is untouched');
});

t('an internal service route keeps its SQL shape', async () => {
    await h.db.run("INSERT INTO chat_messages (id, stream_id, user_id, username, message, timestamp) OVERRIDING SYSTEM VALUE VALUES (902, 77, 1, 'zoner', 'hello', '2026-10-01 10:00:00')");
    const token = h.serviceToken(['chat.messages.read'], { sub: 'svc:live' });
    const r = await h.http('GET', '/internal/chat/messages?stream_id=77', { token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.messages[0].timestamp, '2026-10-01 10:00:00', "Live's internal contract still gets SQL text");
});

t.run(async () => { if (h) await h.close(); });
