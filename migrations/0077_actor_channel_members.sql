-- phase: expand
-- A personal OpenVibe.Actor agent can join a server channel as an AI member. Its room task uses the existing
-- durable Actor poller, and the member id keeps the finished answer under the agent that did the work.
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS actor_member_id bigint REFERENCES room_ai_members(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS room_tasks_actor_member ON room_tasks (actor_member_id) WHERE actor_member_id IS NOT NULL;
