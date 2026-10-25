'use strict';
/**
 * Copy and Try again under Vibe's answers (server/rooms/vibe.js retry, vibe-routes.js, web/vibe-pages.js): Try again
 * removes Vibe's answer to the person's last message and writes a new one (it counts like any answer); it is offered
 * under that answer only; nothing else can be tried again; another person's chat is not there; the form works too.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe retry');
const SITE = 'https://openvibe.chat';
let h, ann, bob, aiClient, vibe;
let n = 0;
const keys = [];
const vibeApi = (method, path, u, body) => h.http(method, `/api/chat/vibe${path}`, { token: u.token, body });
const web = async (method, path, u, fields) => {
    const headers = { cookie: `ov_token=${u.token}`, ...(fields ? { 'content-type': 'application/x-www-form-urlencoded', origin: SITE } : {}) };
    const r = await fetch(`${h.base}${path}`, { method, headers, body: fields ? new URLSearchParams(fields).toString() : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
};
async function answers(slug, count) {
    for (let i = 0; i < 80; i++) {
        const got = ((await h.http('GET', `/api/chat/rooms/${slug}/messages`, { token: ann.token })).body.messages || []).filter((m) => m.ai_member_id);
        if (got.length >= count) return got;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`fewer than ${count} answers`);
}

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    aiClient = require('../server/ai/client');
    vibe = require('../server/rooms/vibe');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    aiClient._setClient({ runs: { create: async (workflow, input, o = {}) => { keys.push(o.idempotencyKey); n++; return { run: { status: 'succeeded', output: { choices: [{ message: { content: `Answer ${n}\n\n\`\`\`js\nconsole.log(${n});\n\`\`\`` } }] } } }; } } });
});

let slug;
t('Try again removes the answer and writes a new one, counted like any answer', async () => {
    const r = await vibeApi('POST', '', ann, { message: 'Write me a one-line program' });
    slug = r.body.room.slug;
    const [first] = await answers(slug, 1);
    const used = await vibe.repliesToday({ id: ann.id });
    const again = await vibeApi('POST', `/${slug}/retry`, ann);
    assert.deepStrictEqual([again.status, again.body.removed], [202, first.id]);
    const after = await answers(slug, 1);
    for (let i = 0; i < 80 && (after.length !== 1 || after[0].id === first.id); i++) { await new Promise((res) => setTimeout(res, 25)); after.splice(0, after.length, ...(await answers(slug, 1))); }
    assert.strictEqual(after.length, 1, 'one answer: the first went');
    assert.notStrictEqual(after[0].id, first.id);
    assert.match(after[0].message, /^Answer 2/);
    assert.strictEqual(await vibe.repliesToday({ id: ann.id }), used + 1);
    // AI answers once per idempotency key: the retry has its own, or AI would replay the first answer's run.
    assert.match(keys[0], /^chat-ai-\d+-\d+-t0$/);
    assert.strictEqual(keys[1], keys[0].replace(/-t0$/, `-r${first.id}-t0`));
});

t('only the answer to the person\'s last message; another person\'s chat is not there', async () => {
    const room = await h.db.get('SELECT * FROM rooms WHERE slug = ?', [slug]);
    await require('../server/rooms/rooms').post(room, h.live.users.get(ann.id), 'and another thing', { ai: false });
    const r = await vibeApi('POST', `/${slug}/retry`, ann);
    assert.deepStrictEqual([r.status, r.body.code], [409, 'vibe.nothing_to_retry'], 'the last message is the person\'s: nothing to try again');
    assert.strictEqual((await vibeApi('POST', `/${slug}/retry`, bob)).status, 404);
});

t('the page offers Try again under the last answer only, and Copy (shown by the script); the form works', async () => {
    const r = await vibeApi('POST', '', ann, { message: 'Two answers please' });
    const s2 = r.body.room.slug;
    await answers(s2, 1);
    const room = await h.db.get('SELECT * FROM rooms WHERE slug = ?', [s2]);
    await require('../server/rooms/rooms').post(room, h.live.users.get(ann.id), 'again', {});
    await answers(s2, 2);
    const page = await web('GET', `/vibe/${s2}`, ann);
    assert.strictEqual((page.text.match(/class="vb-retry"/g) || []).length, 1, 'one Try again');
    assert.match(page.text, /<button type="button" class="vb-act" data-vb-copy hidden>Copy<\/button><form method="post" action="\/vibe\/v-[0-9a-f]{12}\/retry" class="vb-retry"><button type="submit" class="vb-act">Try again<\/button><\/form><\/div><\/div><\/li><\/ol>/, 'under the last answer');
    assert.strictEqual((page.text.match(/data-vb-copy hidden/g) || []).length, 2, 'Copy under each answer');
    const form = await web('POST', `/vibe/${s2}/retry`, ann, {});
    assert.deepStrictEqual([form.status, form.location], [303, `/vibe/${s2}`]);
});

t.run(async () => { if (aiClient) aiClient._setClient(null); if (h && h.close) await h.close(); });
