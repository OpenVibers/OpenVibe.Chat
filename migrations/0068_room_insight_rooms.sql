-- phase: expand
-- A room's AI insight setting (plan 2026-11-10, part 2; GET /api/v1/rooms/:id/insight). NULL keeps the
-- default: a public room is summarised, a private room stays off until its owner turns it on. A DM and a
-- chat with Vibe are never summarised. Only the room's owner (or chat staff) changes it, through the room
-- settings page or PATCH /api/chat/rooms/:slug.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ai_insight integer;
