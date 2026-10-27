-- phase: expand
-- Vibe thinks with the person's own AI key or computer when they choose it (Settings, "Your AI key", and
-- PUT /api/chat/vibe/engine; server/rooms/vibe.js): the member of every Vibe chat of theirs, new ones too, then runs on
-- their credential (engine own) instead of OpenVibe's model. Removing the key ends it. It goes with the account
-- export and deletion.
CREATE TABLE IF NOT EXISTS vibe_own_engine (
    user_id bigint PRIMARY KEY,
    since text COLLATE "C" NOT NULL DEFAULT ov_now()
);
