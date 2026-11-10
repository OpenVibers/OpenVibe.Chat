-- phase: expand
-- A room's AI insight (GET /api/v1/rooms/:id/insight): the same summary row Global already keeps, now
-- with the window's people count and its topics (label + how many messages mentioned it) so one public
-- read answers the shape every room will use. The timeline gets a kind and an optional source message,
-- so a reader can tell a notable moment from a running topic. Both columns are nullable/defaulted:
-- older rows keep working, the job fills them from its next window.
ALTER TABLE chat_ai_summaries ADD COLUMN IF NOT EXISTS people bigint DEFAULT 0;
ALTER TABLE chat_ai_summaries ADD COLUMN IF NOT EXISTS topics_json text COLLATE "C" DEFAULT '[]';
ALTER TABLE chat_timeline_events ADD COLUMN IF NOT EXISTS kind text COLLATE "C" DEFAULT 'moment';
ALTER TABLE chat_timeline_events ADD COLUMN IF NOT EXISTS message_id bigint;
