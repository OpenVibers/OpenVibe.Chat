'use strict';
/**
 * Route ids are validated before they reach a query. PostgreSQL rejects a NaN / zero / negative
 * integer parameter where SQLite matched no rows, so after the engine move a mistyped
 * /api/emotes/channel/abc answered 500 ("Failed to load channel emotes") instead of the old empty
 * list. Every :userId/:id route now answers 400 for anything that is not a positive integer, and
 * the valid-id paths are unchanged.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('route-id-validation');
let h, admin, cid;

const BAD = ['abc', '0', '-1', '1.5', '1e3'];

t('boot', async () => {
    h = await boot({});
    admin = h.addUser('idval-admin', { role: 'admin' });
    cid = h.addChannel(admin.id, { moderators: [] });
    await h.ctx.sync();
});

t('emotes: /channel/:userId is 400 for a non-positive-integer', async () => {
    for (const bad of BAD) {
        const r = await h.http('GET', `/api/emotes/channel/${bad}`);
        assert.strictEqual(r.status, 400, `${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid user id' });
    }
    const ok = await h.http('GET', '/api/emotes/channel/999999');
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(ok.body.emotes, [], 'an id with no emotes is still an empty list');
});

t('emotes: PATCH/DELETE /:id are 400 for a non-positive-integer, 404 for a missing emote', async () => {
    for (const bad of BAD) {
        let r = await h.http('PATCH', `/api/emotes/${bad}`, { token: admin.token, body: { code: 'nope' } });
        assert.strictEqual(r.status, 400, `PATCH ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid emote id' });
        r = await h.http('DELETE', `/api/emotes/${bad}`, { token: admin.token });
        assert.strictEqual(r.status, 400, `DELETE ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid emote id' });
    }
    const gone = await h.http('PATCH', '/api/emotes/999999', { token: admin.token, body: { code: 'nope' } });
    assert.strictEqual(gone.status, 404, gone.text);
});

t('sounds: DELETE /:id is 400 for a non-positive-integer', async () => {
    for (const bad of BAD) {
        const r = await h.http('DELETE', `/api/sounds/${bad}`, { token: admin.token });
        assert.strictEqual(r.status, 400, `${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid sound id' });
    }
});

t('chat history: bad :userId / :streamId are 400', async () => {
    for (const bad of BAD) {
        let r = await h.http('GET', `/api/chat/user/${bad}/history`, { token: admin.token });
        assert.strictEqual(r.status, 400, `user ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid user id' });

        r = await h.http('GET', `/api/chat/${bad}/history`);
        assert.strictEqual(r.status, 400, `stream ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'Invalid stream ID' });
    }
});

t('dm: bad conversation :id and block :userId are 400', async () => {
    for (const bad of BAD) {
        let r = await h.http('GET', `/api/dm/conversations/${bad}`, { token: admin.token });
        assert.strictEqual(r.status, 400, `conversation ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid conversation id' });

        r = await h.http('DELETE', `/api/dm/blocks/${bad}`, { token: admin.token });
        assert.strictEqual(r.status, 400, `block ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid user id' });
    }
    const gone = await h.http('GET', '/api/dm/conversations/999999', { token: admin.token });
    assert.strictEqual(gone.status, 403, gone.text, 'a valid id with no membership stays 403');
});

t('channel moderation: bad :userId / :messageId are 400', async () => {
    for (const bad of BAD) {
        let r = await h.http('DELETE', `/api/chat/channels/${cid}/mods/${bad}`, { token: admin.token });
        assert.strictEqual(r.status, 400, `mod ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid user id' });

        r = await h.http('POST', `/api/chat/channels/${cid}/moderation/messages/${bad}/delete`, { token: admin.token });
        assert.strictEqual(r.status, 400, `message ${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid message id' });
    }
});

t('tts queue report: bad :id is 400', async () => {
    for (const bad of BAD) {
        const r = await h.http('POST', `/api/tts/queue/${bad}/report`, { token: admin.token, body: { state: 'played', channel_user_id: admin.id } });
        assert.strictEqual(r.status, 400, `${bad} -> ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'invalid request id' });
    }
});

t.run(async () => { if (h) await h.close(); });
