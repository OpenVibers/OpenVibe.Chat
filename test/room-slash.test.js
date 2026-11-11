'use strict';
const assert = require('assert');
const { ids, serviceAuth } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const t = suite('room-slash');
let h, owner, member, other, slug, room;
const api = (method, path, user, body) => h.http(method, path, { token: user && user.token, body });

t('boot a server channel', async () => {
    h = await boot({ env: { CHAT_SLASH_COMMANDS_ENABLED: 'true' } });
    owner = h.addUser('commandowner', { subject: ids.newId('user') });
    member = h.addUser('commandmember', { subject: ids.newId('user') });
    other = h.addUser('commandother', { subject: ids.newId('user') });
    for (const user of [owner, member, other]) await h.ctx.upsertUser(h.live.users.get(user.id));
    const created = await api('POST', '/api/chat/servers', owner, { name: 'Command Tests' });
    assert.strictEqual(created.status, 201, created.text);
    slug = created.body.server.slug;
    room = (await api('GET', `/api/chat/servers/${slug}`, owner)).body.channels[0].room;
    await api('POST', `/api/chat/servers/${slug}/join`, member);
});

t('registry and autocomplete use the current server', async () => {
    const listed = await api('GET', `/api/chat/commands?server=${slug}`, member);
    assert.strictEqual(listed.status, 200, listed.text);
    for (const name of ['me', 'shrug', 'nick', 'poll', 'remind']) assert.ok(listed.body.commands.some((c) => c.name === name), name);
    assert.ok(!listed.body.commands.some((c) => c.name === 'timeout'), 'member does not see moderator commands');
    assert.strictEqual((await api('GET', '/api/chat/commands', member)).body.commands.some((c) => c.name === 'timeout'), false);
    assert.strictEqual((await api('GET', `/api/chat/commands/autocomplete?server=${slug}&command=timeout&option=user`, member)).status, 403);
    const suggested = await api('GET', `/api/chat/commands/autocomplete?server=${slug}&command=timeout&option=user&q=commandm`, owner);
    assert.deepStrictEqual(suggested.body.choices, ['commandmember']);
});

t('an approved app registers a command only for a server it manages', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = (user, cap, sub = 'app:app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3') => serviceAuth.signServiceToken({
        iss: h.ISS, sub, actor_type: sub.startsWith('agent:') ? 'agent' : 'app',
        project_id: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', env: 'production', aud: ['openvibe.chat'], cap,
        on_behalf_of: user.subject_id, iat: now, exp: now + 300, jti: `tok_${Math.random().toString(36).slice(2)}`,
    }, h.keys.privateKey);
    const body = { server: slug, command: { name: 'hello', description: 'Say hello', options: [{ name: 'style', description: 'Greeting style', type: 'string', required: false, choices: ['hi', 'hey'] }] }, response_template: 'Hello, {args}!' };
    let r = await h.http('POST', '/api/chat/commands/registered', { token: token(owner, []), body });
    assert.strictEqual(r.status, 403, r.text);
    r = await h.http('POST', '/api/chat/commands/registered', { token: token(owner, ['chat.config.manage']), body });
    assert.strictEqual(r.status, 403, r.text);
    r = await h.http('POST', '/api/chat/commands/registered', { token: token(member, ['chat.commands.register']), body });
    assert.strictEqual(r.status, 403, r.text);
    r = await h.http('POST', '/api/chat/commands/registered', { token: token(owner, ['chat.commands.register']), body });
    assert.strictEqual(r.status, 201, r.text);
    const listed = await api('GET', `/api/chat/commands?server=${slug}`, member);
    assert.ok(listed.body.commands.some((c) => c.name === 'hello' && c.source === 'app'));
    assert.deepStrictEqual(listed.body.commands.find((c) => c.name === 'hello').options, body.command.options);
    assert.deepStrictEqual((await api('GET', `/api/chat/commands/autocomplete?server=${slug}&command=hello&option=style&q=he`, member)).body.choices, ['hey']);
    const sent = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/hello world' });
    assert.strictEqual(sent.body.message.message, 'Hello, world!');
    const agent = token(owner, ['chat.commands.register'], 'agent:agt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3');
    r = await h.http('POST', '/api/chat/commands/registered', { token: agent, body: { server: slug, command: { name: 'welcome', description: 'Welcome a member', options: [] }, response_template: 'Welcome, {args}!' } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.command.source, 'actor');
});

t('messages, nicknames, polls, reminders and vote work as the sender', async () => {
    let r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/me waves' });
    assert.strictEqual(r.status, 201, r.text);
    assert.match(r.body.message.message, /waves$/);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/help' });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.body.reply, /\/remind/);
    assert.doesNotMatch(r.body.reply, /\/timeout/);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/nick Moon' });
    assert.deepStrictEqual([r.status, r.body.reply], [200, 'Your server nickname is Moon.']);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/shrug okay' });
    assert.strictEqual(r.body.message.display_name, 'Moon');
    assert.match(r.body.message.message, /¯\\_\(ツ\)_\/¯/);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/poll Lunch? | Soup | Salad' });
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(r.body.poll_id > 0);
    const voted = await api('POST', `/api/chat/rooms/${room}/polls/${r.body.poll_id}/vote`, owner, { option: 2 });
    assert.deepStrictEqual([voted.status, voted.body.option], [200, 2]);
    const result = await api('GET', `/api/chat/rooms/${room}/polls/${r.body.poll_id}`, member);
    assert.deepStrictEqual(result.body.poll.options.map((o) => o.votes), [0, 1]);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/remind 1h bring soup' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await h.db.all('SELECT text FROM chat_command_reminders WHERE room_id = ?', [(await h.db.get('SELECT id FROM rooms WHERE slug = ?', [room])).id])).length, 1);
});

t('timeouts require rank and block posts, with an audit row', async () => {
    let r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: '/timeout commandowner 300' });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'commands.forbidden']);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, owner, { message: '/timeout commandmember 300' });
    assert.deepStrictEqual([r.status, r.body.reply], [200, 'commandmember timed out for 300s.']);
    r = await api('POST', `/api/chat/rooms/${room}/messages`, member, { message: 'hello' });
    assert.strictEqual(r.status, 403);
    assert.ok((await h.db.all("SELECT id FROM moderation_actions WHERE action_type = 'server_timeout'")).length);
    assert.strictEqual((await api('POST', `/api/chat/rooms/${room}/messages`, other, { message: '/nick Nope' })).status, 403);
});

t.run(async () => { if (h) await h.close(); });
