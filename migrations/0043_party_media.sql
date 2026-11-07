-- phase: expand
-- Party watch v1 (plan R1, 2026-11-07): a party may watch OpenVibe media instead of an agent stream.
--
-- Until now a party watched a public agent stream (or its VOD) and the party row carried the stream and the host's
-- position. A media party watches a Media ref or an https URL on an OpenVibe host instead: the room's shared clock
-- (server/rooms/sync-clock.js, migrations/0042_room_shared_state.sql) holds the timeline and the control lease holds
-- the remote, so the party row keeps only the media, the page it was started from and whose party it is.
--
--   agent_stream_id  nullable now; an agent-stream party still sets it and keeps working as it did
--   party_kind       'agent_stream' (the default, so existing rows need no rewrite) or 'media'
--   media            a Media ref { media_id, role?, variant? } or an https URL on an OpenVibe host, as the clock
--                    validates it; agent-stream parties leave it null
--   source_url       the OpenVibe page the party was started from (same host rule), or null
--
-- Expand only: one nullable column, two new columns with defaults and new constraints; an older release ignores them
-- and its INSERT (which names neither column) still fits, because party_kind defaults to 'agent_stream'.
ALTER TABLE room_parties ALTER COLUMN agent_stream_id DROP NOT NULL;

ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS party_kind text COLLATE "C" NOT NULL DEFAULT 'agent_stream';
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS media jsonb;
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS source_url text COLLATE "C";

DO $$ BEGIN
    ALTER TABLE room_parties ADD CONSTRAINT room_parties_kind_allowed CHECK (party_kind IN ('agent_stream', 'media'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A media party names its media and no stream; an agent-stream party names its stream and no media.
DO $$ BEGIN
    ALTER TABLE room_parties ADD CONSTRAINT room_parties_kind_source CHECK (
        (party_kind = 'agent_stream' AND agent_stream_id IS NOT NULL AND media IS NULL)
        OR (party_kind = 'media' AND agent_stream_id IS NULL AND media IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
