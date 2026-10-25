-- phase: expand
-- Verified visitors for support inboxes (docs/platform.md step 5): a site that knows who its signed-in visitor is passes
-- their id with an HMAC of it made with the inbox's identity secret; Chat then trusts the name and email that come with
-- it, and the visitor's conversation follows them to every device (server/inbox/inbox.js verifiedIdentity).
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS identity_secret text;             -- null: verification off
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS external_id text;     -- the site's id for the visitor, verified
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS visitor_email text;
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS verified smallint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS inbox_conversations_external ON inbox_conversations (inbox_id, external_id) WHERE external_id IS NOT NULL;
