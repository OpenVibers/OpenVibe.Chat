-- phase: expand
-- The files a room message carries from OpenVibe.Media's composer attachments (composer.attachment@1): a video, a
-- picture, a sound, a PDF or a text file, picked in the room's box and sent with the message. Media owns the bytes
-- and answers what plays it, so the message keeps the kind, the type, the poster, the playback (url, mime, ready),
-- the length and the size after the rotation is applied. The bytes never live in Chat's database.
CREATE TABLE room_message_attachments (
    message_id bigint NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
    attachment_id text COLLATE "C" NOT NULL,
    position integer NOT NULL DEFAULT 0,
    owner_subject text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    mime text COLLATE "C" NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
    url text COLLATE "C",
    poster text COLLATE "C",
    playback_url text COLLATE "C",
    playback_mime text COLLATE "C",
    playback_ready integer NOT NULL DEFAULT 0,
    duration_s double precision,
    width bigint,
    height bigint,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (message_id, attachment_id)
);
CREATE INDEX room_message_attachments_id ON room_message_attachments(attachment_id);
CREATE INDEX room_message_attachments_message ON room_message_attachments(message_id, position);
