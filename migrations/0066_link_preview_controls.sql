-- phase: expand
-- Who may take a preview back, and the room setting that turns previews off (server/chat/link-previews.js,
-- server/rooms/routes.js, server/rooms/rooms.js):
--
--   link_previews.removed_at / removed_by   a preview the author (or a room moderator) removed. The row stays as a
--                                           tombstone, so a job that was still running cannot put the preview back.
--   rooms.link_previews                     the room's switch, on by default. Off: no new address in the room is
--                                           fetched, and the reads show no previews.
--
-- Expand only: two nullable columns and one defaulted column; older releases never name them.
ALTER TABLE link_previews ADD COLUMN IF NOT EXISTS removed_at text COLLATE "C";
ALTER TABLE link_previews ADD COLUMN IF NOT EXISTS removed_by bigint;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS link_previews boolean NOT NULL DEFAULT true;
