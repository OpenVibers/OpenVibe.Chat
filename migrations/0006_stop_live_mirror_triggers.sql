-- phase: expand
--
-- The Live read mirror is retired (2026-10-05): Live #31 reads every chat table through Chat's internal reads
-- (docs/chat-ingress.md) and this release deletes the sender (server/bridge/live-mirror.js). The capture
-- triggers 0001_initial.sql put on twelve tables would otherwise keep queueing a row in live_mirror_outbox for
-- every chat write with nothing left to drain it. Dropping them is safe for the previous release too: its sender
-- only ever fed Live's mirror, which nothing reads any more. The (now idle) live_mirror_outbox table itself
-- is dropped by a later contract migration.
DROP TRIGGER IF EXISTS mirror_chat_messages ON chat_messages;
DROP TRIGGER IF EXISTS mirror_dm_conversations ON dm_conversations;
DROP TRIGGER IF EXISTS mirror_dm_participants ON dm_participants;
DROP TRIGGER IF EXISTS mirror_dm_messages ON dm_messages;
DROP TRIGGER IF EXISTS mirror_dm_blocks ON dm_blocks;
DROP TRIGGER IF EXISTS mirror_tts_voice_overrides ON tts_voice_overrides;
DROP TRIGGER IF EXISTS mirror_channel_sounds ON channel_sounds;
DROP TRIGGER IF EXISTS mirror_relay_users ON relay_users;
DROP TRIGGER IF EXISTS mirror_hidden_relay_users ON hidden_relay_users;
DROP TRIGGER IF EXISTS mirror_pending_ip_messages ON pending_ip_messages;
DROP TRIGGER IF EXISTS mirror_stream_first_chats ON stream_first_chats;
DROP TRIGGER IF EXISTS mirror_moderation_actions ON moderation_actions;

DROP FUNCTION IF EXISTS mirror_chat_messages();
DROP FUNCTION IF EXISTS mirror_dm_conversations();
DROP FUNCTION IF EXISTS mirror_dm_participants();
DROP FUNCTION IF EXISTS mirror_dm_messages();
DROP FUNCTION IF EXISTS mirror_dm_blocks();
DROP FUNCTION IF EXISTS mirror_tts_voice_overrides();
DROP FUNCTION IF EXISTS mirror_channel_sounds();
DROP FUNCTION IF EXISTS mirror_relay_users();
DROP FUNCTION IF EXISTS mirror_hidden_relay_users();
DROP FUNCTION IF EXISTS mirror_pending_ip_messages();
DROP FUNCTION IF EXISTS mirror_stream_first_chats();
DROP FUNCTION IF EXISTS mirror_moderation_actions();
