'use strict';
/**
 * Activity on the Network's notifications (server/chat/activity-notify.js): what happened to a person in Chat is one
 * OpenVibe notification each, so the menu's Alerts and openvibe.chat/activity are one list.
 *
 *   a mention pushes one notification (chat.mention, the title, the place on openvibe.chat, the excerpt)
 *   the same activity pushed again pushes none (the dedupe key is the activity row's own id)
 *   a person who switched Chat notifications off gets none (the Network skips the push, as for a direct message)
 *   reading the activity on /activity clears its notification on the Network
 *   the page carries the shared list's mount for a signed-in person
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('activity-notify');

// The SDK's notifications client is stubbed: there is no Network here, and every push is captured. The Network's own
// rule is in the stub: a person who switched a category off gets nothing of it.
const pushed = [];
const switchedOff = new Set();
require('openvibe-sdk/notifications').createNotificationsClient = () => ({
    push: async (n) => {
        pushed.push(n);
        return { sent: true, skipped: switchedOff.has(n.subjectId) && n.category === 'chat' };
    },
});

let h, ann, bob, roomSlug, notify, config;
const api = (method, path, u, body) => h.http(method, path, { token: u && u.token, body });
const room = (method, path, u, body) => api(method, `/api/chat/rooms${path}`, u, body);
const web = async (path, u) => {
    const r = await fetch(`${h.base}${path}`, { headers: u ? { cookie: `ov_token=${u.token}` } : {} });
    return { status: r.status, text: await r.text() };
};

t('boot and the people', async () => {
    h = await boot();
    require('../server/chat/activity-routes');
    require('../server/rooms/routes');
    require('../server/chat/dm-routes');
    notify = require('../server/chat/activity-notify');
    config = require('../server/config');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const r = await room('POST', '/', ann, { name: 'Activity Lab' });
    assert.strictEqual(r.status, 201, r.text);
    roomSlug = r.body.room.slug;
    assert.strictEqual((await room('POST', `/${roomSlug}/join`, bob)).status, 200);
});

t('a mention pushes one Network notification', async () => {
    const r = await room('POST', `/${roomSlug}/messages`, bob, { message: 'morning @ann, are you around?' });
    assert.strictEqual(r.status, 201, r.text);
    await notify.settled();
    assert.strictEqual(pushed.length, 1, 'one mention, one notification');
    const n = pushed[0];
    assert.strictEqual(n.type, 'chat.mention');
    assert.strictEqual(n.category, 'chat', "the person's Chat switch governs it, as it governs a direct message");
    assert.strictEqual(n.service, 'chat');
    assert.strictEqual(n.title, 'Bob mentioned you in #Activity Lab');
    assert.strictEqual(n.url, `${config.web.baseUrl}/r/${roomSlug}`, 'the place, on openvibe.chat');
    assert.strictEqual(n.message, 'morning @ann, are you around?', 'the excerpt the activity row shows');
    assert.strictEqual(n.subjectId, ann.subject);
    assert.strictEqual(n.rich_content.dedupe_key, `chat.activity.${n.rich_content.activity_id}`);
});

t('the same activity pushed again pushes none', async () => {
    const id = pushed[0].rich_content.activity_id;
    const before = pushed.length;
    const again = await notify.push(id);
    assert.strictEqual(again.duplicate, true, 'the activity row was already told');
    assert.strictEqual(pushed.length, before, 'a retry never doubles it');
});

t('a reaction is a notification without an excerpt', async () => {
    const r = await room('POST', `/${roomSlug}/messages`, bob, { message: 'a line to react to' });
    const id = r.body.message.id;
    await room('POST', `/${roomSlug}/messages/${id}/react`, ann, { reaction: 'heart' });
    await notify.settled();
    const n = pushed[pushed.length - 1];
    assert.strictEqual(n.type, 'chat.reaction');
    assert.strictEqual(n.title, 'Ann reacted to your message in #Activity Lab');
    assert.strictEqual(n.message, null, 'the activity row shows no excerpt for a reaction');
});

t('a person who switched Chat notifications off gets none', async () => {
    switchedOff.add(ann.subject);
    const before = pushed.length;
    await room('POST', `/${roomSlug}/messages`, bob, { message: 'and one more @ann' });
    await notify.settled();
    assert.strictEqual(pushed.length, before + 1, 'the Network was told');
    const n = pushed[pushed.length - 1];
    assert.strictEqual(n.category, 'chat', 'the switch that governs it is the Chat one');
    const row = await h.db.get('SELECT status FROM chat_activity_notifications WHERE activity_id = ?', [n.rich_content.activity_id]);
    assert.strictEqual(row.status, 'skipped', 'the Network made no notification for them');
    switchedOff.delete(ann.subject);
});

t('reading the activity on /activity clears its notification on the Network', async () => {
    const before = h.netIdentity.markReads.length;
    const page = await web('/activity', ann);
    assert.strictEqual(page.status, 200, page.text.slice(0, 200));
    await notify.settled();
    const reads = h.netIdentity.markReads.slice(before);
    assert.ok(reads.length >= 1, 'the notification was cleared on the Network');
    const r = reads[reads.length - 1];
    assert.strictEqual(r.type, 'chat.mention', 'the same kind of notification');
    assert.ok(String(r.url_pattern || '').includes(`/r/${roomSlug}`), 'the same place');
    assert.ok(Number(r.user_id) > 0, 'the person it was filed under');
});

t('the page carries the shared list for a signed-in person', async () => {
    const page = await web('/activity', ann);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /id="oc-notif-list"/, 'the mount for the Network\'s own list');
    assert.match(page.text, /activity-notifications\.js/, 'and the script that mounts it');
    const out = await web('/activity', null);
    assert.strictEqual(out.status, 200, 'the page answers 200 signed out');
    assert.ok(!/id="oc-notif-list"/.test(out.text), 'and no list of anyone\'s');
});

t('the Activity dot counts what the menu counts', async () => {
    notify._reset();
    h.setNetUnread(7);
    let page = await web('/messages', ann);
    assert.match(page.text, /"label":"Activity"[^}]*"dot":true/, 'the Network\'s unread count');
    h.setNetUnread(0);
    notify._reset();
    page = await web('/messages', ann);
    assert.match(page.text, /"label":"Activity"[^}]*"dot":false/, 'and no dot when the Network says none');
    h.setNetUnread(null);
    notify._reset();
});
