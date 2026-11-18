-- phase: expand
-- The files a direct message carries (the owner, 11-15: the messaging "needs to use our custom multi-purpose composer
-- with file support and images and all the others, like all file types … you're allowed to attach files"): a picture,
-- a video, a sound or any other file Media accepts (it refuses programs), picked in the box and sent with the
-- message. Media owns the bytes and keeps them with the message; this row is what a reader draws the file from.
-- The same shape as room_message_attachments (0081).
CREATE TABLE dm_message_attachments (
    message_id bigint NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
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
CREATE INDEX dm_message_attachments_id ON dm_message_attachments(attachment_id);
CREATE INDEX dm_message_attachments_message ON dm_message_attachments(message_id, position);
