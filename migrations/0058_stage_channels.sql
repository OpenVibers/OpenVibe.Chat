-- phase: expand
-- Stage channels are call rooms with per-person speaking permission and stage session metadata.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS stage_channel boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS chat_stage_sessions (
    room_id bigint PRIMARY KEY,
    topic text COLLATE "C",
    started_at text COLLATE "C",
    ended_at text COLLATE "C",
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);

CREATE TABLE IF NOT EXISTS chat_stage_speakers (
    room_id bigint NOT NULL,
    user_id bigint NOT NULL,
    hand_raised boolean NOT NULL DEFAULT false,
    invited_by bigint,
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (room_id, user_id)
);
