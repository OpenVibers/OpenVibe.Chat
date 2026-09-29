'use strict';
/**
 * Account export and deletion in Chat (roadmap WS-B task 7, ADR-033):
 *   - network.account.export_requested sends Chat's part to Network: their messages, DMs they sent, conversations,
 *     blocks, and moderation taken on them without who acted.
 *   - network.account.deleted erases what the subject and its merged-in aliases wrote or set up: chat, room and DM
 *     messages, DM memberships (a conversation left empty goes), blocks both ways, the channel's first-chat stats, their
 *     tags, and the Live mirrors (the user mirror as a tombstone). Moderation history stays. The six chat tables are
 *     Chat's (C-04 done) and are erased here.
 * Chat confirms with counts; a failed confirmation is retried without erasing again, and a redelivery sends nothing
 * twice. Chat subscribes to both.
 */
const assert = require('assert');
const { ids, validate } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
const t = suite('account-data');
let h, dana, otto, old;
const ev = (type, payload) => ({ event_id: ids.newId('event'), event_type: type, version: 1, source: 'network', actor: { type: 'user', id: payload.subject },
    timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: payload.subject }, payload });

t('boot', async () => {
    h = await boot();
    dana = h.addUser('dana', { subject: ids.newId('user') });
    old = h.addUser('dana_old', { subject: ids.newId('user') });
    otto = h.addUser('otto', { subject: ids.newId('user') });
    await h.ctx.sync();
    assert.ok(require('../server/events/consumer').TOPICS.includes('network.account.deleted'), 'Chat subscribes');
});

t('export, then erase and confirm', async () => {
    const accountData = require('../server/chat/account-data');
    const d = require('../server/db/database').getDb();
    d.prepare("INSERT INTO chat_messages (user_id, username, message, channel_user_id, subject_id) VALUES (?, 'dana', 'hi otto', ?, ?), (?, 'otto', 'hi dana', ?, ?), (?, 'dana_old', 'old me', ?, ?)")
        .run(dana.id, otto.id, dana.subject_id, otto.id, dana.id, otto.subject_id, old.id, otto.id, old.subject_id);
    const pair = (await h.http('POST', '/api/dm/conversations', { token: dana.token, body: { user_ids: [otto.id] } })).body.conversation.id;
    assert.ok((await h.http('POST', `/api/dm/conversations/${pair}/messages`, { token: dana.token, body: { message: 'psst' } })).status < 300);
    assert.ok((await h.http('POST', `/api/dm/conversations/${pair}/messages`, { token: otto.token, body: { message: 'what' } })).status < 300);
    require('../server/chat/network-blocks').ensureSchema && require('../server/chat/network-blocks').ensureSchema();
    d.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)').run(dana.subject_id, otto.subject_id, otto.subject_id, dana.subject_id);
    d.prepare("INSERT INTO moderation_actions (action_type, actor_user_id, target_user_id, actor_subject_id) VALUES ('timeout', ?, ?, ?)").run(otto.id, dana.id, otto.subject_id);
    d.prepare("INSERT INTO user_tags (user_id, tag_id) VALUES (?, 'veteran')").run(dana.id);

    const sent = [];
    let failNext = false;
    const send = async (p, body) => { if (failNext) { failNext = false; return { ok: false, status: 503 }; } sent.push({ path: p, body }); return { ok: true, status: 200 }; };

    // ── Export ──
    const exp = ev('network.account.export_requested', { export_id: `exp_${ids.ulid()}`, subject: dana.subject_id, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() });
    assert.strictEqual(await accountData.apply({ ...exp, source: 'live' }, { send }), 'ignored:source');
    assert.strictEqual(await accountData.apply(exp, { send }), 'exported');
    const part = sent[0].body;
    assert.ok(validate('network.account-export-part@1', part).valid, JSON.stringify(validate('network.account-export-part@1', part).errors));
    const files = Object.fromEntries(part.files.map((f) => [f.name, f.content]));
    assert.deepStrictEqual(files['chat_messages.json'].map((m) => m.message), ['hi otto']);
    assert.deepStrictEqual(files['direct_messages.json'].map((m) => m.message), ['psst']);
    assert.ok(files['moderation_on_you.json'][0] && !('actor_user_id' in files['moderation_on_you.json'][0]), "moderation on them, without who acted");
    assert.strictEqual(await accountData.apply(exp, { send }), 'unchanged');
    assert.strictEqual(sent.length, 1);

    // ── Deletion ──
    const del = ev('network.account.deleted', { deletion_id: `del_${ids.ulid()}`, subject: dana.subject_id, aliases: [old.subject_id], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() });
    failNext = true;
    await assert.rejects(accountData.apply(del, { send }), /confirmation refused: 503/);
    const q = (sql, ...a) => d.prepare(sql).all(...a);
    assert.deepStrictEqual(q('SELECT message FROM chat_messages ORDER BY id').map((m) => m.message), ['hi dana'], "hers and the alias's gone; otto's stays");
    assert.deepStrictEqual(q('SELECT message FROM dm_messages ORDER BY id').map((m) => m.message), ['what'], 'the DM she sent goes, his reply stays');
    assert.deepStrictEqual(q('SELECT user_id FROM dm_participants WHERE conversation_id = ?', pair).map((p) => p.user_id), [otto.id]);
    assert.strictEqual(q('SELECT * FROM network_blocks').length, 0, 'blocks both ways');
    assert.strictEqual(q('SELECT * FROM moderation_actions').length, 1, 'moderation history stays');
    assert.strictEqual(q('SELECT * FROM user_tags').length, 0, 'the tags table is Chat’s and goes');
    assert.strictEqual(d.prepare('SELECT username FROM ctx_users WHERE id = ?').get(dana.id).username, `deleted-${dana.id}`);
    assert.strictEqual(await accountData.apply(del, { send }), 'confirmed', 'the retry confirms without erasing again');
    const conf = sent[1];
    assert.ok(validate('network.account-deletion-confirmation@1', conf.body).valid, JSON.stringify(validate('network.account-deletion-confirmation@1', conf.body).errors));
    assert.deepStrictEqual([conf.body.erased.messages, conf.body.erased.direct_messages, conf.body.erased.tags, conf.body.retained.moderation_actions], [2, 1, 1, 1]);
    assert.strictEqual(await accountData.apply(del, { send }), 'unchanged');
    assert.strictEqual(sent.length, 2);
});

t.run(async () => { if (h && h.close) await h.close(); });
