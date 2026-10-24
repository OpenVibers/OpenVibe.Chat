-- phase: expand
-- Vibe, OpenVibe's assistant (plan track K, 2026-10-24): a person's own conversations with Vibe are private rooms (kind
-- community) whose one AI member, Vibe, answers every message without being named (server/rooms/vibe.js). assistant = 1
-- marks them: they are listed under Vibe rather than with the person's rooms, never count against the rooms a person may
-- own, and Vibe's answers in them count against the person's daily allowance rather than the room's.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS assistant smallint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS rooms_assistant_by_owner ON rooms (owner_id, last_message_at DESC) WHERE assistant = 1;
-- Vibe's answers to a person per UTC day, across all their chats (deleting a chat does not give answers back).
CREATE TABLE IF NOT EXISTS vibe_usage (
    user_id bigint NOT NULL,
    day text COLLATE "C" NOT NULL,
    replies integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
