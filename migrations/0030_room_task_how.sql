-- phase: expand
-- "How Vibe did this" (consumer plan §4, the Vibe app): what OpenVibe.Actor says about a task it finished, kept with the
-- task so the answer in the chat can show it (server/rooms/how.js): JSON { agent, model, class, checked: { by, reason },
-- actor_task }. Null for tasks finished before this, and for tasks someone in the room ran by hand.
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS how text;
