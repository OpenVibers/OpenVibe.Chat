-- phase: expand
-- Translation for an inbox's people (server/inbox/translate.js): a message's translation into a language is kept, so a
-- second reader of it pays nothing; translations are counted against the inbox's day like Vibe's answers.
CREATE TABLE IF NOT EXISTS inbox_translations (
    message_id bigint NOT NULL,
    lang       text COLLATE "C" NOT NULL,
    text       text NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (message_id, lang)
);
ALTER TABLE inbox_ai_usage ADD COLUMN IF NOT EXISTS translations integer NOT NULL DEFAULT 0;
