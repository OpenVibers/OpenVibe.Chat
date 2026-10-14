-- phase: contract
-- after: 0006
--
-- The Live read mirror is retired (2026-10-05). 0006 dropped the twelve capture triggers that fed
-- live_mirror_outbox and deferred the table itself; since then nothing reads or writes it
-- (test/no-live-mirror.test.js keeps it that way). This drops the idle table. It waits for 0006's N-1
-- window, so a rollback to the release before 0006 still finds the table.
DROP TABLE IF EXISTS live_mirror_outbox;
