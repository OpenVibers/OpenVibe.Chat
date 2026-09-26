'use strict';
/**
 * The staged tables (roadmap C-04, docs/staged-tables-cutover.md): table_authority per table, kept
 * across restarts; at 'live' the staged writes refuse and Live's captured changes keep this copy
 * current (never mirrored back); the handoff over the bridge (to 'chat' needs the mirror, back to
 * 'live' waits until the mirror has sent the table's changes); at 'chat' every write Live's writers
 * make — moderators, settings and alert sounds, emote CRUD with the Media fields, user tags, AI
 * summaries and timeline events — answers Live's own return value plus the rows, once per key, and
 * reaches Live through the mirror; Chat's chat server then reads the moderation tables in place and
 * writes /slow itself; the dual-read slice; scripts/table-authority.js.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { boot, suite } = require('./helpers');

const t = suite('staged-tables');
let h, BRIDGE, streamer, mod, viewer, channelId, streamId;
const STAGED = ['channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events'];
let seq = 0;

const calls = (ops) => h.http('POST', '/internal/live/calls', { token: BRIDGE, body: { boot: 'live-boot-staged', ops: ops.map((o) => ({ seq: ++seq, ...o })) } });
/** One op, its result (throws with Chat's error when it was refused). */
async function op(name, args, { key } = {}) {
    const r = await calls([{ op: name, args, key }]);
    assert.strictEqual(r.status, 200, r.text);
    const res = r.body.results[0];
    if (!res.ok) throw Object.assign(new Error(res.error), { refused: true });
    return res.result;
}
const dbOp = (fn, args, opts) => op('db', [fn, ...args], opts);
const count = (table, where = '1', params = []) => h.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params).n;
const stagedPending = () => h.db.get(`SELECT COUNT(*) AS n FROM live_mirror_outbox WHERE tbl IN (${STAGED.map(() => '?').join(',')})`, STAGED).n;

t('boot with the Live mirror on', async () => {
    h = await boot({ env: { LIVE_MIRROR: '1', LIVE_MIRROR_INTERVAL_MS: '3600000' } });
    BRIDGE = h.serviceToken(['chat.live_bridge.write']);
    streamer = h.addUser('streamer', { role: 'streamer' });
    mod = h.addUser('moddy');
    viewer = h.addUser('viewer');
    channelId = h.addChannel(streamer.id, { settings: { channel_id: 0, slow_mode_seconds: 99 } });
    streamId = h.addStream(streamer.id, channelId);
    await h.ctx.sync();
});

t('every staged table starts at live; a restart keeps the authority it was handed', async () => {
    assert.deepStrictEqual(await op('tableAuthority', []), Object.fromEntries(STAGED.map((s) => [s, 'live'])));
    h.db.setTableAuthority('emotes', 'chat');
    h.db.initDb();
    assert.strictEqual(h.db.tableAuthority('emotes'), 'chat', 'initDb never moves a table back');
    h.db.setTableAuthority('emotes', 'live');
    assert.strictEqual(h.db.tableAuthority('chat_messages'), 'chat', 'Chat’s own tables stay Chat’s');
    assert.throws(() => h.db.setTableAuthority('chat_messages', 'live'), /not a staged table/);
});

t('at live: every staged write refuses, one writer at a time', async () => {
    const tries = [
        ['addChannelModerator', [channelId, mod.id, streamer.id]],
        ['upsertChannelModerationSettings', [channelId, { slow_mode_seconds: 1 }]],
        ['createEmote', [{ user_id: streamer.id, code: 'nope', url: '/e/nope.png' }]],
        ['grantUserTag', [viewer.id, 'og']],
        ['upsertChatAiSummary', [{ scope: 'global', subject_id: 0, window: 'rolling', overview: 'x' }]],
        ['addChatTimelineEvents', ['global', 0, [{ ts: '2026-09-25 10:00:00', label: 'x' }]]],
    ];
    for (const [fn, args] of tries) await assert.rejects(dbOp(fn, args), /written by Live \(table_authority live\)/, fn);
    for (const s of STAGED) assert.strictEqual(count(s), 0, `${s} untouched`);
});

t('at live: Live’s changes keep this copy current, idempotently, and never go back to Live', async () => {
    const changes = [
        { table: 'channel_moderators', op: 'upsert', row: { id: 7, channel_id: channelId, user_id: mod.id, added_by: streamer.id, created_at: '2026-09-25 10:00:00' } },
        { table: 'channel_moderation_settings', op: 'upsert', row: { channel_id: channelId, slow_mode_seconds: 4, emote_scale: 120 } },
        { table: 'emotes', op: 'upsert', row: { id: 3, user_id: streamer.id, code: 'pog', url: '/e/pog.png', channel_owner_id: streamer.id, media_url: null } },
        { table: 'user_tags', op: 'upsert', row: { id: 5, user_id: viewer.id, tag_id: 'legacy', source: 'migration' } },
        { table: 'chat_ai_summaries', op: 'upsert', row: { id: 9, scope: 'global', subject_id: 0, window: 'rolling', overview: 'busy' } },
        { table: 'chat_timeline_events', op: 'upsert', row: { id: 11, scope: 'global', subject_id: 0, ts: '2026-09-25 10:00:00', label: 'raid' } },
        { table: 'chat_messages', op: 'upsert', row: { id: 1, message: 'not staged' } },
    ];
    let r = await op('stagedApply', [changes]);
    assert.strictEqual(r.applied, 6);
    assert.deepStrictEqual(r.skipped.map((s) => s.reason), ['not a staged table']);
    r = await op('stagedApply', [changes.slice(0, 6)]);
    assert.strictEqual(r.applied, 6, 'again: the same rows');
    for (const s of STAGED) assert.strictEqual(count(s), 1, s);
    assert.strictEqual(h.db.get('SELECT emote_scale FROM channel_moderation_settings WHERE channel_id = ?', [channelId]).emote_scale, 120);
    // Removed in Live and added again under a new id: the new row replaces the old one.
    r = await op('stagedApply', [[{ table: 'channel_moderators', op: 'upsert', row: { id: 8, channel_id: channelId, user_id: mod.id, added_by: streamer.id } }]]);
    assert.deepStrictEqual(h.db.all('SELECT id FROM channel_moderators').map((x) => x.id), [8]);
    r = await op('stagedApply', [[{ table: 'user_tags', op: 'delete', pk: { id: 5 } }]]);
    assert.strictEqual(count('user_tags'), 0);
    assert.strictEqual(stagedPending(), 0, 'Live’s own rows are never mirrored back');
    // Chat still reads the moderation tables through Live while Live writes them.
    await h.ctx.ensurePolicy(channelId);
    assert.strictEqual(h.ctx.getChannelModerationSettings(channelId).slow_mode_seconds, 99);
    assert.strictEqual(h.ctx.isChannelModerator(mod.id, channelId), false);
});

t('the dual-read slice: count and hash over the columns asked for, rows when few', async () => {
    const s = await op('stagedSlice', ['channel_moderators', { channel_id: channelId }, ['id', 'channel_id', 'user_id', 'added_by', 'created_at', 'not_a_column']]);
    assert.strictEqual(s.count, 1);
    assert.deepStrictEqual(s.columns, ['added_by', 'channel_id', 'created_at', 'id', 'user_id']);
    assert.strictEqual(s.hash, h.db.sliceHash(s.columns, s.rows));
    assert.strictEqual((await op('stagedSlice', ['emotes', { channel_owner_id: null }])).count, 0, 'null-safe equality');
    await assert.rejects(op('stagedSlice', ['emotes', { 'code; DROP TABLE emotes': 1 }]), /unknown column/);
    await assert.rejects(op('stagedSlice', ['chat_messages', {}]), /not a staged table/);
});

t('the handoff: to chat needs the Live mirror', async () => {
    const { handOver } = require('../server/bridge/live-bridge');
    await assert.rejects(handOver('emotes', 'chat', { mirror: h.mirrorRelay, config: { live: { mirror: false } } }), /LIVE_MIRROR is off/);
    assert.strictEqual(h.db.tableAuthority('emotes'), 'live');
    await assert.rejects(op('setTableAuthority', ['chat_messages', 'live']), /not a staged table/);
    for (const s of STAGED) assert.deepStrictEqual(await op('setTableAuthority', [s, 'chat']), { table: s, authority: 'chat', mirror_pending: 0 });
    assert.strictEqual((await h.http('GET', '/ready')).body.table_authority.emotes, 'chat');
});

let emoteId;
t('at chat: moderators and settings — Live’s return values, the rows, once per key', async () => {
    let r = await dbOp('addChannelModerator', [channelId, viewer.id, streamer.id], { key: 'live:k1' });
    assert.strictEqual(r.value.changes, 1);
    assert.deepStrictEqual(r.mirror.map((c) => [c.table, c.op, c.row.user_id]), [['channel_moderators', 'upsert', viewer.id]]);
    r = await dbOp('addChannelModerator', [channelId, viewer.id, streamer.id], { key: 'live:k1' });
    assert.strictEqual(count('channel_moderators', 'user_id = ?', [viewer.id]), 1, 'a retried key applies once');
    r = await dbOp('removeChannelModerator', [channelId, viewer.id]);
    assert.strictEqual(r.value.changes, 1);
    assert.strictEqual(r.mirror[0].op, 'delete');
    assert.strictEqual(count('channel_moderators', 'user_id = ?', [viewer.id]), 0);
    r = await dbOp('upsertChannelModerationSettings', [channelId, { slow_mode_seconds: 7, emote_scale: 999, tts_max_length: 5, followers_only: true }]);
    assert.deepStrictEqual([r.value.slow_mode_seconds, r.value.emote_scale, r.value.tts_max_length, r.value.followers_only], [7, 300, 10, 1], 'Live’s clamps');
    r = await dbOp('upsertChannelModerationSettings', [channelId + 1000, { slow_mode_seconds: 2 }]);
    assert.deepStrictEqual([r.value.channel_id, r.value.slow_mode_seconds, r.value.allow_anonymous, r.value.max_message_length], [channelId + 1000, 2, 1, 500], 'a new row with Live’s defaults');
    r = await dbOp('setChannelAlertSound', [channelId, 'goal', '/sounds/goal.mp3', 'audio/mpeg']);
    assert.strictEqual(r.mirror[0].row.goal_sound_url, '/sounds/goal.mp3');
    assert.strictEqual(r.mirror[0].row.slow_mode_seconds, 7, 'the whole row travels');
});

t('at chat: emote CRUD with the Media fields, user tags, AI summaries and timeline', async () => {
    let r = await dbOp('createEmote', [{ user_id: streamer.id, code: 'hype', url: '/data/emotes/hype.png', animated: true, channel_owner_id: streamer.id, size: 5 }]);
    emoteId = r.value.lastInsertRowid;
    assert.ok(emoteId > 3);
    assert.deepStrictEqual([r.mirror[0].row.code, r.mirror[0].row.animated, r.mirror[0].row.size], ['hype', 1, 25]);
    await assert.rejects(dbOp('createEmote', [{ user_id: streamer.id, code: 'hype', url: '/x.png', channel_owner_id: streamer.id }]), /UNIQUE/, 'one code per channel');
    r = await dbOp('updateEmote', [emoteId, { code: 'hype2', size: 1000 }]);
    assert.deepStrictEqual([r.value.changes, r.mirror[0].row.code, r.mirror[0].row.size], [1, 'hype2', 400]);
    assert.deepStrictEqual((await dbOp('updateEmote', [emoteId, {}])).value, { changes: 0 });
    r = await dbOp('setEmoteMedia', [emoteId, 'https://openvibe.media/a/77', 77]);
    assert.deepStrictEqual([r.mirror[0].row.media_url, r.mirror[0].row.media_asset_id], ['https://openvibe.media/a/77', 77]);
    r = await dbOp('deleteEmote', [3]);
    assert.deepStrictEqual(r.mirror, [{ table: 'emotes', op: 'delete', pk: { id: 3 } }]);
    r = await dbOp('grantUserTag', [viewer.id, 'founder', 'grant']);
    assert.strictEqual(r.mirror[0].row.source, 'grant');
    await dbOp('grantUserTag', [viewer.id, 'founder']);
    assert.strictEqual(count('user_tags'), 1, 'a tag is owned once');
    r = await dbOp('revokeUserTag', [viewer.id, 'founder']);
    assert.strictEqual(r.value.changes, 1);
    r = await dbOp('upsertChatAiSummary', [{ scope: 'user', subject_id: viewer.id, window: 'rolling', overview: 'first', last_message_id: 10 }]);
    r = await dbOp('upsertChatAiSummary', [{ scope: 'user', subject_id: viewer.id, window: 'rolling', overview: 'second', last_message_id: 20 }]);
    assert.deepStrictEqual([r.mirror[0].row.overview, r.mirror[0].row.last_message_id], ['second', 20]);
    assert.strictEqual(count('chat_ai_summaries', "scope = 'user'"), 1);
    r = await dbOp('addChatTimelineEvents', ['global', 0, [{ ts: '2026-09-25 11:00:00', label: 'clip' }, { ts: '2026-09-25 11:00:00', label: 'clip' }, { label: 'no ts' }]]);
    assert.strictEqual(r.value, 2, 'Live counts the duplicate it tried');
    assert.strictEqual(r.mirror.length, 1);
    // Live's changes no longer apply to a table Chat writes.
    const refused = await op('stagedApply', [[{ table: 'emotes', op: 'delete', pk: { id: emoteId } }]]);
    assert.deepStrictEqual([refused.applied, refused.skipped[0].reason], [0, 'Chat writes this table (table_authority chat)']);
    assert.strictEqual(count('emotes', 'id = ?', [emoteId]), 1);
});

t('at chat: every change reaches Live through the mirror, newest state per row', async () => {
    assert.ok(stagedPending() > 0);
    await h.mirrorRelay.flush();
    assert.strictEqual(stagedPending(), 0);
    const got = (table) => h.live.mirror.filter((c) => c.table === table);
    assert.deepStrictEqual(got('emotes').find((c) => c.row && c.row.id === emoteId).row.code, 'hype2');
    assert.ok(got('emotes').some((c) => c.op === 'delete' && c.pk.id === 3));
    assert.ok(got('channel_moderators').some((c) => c.op === 'delete'));
    assert.strictEqual(got('channel_moderation_settings').find((c) => c.row.channel_id === channelId).row.goal_sound_url, '/sounds/goal.mp3');
    for (const s of ['user_tags', 'chat_ai_summaries', 'chat_timeline_events']) assert.ok(got(s).length >= 1, s);
});

t('at chat: Chat’s chat server reads the moderation tables in place and persists /slow itself', async () => {
    await dbOp('addChannelModerator', [channelId, mod.id, streamer.id]);
    assert.strictEqual(h.ctx.isChannelModerator(mod.id, channelId), true, 'Live’s policy lists no moderators; the local row counts');
    assert.strictEqual(h.ctx.getChannelModerationSettings(channelId).slow_mode_seconds, 7, 'the local row, not Live’s 99');
    assert.strictEqual(h.ctx.getChannelModerationSettings(424242).allow_anonymous, 1, 'defaults when there is no row');
    const effectsBefore = h.live.effects.length;
    const ws = await h.ws({ ip: '198.51.100.60', token: mod.token, stream: streamId });
    ws.sendJson({ type: 'join', streamId, token: mod.token });
    await ws.next((m) => m.type === 'auth');
    ws.sendJson({ type: 'chat', message: '/slow 12' });
    assert.strictEqual((await ws.next((m) => m.type === 'slowmode')).seconds, 12, 'a moderator by the local table');
    await h.sleep(100);
    assert.strictEqual(h.db.get('SELECT slow_mode_seconds FROM channel_moderation_settings WHERE channel_id = ?', [channelId]).slow_mode_seconds, 12);
    assert.ok(!h.live.effects.slice(effectsBefore).some((e) => e.name === 'channel-settings'), 'Live is not asked to write it');
    ws.close();
    // Alert sounds: files in the sounds directory only, written here.
    await assert.rejects(h.ctx.effects.setChannelAlertSound(channelId, 'donation', '/etc/hostname', 'audio/mpeg', streamer.id), /sounds directory/);
    const snd = path.join(h.tmp, 'sounds', 'alert.mp3');
    fs.writeFileSync(snd, 'ID3');
    await h.ctx.effects.setChannelAlertSound(channelId, 'donation', snd, 'audio/mpeg', streamer.id);
    assert.strictEqual(h.ctx.getChannelAlertSoundsByUser(streamer.id).donation_sound_url, snd);
    assert.ok(!h.live.effects.slice(effectsBefore).some((e) => e.name === 'alert-sound'));
});

t('back to live: waits for the mirror, refused while Live refuses it, then Live writes again', async () => {
    await dbOp('addChannelModerator', [channelId, viewer.id, streamer.id]);
    assert.ok(h.db.mirrorPending('channel_moderators') > 0);
    h.live.mirrorStatus = 409;
    await assert.rejects(op('setTableAuthority', ['channel_moderators', 'live']), /not in Live yet/);
    assert.strictEqual(h.db.tableAuthority('channel_moderators'), 'chat', 'nothing moved');
    h.live.mirrorStatus = 200;
    assert.deepStrictEqual(await op('setTableAuthority', ['channel_moderators', 'live']), { table: 'channel_moderators', authority: 'live', mirror_pending: 0 });
    assert.ok(h.live.mirror.some((c) => c.table === 'channel_moderators' && c.row && c.row.user_id === viewer.id), 'Chat’s newest row reached Live first');
    await assert.rejects(dbOp('addChannelModerator', [channelId, streamer.id, streamer.id]), /written by Live/);
    assert.strictEqual((await op('stagedApply', [[{ table: 'channel_moderators', op: 'delete', pk: { id: 8 } }]])).applied, 1, 'Live’s changes apply again');
    assert.strictEqual(stagedPending(), 0, 'and are not mirrored back');
});

t('scripts/table-authority.js: status; set only with --force; never back to live with changes queued', async () => {
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'table-authority.js'), ...args], { encoding: 'utf8', env: { ...process.env } });
    let r = run();
    assert.strictEqual(r.status, 0, r.stderr);
    const st = JSON.parse(r.stdout).tables;
    assert.deepStrictEqual([st.channel_moderators.authority, st.emotes.authority], ['live', 'chat']);
    assert.strictEqual(run('set', 'emotes', 'live').status, 2, 'needs --force');
    await dbOp('createEmote', [{ user_id: viewer.id, code: 'late', url: '/e/late.png' }]);
    r = run('set', 'emotes', 'live', '--force');
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /have not reached Live yet/);
    await h.mirrorRelay.flush();
    r = run('set', 'emotes', 'live', '--force');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), { table: 'emotes', before: 'chat', after: 'live' });
    await h.sleep(1100);   // the service's authority cache
    await assert.rejects(dbOp('createEmote', [{ user_id: viewer.id, code: 'later', url: '/e/later.png' }]), /written by Live/);
});

t.run(async () => { if (h) await h.close(); });
