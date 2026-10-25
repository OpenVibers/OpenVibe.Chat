-- phase: expand
-- Vibe answers a person through another OpenVibe service (capability chat.vibe.ask, server/chat/internal-vibe.js):
-- OpenVibe.Bot's Vibe by voice. Each source (a machine) has the person's own Vibe chat, "Voice on <machine>", marked by
-- rooms.assistant_source (kind:id); deleting the chat removes the mark with it, and the next question starts a new one.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS assistant_source text COLLATE "C";
CREATE UNIQUE INDEX IF NOT EXISTS rooms_assistant_source ON rooms (owner_id, assistant_source) WHERE assistant_source IS NOT NULL;
-- One answer per caller's idempotency key (a retried voice_ask gets the first answer, once), kept 7 days.
CREATE TABLE IF NOT EXISTS vibe_asks (
    idempotency_key text COLLATE "C" PRIMARY KEY,
    caller text COLLATE "C" NOT NULL,
    user_id bigint NOT NULL,
    room_id bigint,
    state text COLLATE "C" NOT NULL CHECK (state IN ('answered', 'refused')),
    answer text NOT NULL DEFAULT '',
    code text COLLATE "C",
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS vibe_asks_by_user ON vibe_asks (user_id);
CREATE INDEX IF NOT EXISTS vibe_asks_created ON vibe_asks (created_at);
