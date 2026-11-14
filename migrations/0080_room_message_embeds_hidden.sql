-- phase: expand
-- Taking a message's cards back whole (server/chat/link-previews.js, server/rooms/routes.js):
--
--   room_messages.embeds_hidden   the author (or the room's owner or a moderator) took the previews of this
--                                  message back. The cards are not sent on a read while the flag is set, and the
--                                  flag can be cleared, so the cards can come back.
--
-- Expand only: one defaulted column; older releases never name it and keep showing the cards.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS embeds_hidden boolean NOT NULL DEFAULT false;
