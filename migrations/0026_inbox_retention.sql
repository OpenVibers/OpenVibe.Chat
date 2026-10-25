-- phase: expand
-- How long an inbox keeps finished conversations (server/inbox/records.js): null keeps them; otherwise a resolved
-- conversation, or one only Vibe answered, quiet for longer than this many days goes with its messages.
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 7 AND 3650);
