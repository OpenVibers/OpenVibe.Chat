-- phase: expand
-- Who answers a support conversation (server/inbox/routing.js): with turns on, a conversation that starts waiting goes
-- to the person whose turn it is (the one assigned longest ago); a teammate can assign one to anyone in the inbox.
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS route text COLLATE "C" NOT NULL DEFAULT 'none' CHECK (route IN ('none', 'round_robin'));
ALTER TABLE inbox_members ADD COLUMN IF NOT EXISTS last_assigned_at text COLLATE "C";
