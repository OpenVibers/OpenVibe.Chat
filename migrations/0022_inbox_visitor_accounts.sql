-- phase: expand
-- A visitor who signs in to OpenVibe in a site's chat panel (docs/platform.md, "the visitor finally has an inbox too"):
-- their conversations with every site's inbox are theirs, listed in their own openvibe.chat Messages, and follow them
-- to any device (server/inbox/inbox.js accountToken).
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS visitor_user_id bigint;
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS visitor_subject text COLLATE "C";
CREATE INDEX IF NOT EXISTS inbox_conversations_visitor_user ON inbox_conversations (visitor_user_id, last_message_at DESC) WHERE visitor_user_id IS NOT NULL;
