-- phase: expand
-- The app shell (the plan, 2026-11-09, stage V2): a channel's category in the side column, and the people you
-- talk to (Friends and Requests on Home).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS category text COLLATE "C";

CREATE TABLE IF NOT EXISTS dm_contacts (
    user_id bigint NOT NULL,
    contact_id bigint NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'friend' CHECK (status IN ('friend', 'outgoing', 'incoming')),
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (user_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_contacts_user ON dm_contacts(user_id);
