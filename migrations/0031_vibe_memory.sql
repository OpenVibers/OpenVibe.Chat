-- phase: expand
-- Vibe's memory of a person (consumer plan §4, the Vibe app's Memory; server/rooms/vibe-memory.js): short notes Vibe
-- keeps across all their own chats with it, saved when they ask it to remember something or tell it a lasting
-- preference (source vibe), or written by them on /vibe/memory (source you). Only their own Vibe chats read them, never
-- a room Vibe was added to. They see and delete each one; the notes go with the account export and deletion.
CREATE TABLE IF NOT EXISTS vibe_memory (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
    source text COLLATE "C" NOT NULL DEFAULT 'vibe' CHECK (source IN ('vibe', 'you')),
    room_id bigint,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS vibe_memory_by_user ON vibe_memory (user_id, id DESC);
-- A person who switched the memory off: Vibe then neither reads nor saves notes (the notes stay until they delete them).
CREATE TABLE IF NOT EXISTS vibe_memory_off (
    user_id bigint PRIMARY KEY,
    since text COLLATE "C" NOT NULL DEFAULT ov_now()
);
