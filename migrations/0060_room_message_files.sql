-- phase: expand
-- Files attached to a chat message (ai.file@1 references, stored in Media): the Vibe composer's tray
-- sends them with the message, and Vibe's turn reads them by reference. The bytes never live here.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb;
