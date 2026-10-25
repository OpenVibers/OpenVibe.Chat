-- phase: expand
-- A first-party service's results in a person's own Vibe chats (capability chat.vibe.deliver; server/chat/internal-vibe.js):
-- OpenVibe.Actor posts each passed run of one of their agents into the chat named after it (rooms.assistant_source
-- 'agent:<id>', migrations/0033_vibe_asks.sql). One post per caller's idempotency key (the run's task id), kept 30 days.
CREATE TABLE IF NOT EXISTS vibe_deliveries (
    idempotency_key text COLLATE "C" PRIMARY KEY,
    caller text COLLATE "C" NOT NULL,
    user_id bigint NOT NULL,
    room_id bigint NOT NULL,
    message_id bigint,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS vibe_deliveries_by_user ON vibe_deliveries (user_id);
CREATE INDEX IF NOT EXISTS vibe_deliveries_created ON vibe_deliveries (created_at);
