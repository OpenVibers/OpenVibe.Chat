-- phase: expand
CREATE TABLE person_chat_memory (
    user_id bigint NOT NULL,
    channel_user_id bigint NOT NULL DEFAULT 0,
    level text NOT NULL CHECK (level IN ('day', 'week', 'month')),
    period_start text NOT NULL,
    summary text NOT NULL DEFAULT '',
    topics jsonb NOT NULL DEFAULT '[]'::jsonb,
    highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
    tone text NOT NULL DEFAULT '',
    catchphrases jsonb NOT NULL DEFAULT '[]'::jsonb,
    people jsonb NOT NULL DEFAULT '[]'::jsonb,
    message_count bigint NOT NULL DEFAULT 0,
    last_message_id bigint NOT NULL DEFAULT 0,
    updated_at text NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (user_id, channel_user_id, level, period_start)
);
CREATE INDEX person_chat_memory_channel ON person_chat_memory (channel_user_id, level, period_start DESC);
CREATE TABLE person_chat_memory_settings (
    user_id bigint PRIMARY KEY,
    opted_out bigint NOT NULL DEFAULT 0,
    resume_after_id bigint NOT NULL DEFAULT 0,
    updated_at text NOT NULL DEFAULT ov_now()
);
CREATE TABLE person_chat_memory_spend (
    day text PRIMARY KEY,
    spent_usd numeric(12,6) NOT NULL DEFAULT 0,
    calls bigint NOT NULL DEFAULT 0
);
