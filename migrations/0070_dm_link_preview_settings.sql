-- phase: expand
-- Link previews in direct messages (server/chat/dm-preview-settings.js, server/chat/dm.js): a person's switch,
-- on by default. A DM address is fetched (and its stored previews shown) only when everyone in the conversation
-- has it on; put off, the message gains no preview and an earlier one is hidden on every read.
--
-- Expand only: one new table. No row means on, so older releases and every existing query keep working.
CREATE TABLE IF NOT EXISTS dm_link_preview_settings (
    user_id    bigint PRIMARY KEY,                   -- the Chat user id (dm_participants.user_id)
    enabled    boolean NOT NULL DEFAULT true,
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
