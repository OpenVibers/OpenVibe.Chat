-- phase: expand
-- Preserve prior text for moderators and mark the current revision on every message store.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS edited_at text COLLATE "C";
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS edit_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS edited_at text COLLATE "C";
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS edit_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at text COLLATE "C";
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edit_history jsonb NOT NULL DEFAULT '[]'::jsonb;
