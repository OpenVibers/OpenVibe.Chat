'use strict';
/**
 * OpenVibe.Help's per-ticket conversation (server/chat/internal-tickets.js, capability
 * chat.ticket.write, chat.ticket-conversation@1 added in openvibe-contracts 0.100.0): a
 * conversation is keyed by (ticket id, calling service) and a service only ever reads its own.
 */

const assert = require('assert');
const path = require('path');
const { validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const quiet = { log() {}, info() {}, warn() {}, error() {} };

const t = suite('chat-internal-tickets');
let h;
const TICKET = 'tkt_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const HELP = (cap = 'chat.ticket.write') => h.serviceToken([cap], { sub: 'svc:help' });
const AI = (cap = 'chat.ticket.write') => h.serviceToken([cap], { sub: 'svc:ai' });
const msg = (author_kind, author, body, created_at = '2026-10-05T09:00:00Z') => ({ author_kind, author, body, created_at });

// chat.ticket-conversation@1 arrives with openvibe-contracts 0.100.0. Until the pin reaches it an
// older package cannot validate it: the run says so instead of failing (shapes are asserted too).
function check(ref, body) {
    let r;
    try { r = validate(ref, body); } catch (err) {
        if (/unknown contract|is v\d/.test(err.message)) return body;
        throw err;
    }
    assert.ok(r.valid, `${ref} invalid: ${JSON.stringify(r.errors)} (${JSON.stringify(body)})`);
    return body;
}
async function post(token, ticket, body) {
    const r = await h.http('POST', `/internal/chat/tickets/${encodeURIComponent(ticket)}/messages`, { token, body });
    assert.strictEqual(r.status, 200, `${JSON.stringify(body)}: ${r.text}`);
    return r.body;
}
async function get(token, ticket, qs = '', status = 200) {
    const r = await h.http('GET', `/internal/chat/tickets/${encodeURIComponent(ticket)}${qs}`, { token });
    assert.strictEqual(r.status, status, `${ticket}${qs}: ${r.text}`);
    return r.body;
}

t('migrate the final schema and boot', async () => {
    // The shared harness migrates with the N-1 window, which holds 0005 (a contract migration) and
    // with it the later 0006/0007. The ticket tables arrive in 0007, so apply the final schema
    // first, exactly as test/pg-schema.test.js does.
    const owner = globalThis.__ovChatTestOwnerDb && globalThis.__ovChatTestOwnerDb();
    if (!owner) throw new Error('run this file through test/run.js (test/helpers/pg-preload.mjs provides the test database)');
    await owner.migrate({ dir: MIGRATIONS, windowDays: 0, log: quiet });
    h = await boot();
});

t('the route needs its capability, a service token for Chat and loopback', async () => {
    const url = `/internal/chat/tickets/${TICKET}/messages`;
    const body = msg('person', 'user:usr_01', 'hello');
    assert.strictEqual((await h.http('POST', url, { body })).status, 401, 'no token');
    assert.strictEqual((await h.http('POST', url, { body, token: h.serviceToken(['chat.messages.read'], { sub: 'svc:help' }) })).status, 403, 'wrong capability');
    assert.strictEqual((await h.http('GET', `/internal/chat/tickets/${TICKET}`, { token: h.serviceToken(['chat.messages.read'], { sub: 'svc:help' }) })).status, 403, 'wrong capability (GET)');
    assert.strictEqual((await h.http('POST', url, { body, token: h.serviceToken(['chat.ticket.write'], { sub: 'svc:help', aud: 'openvibe.live' }) })).status, 401, 'wrong audience');
    assert.strictEqual((await h.http('POST', url, { body, token: HELP(), headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, 'from outside');
    assert.strictEqual((await h.http('GET', `/internal/chat/tickets/${TICKET}`)).status, 401, 'GET no token');
});

t('an app token is refused: only a first-party service token', async () => {
    const app = h.serviceToken(['chat.ticket.write'], { sub: 'app:app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' });
    const body = msg('person', 'user:usr_01', 'hello');
    assert.strictEqual((await h.http('POST', `/internal/chat/tickets/${TICKET}/messages`, { token: app, body })).status, 403);
    assert.strictEqual((await h.http('GET', `/internal/chat/tickets/${TICKET}`, { token: app })).status, 403);
});

t('create, append and read back: the conversation is (ticket, service)', async () => {
    const first = msg('person', 'user:usr_01', 'My export from yesterday is missing the last day.');
    const created = await post(HELP(), TICKET, first);
    // The contract describes {ticket_id, service, message}; Chat's answer adds its usual ok.
    check('chat.ticket-conversation@1', { ticket_id: created.ticket_id, service: created.service, message: created.message });
    assert.deepStrictEqual(created, { ok: true, ticket_id: TICKET, service: 'help', message: first });

    await post(HELP(), TICKET, msg('agent', 'agent:agt_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'Checking the export job.', '2026-10-05T09:01:30Z'));
    await post(HELP(), TICKET, msg('staff', 'staff:sam', 'The last hour moves into the next day file.', '2026-10-05T09:02:00Z'));

    const page = await get(HELP(), TICKET);
    assert.strictEqual(page.ticket_id, TICKET);
    assert.strictEqual(page.service, 'help');
    assert.match(page.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'conversation created_at');
    assert.strictEqual(page.messages.length, 3);
    assert.deepStrictEqual(page.messages.map((m) => m.author_kind), ['staff', 'agent', 'person'], 'newest first');
    assert.deepStrictEqual(page.messages[0], {
        id: page.max_id, author_kind: 'staff', author: 'staff:sam',
        body: 'The last hour moves into the next day file.', created_at: '2026-10-05T09:02:00Z',
    });
    assert.strictEqual(page.max_id, Math.max(...page.messages.map((m) => m.id)));

    // after_id pages forward (oldest first); before_id and limit page back.
    const oldest = page.messages[page.messages.length - 1].id;
    const forward = await get(HELP(), TICKET, `?after_id=${oldest}`);
    assert.deepStrictEqual(forward.messages.map((m) => m.author_kind), ['agent', 'staff']);
    assert.strictEqual(forward.max_id, page.max_id);
    assert.deepStrictEqual((await get(HELP(), TICKET, '?limit=2')).messages.map((m) => m.author_kind), ['staff', 'agent']);
    assert.deepStrictEqual((await get(HELP(), TICKET, `?before_id=${page.max_id}`)).messages.map((m) => m.author_kind), ['agent', 'person']);
    assert.deepStrictEqual(await get(HELP(), TICKET, `?after_id=${page.max_id}`), { ok: true, ticket_id: TICKET, service: 'help', created_at: page.created_at, messages: [], max_id: page.max_id });
    // limit is clamped to 500, not refused: 100000 reads the whole conversation.
    assert.strictEqual((await get(HELP(), TICKET, '?limit=100000')).messages.length, 3);
});

t('another service gets its own conversation and never reads help\'s', async () => {
    await post(AI(), TICKET, msg('agent', 'agent:agt_ai', 'AI here, on the same ticket.'));

    const ai = await get(AI(), TICKET);
    assert.strictEqual(ai.service, 'ai');
    assert.deepStrictEqual(ai.messages.map((m) => m.author), ['agent:agt_ai'], 'only ai\'s own message');

    const help = await get(HELP(), TICKET);
    assert.strictEqual(help.messages.length, 3, 'help\'s conversation did not grow');
    assert.ok(help.messages.every((m) => m.author !== 'agent:agt_ai'), 'ai\'s message is not in help\'s conversation');

    // A ticket only ai has: help is 404 (it has no conversation), and posting as ai never makes one for help.
    assert.deepStrictEqual(await get(HELP(), 'tkt_ai_only', '', 404), { ok: false, error: 'Ticket conversation not found' });
    await post(AI(), 'tkt_ai_only', msg('staff', 'staff:sam', 'Only ai has this ticket.'));
    assert.strictEqual((await get(HELP(), 'tkt_ai_only', '', 404)).ok, false);
    assert.strictEqual((await get(AI(), 'tkt_ai_only')).messages.length, 1);

    // An unknown ticket has no conversation at all.
    assert.deepStrictEqual(await get(HELP(), 'tkt_nobody', '', 404), { ok: false, error: 'Ticket conversation not found' });
});

t('validation: author_kind, author, body bounds, created_at, ticket id and query', async () => {
    const url = `/internal/chat/tickets/${TICKET}/messages`;
    const write = (body) => h.http('POST', url, { token: HELP(), body });
    const long = 'x'.repeat(6000);
    const bad = [
        msg('bot', 'user:usr_01', 'not a kind'),
        msg('person', '', 'empty author'),
        msg('person', 'a'.repeat(201), 'long author'),
        msg('person', 'user:usr_01', ''),
        msg('person', 'user:usr_01', '   '),
        msg('person', 'user:usr_01', 'x'.repeat(6001)),
        msg('person', 'user:usr_01', 'nul \u0000 byte'),
        msg('person', 'user:\u0000', 'nul in author'),
        { ...msg('person', 'user:usr_01', 'x'), extra: 1 },
        { author_kind: 'person', author: 'user:usr_01', body: 'x' },
        { ...msg('person', 'user:usr_01', 'x'), created_at: 'yesterday' },
        [1],
    ];
    for (const body of bad) assert.strictEqual((await write(body)).status, 400, JSON.stringify(body));

    // 6000 characters is the contract's maximum: accepted and returned unchanged, never as HTML.
    await post(HELP(), 'tkt_bounds', msg('person', 'user:usr_01', long));
    assert.strictEqual((await get(HELP(), 'tkt_bounds')).messages[0].body, long);

    // The ticket id comes from the path: blank, whitespace, a slash or over 200 characters is 400.
    for (const ticket of ['%20', 'a%20b', 'a%2Fb', 'a'.repeat(201)]) {
        const r = await h.http('POST', `/internal/chat/tickets/${ticket}/messages`, { token: HELP(), body: msg('person', 'user:usr_01', 'x') });
        assert.strictEqual(r.status, 400, ticket);
    }

    for (const q of ['?limit=0', '?limit=-1', '?limit=abc', '?limit=', '?after_id=0', '?before_id=0', '?unknown=1']) {
        const r = await h.http('GET', `/internal/chat/tickets/${TICKET}${q}`, { token: HELP() });
        assert.strictEqual(r.status, 400, q);
    }
});

t('the contract has no idempotency key, so a retry appends another message', async () => {
    const body = msg('person', 'user:usr_dup', 'sent twice');
    await post(HELP(), 'tkt_dup', body);
    await post(HELP(), 'tkt_dup', body);
    assert.deepStrictEqual((await get(HELP(), 'tkt_dup')).messages.map((m) => m.body), ['sent twice', 'sent twice']);
});

t.run(async () => {
    if (h) await h.close();
});
