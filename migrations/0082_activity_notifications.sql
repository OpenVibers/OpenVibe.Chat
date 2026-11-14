-- phase: expand
-- What Chat's activity told the Network (server/chat/activity-notify.js): one row per activity that was pushed as
-- an OpenVibe notification, so the same row is never pushed twice. The key is the activity row's own id
-- (chat.activity.<id>): a retry of the push, or the page reading the activity again, finds the row and sends
-- nothing. status is 'sent' (the Network made a notification), 'skipped' (the person switched Chat notifications
-- off, so the Network made none) or 'failed' (the Network could not be reached; the row may be pushed again).
CREATE TABLE IF NOT EXISTS chat_activity_notifications (
    activity_id  bigint PRIMARY KEY REFERENCES chat_activity(id) ON DELETE CASCADE,
    user_id      bigint NOT NULL,                            -- the person it was pushed to
    kind         text COLLATE "C" NOT NULL,                  -- mention, reply, reaction, role, ...
    dedupe_key   text COLLATE "C" NOT NULL,                  -- chat.activity.<activity_id>
    type         text COLLATE "C" NOT NULL,                  -- the Network's notification type (chat.<kind>)
    url          text COLLATE "C",                           -- where the notification leads (openvibe.chat)
    status       text COLLATE "C" NOT NULL DEFAULT 'sent',
    created_at   text COLLATE "C" NOT NULL DEFAULT ov_now(),
    CHECK (status IN ('sent', 'skipped', 'failed'))
);
-- The rows that were pushed, for the person and the newest first.
CREATE INDEX IF NOT EXISTS idx_chat_activity_notifications_user ON chat_activity_notifications (user_id, activity_id DESC);
