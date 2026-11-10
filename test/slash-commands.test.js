'use strict';
/**
 * The composer's slash commands: the registry and autocomplete Chat serves (GET /api/chat/commands,
 * behind the default-off CHAT_SLASH_COMMANDS_ENABLED switch), and the same commands over /ws/chat.
 * An execution keeps running through the socket's authenticated pipeline, so a moderating command
 * runs with the sender's own rights and nothing more; an unknown command is a plain sentence.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('slash-commands');
let h, streamer, mod, alice, bob, channelId, streamId;

t('boot: a stream room, its moderator and two viewers', async () => {
    h = await boot({ env: { CHAT_SLASH_COMMANDS_ENABLED: 'true' } });
    streamer = h.addUser('streamer', { role: 'streamer' });
    mod = h.addUser('moddy');
    alice = h.addUser('alice');
    bob = h.addUser('bob');
    channelId = h.addChannel(streamer.id, { moderators: [mod.id] });
    await h.db.addChannelModerator(channelId, mod.id, streamer.id);
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
});

t('registry: signed-in only, built-ins without their permission, q filters by name', async () => {
    let r = await h.http('GET', '/api/chat/commands');
    assert.strictEqual(r.status, 401);

    r = await h.http('GET', '/api/chat/commands', { token: alice.token });
    assert.strictEqual(r.status, 200, r.text);
    const names = r.body.commands.map((c) => c.name);
    for (const n of ['me', 'shrug', 'help', 'mute', 'timeout']) assert.ok(names.includes(n), n);
    assert.ok(r.body.commands.every((c) => !('permission' in c)), 'rights are not advertised');
    const shrug = r.body.commands.find((c) => c.name === 'shrug');
    assert.deepStrictEqual(shrug.options.map((o) => [o.name, o.type, o.required]), [['text', 'string', false]]);

    r = await h.http('GET', '/api/chat/commands?q=%2Fsh', { token: alice.token });
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['shrug']);
});

t('autocomplete: only an option with choices answers, filtered and capped', async () => {
    let r = await h.http('GET', '/api/chat/commands/autocomplete?command=timeout&option=seconds', { token: alice.token });
    assert.deepStrictEqual(r.body.choices, ['60', '300', '900']);
    r = await h.http('GET', '/api/chat/commands/autocomplete?command=%2Ftimeout&option=seconds&q=3', { token: alice.token });
    assert.deepStrictEqual(r.body.choices, ['300']);
    r = await h.http('GET', '/api/chat/commands/autocomplete?command=shrug&option=text&q=hi', { token: alice.token });
    assert.deepStrictEqual(r.body.choices, [], 'an option without choices suggests nothing');
});

t('the switch is off by default: the registry 404s and the added commands are unknown', async () => {
    const config = require('../server/config');
    config.slashCommands.enabled = false;
    try {
        const r = await h.http('GET', '/api/chat/commands', { token: alice.token });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'commands.disabled']);
        const ws = await h.ws({ ip: '198.51.100.61', token: alice.token, stream: streamId });
        ws.sendJson({ type: 'join', streamId, token: alice.token });
        await ws.next((m) => m.type === 'auth');
        ws.sendJson({ type: 'chat', message: '/shrug off' });
        assert.strictEqual((await ws.next((m) => m.type === 'system')).message, 'Unknown command: /shrug. Type /help for a list.');
        ws.close();
    } finally { config.slashCommands.enabled = true; }
});

t('an unknown command is refused with a plain sentence', async () => {
    const ws = await h.ws({ ip: '198.51.100.62', token: alice.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: alice.token });
    await ws.next((m) => m.type === 'auth');
    ws.sendJson({ type: 'chat', message: '/frobnicate loudly' });
    assert.strictEqual((await ws.next((m) => m.type === 'system')).message, 'Unknown command: /frobnicate. Type /help for a list.');
    ws.close();
});

t('/shrug runs as the sender and reaches the room', async () => {
    const bobWs = await h.ws({ ip: '198.51.100.63', token: bob.token, stream: streamId });
    bobWs.sendJson({ type: 'join', streamId, token: bob.token });
    await bobWs.next((m) => m.type === 'auth');
    const aliceWs = await h.ws({ ip: '198.51.100.64', token: alice.token, stream: streamId });
    aliceWs.sendJson({ type: 'join', streamId, token: alice.token });
    await aliceWs.next((m) => m.type === 'auth');
    aliceWs.sendJson({ type: 'chat', message: '/shrug hello' });
    const got = await bobWs.next((m) => m.type === 'chat');
    assert.strictEqual(got.message, 'hello ¯\\_(ツ)_/¯');
    assert.deepStrictEqual([got.username, got.core_username, got.user_id], ['Alice', 'alice', alice.id]);
    aliceWs.close(); bobWs.close();
});

t('a moderating command runs with the sender\'s own rights and never more', async () => {
    const aliceWs = await h.ws({ ip: '198.51.100.65', token: alice.token, stream: streamId });
    aliceWs.sendJson({ type: 'join', streamId, token: alice.token });
    await aliceWs.next((m) => m.type === 'auth');
    aliceWs.sendJson({ type: 'chat', message: '/mute bob' });
    assert.strictEqual((await aliceWs.next((m) => m.type === 'system')).message, 'You do not have permission.');
    assert.ok(!h.live.effects.some((e) => e.name === 'ban' && e.body.user_id === bob.id), 'a viewer changed nobody’s access');
    assert.ok(!(await h.db.all('SELECT id FROM moderation_actions')).length, 'and left no moderation row');

    // The channel's moderator can, and the action is logged with the sender as its actor.
    const modWs = await h.ws({ ip: '198.51.100.66', token: mod.token, stream: streamId });
    modWs.sendJson({ type: 'join', streamId, token: mod.token });
    await modWs.next((m) => m.type === 'auth');
    modWs.sendJson({ type: 'chat', message: '/mute bob' });
    assert.strictEqual((await modWs.next((m) => m.type === 'system')).message, 'bob timed out for 300s.');
    const fx = h.live.effects.filter((e) => e.name === 'ban' && e.body.user_id === bob.id).pop();
    assert.deepStrictEqual([fx.body.reason, fx.body.actor_user_id], ['Timeout 300s', mod.id]);
    const rows = await h.db.all('SELECT action_type FROM moderation_actions');
    assert.deepStrictEqual(rows.map((r) => r.action_type), ['channel_timeout']);
    aliceWs.close(); modWs.close();
});

t.run(async () => { if (h && h.close) await h.close(); });
