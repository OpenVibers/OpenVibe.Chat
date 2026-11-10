-- phase: expand
-- OpenVibe's own computers for openvibe.party (message 11: a party's desktop runs on a Link machine or on
-- OpenVibe's compute). A party with no machine of its own asks this pool. The owner (rank owner) registers a
-- Link machine and what it can run; placement holds it for one room and releases it when the room ends or the
-- hold goes idle. Pool machines are the owner's own: nothing here rents capacity or spends money.
--
--   party_pool_machines  what one Link machine offers: its node principal (lnk_…, the identity in its node
--                        token), a display name, what it can run, and how many desktops it may host at once
--   party_pool_holds     one room's reservation: queued (no free desktop), held (a machine is reserved),
--                        hosting (Link claimed it), ready (its Connect share is up) or released. The partial
--                        unique index keeps one open hold per room; released rows stay as the record.
--   party_pool_settings  the owner's switch, one row, off by default. CHAT_PARTY_POOL=1 is the operator override.
--
-- Expand only: new tables, and an older release ignores all of it.
CREATE TABLE IF NOT EXISTS party_pool_settings (
    id         smallint PRIMARY KEY CHECK (id = 1),
    enabled    boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text COLLATE "C"
);
INSERT INTO party_pool_settings (id, enabled) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS party_pool_machines (
    principal_id text COLLATE "C" PRIMARY KEY,
    owner_subject text COLLATE "C" NOT NULL,
    name         text COLLATE "C" NOT NULL,
    can_run      jsonb NOT NULL DEFAULT '["desktop"]'::jsonb,
    desktops     integer NOT NULL DEFAULT 1 CHECK (desktops BETWEEN 1 AND 50),
    enabled      boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (principal_id ~ '^lnk_[0-9A-HJKMNP-TV-Z]{26}$')
);

CREATE TABLE IF NOT EXISTS party_pool_holds (
    id             text COLLATE "C" PRIMARY KEY,
    slug           text COLLATE "C" NOT NULL,
    room_id        bigint REFERENCES rooms(id) ON DELETE CASCADE,
    actor_subject  text COLLATE "C" NOT NULL,
    principal_id   text COLLATE "C",
    state          text COLLATE "C" NOT NULL DEFAULT 'queued',
    held_at        timestamptz,
    renewed_at     timestamptz NOT NULL DEFAULT now(),
    released_at    timestamptz,
    release_reason text COLLATE "C",
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (state IN ('queued', 'held', 'hosting', 'ready', 'released'))
);
CREATE UNIQUE INDEX IF NOT EXISTS party_pool_holds_open_room ON party_pool_holds (room_id) WHERE state <> 'released' AND room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS party_pool_holds_open ON party_pool_holds (state, created_at) WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS party_pool_holds_machine ON party_pool_holds (principal_id, state) WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS party_pool_holds_actor ON party_pool_holds (actor_subject, state) WHERE state <> 'released';
