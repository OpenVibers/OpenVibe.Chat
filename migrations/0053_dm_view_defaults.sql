-- phase: expand
-- The default view for each kind of conversation (bubbles or a chat room): the plan, 2026-11-09, stage V1.
CREATE TABLE IF NOT EXISTS dm_view_defaults (
    user_id bigint NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('one_to_one', 'ai', 'group', 'channel')),
    view text COLLATE "C" NOT NULL CHECK (view IN ('bubbles', 'room')),
    PRIMARY KEY (user_id, kind)
);
