'use strict';
const assert = require('assert');
const { suite } = require('./helpers');
const forum = require('../server/rooms/community-forum');

const t = suite('community forum client');

t('validates forum connections with the signed-in person token and supports activity, newest and category filters', async () => {
    assert.strictEqual(forum.slugOf('../private'), null);
    const oldFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, options) => {
        seen.push({ url: String(url), options });
        return { ok: true, status: 200, json: async () => ({ space: { slug: 'announcements', style: 'forum' }, viewer: { can_moderate: true }, threads: [] }) };
    };
    try {
        const connected = await forum.verifyManage('announcements', 'user-token');
        assert.strictEqual(connected.space.slug, 'announcements');
        assert.strictEqual(seen[0].options.headers.Authorization, 'Bearer user-token');
        assert.match(seen[0].url, /\/api\/v1\/spaces\/announcements\/threads\?limit=1$/);
        await forum.list('announcements', 'user-token', { sort: 'new', category: 'updates' });
        assert.match(seen[1].url, /sort=new/);
        assert.match(seen[1].url, /category=updates/);
    } finally { global.fetch = oldFetch; }
});
