-- phase: expand
-- A shared computer is a private party room with its existing control lease.
-- A Link machine supplies the browser; its Connect share is closed when the party ends.
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS desktop_hosting text COLLATE "C";
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS desktop_state text COLLATE "C";
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS desktop_layout text COLLATE "C" DEFAULT 'watch';
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS desktop_node_id text COLLATE "C";
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS desktop_share_id text COLLATE "C";
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS desktop_share_url text COLLATE "C";
ALTER TABLE room_parties DROP CONSTRAINT IF EXISTS room_parties_kind_allowed;
ALTER TABLE room_parties ADD CONSTRAINT room_parties_kind_allowed CHECK (party_kind IN ('agent_stream', 'media', 'radio', 'desktop'));
ALTER TABLE room_parties ADD CONSTRAINT room_parties_desktop_layout CHECK (desktop_layout IN ('watch', 'listen'));
ALTER TABLE room_parties DROP CONSTRAINT IF EXISTS room_parties_kind_source;
ALTER TABLE room_parties ADD CONSTRAINT room_parties_kind_source CHECK (
    (party_kind = 'agent_stream' AND agent_stream_id IS NOT NULL AND media IS NULL)
    OR (party_kind IN ('media', 'radio') AND agent_stream_id IS NULL AND media IS NOT NULL)
    OR (party_kind = 'desktop' AND agent_stream_id IS NULL AND media IS NULL
        AND desktop_hosting IN ('link', 'openvibe') AND desktop_state IN ('waiting', 'ready', 'stopped'))
);
