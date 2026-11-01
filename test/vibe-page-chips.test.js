'use strict';
/**
 * What Vibe did, on openvibe.chat/vibe (plan L48 V2; rooms/vibe-results.js): under an answer that set a reminder or a
 * timer, a chip with Undo (a plain form, for a day) and Open; a stopped one says so and offers nothing; the Undo form
 * is the person's own and same-site only.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe page: result chips');
const SITE = 'https://openvibe.chat';
let h, ann, bob, slug, answerId;
const web = async (method, path, u, fields, origin = SITE) => {
    const headers = { ...(u ? { cookie: `ov_token=${u.token}` } : {}), ...(fields ? { 'content-type': 'application/x-www-form-urlencoded', origin } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: fields ? new URLSearchParams(fields).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const vibe = require('../server/rooms/vibe');
    const room = await vibe.createRoom(h.live.users.get(ann.id), 'Plans');
    slug = room.slug || (await require('../server/db/database').get('SELECT slug FROM rooms WHERE id = ?', [room.id || room])).slug;
    const db = require('../server/db/database');
    const r = await db.get('SELECT id FROM rooms WHERE slug = ?', [slug]);
    const ai = await db.get('SELECT id FROM room_ai_members WHERE room_id = ?', [r.id]);
    await db.run('INSERT INTO room_messages (room_id, user_id, message) VALUES (?, ?, ?)', [r.id, ann.id, 'remind me to stretch every 2 hours']);
    const ins = await db.run('INSERT INTO room_messages (room_id, user_id, ai_member_id, message, results) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [r.id, ann.id, ai.id, 'Reminder set: Stretch, every 2 hours.', JSON.stringify([
            { kind: 'reminder', action: 'set', id: 'rem_01J8Z3V9Q6N1X2Y3Z4A5B6C7E1', title: 'Stretch', when: 'Every 2 hours, 9 am–5 pm', url: 'https://openvibe.today/me#reminders' },
            { kind: 'timer', action: 'stopped', title: '25 min focus' },
        ])]);
    answerId = Number(ins.lastInsertRowid || (ins.rows && ins.rows[0] && ins.rows[0].id));
});

t('the answer carries its chips: Undo and Open for what is set, "stopped" for what is not', async () => {
    const r = await web('GET', `/vibe/${slug}`, ann);
    assert.strictEqual(r.status, 200);
    const box = (/<div class="vb-res">[\s\S]*?<\/div><\/div><\/div>(?=<)/.exec(r.text) || [''])[0] || r.text.slice(r.text.indexOf('<div class="vb-res">'), r.text.indexOf('<div class="vb-res">') + 2000);
    assert.match(box, /<div class="vb-res-c"><svg[^>]*>[\s\S]*?<\/svg><div class="vb-res-t"><b>Reminder set:<\/b> Stretch<small>Every 2 hours, 9 am–5 pm<\/small><\/div>/);
    assert.match(box, new RegExp(`<form method="post" action="/vibe/${slug}/undo"><input type="hidden" name="message_id" value="${answerId}"><input type="hidden" name="index" value="0"><button type="submit" class="vb-act">Undo</button></form>`));
    assert.match(box, /<a class="vb-act" href="https:\/\/openvibe\.today\/me#reminders">Open<\/a>/);
    assert.match(box, /<div class="vb-res-c is-stopped">[\s\S]*?<b>Timer stopped:<\/b> 25 min focus<\/div><\/div>/, 'a stopped one offers nothing');
});

t('the Undo form is the person\'s own, and same-site only', async () => {
    const other = await web('POST', `/vibe/${slug}/undo`, bob, { message_id: String(answerId), index: '0' });
    assert.strictEqual(other.status, 303);
    assert.strictEqual(other.location, '/vibe', 'someone else\'s chat: nothing happens');
    const cross = await web('POST', `/vibe/${slug}/undo`, ann, { message_id: String(answerId), index: '0' }, 'https://evil.example');
    assert.strictEqual(cross.status, 403);
    const db = require('../server/db/database');
    const row = await db.get('SELECT results FROM room_messages WHERE id = ?', [answerId]);
    assert.strictEqual(require('../server/rooms/vibe-results').list(row.results)[0].action, 'set', 'still set');
});

t.run(async () => { if (h && h.close) await h.close(); });
