-- phase: expand
-- A Vibe conversation remembers the OpenVibe site where it began for the Dock's cross-site list.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS vibe_origin_site text COLLATE "C";
