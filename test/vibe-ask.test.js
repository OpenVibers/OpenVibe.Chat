'use strict';
/**
 * Vibe answers a person through another service (server/chat/internal-vibe.js, capability chat.vibe.ask, contracts
 * 0.214.0): Bot's Vibe by voice. The question and Vibe's answer land in the person's own "Voice on <machine>" chat (one
 * per machine), the answer comes back as plain text to speak, it counts against their allowance, the same key answers
 * once, and a person Chat has not seen or the allowance spent is refused with why. Only a service token
 * holding the capability, from loopback, reaches it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('vibe ask');
let h, ann, config, vibe;
const BOT = (cap = 'chat.vibe.ask') => h.serviceToken([cap], { sub: 'svc:bot' });
const DEVICE = 'dev_01JABCDEFGHJKMNPQRSTVWXYZ0';
const ask = (body, token = BOT(), headers = {}) => h.http('POST', '/internal/chat/vibe/ask', { token, body, headers });
const calls = [];

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    config = require('../server/config');
    vibe = require('../server/rooms/vibe');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    require('../server/ai/client')._setClient({
        runs: {
            create: async (workflow, input) => {
                calls.push({ workflow, input });
                return { run: { status: 'succeeded', output: { choices: [{ message: { content: '**Clear skies** after six. See [the forecast](https://example.org/w) for more:\n\n- around 12 °C\n- light wind' } }] } } };
            },
        },
    });
});

t('a question from a machine: kept in "Voice on <machine>", answered as plain text, counted', async () => {
    const subject = h.live.users.get(ann.id).subject_id;
    const before = await vibe.repliesToday({ id: ann.id });
    const r = await ask({ subject, text: 'what is the weather like this evening', source: { kind: 'voice', id: DEVICE, name: 'desk-pc' }, lang: 'en-US', idempotency_key: 'va-001' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.state, 'answered');
    assert.strictEqual(r.body.text, 'Clear skies after six. See the forecast for more:\naround 12 °C\nlight wind', 'Markdown and links off, for speech');
    assert.match(r.body.url, /^https:\/\/openvibe\.chat\/vibe\/v-[0-9a-f]{12}$/);
    const room = await h.db.get('SELECT * FROM rooms WHERE slug = ?', [r.body.chat]);
    assert.deepStrictEqual([room.name, room.assistant_source, Number(room.owner_id)], ['Voice on desk-pc', `voice:${DEVICE}`, ann.id]);
    const msgs = await h.db.all('SELECT message, ai_member_id FROM room_messages WHERE room_id = ? ORDER BY id', [room.id]);
    assert.deepStrictEqual(msgs.map((m) => (m.ai_member_id ? 'vibe' : m.message)), ['what is the weather like this evening', 'vibe'], 'the question and the answer, in their chat');
    assert.strictEqual(await vibe.repliesToday({ id: ann.id }), before + 1, 'it counts against their allowance');
    // A second question from the same machine goes to the same chat; another machine gets its own.
    const again = await ask({ subject, text: 'and tomorrow?', source: { kind: 'voice', id: DEVICE, name: 'desk-pc' }, idempotency_key: 'va-002' });
    assert.strictEqual(again.body.chat, r.body.chat);
    const other = await ask({ subject, text: 'hello', source: { kind: 'voice', id: 'dev_01JABCDEFGHJKMNPQRSTVWXYZ1', name: 'robot' } });
    assert.notStrictEqual(other.body.chat, r.body.chat);
});

t('the same key answers once: asked again, the first answer and no second model call', async () => {
    const subject = h.live.users.get(ann.id).subject_id;
    const before = calls.length;
    const r = await ask({ subject, text: 'what is the weather like this evening', source: { kind: 'voice', id: DEVICE, name: 'desk-pc' }, idempotency_key: 'va-001' });
    assert.strictEqual(r.body.state, 'answered');
    assert.match(r.body.url, /\/vibe\/v-/);
    assert.strictEqual(calls.length, before, 'no model call');
});

t('refused, with why: a person Chat has not seen, the allowance spent', async () => {
    const subject = h.live.users.get(ann.id).subject_id;
    const unknown = await ask({ subject: ids.newId('user'), text: 'hi', source: { kind: 'voice', id: DEVICE } });
    assert.deepStrictEqual([unknown.status, unknown.body.state, unknown.body.code], [200, 'refused', 'chat.vibe.unknown_person']);
    const keep = config.ai.vibeRepliesPerDay;
    config.ai.vibeRepliesPerDay = await vibe.repliesToday({ id: ann.id });
    try {
        const spent = await ask({ subject, text: 'one more', source: { kind: 'voice', id: DEVICE } });
        assert.deepStrictEqual([spent.body.state, spent.body.code], ['refused', 'chat.vibe.allowance']);
        assert.match(spent.body.text, /free answers/);
    } finally { config.ai.vibeRepliesPerDay = keep; }
});

t('only a service token with chat.vibe.ask, from loopback; bad bodies are refused', async () => {
    const subject = h.live.users.get(ann.id).subject_id;
    const body = { subject, text: 'hi', source: { kind: 'voice', id: DEVICE } };
    assert.strictEqual((await ask(body, null)).status, 401);
    assert.strictEqual((await ask(body, BOT('chat.ticket.write'))).status, 403, 'another capability');
    assert.strictEqual((await ask(body, BOT(), { 'x-forwarded-for': '203.0.113.9' })).status, 403, 'not through the proxy');
    for (const bad of [{ ...body, subject: 'ann' }, { ...body, text: '' }, { ...body, source: { kind: 'chat', id: DEVICE } }, { ...body, extra: 1 }]) {
        assert.strictEqual((await ask(bad)).status, 400, JSON.stringify(bad));
    }
});

t('account export and deletion include what they asked by voice', async () => {
    const ad = require('../server/chat/account-data');
    const src = require('fs').readFileSync(require.resolve('../server/chat/account-data'), 'utf8');
    assert.ok(src.includes("['vibe_asks.json'") && src.includes("['vibe_asks', 'DELETE FROM vibe_asks"), 'listed in both');
    assert.ok(ad, 'module loads');
});

t.run(async () => { require('../server/ai/client')._setClient(null); if (h && h.close) await h.close(); });
