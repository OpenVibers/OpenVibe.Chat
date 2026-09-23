-- Live's chat tables exactly as a current Live creates them (dumped from a fresh
-- OpenVibe.Live database, 2026-09-22), plus the minimum of Live's own tables the importer reads.
-- Used by test/import.test.js to build a fake Live snapshot.
-- chat_messages
CREATE TABLE "chat_messages" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER,
    user_id INTEGER,                       -- NULL for anon
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
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, channel_user_id INTEGER,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_chat_stream_id ON chat_messages(stream_id);
CREATE INDEX idx_chat_timestamp ON chat_messages(timestamp);
CREATE INDEX idx_chat_user_id ON chat_messages(user_id);
CREATE INDEX idx_chat_channel_user_ts ON chat_messages(channel_user_id, timestamp);
CREATE INDEX idx_chat_stream_ts ON chat_messages(stream_id, timestamp);
CREATE INDEX idx_chat_autodelete ON chat_messages(auto_delete_at);
CREATE INDEX idx_chat_ts_deleted ON chat_messages(timestamp, is_deleted);
-- dm_conversations
CREATE TABLE dm_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                is_group INTEGER DEFAULT 0,
                created_by INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
            );
-- dm_participants
CREATE TABLE dm_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                last_read_at DATETIME DEFAULT '1970-01-01 00:00:00',
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(conversation_id, user_id),
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
CREATE INDEX idx_dm_participants_conv ON dm_participants(conversation_id);
CREATE INDEX idx_dm_participants_user ON dm_participants(user_id);
-- dm_messages
CREATE TABLE dm_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            );
CREATE INDEX idx_dm_messages_conv ON dm_messages(conversation_id, created_at);
CREATE INDEX idx_dm_messages_sender ON dm_messages(sender_id);
-- dm_blocks
CREATE TABLE dm_blocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                blocker_id INTEGER NOT NULL,
                blocked_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(blocker_id, blocked_id),
                FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
            );
CREATE INDEX idx_dm_blocks_blocker ON dm_blocks(blocker_id);
CREATE INDEX idx_dm_blocks_blocked ON dm_blocks(blocked_id);
-- tts_voice_overrides
CREATE TABLE tts_voice_overrides (
            identity_key TEXT PRIMARY KEY,
            voice TEXT,
            pitch INTEGER,
            speed INTEGER,
            gap INTEGER DEFAULT 0,
            set_by INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
-- emotes
CREATE TABLE "emotes" (
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
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
CREATE INDEX idx_emotes_user ON emotes(user_id);
CREATE INDEX idx_emotes_global ON emotes(is_global);
CREATE INDEX idx_emotes_code ON emotes(code);
CREATE INDEX idx_emotes_channel_owner ON emotes(channel_owner_id);
CREATE UNIQUE INDEX idx_emotes_channel_code ON emotes(COALESCE(channel_owner_id, user_id), code);
-- channel_sounds
CREATE TABLE channel_sounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_owner_id INTEGER NOT NULL,      -- streamer whose channel this sound belongs to
    command TEXT NOT NULL,                   -- trigger word (without leading '!'), lowercased
    url TEXT NOT NULL,                       -- served path of the audio file on disk
    mime TEXT DEFAULT 'audio/mpeg',
    duration_seconds REAL DEFAULT 0,
    created_by INTEGER,                      -- uploader user id (NULL if removed user)
    created_by_name TEXT DEFAULT '',
    is_approved INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, emote_code TEXT DEFAULT '',
    -- Multiple sounds may share a command; playback picks one at random.
    FOREIGN KEY (channel_owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_sounds_owner ON channel_sounds(channel_owner_id);
CREATE INDEX idx_channel_sounds_cmd ON channel_sounds(channel_owner_id, command);
-- media_requests
CREATE TABLE media_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    streamer_id INTEGER NOT NULL,
    stream_id INTEGER,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    input TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    embed_url TEXT,
    provider TEXT NOT NULL CHECK(provider IN ('youtube', 'vimeo', 'audio', 'video')),
    title TEXT NOT NULL,
    thumbnail_url TEXT,
    duration_seconds INTEGER,
    cost INTEGER NOT NULL DEFAULT 25,
    currency TEXT DEFAULT 'opencoins',
    queue_position INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'playing', 'played', 'skipped', 'removed', 'failed')),
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    ended_at DATETIME,
    last_error TEXT, stream_url TEXT, download_status TEXT DEFAULT 'none' CHECK(download_status IN ('none','extracting','downloading','ready','failed')), file_path TEXT, playback_position REAL DEFAULT 0, refunded INTEGER DEFAULT 0,
    FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_media_requests_streamer_status ON media_requests(streamer_id, status, queue_position, requested_at);
CREATE INDEX idx_media_requests_user_status ON media_requests(user_id, status, requested_at);
CREATE INDEX idx_media_requests_canonical ON media_requests(streamer_id, canonical_url, status);
-- media_request_settings
CREATE TABLE media_request_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    request_cost INTEGER DEFAULT 25,
    max_per_user INTEGER DEFAULT 3,
    max_duration_seconds INTEGER DEFAULT 600,
    allow_youtube INTEGER DEFAULT 1,
    allow_vimeo INTEGER DEFAULT 1,
    allow_direct_media INTEGER DEFAULT 1,
    auto_advance INTEGER DEFAULT 1,
    currency TEXT DEFAULT 'opencoins' CHECK(currency IN ('free','vibes','opencoins','points')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, cost_mode TEXT DEFAULT 'flat' CHECK(cost_mode IN ('flat','per_minute')), cost_per_minute INTEGER DEFAULT 5, allow_live INTEGER DEFAULT 0, download_mode TEXT DEFAULT 'stream' CHECK(download_mode IN ('stream','download')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
-- moderation_actions
CREATE TABLE moderation_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_type TEXT NOT NULL DEFAULT 'site',
            scope_id INTEGER,
            actor_user_id INTEGER,
            target_user_id INTEGER,
            action_type TEXT NOT NULL,
            details TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE INDEX idx_mod_actions_created ON moderation_actions(created_at DESC);
CREATE INDEX idx_mod_actions_actor ON moderation_actions(actor_user_id);
CREATE INDEX idx_mod_actions_scope ON moderation_actions(scope_type, scope_id);
-- channel_moderators
CREATE TABLE channel_moderators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_channel_mods_channel ON channel_moderators(channel_id);
CREATE INDEX idx_channel_mods_user ON channel_moderators(user_id);
-- channel_moderation_settings
CREATE TABLE channel_moderation_settings (
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
    custom_emotes_enabled INTEGER DEFAULT 1,   -- viewers may upload gif/png emotes for this channel
    custom_sounds_enabled INTEGER DEFAULT 1,   -- viewers may upload !sound commands for this channel
    max_sound_seconds INTEGER DEFAULT 10,      -- max duration of an uploaded channel sound
    uploads_mods_only INTEGER DEFAULT 0,       -- restrict emote/sound uploads to channel mods
    mods_can_edit_about INTEGER DEFAULT 0,     -- allow channel mods to edit the streamer's About/panels
    donation_sound_url TEXT,                   -- on-disk path to the streamer's donation alert sound
    donation_sound_mime TEXT,
    goal_sound_url TEXT,                       -- optional override sound for goal-reached
    goal_sound_mime TEXT,
    emote_scale INTEGER DEFAULT 100,           -- emote display size in chat, percent (50-300)
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, tts_max_length INTEGER DEFAULT 200, sound_min_speed REAL DEFAULT 0.5, sound_max_speed REAL DEFAULT 3.0, sound_min_pitch_cents INTEGER DEFAULT -1200, sound_max_pitch_cents INTEGER DEFAULT 1200, emote_size_min INTEGER DEFAULT 50, emote_size_max INTEGER DEFAULT 200, sounds_mods_only INTEGER DEFAULT 0,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
-- relay_users
CREATE TABLE relay_users (
            platform TEXT NOT NULL,
            username TEXT NOT NULL,
            display_name TEXT,
            first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            message_count INTEGER DEFAULT 0,
            PRIMARY KEY (platform, username)
        );
-- hidden_relay_users
CREATE TABLE hidden_relay_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER,
            platform TEXT NOT NULL,
            external_username TEXT NOT NULL,
            action TEXT DEFAULT 'hide' CHECK(action IN ('hide','ban')),
            reason TEXT,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE INDEX idx_hidden_relay_channel ON hidden_relay_users(channel_id, platform);
-- pending_ip_messages
CREATE TABLE pending_ip_messages (
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE INDEX idx_pending_ip_channel ON pending_ip_messages(channel_id, status);
-- stream_first_chats
CREATE TABLE stream_first_chats (
            chatter_key TEXT NOT NULL,
            channel_user_id INTEGER NOT NULL,
            first_chat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chatter_key, channel_user_id)
        );
CREATE INDEX idx_sfc_channel ON stream_first_chats(channel_user_id);
-- chat_ai_summaries
CREATE TABLE chat_ai_summaries (
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
CREATE INDEX idx_chat_ai_scope ON chat_ai_summaries(scope, subject_id, window);
-- chat_timeline_events
CREATE TABLE chat_timeline_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL DEFAULT 'global',
            subject_id INTEGER NOT NULL DEFAULT 0,
            ts DATETIME NOT NULL,
            label TEXT NOT NULL,
            detail TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
CREATE INDEX idx_chat_tl_scope_ts ON chat_timeline_events(scope, subject_id, ts DESC);
CREATE UNIQUE INDEX idx_chat_tl_dedup ON chat_timeline_events(scope, subject_id, ts, label);
-- linked_accounts
CREATE TABLE linked_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT NOT NULL,
            service_user_id TEXT NOT NULL,
            service_username TEXT,
            linked_at DATETIME DEFAULT CURRENT_TIMESTAMP, subject_id TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(service, service_user_id)
        );
CREATE INDEX idx_linked_subject ON linked_accounts(subject_id);
CREATE INDEX idx_linked_service ON linked_accounts(service, service_user_id);
CREATE INDEX idx_linked_user ON linked_accounts(user_id);
-- managed_streams
CREATE TABLE managed_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id INTEGER,
    slug TEXT,                              -- optional unique string ID (must contain non-numeric chars)
    title TEXT DEFAULT 'Untitled Stream',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'irl',
    tags TEXT DEFAULT '[]',
    protocol TEXT DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
    stream_key TEXT UNIQUE NOT NULL,       -- per-stream stable key (reusable across sessions)
    is_nsfw INTEGER DEFAULT 0,
    control_config_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, slot_clip_recording_enabled INTEGER DEFAULT 1, slot_clip_notify_enabled INTEGER DEFAULT 1, slot_powerchat_relay INTEGER DEFAULT 1, slot_powerchat_count_rs_views INTEGER DEFAULT 1, broadcast_settings TEXT DEFAULT '{}', streaming_method TEXT DEFAULT 'browser', browser_mode TEXT DEFAULT 'camera', pip_source_msid INTEGER, pip_defaults TEXT DEFAULT '{}', default_vod_visibility TEXT DEFAULT 'public', default_clip_visibility TEXT DEFAULT 'public', slot_vod_recording_enabled INTEGER DEFAULT 1, weather_zip TEXT DEFAULT NULL, weather_detail TEXT DEFAULT 'basic', weather_show_location INTEGER DEFAULT 0, mic_only_image TEXT DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
    FOREIGN KEY (control_config_id) REFERENCES control_configs(id) ON DELETE SET NULL
);
CREATE INDEX idx_managed_streams_user ON managed_streams(user_id);
CREATE INDEX idx_managed_streams_slug ON managed_streams(slug);
CREATE INDEX idx_managed_streams_key ON managed_streams(stream_key);

-- user_tags (created lazily by Live's game/tags.js)
CREATE TABLE user_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tag_id TEXT NOT NULL,
            source TEXT DEFAULT 'shop',
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, tag_id)
        );
-- Live-owned tables the importer reads (subjects, projections)
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, email TEXT, password_hash TEXT NOT NULL, display_name TEXT, avatar_url TEXT, role TEXT DEFAULT 'user', stream_key TEXT, is_banned INTEGER DEFAULT 0, ban_reason TEXT, profile_color TEXT DEFAULT '#8b5cf6', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_owner INTEGER DEFAULT 0);
CREATE TABLE streams (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channel_id INTEGER, managed_stream_id INTEGER, title TEXT, is_live INTEGER DEFAULT 0, started_at DATETIME, ended_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, title TEXT);
