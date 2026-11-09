-- phase: expand
-- Onboarding (the plan, 2026-11-09, stage V3): a server's rules, the roles a new member may pick, and the roles
-- each member picked. Rules and role definitions are the server's; a member's picks are their own and go with their
-- membership (account export and deletion already cover chat_server_members).
ALTER TABLE chat_servers ADD COLUMN IF NOT EXISTS rules text;
ALTER TABLE chat_servers ADD COLUMN IF NOT EXISTS self_roles text;
ALTER TABLE chat_server_members ADD COLUMN IF NOT EXISTS roles text;
