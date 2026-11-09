-- phase: expand
-- Explore (the plan, 2026-11-09, stage V3): a server's category, its picture, and the template it started from.
ALTER TABLE chat_servers ADD COLUMN IF NOT EXISTS category text COLLATE "C";
ALTER TABLE chat_servers ADD COLUMN IF NOT EXISTS picture_url text;
ALTER TABLE chat_servers ADD COLUMN IF NOT EXISTS template text COLLATE "C";
