-- phase: expand
-- An unlisted agent room follows the stream's link secret. Public room lists and
-- the ordinary room API must not expose it; the agent embed checks this hash.
ALTER TABLE agent_room_identities ADD COLUMN IF NOT EXISTS link_secret_hash text;
UPDATE rooms SET slug = lower(slug) WHERE kind = 'agent_stream' AND slug <> lower(slug);
