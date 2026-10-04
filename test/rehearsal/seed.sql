-- PostgreSQL seed for `ov rehearse` (declared in docs/cutover.md's rehearse block); test/fixtures/*.sql are SQLite fixtures for the import tests, not seeds.
--
-- Loaded on a fresh scratch database *after* main's migrations (migrations/0001_initial.sql,
-- 0002_audio_claim_owner.sql) and *before* this branch's migrations (0003_chat_ingress.sql), so it
-- may only name columns those two create and must not touch chat_ingress_applied (0003's table).
-- Plain PostgreSQL INSERTs, no SQLite syntax. The database is empty, so identity columns are left
-- to their defaults and the first dm_conversations row is id 1, which the child rows reference.

-- A stream's chat: two regular lines and a system notice.
INSERT INTO chat_messages (stream_id, user_id, anon_id, username, message, message_type, source_platform, timestamp, channel_user_id, subject_id) VALUES
    (9001, 42,   NULL,    'alice', 'first!',                 'chat',   'openvibe', '2026-10-01 12:00:00', 42, 'usr_alice'),
    (9001, NULL, 'anon1', 'guest', 'hi from a guest',        'chat',   'openvibe', '2026-10-01 12:00:05', 42, NULL),
    (9001, NULL, NULL,    NULL,    'guest joined the chat',  'system', 'openvibe', '2026-10-01 12:00:06', 42, NULL);

-- One direct conversation between alice and bob (id 1), with its participants and two lines.
INSERT INTO dm_conversations (name, is_group, created_by, created_at, updated_at) VALUES
    (NULL, 0, 42, '2026-10-01 12:01:00', '2026-10-01 12:01:45');

INSERT INTO dm_participants (conversation_id, user_id, last_read_at, joined_at, subject_id) VALUES
    (1, 42, '1970-01-01 00:00:00', '2026-10-01 12:01:00', 'usr_alice'),
    (1, 43, '1970-01-01 00:00:00', '2026-10-01 12:01:00', 'usr_bob');

INSERT INTO dm_messages (conversation_id, sender_id, message, created_at, sender_subject_id) VALUES
    (1, 42, 'hey bob',   '2026-10-01 12:01:30', 'usr_alice'),
    (1, 43, 'hey alice', '2026-10-01 12:01:45', 'usr_bob');

-- A bridge delivery already applied once (its idempotency key would return this result on a retry).
INSERT INTO bridge_applied (key, result, applied_at) VALUES
    ('rehearsal:seed:1', '{"ok":true}', 1788220800000);
