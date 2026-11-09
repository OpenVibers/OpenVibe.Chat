-- phase: expand
-- A person's saved presentation choice for each DM conversation.
CREATE TABLE IF NOT EXISTS dm_view_preferences (
    user_id bigint NOT NULL,
    conversation_id bigint NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    view text COLLATE "C" NOT NULL CHECK (view IN ('bubbles', 'room')),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (user_id, conversation_id)
);
