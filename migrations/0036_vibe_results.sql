-- phase: expand
-- What Vibe really did in its answer (plan L48, V2: the result chips the Dock and Chat show for a Vibe answer):
-- the reminders and timers it set or stopped for the person, kept with the answer in room_messages.results as a
-- JSON list of at most four { kind, action, id?, title, when?, url? } (server/rooms/vibe-results.js). A nullable
-- column on the table the messages live in: the results live and die with the answer, they are read with the
-- message and never on their own, and no new table needs a person column of its own (ADR-033). Null for every
-- message that is not a Vibe answer with something to show.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS results jsonb;
