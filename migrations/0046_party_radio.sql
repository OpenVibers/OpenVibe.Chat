-- phase: expand
-- Radio parties share the media clock and hold an approved Radio track plus a durable queue.
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS radio_track jsonb;
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS radio_queue jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS radio_allow_all boolean NOT NULL DEFAULT false;
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS radio_version integer NOT NULL DEFAULT 0;
ALTER TABLE room_parties DROP CONSTRAINT IF EXISTS room_parties_kind_allowed;
ALTER TABLE room_parties ADD CONSTRAINT room_parties_kind_allowed CHECK (party_kind IN ('agent_stream', 'media', 'radio'));
ALTER TABLE room_parties DROP CONSTRAINT IF EXISTS room_parties_kind_source;
ALTER TABLE room_parties ADD CONSTRAINT room_parties_kind_source CHECK (
    (party_kind = 'agent_stream' AND agent_stream_id IS NOT NULL AND media IS NULL)
    OR (party_kind IN ('media', 'radio') AND agent_stream_id IS NULL AND media IS NOT NULL)
);
