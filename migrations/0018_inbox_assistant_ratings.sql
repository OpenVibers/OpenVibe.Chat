-- phase: expand
-- Support inboxes, two more things (docs/platform.md step 3): an inbox where only Vibe answers (a site assistant, with
-- no "Talk to a person"), and the visitor's rating of a resolved conversation (good or bad, and a line).
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS handoff smallint NOT NULL DEFAULT 1;     -- 0: only Vibe answers
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS rating smallint CHECK (rating IN (-1, 1));
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS rating_comment text;
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS rated_at text COLLATE "C";
