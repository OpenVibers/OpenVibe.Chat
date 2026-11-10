-- phase: expand
-- A Chat forum channel is a view of a Community forum space; Community remains the thread store.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS forum_space text COLLATE "C";
CREATE INDEX IF NOT EXISTS idx_rooms_forum_space ON rooms (forum_space) WHERE forum_space IS NOT NULL AND archived_at IS NULL;
