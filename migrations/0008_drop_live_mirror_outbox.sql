-- phase: contract
-- after: 0006
--
-- The Live read mirror is retired (2026-10-05, Live #31): 0006_stop_live_mirror_triggers.sql dropped the twelve
-- capture triggers, and nothing has written or read live_mirror_outbox since. Its last rows (frozen before
-- 2026-10-07) never had a drain: they only ever fed Live's mirror, which no longer exists.
DROP TABLE IF EXISTS live_mirror_outbox;
