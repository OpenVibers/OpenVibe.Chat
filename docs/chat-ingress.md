# Chat-owned internal ingress (T3 J2 prerequisite)

These routes accept an RS256 service token for `openvibe.chat` on loopback only. They replaced the
`/internal/live/*` bridge, which is retired (T3 J3a; Live #20/#21). All POST bodies require a
stable `key` (1–160 letters, digits, `:._-`). A retry with the same principal, route and body
returns the first result. Reusing the key with another body returns 409. If delivery fails after
the database write, retry the same key: Chat retries the broadcast without writing another row.
While another Chat process holds the delivery claim for the key (or one crashed holding it), a
retry gets 503 "delivery in progress; retry with the same key", never a 200 for an undelivered
broadcast. A crashed claim expires after five minutes; the next retry then delivers it, so the
caller must keep retrying 503s past that lease. A crash between the broadcast and marking it
delivered can still repeat that broadcast once (at least once, never lost). Bad input is 400 and
a stream that does not exist is 404: do not retry a 4xx.

| Route | Capability | Body and result |
| --- | --- | --- |
| `POST /internal/chat/messages` | `chat.message.send` | Chat message fields (`stream_id`, `channel_user_id`, `user_id`, `anon_id`, `username`, `message`, `message_type`, `is_global`, `reply_to_id`, `source_platform`, `metadata`), optional `mirror`, `tts:{voice,identity_key,key}`, `auto_delete_at`, and typed chat-frame fields in `frame` (`role`: `admin`/`global_mod`/`streamer`/`user`/`anon`/`external`, `profile_color`: hex, `avatar_url`, `is_ai`/`is_bot`/`filtered`: booleans, `core_username`, `display_name`); the broadcast carries `reply_to_id`, `is_global`, `auto_delete_at` and `metadata` from the body. Returns `{ok,id,stream_id,channel_user_id,first_chat}`: `first_chat` (`chat.send-result` 1.2.0) is true when this line recorded the chatter's first chat in the channel, so Live can welcome them. With no TTS key, Chat uses `m<real message id>`. `dm:{to_user_id}` with `user_id` persists and delivers a direct message (the same `dm` frame as `POST /api/dm`, with the sender looked up by id), returning `{ok,id,conversation_id,to_user_id}`; a blank message is 400. Chat records the first chat in the channel (the welcome check) under `first_chat_key` when given (`user:<user_id>`, `anon:<anonId>` or `ext:<prefixed username>`), otherwise for a `chat` line only: `ext:<username>` with `source_platform`, else `user:<user_id>`, else `anon:<anon_id>`. |
| `POST /internal/chat/events` | `chat.event.publish` | `{key,target:{kind,id?},frame:{type,...}}`, returns `{ok:true}`. Target kinds: `stream`, `channel`, `owner-streams`, `user` (positive `id`), `global`, `all` (no `id`). Only the event frame types allowlisted in `internal-ingress.js` are accepted; `dm` and delete frames are refused, and `chat` only as the news card. |
| `POST /internal/chat/moderation` | `chat.moderation.write` | `{key,action,...}`; actions: `delete-message`, `delete-user-messages`, `delete-anon-messages`, `delete-relay-messages`, `delete-by-range`, `review-pending-ip`, `approve-ip-messages`, `deny-ip-messages`, `relay-hide`, `relay-unhide`, `relay-record`, `tts-voice-override`, `disconnect`, `log`. Deletes return `ids` and broadcast `delete-messages` to every affected surface. |
| `POST /internal/chat/invalidate` | `chat.cache.invalidate` | `{key,user?,user_data?,approvals?,bans?,channel?}`; a cache hint, returns `{ok:true}`. Include a typed `user_data` object when Live edited the account, so Chat updates sockets and stored message names. |
| `GET /internal/chat/presence` | `chat.presence.read` | Who is connected where: counts, per-stream viewers, slow modes, users/anons with their addresses (`server/chat/presence.js`). |

Live's reads of Chat's tables, in place of the read mirror retired on 2026-10-05 (`server/chat/internal-reads.js`, plan
T3 J4b N1–N5, contracts in `openvibe-contracts` 0.95.0). Unknown or malformed parameters are 400;
deleted messages are never read; `since`/`until` are epoch ms (`until` exclusive). Every answer is
`{ok:true,...}` or `{ok:false,error}`.

| Route | Capability | Request and result |
| --- | --- | --- |
| `POST /internal/chat/stats` | `chat.stats.read` | `{kind:'site'\|'user'\|'stream'\|'channel-top'\|'site-daily', user_id?, stream_id?, channel_user_id?, since?, until?, limit?}`. `site`/`user`(`user_id`)/`stream`(`stream_id`) → `{messages,chatters}` (+ `sounds`, soundboard plays, for `stream`); `channel-top` (by `stream_id`, `channel_user_id` or all chat; `limit` ≤ 50, default 10) → `{top_chatters:[{user_id,username,display_name,avatar_url,profile_color,count}]}`; `site-daily` (`since` and `until` required, epoch ms, at most 400 UTC days) → `{days:[{day,messages,chatters}]}`, one row per UTC day in `[since,until)` with zero-filled gaps: every non-deleted message across all channels (Live's home `messages` series) and distinct chatters (Live's `active`: `COALESCE(user_id,anon_id,source_platform‖username)`). |
| `GET /internal/chat/messages` | `chat.messages.read` | Exactly one of `channel_user_id`, `stream_id`, `user_id`, `anon_id`, `username`, `id`; `after_id` (oldest first), `before_id` (newest first; the default), `limit` ≤ 500 (default 100), `types=chat,donation,…`, `tail=1` (no rows) → `{messages,max_id}`; `max_id` is the newest matching id. |
| `GET /internal/chat/timeline` | `chat.analysis.read` | `channel_user_id` or `stream_id`, `since`, `until` (default now), `bucket_ms` ≥ 1000 (≤ 10 000 buckets) → `{buckets:[{t,count}],max_id}`; buckets start at `since`, oldest first, empty ones left out. |
| `GET /internal/chat/first-chat?channel_id&identity` | `chat.analysis.read` | `{first}`: true when `identity` (`user:<user_id>`, `anon:<anonId>`, `ext:<prefixed username>`; ≤ 160) has never chatted in the channel — Live's `isFirstChatInChannel`, from `stream_first_chats`. `channel_id` is the channel owner's Live user id (`stream_first_chats.channel_user_id`), not `ctx_channels.id`. A registered identity is `user:<user_id>`, the numeric Live user id and **never** the username: Live's own `user:${line.username}` key would read `first:true` forever, so its welcome check must pass `user:${line.user_id}`. |
| `GET /internal/chat/moderation/pending-ip?channel_id` | `chat.moderation.queue.read` | `{pending_ip}`: the channel's pending rows, oldest first (`limit` ≤ 500, default 50). |
| `GET /internal/chat/moderation/relay-users?channel_id` | `chat.moderation.queue.read` | `{relay_users}`: hidden or banned relay names on the channel or everywhere, newest first, with `created_by_username` (`limit` ≤ 500, default 100). |
| `GET /internal/chat/moderation/relay-users/:id` | `chat.moderation.queue.read` | `{relay_user}`, null when unknown. |
| `GET /internal/chat/moderation/tts-override?identity_key` | `chat.moderation.queue.read` | `{tts_override}` (key trimmed and lowercased), null when none. |
| `GET /internal/chat/sounds?channel_owner_id` (also `/sounds/count`) | `chat.sounds.read` | `{count}` of the channel's sounds. |
| `GET /internal/chat/sounds?pending_asset=1` | `chat.sounds.read` | `{sounds}` not yet on Media (`media_asset_id` null), by id; optional `channel_owner_id`, `after_id`, `limit` ≤ 500 (default 100). |
| `GET /internal/chat/sounds/by-command?channel_id&command` | `chat.sounds.read` | `{sound}`: the approved (`is_approved=1`) channel sound `command` plays, one at random when several match, or 404 — Live's `getChannelSoundByCommand`. `command` is trimmed, lowercased and has leading `!` stripped (≤ 120); `channel_id` is the channel owner's Live user id (`channel_sounds.channel_owner_id`); same projection as `/sounds`. |
| `POST /internal/chat/sounds/asset` | `chat.sounds.write` | `{id,media_url,media_asset_id}` records Live's upload (`migrations/0004_channel_sound_media.sql`); repeating it is a 200 no-op; an unknown sound is 404. For a sound Chat has no Media asset for, Live's own asset columns stay as its asset sync left them (the read mirror that used to preserve them was retired on 2026-10-05). |

### Per-ticket conversation (OpenVibe.Help)

OpenVibe.Help reads and answers a ticket through one conversation per (ticket id, calling
service), guarded by `chat.ticket.write` (`server/chat/internal-tickets.js`,
`chat.ticket-conversation@1`, openvibe-contracts 0.103.0; the tables are
`migrations/0007_ticket_conversations.sql`). The calling service is the service token's principal
(`svc:help` → `help`): two services on one ticket get two conversations and a service can only
ever read or write its own — an app, node or agent token is refused. Bodies are the author's plain
text (1–6000 characters, not blank), stored and answered as sent and never rendered as HTML. The
contract has no idempotency key, so a retried POST appends another message; `created_at` is the
author's clock and Chat orders by its own message id (newest first by default, `after_id` pages
oldest first).

| Route | Capability | Request and result |
| --- | --- | --- |
| `POST /internal/chat/tickets/:ticket_id/messages` | `chat.ticket.write` | `{author_kind:'person'\|'agent'\|'staff', author, body, created_at}` with `author` the author's subject (≤ 200) and `created_at` an RFC 3339 date-time; creates the (ticket, service) conversation on first use and appends the message. Returns `{ok:true, ticket_id, service, message:{author_kind, author, body, created_at}}` (the contract's conversation shape). |
| `GET /internal/chat/tickets/:ticket_id` | `chat.ticket.write` | The calling service's own conversation, paged: `{ok:true, ticket_id, service, created_at, messages:[{id, author_kind, author, body, created_at}], max_id}`; `after_id` (oldest first), `before_id` (newest first, the default), `limit` ≤ 500 (default 100); `max_id` is the conversation's newest message id. A service with no conversation for the ticket gets 404 — another service's is never readable. |

`/internal/chat/events` is a narrow transient event ingress, not a generic ChatServer call.
`live.release.deployed` continues through OpenVibe.Events; there is no deploy-notice endpoint.
An `alert` targets its `streamerId` channel; a `channel-sound` targets its `streamId` stream.
`voice-channels` targets `all`. `media_queue_update` (`state` object) and `media_now_playing`
(`request` object or null) target `owner-streams` (the media owner's live streams).
`redemption` (`username`, `reward_title`, numeric `cost`) and `vibe-coding` (`managed_stream_id`,
`event` object) target a `stream`. The transient call frames `vc-call-invite` and
`vc-call-response` (typed fields only: `channelId`, `channelName`, `fromUserId`, `fromUsername`,
`fromDisplayName`, `fromAvatarUrl`, `createdAt`, plus `status` on a response) are the only frames
that target a `user`; Chat sends them to that user's sockets and persists nothing. The news card
(Live `news-service`) is a `chat` frame with `message_type: 'news'` and only `username`,
`message`, `timestamp`, and optional `url` (≤ 500 characters), `news_source`,
`source_platform: 'news'` and `system` (boolean); it targets a `stream` and is never
saved.

Before Live repoints, the separate **OpenVibe.Contracts** repository must register
`chat.event.publish`, `chat.moderation.write`, and `chat.cache.invalidate` and add them to
`manifests/services/chat.json`. Network's `principal_grants` and `DEFAULT_GRANTS` must grant
`live chat.event.publish openvibe.chat`, `live chat.moderation.write openvibe.chat`, and
`live chat.cache.invalidate openvibe.chat`. Keep the Live grants for `chat.message.send`
(`messages`), `chat.presence.read` (`/internal/chat/presence`) and `chat.live_bridge.write` (the call
hooks at `/internal/calls/stream-channel`): the bridge is gone, but each still guards a route. For
the read API above, Network's `DEFAULT_GRANTS` must add `live chat.stats.read openvibe.chat`,
`live chat.messages.read openvibe.chat`, `live chat.analysis.read openvibe.chat`,
`live chat.moderation.queue.read openvibe.chat`, `live chat.sounds.read openvibe.chat` and
`live chat.sounds.write openvibe.chat`. Chat's
local proposals are in `docs/capabilities-proposal/`. The three plan-T3 reads added for Live's home
series, its welcome check and its robot channel sounds use those same capabilities but add result
schemas `chat.site-daily-result@1`, `chat.first-chat-result@1` and `chat.sound-result@1`, which
land in openvibe-contracts 0.103.0, now pinned.

Live J2 (done: Live #20/#21) replaced its bridge writer with a typed client: repoint message producers and persisted DMs
to `messages` (with `role`/`profile_color` etc. in `frame`), card, sound, media-queue, redemption
and vibe-coding producers to `events`, the call invite/response `sendDm` calls to `events` with a
`user` target, moderation writes and disconnects to
`moderation`, cache hints to `invalidate`, and presence reads to `/internal/chat/presence`.
Await the real message id; use one stable key per operation. Live J4b moves arena-command replies
into the Chat-effects response; Chat sends each returned reply to the socket that ran the command.
For deploy notices, Live publishes `live.release.deployed` through Events. If Events outbox
initialization fails, Live must leave `deploy_last_announced` unchanged so the next boot retries.
