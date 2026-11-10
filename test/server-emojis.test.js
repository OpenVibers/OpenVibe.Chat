'use strict';
/**
 * Per-server custom emoji (/api/chat/servers/:slug/emojis, migration 0057_server_emojis.sql):
 * a member uploads a small image and a name, the bytes go to OpenVibe.Media and the row keeps the
 * server; a name is unique per server (case-insensitive), a server holds 50; a server moderator
 * removes one and its Media object goes with it; a row without a media URL lists a `:name:` fallback
 * so a client whose image is gone still shows what was meant. Every route answers 404 while
 * CHAT_SERVER_EMOJI_ENABLED is off (the default).
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('server-emojis');
let h, owner, member, outsider, mod, staff, slug, serverId;
const uploads = [];
const deleted = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

const api = (method, path, u, body) => h.http(method, `/api/chat/servers${path}`, { token: u && u.token, body });
async function upload(u, name, bytes = PNG, type = 'image/png', field = 'file') {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type }), 'emoji.png');
    if (name !== undefined) form.append('name', String(name));
    const res = await fetch(`${h.base}/api/chat/servers/${slug}/emojis`, {
        method: 'POST',
        headers: u ? { Authorization: `Bearer ${u.token}` } : {},
        body: form,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const list = (u) => h.http('GET', `/api/chat/servers/${slug}/emojis`, { token: u && u.token });

t('boot: a public server with an owner, a member, a moderator and an outsider', async () => {
    h = await boot({ env: { CHAT_SERVER_EMOJI_ENABLED: 'true' } });
    owner = h.addUser('ann');
    member = h.addUser('bob');
    outsider = h.addUser('cat');
    mod = h.addUser('mox');
    staff = h.addUser('staffer', { role: 'global_mod' });
    for (const u of [owner, member, outsider, mod, staff]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const r = await api('POST', '/', owner, { name: 'Emoji Place' });
    assert.strictEqual(r.status, 201, r.text);
    slug = r.body.server.slug;
    serverId = r.body.server.id;
    assert.strictEqual((await api('POST', `/${slug}/join`, member)).status, 200);
    assert.strictEqual((await api('POST', `/${slug}/join`, mod)).status, 200);
    const m = await api('POST', `/${slug}/members`, owner, { username: 'mox', role: 'mod' });
    assert.strictEqual(m.body.role, 'mod');
    // The Media mock: uploads answer a public object, deletes are recorded.
    require('../server/media/client')._setClient({
        upload: async (buf, opts) => { const id = 900 + uploads.length + 1; uploads.push({ id, opts }); return { id, public_url: `https://openvibe.media/chat/emoji-${id}.png` }; },
        delete: async (id) => { deleted.push(id); return true; },
    });
});

t('the switch is off by default: every emoji route answers 404', async () => {
    const config = require('../server/config');
    config.emotes.serverEmojiEnabled = false;
    try {
        const r = await list(null);
        assert.deepStrictEqual([r.status, r.body.code], [404, 'emoji.disabled']);
        assert.strictEqual((await upload(member, 'party')).status, 404);
        assert.strictEqual((await api('DELETE', `/${slug}/emojis/1`, mod)).body.code, 'emoji.disabled');
    } finally { config.emotes.serverEmojiEnabled = true; }
});

t('the list is public and starts empty; a member uploads within the limits', async () => {
    let r = await list(null);
    assert.deepStrictEqual([r.status, r.body.emojis], [200, []]);

    // Signed out cannot upload.
    assert.strictEqual((await upload(null, 'party')).status, 401);
    // A non-member is asked to join first.
    const no = await upload(outsider, 'party');
    assert.deepStrictEqual([no.status, no.body.code], [403, 'servers.forbidden']);

    const up = await upload(member, 'party');
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    assert.deepStrictEqual([up.body.emoji.name, up.body.emoji.fallback], ['party', ':party:']);
    assert.match(up.body.emoji.url, /^https:\/\/openvibe\.media\/chat\/emoji-\d+\.png$/);
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].opts.mimeType, 'image/png');

    const row = await h.db.get('SELECT * FROM emotes WHERE server_id = ? AND code = ?', [serverId, 'party']);
    assert.ok(row, 'the row is kept for the server');
    assert.strictEqual(Number(row.user_id), member.id, 'the uploader is recorded');
    assert.strictEqual(row.media_url, up.body.emoji.url);
    assert.ok(row.media_asset_id, 'the Media object id is stored');

    r = await list(null);
    assert.deepStrictEqual(r.body.emojis.map((e) => [e.name, e.url, e.fallback]), [['party', up.body.emoji.url, ':party:']]);
});

t('a name already taken on the server is refused, in any case; bad names and non-images too', async () => {
    let r = await upload(member, 'Party');
    assert.deepStrictEqual([r.status, r.body.code], [409, 'emoji.name_taken']);
    r = await upload(member, 'a');
    assert.deepStrictEqual([r.status, r.body.code], [400, 'emoji.invalid_name']);
    r = await upload(member, 'has space');
    assert.deepStrictEqual([r.status, r.body.code], [400, 'emoji.invalid_name']);
    r = await upload(member, 'two', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    assert.deepStrictEqual([r.status, r.body.code], [400, 'emoji.invalid_image']);
    assert.strictEqual(uploads.length, 1, 'a refused upload never reaches Media');
});

t('a server holds 50 emoji; the fifty-first is refused', async () => {
    for (let i = 0; i < 49; i++) {
        await h.db.run('INSERT INTO emotes (user_id, code, url, media_url, media_asset_id, server_id) VALUES (?, ?, ?, ?, ?, ?)',
            [member.id, `filler_${i}`, `https://openvibe.media/chat/filler-${i}.png`, `https://openvibe.media/chat/filler-${i}.png`, 500 + i, serverId]);
    }
    const r = await upload(member, 'one_too_many');
    assert.deepStrictEqual([r.status, r.body.code], [409, 'emoji.limit']);
    await h.db.run('DELETE FROM emotes WHERE server_id = ? AND code LIKE ?', [serverId, 'filler_%']);
});

t('the :name: fallback lists when the image is gone', async () => {
    await h.db.run("UPDATE emotes SET media_url = NULL WHERE server_id = ? AND code = 'party'", [serverId]);
    const r = await list(null);
    assert.strictEqual(r.status, 200);
    const e = r.body.emojis.find((x) => x.name === 'party');
    assert.strictEqual(e.url, null, 'no image URL to point at');
    assert.strictEqual(e.fallback, ':party:', 'the client shows the name instead');
});

t('removal: only a server moderator, and its Media object goes too', async () => {
    const first = (await list(null)).body.emojis.find((e) => e.name === 'party');
    const assetId = (await h.db.get('SELECT media_asset_id FROM emotes WHERE id = ?', [first.id])).media_asset_id;
    assert.strictEqual((await api('DELETE', `/${slug}/emojis/${first.id}`, member)).body.code, 'emoji.forbidden');
    assert.strictEqual((await api('DELETE', `/${slug}/emojis/${first.id}`, outsider)).body.code, 'emoji.forbidden');

    const del = await api('DELETE', `/${slug}/emojis/${first.id}`, mod);
    assert.deepStrictEqual([del.status, del.body.ok], [200, true]);
    assert.ok(!(await h.db.get('SELECT id FROM emotes WHERE id = ?', [first.id])), 'the row is gone');
    assert.deepStrictEqual(deleted, [Number(assetId)], 'its Media object removed');
    assert.deepStrictEqual((await list(null)).body.emojis, []);

    // A second delete is a plain 404.
    assert.deepStrictEqual([(await api('DELETE', `/${slug}/emojis/${first.id}`, mod)).status], [404]);
});

t.run(async () => { if (h && h.close) await h.close(); });
