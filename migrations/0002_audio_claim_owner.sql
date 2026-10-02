-- phase: expand
-- The audio queue's claims are owned and one per room (server/chat/audio-queue.js):
--   claimed_by   the Chat process (its instance id) that claimed the row and plays it;
--   lease_until  ms; that process renews it while the row is playing. A playing row whose lease has passed
--                belongs to a process that died: recover() and the sweeper settle it, never a live owner's.
-- At most one playing row per room, across processes: the partial unique index is the store's guarantee
-- (claim() also takes a per-room advisory lock, so a losing claimer just gets nothing).
-- Safe on the live table and idempotent: nullable columns, no rewrite. The index is built in this transaction
-- under a short SHARE ROW EXCLUSIVE lock (the table holds about a week of requests), so the duplicates it
-- would refuse can be settled first and no claim of a previous-release process slips in between; CREATE INDEX
-- CONCURRENTLY could not run next to that clean-up, and a failed concurrent build leaves an invalid index that
-- IF NOT EXISTS would then keep.
ALTER TABLE audio_requests ADD COLUMN IF NOT EXISTS claimed_by text COLLATE "C";
ALTER TABLE audio_requests ADD COLUMN IF NOT EXISTS lease_until bigint;

LOCK TABLE audio_requests IN SHARE ROW EXCLUSIVE MODE;
-- Two clips playing at once in one room (the race this closes): keep the oldest, the others reached the room too.
UPDATE audio_requests a SET state = 'played', error = 'delivered before a restart',
       finished_at = COALESCE(a.finished_at, a.started_at, a.created_at)
 WHERE a.state = 'playing'
   AND EXISTS (SELECT 1 FROM audio_requests b WHERE b.room = a.room AND b.state = 'playing' AND b.id < a.id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_requests_one_playing ON audio_requests(room) WHERE state = 'playing';
