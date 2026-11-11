-- phase: expand
-- The turns a visitor's own widget session may ask for, per hour and per UTC day (one-engine slice).
--
-- The inbox's own daily cap (inbox_ai_usage) is the outer limit: this table is the inner one, so one visitor
-- cannot spend the whole day's answers on their own while other visitors wait. The visitor is their widget
-- token, hashed: the table never keeps the token itself.
CREATE TABLE IF NOT EXISTS inbox_visitor_turns (
    inbox_id           text COLLATE "C" NOT NULL,
    visitor_token_hash text COLLATE "C" NOT NULL,
    period             text COLLATE "C" NOT NULL,   -- the hour or the UTC day the count belongs to
    turns              integer NOT NULL DEFAULT 0,
    PRIMARY KEY (inbox_id, visitor_token_hash, period)
);
CREATE INDEX IF NOT EXISTS inbox_visitor_turns_period ON inbox_visitor_turns (inbox_id, period);
