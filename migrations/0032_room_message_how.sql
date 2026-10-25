-- phase: expand
-- "How Vibe did this" under a chat answer (consumer plan §4, the Vibe app): what Vibe did to answer in a person's own
-- chat (searched OpenVibe or the web for what, which pages it read, a note saved, an agent set up), kept with its
-- message as JSON { steps: [text], sources: [url] } (server/rooms/how.js). Null for every other message.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS how text;
