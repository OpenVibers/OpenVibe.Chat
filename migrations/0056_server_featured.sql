-- phase: expand
-- Explore's featured row (the plan, 2026-11-09, stage V3): staff mark a public server to sit above the categories.
ALTER TABLE chat_servers ADD COLUMN IF NOT EXISTS featured_at text;
