'use strict';
/**
 * scripts/import-from-live.js against a fake Live snapshot built from Live's real table
 * definitions (test/fixtures/live-chat-schema.sql): counts per table, a dry run unless --apply (and
 * it writes nothing), --apply backs Chat's database up first, ids kept, Network subjects filled in,
 * id headroom, projections seeded, idempotent re-runs, Chat's edits win on chat tables while staged
 * tables at 'live' are made equal to Live's (refreshed, and pruned of rows Live removed) and staged
 * tables at 'chat' are only compared, conflicting rows and transient-table rows held (never
 * dropped), rows Live wrote after the first pass brought over, schema drift refused; and
 * scripts/parity-check.js --tables (row counts and a content hash per staged table).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { suite } = require('./helpers');

const t = suite('import');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-import-'));
const liveDb = path.join(tmp, 'live-snapshot.db');
const chatDb = path.join(tmp, 'chat.db');
const SUBJ = 'usr_01J9SUBJECTSUBJECTSUBJECTS';

function importer(args) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-from-live.js'), '--live-db', liveDb, '--chat-db', chatDb, ...args], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', OV_LIVE_INTERNAL_URL: 'http://127.0.0.1:9' },
    });
    let report = null;
    try { report = JSON.parse(r.stdout); } catch { /* */ }
    return { code: r.status, report, stderr: r.stderr, stdout: r.stdout };
}

let live;
t('build a Live snapshot with every chat table', () => {
    live = new Database(liveDb);
    live.pragma('foreign_keys = OFF');
    live.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'live-chat-schema.sql'), 'utf8'));
    live.exec('ALTER TABLE channel_sounds ADD COLUMN media_url TEXT; ALTER TABLE channel_sounds ADD COLUMN media_asset_id INTEGER;');
    const u = live.prepare("INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, '!', ?, ?)");
    u.run(1, 'streamer', 'Streamer', 'streamer'); u.run(2, 'alice', 'Alice', 'user'); u.run(3, 'bob', 'Bob', 'user');
    live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '77', ?)").run(SUBJ);
    live.prepare("INSERT INTO channels (id, user_id, title) VALUES (5, 1, 'TV')").run();
    live.prepare("INSERT INTO managed_streams (id, user_id, channel_id, slug, title, stream_key) VALUES (9, 1, 5, 'main', 'Main', 'k')").run();
    live.prepare("INSERT INTO streams (id, user_id, channel_id, managed_stream_id, title, is_live) VALUES (40, 1, 5, 9, 'Show', 1)").run();
    const msg = live.prepare('INSERT INTO chat_messages (id, stream_id, channel_user_id, user_id, anon_id, username, message, message_type, metadata, is_global, is_deleted, reply_to_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    msg.run(101, 40, 1, 2, null, 'Alice', 'first', 'chat', null, 0, 0, null, '2026-09-01 10:00:00');
    msg.run(102, 40, 1, 3, null, 'Bob', 'reply', 'chat', null, 0, 0, 101, '2026-09-01 10:00:05');
    msg.run(103, null, null, null, 'anon4', 'anon4', 'global hi', 'chat', null, 1, 0, null, '2026-09-01 10:01:00');
    msg.run(104, 40, 1, null, null, 'Donor', 'tipped 5 Vibes', 'donation', '{"kind":"donation","amount":5}', 0, 0, null, '2026-09-01 10:02:00');
    msg.run(105, 40, 1, 2, null, 'Alice', 'deleted one', 'chat', null, 0, 1, null, '2026-09-01 10:03:00');
    live.prepare("INSERT INTO dm_conversations (id, created_by, created_at) VALUES (7, 2, '2026-09-02 00:00:00')").run();
    live.prepare('INSERT INTO dm_participants (conversation_id, user_id) VALUES (7, 2), (7, 3)').run();
    live.prepare("INSERT INTO dm_messages (id, conversation_id, sender_id, message, created_at) VALUES (70, 7, 2, 'psst', '2026-09-02 00:00:01')").run();
    live.prepare('INSERT INTO dm_blocks (blocker_id, blocked_id) VALUES (3, 1)').run();
    live.prepare("INSERT INTO tts_voice_overrides (identity_key, voice, pitch, speed) VALUES ('user:alice', 'en+f3', 60, 170)").run();
    live.prepare("INSERT INTO channel_sounds (id, channel_owner_id, command, url, created_by, media_url, media_asset_id) VALUES (11, 1, 'honk', '/opt/openvibe.live/data/sounds/snd-1.mp3', 2, 'https://openvibe.media/a/1', 555)").run();
    live.prepare("INSERT INTO relay_users (platform, username, display_name, message_count) VALUES ('twitch', 'zed', 'Zed', 3)").run();
    live.prepare("INSERT INTO hidden_relay_users (channel_id, platform, external_username) VALUES (5, 'twitch', 'spammer')").run();
    live.prepare("INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, username, message) VALUES (5, 40, '203.0.113.5', 'anon9', 'let me in')").run();
    live.prepare("INSERT INTO stream_first_chats (chatter_key, channel_user_id) VALUES ('user:2', 1)").run();
    live.prepare("INSERT INTO moderation_actions (scope_type, actor_user_id, target_user_id, action_type, details) VALUES ('channel', 2, 3, 'channel_ban', '{}')").run();
    live.prepare('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (5, 2, 1)').run();
    live.prepare('INSERT INTO channel_moderation_settings (channel_id, slow_mode_seconds) VALUES (5, 3)').run();
    live.prepare("INSERT INTO emotes (user_id, code, url, channel_owner_id) VALUES (1, 'pog', '/e/pog.png', 1)").run();
    live.prepare("INSERT INTO user_tags (user_id, tag_id) VALUES (2, 'og')").run();
    live.prepare("INSERT INTO chat_ai_summaries (scope, subject_id, window, overview) VALUES ('user', 2, '7d', 'nice')").run();
    live.prepare("INSERT INTO chat_timeline_events (scope, ts, label) VALUES ('global', '2026-09-01 10:00:00', 'hype')").run();
    live.prepare("INSERT INTO media_requests (streamer_id, user_id, username, input, canonical_url, provider, title) VALUES (1, 2, 'Alice', 'x', 'https://youtu.be/x', 'youtube', 'X')").run();
    live.exec("CREATE TABLE chat_messages_new AS SELECT * FROM chat_messages WHERE id = 101");
});

t('dry run reports and writes nothing (the default; --dry-run says it too)', () => {
    for (const args of [[], ['--dry-run']]) {
        const r = importer(args);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(r.report.dry_run, true);
        assert.strictEqual(r.report.backup, null);
    }
    const r = importer([]);
    assert.strictEqual(r.report.tables.channel_moderators.authority, 'live');
    assert.strictEqual(r.report.tables.chat_messages.inserted, 5);
    assert.strictEqual(r.report.tables.chat_messages_new.held, 1);
    const c = new Database(chatDb, { readonly: true });
    assert.strictEqual(c.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 0);
    assert.strictEqual(c.prepare('SELECT COUNT(*) AS n FROM import_hold').get().n, 0);
    assert.strictEqual(c.prepare('SELECT COUNT(*) AS n FROM import_runs').get().n, 0);
    c.close();
});

t('import copies every table with ids kept, subjects filled, headroom set', () => {
    const r = importer(['--apply', '--headroom', '1000']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.report.backup && fs.existsSync(r.report.backup), 'backed up first');
    const b = new Database(r.report.backup, { readonly: true });
    assert.strictEqual(b.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 0, 'the backup is the database before the run');
    b.close();
    const T = r.report.tables;
    const expect = { chat_messages: 5, dm_conversations: 1, dm_participants: 2, dm_messages: 1, dm_blocks: 1, tts_voice_overrides: 1, channel_sounds: 1, relay_users: 1, hidden_relay_users: 1, pending_ip_messages: 1, stream_first_chats: 1, moderation_actions: 1, channel_moderators: 1, channel_moderation_settings: 1, emotes: 1, user_tags: 1, chat_ai_summaries: 1, chat_timeline_events: 1 };
    for (const [tbl, n] of Object.entries(expect)) {
        assert.strictEqual(T[tbl].live, n, `${tbl} live`);
        assert.strictEqual(T[tbl].inserted, n, `${tbl} inserted`);
    }
    assert.strictEqual(T.media_requests.not_moved.startsWith('stays in Live'), true);
    assert.strictEqual(T.chat_messages_new.held, 1);
    assert.strictEqual(T.chat_messages.next_id, 105 + 1000 + 1);
    const c = new Database(chatDb, { readonly: true });
    const m = c.prepare('SELECT * FROM chat_messages WHERE id = 102').get();
    assert.strictEqual(m.reply_to_id, 101);
    assert.strictEqual(m.user_id, 3);
    assert.strictEqual(c.prepare('SELECT subject_id FROM chat_messages WHERE id = 101').get().subject_id, SUBJ);
    assert.strictEqual(c.prepare('SELECT is_deleted FROM chat_messages WHERE id = 105').get().is_deleted, 1, 'deleted rows are kept, still deleted');
    assert.strictEqual(c.prepare('SELECT metadata FROM chat_messages WHERE id = 104').get().metadata, '{"kind":"donation","amount":5}');
    assert.strictEqual(c.prepare('SELECT sender_subject_id FROM dm_messages WHERE id = 70').get().sender_subject_id, SUBJ);
    assert.strictEqual(c.prepare('SELECT actor_subject_id FROM moderation_actions').get().actor_subject_id, SUBJ);
    assert.strictEqual(c.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'chat_messages'").get().seq, 1105);
    const hold = c.prepare('SELECT * FROM import_hold').all();
    assert.strictEqual(hold.length, 1);
    assert.strictEqual(hold[0].source_table, 'chat_messages_new');
    assert.match(hold[0].reason, /transient migration table/);
    assert.strictEqual(c.prepare('SELECT username FROM ctx_users WHERE id = 2').get().username, 'alice', 'projections seeded');
    assert.strictEqual(c.prepare('SELECT subject_id FROM ctx_users WHERE id = 2').get().subject_id, SUBJ);
    assert.strictEqual(c.prepare('SELECT slug FROM ctx_managed_streams WHERE id = 9').get().slug, 'main');
    assert.strictEqual(c.prepare('SELECT COUNT(*) AS n FROM live_mirror_outbox').get().n, 0, 'imported rows are never mirrored back to Live');
    assert.strictEqual(c.prepare('SELECT COUNT(*) AS n FROM events_outbox').get().n, 0, 'imported history is not re-announced');
    c.close();
});

t('re-running is idempotent', () => {
    const r = importer(['--apply', '--no-backup', '--headroom', '1000']);
    assert.strictEqual(r.report.backup, null);
    assert.strictEqual(r.code, 0, r.stderr);
    for (const [tbl, v] of Object.entries(r.report.tables)) {
        if (v.inserted !== undefined) assert.strictEqual(v.inserted, 0, `${tbl} inserted again`);
    }
    assert.strictEqual(r.report.tables.chat_messages.identical, 5);
    assert.strictEqual(r.report.held_total, 1, 'holds are not duplicated');
});

t('after the cutover: Chat’s edits win, staged tables refresh, conflicts are held, late Live rows come over', () => {
    const c = new Database(chatDb);
    c.prepare('UPDATE chat_messages SET is_deleted = 1 WHERE id = 101').run();                    // a moderator deleted it in Chat
    c.prepare("INSERT INTO chat_messages (id, user_id, username, message) VALUES (106, 3, 'Bob', 'written in chat')").run();
    c.close();
    live.prepare('UPDATE channel_moderation_settings SET slow_mode_seconds = 10 WHERE channel_id = 5').run();
    live.prepare("INSERT INTO chat_messages (id, user_id, username, message, timestamp) VALUES (106, 2, 'Alice', 'a different 106', '2026-09-03 00:00:00')").run();
    live.prepare("INSERT INTO chat_messages (id, user_id, username, message, timestamp) VALUES (107, 2, 'Alice', 'written in Live after the first pass', '2026-09-03 00:00:01')").run();
    const r = importer(['--apply', '--no-backup', '--headroom', '1000']);
    assert.strictEqual(r.code, 0, r.stderr);
    const T = r.report.tables;
    assert.strictEqual(T.chat_messages.chat_kept, 1);
    assert.strictEqual(T.chat_messages.held, 1);
    assert.strictEqual(T.chat_messages.inserted, 1);
    assert.strictEqual(T.channel_moderation_settings.refreshed, 1);
    const d = new Database(chatDb, { readonly: true });
    assert.strictEqual(d.prepare('SELECT is_deleted FROM chat_messages WHERE id = 101').get().is_deleted, 1);
    assert.strictEqual(d.prepare('SELECT message FROM chat_messages WHERE id = 106').get().message, 'written in chat');
    assert.strictEqual(d.prepare('SELECT message FROM chat_messages WHERE id = 107').get().message, 'written in Live after the first pass');
    assert.strictEqual(d.prepare('SELECT slow_mode_seconds FROM channel_moderation_settings WHERE channel_id = 5').get().slow_mode_seconds, 10);
    const held = d.prepare("SELECT * FROM import_hold WHERE source_table = 'chat_messages'").get();
    assert.match(held.reason, /different row/);
    assert.strictEqual(JSON.parse(held.row_json).message, 'a different 106');
    assert.strictEqual(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'chat_messages'").get().seq, 1107, 'headroom follows Live’s new max, never lowered');
    d.close();
});

function parity(args) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'parity-check.js'), '--tables', '--live-db', liveDb, '--chat-db', chatDb, ...args], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

t('parity --tables: after an import every staged table has the same rows and hash', () => {
    const r = parity([]);
    assert.strictEqual(r.code, 0, r.out + r.err);
    for (const tbl of ['channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events']) {
        assert.match(r.out, new RegExp(`^same\\s+${tbl}\\s+\\(live\\) rows 1\\b`, 'm'), tbl);
    }
    assert.match(r.out, /all staged tables are the same/);
});

t('staged tables at live follow Live: a removed moderator goes, a re-added one comes back; parity sees each step', () => {
    live.prepare('DELETE FROM channel_moderators WHERE channel_id = 5 AND user_id = 2').run();
    live.prepare('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (5, 3, 1)').run();
    let p = parity(['--table', 'channel_moderators']);
    assert.strictEqual(p.code, 1);
    assert.match(p.out, /DIFFERENT channel_moderators\s+\(live\) rows 1 ≠ 1/);
    assert.match(p.out, /only in Live \(1\): \[2\]/);
    assert.match(p.out, /only in Chat \(1\): \[1\]/);
    const dry = importer(['--tables', 'channel_moderators']);
    assert.strictEqual(dry.code, 0, dry.stderr + dry.stdout);
    assert.deepStrictEqual([dry.report.tables.channel_moderators.pruned, dry.report.tables.channel_moderators.inserted], [1, 1], 'the dry run counts it');
    assert.strictEqual(parity(['--table', 'channel_moderators']).code, 1, 'and changes nothing');
    const r = importer(['--apply', '--no-backup', '--tables', 'channel_moderators']);
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.deepStrictEqual([r.report.tables.channel_moderators.pruned, r.report.tables.channel_moderators.inserted], [1, 1]);
    p = parity(['--table', 'channel_moderators']);
    assert.strictEqual(p.code, 0, p.out);
    // The same user removed and added again under a new id: the old row goes first, no collision.
    live.prepare('DELETE FROM channel_moderators WHERE user_id = 3').run();
    live.prepare('INSERT INTO channel_moderators (channel_id, user_id, added_by) VALUES (5, 3, 1)').run();
    const again = importer(['--apply', '--no-backup', '--tables', 'channel_moderators']);
    assert.deepStrictEqual([again.report.tables.channel_moderators.pruned, again.report.tables.channel_moderators.inserted, again.report.tables.channel_moderators.held], [1, 1, 0]);
    assert.strictEqual(parity(['--table', 'channel_moderators']).code, 0);
});

t('a staged table at chat is only compared: Chat is its authority', () => {
    const c = new Database(chatDb);
    c.prepare("UPDATE table_authority SET authority = 'chat' WHERE table_name = 'emotes'").run();
    c.prepare("UPDATE emotes SET code = 'pogchat' WHERE code = 'pog'").run();
    c.close();
    live.prepare("INSERT INTO emotes (user_id, code, url, channel_owner_id) VALUES (1, 'kek', '/e/kek.png', 1)").run();
    const r = importer(['--apply', '--no-backup', '--tables', 'emotes']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(r.report.tables.emotes, { authority: 'chat', live: 2, identical: 0, differs: 1, live_only: 1, chat_only: 0 });
    const d = new Database(chatDb, { readonly: true });
    assert.deepStrictEqual(d.prepare('SELECT code FROM emotes ORDER BY id').all().map((x) => x.code), ['pogchat'], 'nothing written');
    d.close();
    assert.match(parity(['--table', 'emotes']).out, /DIFFERENT emotes\s+\(chat\)/);
});

t('schema drift is refused before anything is written', () => {
    live.exec('ALTER TABLE chat_messages ADD COLUMN surprise TEXT');
    live.prepare("INSERT INTO chat_messages (id, username, message, surprise) VALUES (108, 'x', 'y', 'z')").run();
    const r = importer([]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /chat_messages: surprise/);
    const d = new Database(chatDb, { readonly: true });
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE id = 108').get().n, 0);
    d.close();
});

t.run(() => { try { live.close(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
