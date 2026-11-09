-- phase: expand
-- Explicit model answers belong to the person's existing Vibe room and question.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS vibe_model text COLLATE "C";
CREATE TABLE IF NOT EXISTS vibe_model_turns (
    message_id bigint NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
    room_id bigint NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    model text COLLATE "C" NOT NULL,
    position smallint NOT NULL DEFAULT 0,
    status text COLLATE "C" NOT NULL DEFAULT 'writing',
    text text COLLATE "C",
    provider text COLLATE "C",
    cost_usd numeric,
    ms integer,
    run_id text COLLATE "C",
    error text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (message_id, model),
    CONSTRAINT vibe_model_turn_status CHECK (status IN ('writing', 'finished', 'failed'))
);
CREATE INDEX IF NOT EXISTS vibe_model_turns_room ON vibe_model_turns(room_id, message_id);

CREATE TABLE IF NOT EXISTS vibe_chat_settings (
    room_id bigint PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    models jsonb NOT NULL DEFAULT '[]'::jsonb,
    system_prompt text COLLATE "C",
    temperature numeric,
    exchange_id text COLLATE "C" UNIQUE,
    CONSTRAINT vibe_chat_models_array CHECK (jsonb_typeof(models) = 'array'),
    CONSTRAINT vibe_chat_temperature CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2))
);

CREATE TABLE IF NOT EXISTS vibe_model_preferences (
    message_id bigint NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
    user_id bigint NOT NULL,
    winner text COLLATE "C" NOT NULL,
    bench_round_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS vibe_import_notices (
    user_id bigint PRIMARY KEY,
    dismissed_at text COLLATE "C",
    imported_at text COLLATE "C"
);
