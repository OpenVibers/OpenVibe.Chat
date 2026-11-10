-- phase: expand
-- Listening together in a party room (openvibe.party): any media or shared-computer party can play OpenVibe Radio
-- beside what it watches. The room's remote holder starts a licensed track or the Radio station; the state carries
-- the track, who started it, and the point its timeline was measured from, so a late joiner is at the right second.
--
--   music_state    the current track (as OpenVibe Radio publishes it), the station flag, the queue of licensed track
--                  ids the station will play next, the starter, and position_ms at at_ms (or paused at position_ms)
--   music_version  a compare-and-set counter: two changes cannot overwrite each other, and the room hears one seq
--
-- A party that does not play music (agent-stream, radio, a desktop before anyone starts the Radio) leaves music_state
-- NULL. Expand only: two nullable/defaulted columns; an older release ignores them and its INSERT still fits.
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS music_state jsonb;
ALTER TABLE room_parties ADD COLUMN IF NOT EXISTS music_version integer NOT NULL DEFAULT 0;
