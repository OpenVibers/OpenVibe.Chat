-- phase: expand
-- Incoming hooks for workspace rooms (server/rooms/hooks.js; owner 2026-10-25: the shared room "integrated with Watch,
-- Run and the rest"). A room's owner makes a hook: an address and a secret, shown once. A signed POST to it (signed like
-- an OpenVibe.Events delivery, as a Watch webhook action signs one) becomes a message from the room's Vibe, and, when
-- the hook says so, a task in the room's queue for the person who made the hook.
CREATE TABLE IF NOT EXISTS room_hooks (
    id               text COLLATE "C" PRIMARY KEY,         -- rh_<random>: the last part of the hook's address
    room_id          bigint NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    label            text NOT NULL,                         -- what the room sees before each message (<= 60)
    secret           text NOT NULL,                         -- whsec_…: checks X-OpenVibe-Signature-V2 (shown once)
    queue_kind       text COLLATE "C"                       -- NULL: a message only; else the kind of task each one queues
                     CHECK (queue_kind IS NULL OR queue_kind IN ('answer', 'research', 'web', 'code', 'computer', 'other')),
    created_by       bigint NOT NULL,                       -- Chat user id: queued tasks are theirs
    deliveries       integer NOT NULL DEFAULT 0,
    last_at          text COLLATE "C",
    created_at       text COLLATE "C" DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS room_hooks_room_idx ON room_hooks (room_id);
CREATE INDEX IF NOT EXISTS room_hooks_creator_idx ON room_hooks (created_by);
