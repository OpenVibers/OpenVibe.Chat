-- phase: expand
-- An inbox's business hours (server/inbox/hours.js): { tz, days, start, end }; null is always open.
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS hours jsonb;
