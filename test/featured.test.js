'use strict';
/**
 * Explore's featured row (the plan, 2026-11-09, stage V3): staff mark a public server featured in the server's
 * settings, and the row sits above the categories. With none featured the row is left out; a private server never
 * appears in it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('explore featured');
let h, ann, staff, servers;
const api = (method, path, u, body) => h.http(method, `/api/chat/servers${path}`, { token: u && u.token, body });
const get = async (path, u) => {
    const r = await fetch(`${h.base}${path}`, { headers: u ? { cookie: `ov_token=${u.token}` } : {} });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
const post = async (path, u, fields) => {
    const r = await fetch(`${h.base}${path}`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: `ov_token=${u.token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });
    return { status: r.status, location: r.headers.get('location') };
};

t('boot', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    staff = h.addUser('staffer', { subject: ids.newId('user'), role: 'global_mod' });
    for (const u of [ann, staff]) await h.ctx.upsertUser(h.live.users.get(u.id));
    servers = require('../server/rooms/servers');
});

t('staff feature a server: the row sits above the categories; nobody else can', async () => {
    const made = await api('POST', '/', ann, { name: 'Saturday Raiders' });
    const slug = made.body.server.slug;

    const before = await get('/servers', ann);
    assert.doesNotMatch(before.text, /id="oc-featured-h"/, 'no row when nothing is featured');
    assert.doesNotMatch(before.text, /No other public server yet\./, 'and the old empty line is gone');

    const refused = await post(`/s/${slug}/featured`, ann, { featured: '1' });
    assert.match(refused.location, /^\/s\/saturday-raiders\/settings\?error=/, 'the owner is not staff');
    assert.strictEqual((await servers.bySlug(slug)).featured_at, null);

    const done = await post(`/s/${slug}/featured`, staff, { featured: '1' });
    assert.strictEqual(done.status, 303);
    assert.match(done.location, /#oc-featured$/);
    assert.ok((await servers.bySlug(slug)).featured_at, 'marked featured');

    const shown = await get('/servers', ann);
    const row = shown.text.indexOf('id="oc-featured-h"');
    const chips = shown.text.indexOf('class="oc-chips"');
    assert.ok(row > 0, 'the row is there');
    assert.ok(chips > 0 && row < chips, 'above the categories');
    assert.match(shown.text.slice(row, chips), new RegExp(`href="/s/${slug}"`), 'the featured server is its card');

    assert.deepStrictEqual((await servers.featured()).map((s) => s.slug), [slug]);

    const settings = await get(`/s/${slug}/settings`, staff);
    assert.match(settings.text, /id="oc-featured"/, 'staff see the toggle');
    assert.match(settings.text, /name="featured" value="0"/, 'and can take it down');

    // A private server is never featured on Explore, even when staff mark it.
    const priv = await api('POST', '/', ann, { name: 'Secret Club', visibility: 'private' });
    await servers.setFeatured(await servers.bySlug(priv.body.server.slug), h.live.users.get(staff.id), true);
    assert.ok(!(await servers.featured()).some((s) => s.slug === priv.body.server.slug), 'private stays out');

    await post(`/s/${slug}/featured`, staff, { featured: '0' });
    assert.doesNotMatch((await get('/servers', ann)).text, /id="oc-featured-h"/, 'and the row goes');
});

t.run(async () => { if (h && h.close) await h.close(); });
