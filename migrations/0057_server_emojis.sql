-- phase: expand
ALTER TABLE emotes ADD COLUMN server_id bigint;
CREATE INDEX idx_emotes_server ON emotes(server_id);
CREATE UNIQUE INDEX idx_emotes_server_code ON emotes(server_id, lower(code)) WHERE server_id IS NOT NULL;
