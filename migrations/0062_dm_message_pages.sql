-- phase: expand
-- A DM's newest and before-ID pages follow one conversation's monotonic message IDs.
CREATE INDEX IF NOT EXISTS idx_dm_messages_page ON dm_messages (conversation_id, id DESC);
