-- phase: expand
-- Agent Streams S7 (design 2026-11-06, AGENT-STREAMS-S7-REACH-DESIGN): watch parties on a public agent stream or its
-- VOD.
--
-- A party is a Chat room of kind 'party' (the room row keeps its name, members and messages) plus this row: the
-- stream it watches, the host whose position a VOD follows, and whether the stream's page may count it. A live party
-- follows the live edge and has no position. The room is private by default: its link carries a secret (only its
-- sha256 is stored), so joining is by that link and a stranger without it sees the same 404 as a missing room.
-- `listed` only lets the stream's page say "3 parties watching": the count query never reads a member or a name.
--
-- Expand only: 'party' joins the existing room kinds, every table is new, and an older release ignores all of it.
DO $$ BEGIN
    ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_kind_allowed;
    ALTER TABLE rooms ADD CONSTRAINT rooms_kind_allowed CHECK (kind IN ('community', 'call', 'system', 'agent_stream', 'party'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS room_parties (
    room_id          bigint PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    agent_stream_id  text COLLATE "C" NOT NULL,
    vod_id           bigint,
    host_user_id     bigint NOT NULL,
    host_subject     text COLLATE "C" NOT NULL,
    mode             text COLLATE "C" NOT NULL CHECK (mode IN ('live', 'vod')),
    position_s       integer NOT NULL DEFAULT 0 CHECK (position_s >= 0),
    playing          boolean NOT NULL DEFAULT false,
    position_at      timestamptz NOT NULL DEFAULT now(),
    listed           boolean NOT NULL DEFAULT false,
    join_secret_hash text COLLATE "C" NOT NULL,
    ended_at         timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_parties_stream ON room_parties (agent_stream_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS room_parties_host ON room_parties (host_user_id);
