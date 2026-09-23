-- ═══════════════════════════════════════════════════════════════
-- OpenVibe.Chat — database schema
--
-- Three kinds of tables live here:
--
--   1. Chat's own tables (authority from the W6 cutover). Same columns as OpenVibe.Live's
--      tables of the same name, so importing is a copy and ids are kept: a message, DM or
--      sound keeps the id it had in Live. Rows still carry Live's user ids; *subject_id
--      columns add the OpenVibe.Network subject (usr_…) where it is known, so later waves can
--      drop Live ids.
--   2. Staged copies of chat-target tables that Live still writes in W6 (channel moderators
--      and settings, emotes, user tags, chat-AI summaries and timeline). The importer fills
--      them; Chat reads the live values through server/live-context.js until the routes that
--      write them move. See table_authority.
--   3. Bookkeeping: projections of Live data (ctx_*), the events outbox, the Live mirror
--      outbox, import holds.
--
-- Everything is CREATE … IF NOT EXISTS (idempotent on every boot). Foreign keys to Live's
-- tables (users, streams, channels) are gone: those rows are not here.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Chat-owned ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER,                     -- Live stream (session) id
    user_id INTEGER,                       -- Live user id; NULL for anon
    anon_id TEXT,                          -- 'anon12345' format
    username TEXT,
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat', 'system', 'donation', 'command', 'tts', 'channel-sound', 'soundboard', 'clip')),
    metadata TEXT,                         -- JSON sidecar for rich events (donation/goal-reached)
    is_global INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    is_filtered INTEGER DEFAULT 0,
    reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    source_platform TEXT,
    deleted_by INTEGER,
    deleted_at DATETIME,
    auto_delete_at DATETIME,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    channel_user_id INTEGER,               -- the broadcaster whose channel room this is
    subject_id TEXT                        -- Network subject of the author (usr_…), when known
);
CREATE INDEX IF NOT EXISTS idx_chat_stream_id ON chat_messages(stream_id);
CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_channel_user_ts ON chat_messages(channel_user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_stream_ts ON chat_messages(stream_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_autodelete ON chat_messages(auto_delete_at);
CREATE INDEX IF NOT EXISTS idx_chat_ts_deleted ON chat_messages(timestamp, is_deleted);
CREATE INDEX IF NOT EXISTS idx_chat_anon ON chat_messages(anon_id);

CREATE TABLE IF NOT EXISTS dm_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    is_group INTEGER DEFAULT 0,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dm_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_at DATETIME DEFAULT '1970-01-01 00:00:00',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    subject_id TEXT,
    UNIQUE(conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dm_participants_conv ON dm_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);

CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sender_subject_id TEXT,
    FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_messages_sender ON dm_messages(sender_id);

CREATE TABLE IF NOT EXISTS dm_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    blocker_subject_id TEXT,
    UNIQUE(blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_blocks_blocker ON dm_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_dm_blocks_blocked ON dm_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS tts_voice_overrides (
    identity_key TEXT PRIMARY KEY,
    voice TEXT,
    pitch INTEGER,
    speed INTEGER,
    gap INTEGER DEFAULT 0,
    set_by INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_sounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_owner_id INTEGER NOT NULL,      -- streamer whose channel this sound belongs to
    command TEXT NOT NULL,                   -- trigger word (without leading '!'), lowercased
    url TEXT NOT NULL,                       -- on-disk path of the audio file
    mime TEXT DEFAULT 'audio/mpeg',
    duration_seconds REAL DEFAULT 0,
    created_by INTEGER,                      -- uploader user id (NULL if removed user)
    created_by_name TEXT DEFAULT '',
    is_approved INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    emote_code TEXT DEFAULT '',
    created_by_subject_id TEXT
    -- Multiple sounds may share a command; playback picks one at random.
    -- media_url / media_asset_id stay on Live's copy (its asset-sync mirrors files to Media).
);
CREATE INDEX IF NOT EXISTS idx_channel_sounds_owner ON channel_sounds(channel_owner_id);
CREATE INDEX IF NOT EXISTS idx_channel_sounds_cmd ON channel_sounds(channel_owner_id, command);

CREATE TABLE IF NOT EXISTS relay_users (
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    PRIMARY KEY (platform, username)
);

CREATE TABLE IF NOT EXISTS hidden_relay_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    platform TEXT NOT NULL,
    external_username TEXT NOT NULL,
    action TEXT DEFAULT 'hide' CHECK(action IN ('hide','ban')),
    reason TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hidden_relay_channel ON hidden_relay_users(channel_id, platform);

CREATE TABLE IF NOT EXISTS pending_ip_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    stream_id INTEGER,
    ip_address TEXT NOT NULL,
    user_id INTEGER,
    anon_id TEXT,
    username TEXT,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
    reviewed_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_ip_channel ON pending_ip_messages(channel_id, status);

CREATE TABLE IF NOT EXISTS stream_first_chats (
    chatter_key TEXT NOT NULL,
    channel_user_id INTEGER NOT NULL,
    first_chat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chatter_key, channel_user_id)
);
CREATE INDEX IF NOT EXISTS idx_sfc_channel ON stream_first_chats(channel_user_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL DEFAULT 'site',
    scope_id INTEGER,
    actor_user_id INTEGER,
    target_user_id INTEGER,
    action_type TEXT NOT NULL,
    details TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor_subject_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mod_actions_actor ON moderation_actions(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_mod_actions_scope ON moderation_actions(scope_type, scope_id);

-- ── 2. Staged: chat targets Live still writes in W6 ─────────────

CREATE TABLE IF NOT EXISTS channel_moderators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_mods_channel ON channel_moderators(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_mods_user ON channel_moderators(user_id);

CREATE TABLE IF NOT EXISTS channel_moderation_settings (
    channel_id INTEGER PRIMARY KEY,
    slow_mode_seconds INTEGER DEFAULT 0,
    followers_only INTEGER DEFAULT 0,
    emote_only INTEGER DEFAULT 0,
    allow_anonymous INTEGER DEFAULT 1,
    links_allowed INTEGER DEFAULT 1,
    gifs_enabled INTEGER DEFAULT 1,
    account_age_gate_hours INTEGER DEFAULT 0,
    caps_percentage_limit INTEGER DEFAULT 0,
    aggressive_filter INTEGER DEFAULT 0,
    max_message_length INTEGER DEFAULT 500,
    slur_filter_enabled INTEGER DEFAULT 0,
    slur_filter_use_builtin INTEGER DEFAULT 1,
    slur_filter_terms TEXT DEFAULT '',
    slur_filter_regexes TEXT DEFAULT '',
    slur_filter_nudge_message TEXT DEFAULT '',
    slur_filter_disabled_categories TEXT DEFAULT '[]',
    ip_approval_mode INTEGER DEFAULT 0,
    soundboard_enabled INTEGER DEFAULT 1,
    soundboard_allow_pitch INTEGER DEFAULT 1,
    soundboard_allow_speed INTEGER DEFAULT 1,
    soundboard_banned_ids TEXT DEFAULT '',
    viewer_auto_delete_enabled INTEGER DEFAULT 1,
    viewer_delete_all_enabled INTEGER DEFAULT 1,
    custom_emotes_enabled INTEGER DEFAULT 1,
    custom_sounds_enabled INTEGER DEFAULT 1,
    max_sound_seconds INTEGER DEFAULT 10,
    uploads_mods_only INTEGER DEFAULT 0,
    mods_can_edit_about INTEGER DEFAULT 0,
    donation_sound_url TEXT,
    donation_sound_mime TEXT,
    goal_sound_url TEXT,
    goal_sound_mime TEXT,
    emote_scale INTEGER DEFAULT 100,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    tts_max_length INTEGER DEFAULT 200,
    sound_min_speed REAL DEFAULT 0.5,
    sound_max_speed REAL DEFAULT 3.0,
    sound_min_pitch_cents INTEGER DEFAULT -1200,
    sound_max_pitch_cents INTEGER DEFAULT 1200,
    emote_size_min INTEGER DEFAULT 50,
    emote_size_max INTEGER DEFAULT 200,
    sounds_mods_only INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS emotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    url TEXT NOT NULL,
    animated INTEGER DEFAULT 0,
    width INTEGER DEFAULT 28,
    height INTEGER DEFAULT 28,
    is_global INTEGER DEFAULT 0,
    is_approved INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    channel_owner_id INTEGER,
    size INTEGER DEFAULT 100,
    media_url TEXT,
    media_asset_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_emotes_user ON emotes(user_id);
CREATE INDEX IF NOT EXISTS idx_emotes_channel_owner ON emotes(channel_owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emotes_channel_code ON emotes(COALESCE(channel_owner_id, user_id), code);

CREATE TABLE IF NOT EXISTS user_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tag_id TEXT NOT NULL,
    source TEXT DEFAULT 'shop',
    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tags_user ON user_tags(user_id);

CREATE TABLE IF NOT EXISTS chat_ai_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    subject_id INTEGER NOT NULL DEFAULT 0,
    window TEXT NOT NULL,
    overview TEXT DEFAULT '',
    memory_json TEXT DEFAULT '',
    timeline_json TEXT DEFAULT '[]',
    message_count INTEGER DEFAULT 0,
    window_message_count INTEGER DEFAULT 0,
    last_message_id INTEGER DEFAULT 0,
    window_label TEXT DEFAULT '',
    window_start DATETIME,
    window_end DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scope, subject_id, window)
);

CREATE TABLE IF NOT EXISTS chat_timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'global',
    subject_id INTEGER NOT NULL DEFAULT 0,
    ts DATETIME NOT NULL,
    label TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_tl_dedup ON chat_timeline_events(scope, subject_id, ts, label);

-- Who writes each baseline chat table in this wave (docs/cutover.md).
CREATE TABLE IF NOT EXISTS table_authority (
    table_name TEXT PRIMARY KEY,
    authority TEXT NOT NULL CHECK(authority IN ('chat', 'live')),
    note TEXT
);

-- ── 3. Bookkeeping ──────────────────────────────────────────────

-- Projections of Live data, maintained by server/live-context.js only. Never authority.
CREATE TABLE IF NOT EXISTS ctx_users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    profile_color TEXT,
    role TEXT DEFAULT 'user',
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    is_owner INTEGER DEFAULT 0,
    created_at DATETIME,
    subject_id TEXT,
    synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ctx_users_username ON ctx_users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ctx_users_display ON ctx_users(display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS ctx_streams (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    channel_id INTEGER,
    managed_stream_id INTEGER,
    title TEXT,
    is_live INTEGER DEFAULT 0,
    started_at DATETIME,
    ended_at DATETIME,
    created_at DATETIME,
    synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ctx_streams_user ON ctx_streams(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ctx_streams_channel ON ctx_streams(channel_id);
CREATE INDEX IF NOT EXISTS idx_ctx_streams_managed ON ctx_streams(managed_stream_id);

CREATE TABLE IF NOT EXISTS ctx_managed_streams (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    slug TEXT,
    title TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME,
    synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ctx_ms_user ON ctx_managed_streams(user_id);

CREATE TABLE IF NOT EXISTS ctx_channels (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE,
    title TEXT,
    synced_at INTEGER
);

CREATE TABLE IF NOT EXISTS ctx_sync (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
);

-- Transactional outbox (events.event-envelope@1), written in the same transaction as the change.
CREATE TABLE IF NOT EXISTS events_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    attempts INTEGER DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_outbox_unsent ON events_outbox(sent_at, seq);

-- Row changes to mirror into Live's copy of Chat's tables (filled by per-connection TEMP
-- triggers, so only writes made by this service are captured — never the importer's).
CREATE TABLE IF NOT EXISTS live_mirror_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl TEXT NOT NULL,
    op TEXT NOT NULL CHECK(op IN ('upsert', 'delete')),
    pk TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- Writes Live forwarded over the bridge, by idempotency key (Live's outbox id): a retried
-- delivery returns the first result instead of writing twice.
CREATE TABLE IF NOT EXISTS bridge_applied (
    key TEXT PRIMARY KEY,
    result TEXT,
    applied_at INTEGER NOT NULL
);

-- Live's placeholder ids (a large negative number per Live boot) → the real chat_messages id, so a
-- later op of the same Live boot that carries the placeholder is rewritten even after a Chat
-- restart (the batch that acknowledged the insert and the one carrying its broadcast can straddle
-- one). Kept a day.
CREATE TABLE IF NOT EXISTS bridge_refs (
    boot TEXT NOT NULL,
    ref INTEGER NOT NULL,
    id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (boot, ref)
);

-- Rows the importer could not represent. Never dropped; reviewed by hand.
CREATE TABLE IF NOT EXISTS import_hold (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table TEXT NOT NULL,
    source_pk TEXT NOT NULL,
    reason TEXT NOT NULL,
    row_json TEXT NOT NULL,
    held_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_table, source_pk)
);

CREATE TABLE IF NOT EXISTS import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    live_db TEXT,
    dry_run INTEGER DEFAULT 0,
    counts TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
);

CREATE TABLE IF NOT EXISTS chat_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
