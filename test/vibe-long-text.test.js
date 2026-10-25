'use strict';
/**
 * Long text in a person's own Vibe chat (server/rooms/rooms.js post, ai-members.js, web/vibe-pages.js): a message may
 * hold 12000 characters there (a pasted page, a file's text, code) and Vibe reads all of it; the spam guess does not
 * apply (rows of = and links are normal in pasted text); everywhere else the limits stay (2000, spam refused). The
 * composer takes 12000 and its attach button takes text files.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe long text');
let h, ann, aiClient;
const turns = [];
const vibeApi = (method, path, body) => h.http(method, `/api/chat/vibe${path}`, { token: ann.token, body });

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    aiClient = require('../server/ai/client');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    aiClient._setClient({ runs: { create: async (workflow, input) => { turns.push({ workflow, input }); return { run: { status: 'succeeded', output: { choices: [{ message: { content: 'Read it.' } }] } } }; } } });
});

t('a 9000-character message in your own Vibe chat is taken, and Vibe reads all of it; 12001 is refused', async () => {
    const long = `Summarise this:\n${'Lorem ipsum dolor sit amet. '.repeat(330)}THE END MARKER`;
    assert.ok(long.length > 9000 && long.length < 12000, String(long.length));
    const r = await vibeApi('POST', '', { message: long });
    assert.strictEqual(r.status, 201, r.text);
    for (let i = 0; i < 80 && !turns.length; i++) await new Promise((res) => setTimeout(res, 25));
    assert.ok(JSON.stringify(turns[turns.length - 1].input).includes('THE END MARKER'), 'the end of the text reached Vibe');
    const tooLong = await vibeApi('POST', '', { message: 'x '.repeat(6001) });
    assert.deepStrictEqual([tooLong.status, /at most 12000/.test(tooLong.body.error)], [422, true]);
});

t('pasted text with rows of = and many links is not spam in your own chat', async () => {
    const pasted = `Notes\n==============\n${['a', 'b', 'c', 'd', 'e'].map((x) => `https://example.com/${x}`).join('\n')}`;
    assert.strictEqual((await vibeApi('POST', '', { message: pasted })).status, 201);
});

t('everywhere else the limits stay: 2000 characters, spam refused', async () => {
    assert.strictEqual((await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Long Crew', visibility: 'private' } })).status, 201);
    const post = (message) => h.http('POST', '/api/chat/rooms/long-crew/messages', { token: ann.token, body: { message } });
    const long = await post('y'.repeat(2001));
    assert.deepStrictEqual([long.status, /at most 2000/.test(long.body.error)], [422, true]);
    assert.strictEqual((await post('look ==============')).status, 422, 'spam still refused in a room');
});

t('the composer takes 12000 characters and the attach button takes text files', async () => {
    const page = await fetch(`${h.base}/vibe`, { headers: { cookie: `ov_token=${ann.token}` } }).then((x) => x.text());
    assert.match(page, /<textarea id="vb-input" name="message" rows="1" maxlength="12000"/);
    assert.match(page, /<input type="file" id="vb-file" accept="[^"]*text\/plain[^"]*\.csv[^"]*\.py[^"]*" hidden>/);
    assert.match(page, /aria-label="Add (a picture or )?a text file"/);
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
