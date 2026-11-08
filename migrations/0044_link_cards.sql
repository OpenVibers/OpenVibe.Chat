-- phase: expand
-- A known OpenVibe link in a message shows a card with the one move it is for (plan HO: one account across every
-- site; server/chat/link-cards.js). The card is JSON text, resolved when the message is sent:
--
--   { kind, url, title, line, note?, image, action: { label, href } | null, at }
--
-- Null for every message without a known link, and for every message saved before this release (a read never
-- resolves a missing card: only a stored one older than a day is resolved again). Chat's own messages, room
-- messages, direct messages and support-inbox messages all carry one.
--
-- Expand only: one nullable column per message table; an older release ignores it and its INSERTs (which name the
-- column not at all) still fit.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS card text COLLATE "C";
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS card text COLLATE "C";
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS card text COLLATE "C";
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS card text COLLATE "C";
