-- phase: expand
ALTER TABLE chat_server_members ADD COLUMN IF NOT EXISTS nickname text COLLATE "C";
CREATE TABLE IF NOT EXISTS chat_server_timeouts (
    server_id bigint NOT NULL REFERENCES chat_servers(id) ON DELETE CASCADE,
    user_id bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    actor_user_id bigint NOT NULL,
    PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_command_polls (
    id bigserial PRIMARY KEY,
    room_id bigint NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_user_id bigint NOT NULL,
    question text COLLATE "C" NOT NULL,
    options jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    closes_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
);
CREATE TABLE IF NOT EXISTS chat_command_poll_votes (
    poll_id bigint NOT NULL REFERENCES chat_command_polls(id) ON DELETE CASCADE,
    user_id bigint NOT NULL,
    option_index integer NOT NULL,
    PRIMARY KEY (poll_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_command_reminders (
    id bigserial PRIMARY KEY,
    room_id bigint NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id bigint NOT NULL,
    due_at timestamptz NOT NULL,
    text text COLLATE "C" NOT NULL,
    delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_chat_command_reminders_due ON chat_command_reminders(due_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS chat_registered_commands (
    id bigserial PRIMARY KEY,
    server_id bigint NOT NULL REFERENCES chat_servers(id) ON DELETE CASCADE,
    application_id text COLLATE "C" NOT NULL,
    source text COLLATE "C" NOT NULL CHECK (source IN ('app', 'actor')),
    name text COLLATE "C" NOT NULL,
    description text COLLATE "C" NOT NULL,
    options jsonb NOT NULL DEFAULT '[]'::jsonb,
    response_template text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (server_id, name)
);
