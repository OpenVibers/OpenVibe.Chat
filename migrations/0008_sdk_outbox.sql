-- phase: expand
--
-- SDK outbox rows use a JSONB envelope and millisecond timestamps. Keep events_outbox through the
-- N-1 window; a later contract migration drops it after rollback no longer needs the old relay.
CREATE TABLE IF NOT EXISTS service_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS service_outbox_due ON service_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS service_outbox_sent ON service_outbox (sent_at) WHERE sent_at IS NOT NULL;

-- The old writer stores ISO 8601 UTC. Accept ov_now()'s UTC SQLite format as well.
INSERT INTO service_outbox (event_id, envelope, created_at, attempts)
SELECT event_id, event::jsonb,
       COALESCE((EXTRACT(EPOCH FROM ov_ts(created_at) AT TIME ZONE 'UTC') * 1000)::bigint, 0),
       attempts
FROM events_outbox WHERE sent_at IS NULL
ON CONFLICT (event_id) DO NOTHING;
