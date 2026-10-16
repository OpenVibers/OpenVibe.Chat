-- phase: expand
-- A model of their own for AI members (server/rooms/ai-members.js; the owner's "multi model group chat"): an AI member
-- thinks with OpenVibe's model (engine 'openvibe', the default) or with the provider key a person keeps in OpenVibe.AI
-- through Chat (engine 'own': OpenAI, Anthropic or any OpenAI-compatible endpoint, their model, their daily budget).
-- engine_subject is whose key; engine_label what the room shows ("openai · gpt-4o-mini").
ALTER TABLE room_ai_members ADD COLUMN IF NOT EXISTS engine text COLLATE "C" NOT NULL DEFAULT 'openvibe';
ALTER TABLE room_ai_members ADD COLUMN IF NOT EXISTS engine_subject text COLLATE "C";
ALTER TABLE room_ai_members ADD COLUMN IF NOT EXISTS engine_label text COLLATE "C";
ALTER TABLE room_ai_members ADD CONSTRAINT room_ai_members_engine CHECK (engine IN ('openvibe', 'own'));
