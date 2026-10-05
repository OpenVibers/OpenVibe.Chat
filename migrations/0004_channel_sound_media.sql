-- phase: expand
-- Where Live's asset sync put each channel sound on OpenVibe.Media (plan T3 J4b, N5): Live reads the
-- sounds still to upload (GET /internal/chat/sounds?pending_asset=1) and writes the asset back
-- (POST /internal/chat/sounds/asset), instead of using its mirrored copy of channel_sounds.
-- Both stay NULL until the sound is uploaded.
ALTER TABLE channel_sounds ADD COLUMN IF NOT EXISTS media_url text COLLATE "C";
ALTER TABLE channel_sounds ADD COLUMN IF NOT EXISTS media_asset_id bigint;
CREATE INDEX IF NOT EXISTS idx_channel_sounds_pending_asset ON channel_sounds(id) WHERE media_asset_id IS NULL;
