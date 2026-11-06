-- phase: expand
-- The chat apps (Telegram, Discord, Slack): your OpenVibe agent in each of them (the agent plan of
-- 2026-10-30, stage A4). Three kinds of rows: the one-time link token a person gets from /link, the
-- rules of a group (what the bot may do there and how fast), and the buttons a person may press.
--
-- The link token holds only the token's hash: the token itself is in the person's link and in the
-- Network's page. It is used once (state 'used') when the person confirms it while signed in.
CREATE TABLE IF NOT EXISTS chat_app_link_tokens (
    token_hash       text COLLATE "C" PRIMARY KEY,
    app              text COLLATE "C" NOT NULL CHECK (app IN ('telegram', 'discord', 'slack')),
    service_user_id  text COLLATE "C" NOT NULL,      -- the person in the app (their id there)
    service_username text COLLATE "C",               -- their name there, for the page that asks
    state            text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'used', 'expired')),
    subject          text COLLATE "C",               -- their usr_… once the link is made
    created_at       text COLLATE "C" NOT NULL DEFAULT ov_now(),
    expires_at       text COLLATE "C" NOT NULL,
    used_at          text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS chat_app_link_tokens_by_person ON chat_app_link_tokens (app, service_user_id, state);
CREATE INDEX IF NOT EXISTS chat_app_link_tokens_expiry ON chat_app_link_tokens (expires_at);

-- What the bot may do in a group or a channel: off, answer only (it answers when it is mentioned and
-- never acts), or act with approvals (it may act, and every risky step waits for the linked person).
-- The rate is how many answers an hour that chat gets.
CREATE TABLE IF NOT EXISTS chat_app_settings (
    app           text COLLATE "C" NOT NULL CHECK (app IN ('telegram', 'discord', 'slack')),
    chat_id       text COLLATE "C" NOT NULL,
    mode          text COLLATE "C" NOT NULL DEFAULT 'answer_only' CHECK (mode IN ('off', 'answer_only', 'act_with_approvals')),
    rate_per_hour integer NOT NULL DEFAULT 20 CHECK (rate_per_hour > 0),
    updated_at    text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (app, chat_id)
);

-- A button ("Needs you" from the agent). It is used once (state 'used'), it expires, and only the
-- person the button was made for may press it.
CREATE TABLE IF NOT EXISTS chat_app_callbacks (
    id           text COLLATE "C" PRIMARY KEY,
    app          text COLLATE "C" NOT NULL CHECK (app IN ('telegram', 'discord', 'slack')),
    chat_id      text COLLATE "C" NOT NULL,
    user_id      text COLLATE "C" NOT NULL,          -- the linked person the button belongs to
    subject      text COLLATE "C",                   -- their usr_…
    action       text COLLATE "C" NOT NULL CHECK (action IN ('approve', 'decline')),
    approval_id  text COLLATE "C",                   -- the approval in OpenVibe.Actor
    state        text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'used')),
    created_at   text COLLATE "C" NOT NULL DEFAULT ov_now(),
    expires_at   text COLLATE "C" NOT NULL,
    used_at      text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS chat_app_callbacks_by_chat ON chat_app_callbacks (app, chat_id, state);
CREATE INDEX IF NOT EXISTS chat_app_callbacks_expiry ON chat_app_callbacks (expires_at);

CREATE TABLE chat_app_deliveries (
    app text NOT NULL,
    id text NOT NULL,
    message jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed')),
    created_at text NOT NULL DEFAULT ov_now(),
    PRIMARY KEY(app, id)
);
CREATE TABLE chat_app_rates (
    key text PRIMARY KEY,
    hour_bucket bigint NOT NULL,
    count integer NOT NULL
);
