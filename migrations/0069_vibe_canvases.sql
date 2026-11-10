-- phase: expand
-- Versioned documents and code artifacts created in a person's Vibe conversation (C3 Canvas).
CREATE TABLE IF NOT EXISTS vibe_canvases (
    id text COLLATE "C" PRIMARY KEY,
    room_id bigint NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('document', 'code')),
    version bigint NOT NULL DEFAULT 1,
    content text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS vibe_canvases_room_updated ON vibe_canvases (room_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS vibe_canvas_versions (
    canvas_id text COLLATE "C" NOT NULL REFERENCES vibe_canvases(id) ON DELETE CASCADE,
    version bigint NOT NULL,
    content text COLLATE "C" NOT NULL,
    created_by text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (canvas_id, version)
);
