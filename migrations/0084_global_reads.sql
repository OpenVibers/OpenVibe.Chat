-- phase: expand
-- Where each person stopped reading Global (the owner, 11-17: "remember where you were in the chat last and … save it
-- locally and on the server … new messages … wherever you last read"): the last Global message they read. It only
-- moves forward, so every site's menu and every device opens Global at the same "New messages" line, and the count
-- on the Global segment is what came after it. server/chat/routes.js (GET and POST /api/chat/global/read).
CREATE TABLE IF NOT EXISTS global_reads (
    user_id      bigint PRIMARY KEY,
    last_read_id bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
