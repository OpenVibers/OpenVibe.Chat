-- phase: expand
ALTER TABLE emotes ADD COLUMN server_id bigint;
DROP INDEX idx_emotes_channel_code;
CREATE UNIQUE INDEX idx_emotes_channel_code ON emotes(COALESCE(channel_owner_id, user_id), code) WHERE server_id IS NULL;
CREATE INDEX idx_emotes_server ON emotes(server_id);
CREATE UNIQUE INDEX idx_emotes_server_code ON emotes(server_id, lower(code)) WHERE server_id IS NOT NULL;
