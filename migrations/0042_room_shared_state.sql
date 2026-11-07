-- phase: expand
-- Shared party state (seven domains plan B3/B4, 2026-11-07): one control lease and one sync clock per Chat room.
--
-- A room's latest sync clock is kept in memory by server/rooms/sync-clock.js and copied here after every accepted
-- change; a restart reads it back. A room's control lease is kept the same way in server/rooms/control-lease.js.
-- Both tables are expand-only: new tables, no existing column changes, and an older release ignores them.
--
-- The clock's media is JSON text: either a Media ref ({ media_id, role, variant }) or an https URL string.
-- The lease's watchers are JSON text too, but they are live presence (the signed-in subjects connected to the room),
-- not a membership list: they are refreshed on every join and leave and do not increment seq.
CREATE TABLE IF NOT EXISTS room_sync_clocks (
    room_id     bigint PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    media       text COLLATE "C" NOT NULL,
    position_ms bigint NOT NULL CHECK (position_ms >= 0 AND position_ms <= 2592000000),
    rate        double precision NOT NULL DEFAULT 1 CHECK (rate > 0 AND rate <= 16),
    paused      boolean NOT NULL DEFAULT false,
    at_ms       bigint NOT NULL CHECK (at_ms >= 0),
    set_by      text COLLATE "C" NOT NULL,
    seq         bigint NOT NULL DEFAULT 1 CHECK (seq >= 1),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_control_leases (
    room_id        bigint PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    thing          text COLLATE "C" NOT NULL,
    holder_kind    text COLLATE "C" NOT NULL CHECK (holder_kind IN ('person', 'ai', 'nobody')),
    holder_subject text COLLATE "C",
    since_ms       bigint NOT NULL CHECK (since_ms >= 0),
    expires_ms     bigint CHECK (expires_ms IS NULL OR expires_ms >= since_ms),
    watchers       text NOT NULL DEFAULT '[]',
    seq            bigint NOT NULL DEFAULT 1 CHECK (seq >= 1),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT room_control_leases_holder CHECK ((holder_kind = 'nobody') = (holder_subject IS NULL))
);
