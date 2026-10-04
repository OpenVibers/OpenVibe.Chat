# Chat-owned internal ingress (T3 J2 prerequisite)

These routes accept an RS256 service token for `openvibe.chat` on loopback only. The existing
`/internal/live/*` bridge remains available during the Live rollout. All POST bodies require a
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
| `POST /internal/chat/messages` | `chat.message.send` | Chat message fields (`stream_id`, `channel_user_id`, `user_id`, `anon_id`, `username`, `message`, `message_type`, `is_global`, `reply_to_id`, `source_platform`, `metadata`), optional `mirror`, `tts:{voice,identity_key,key}`, `auto_delete_at`, and typed chat-frame fields in `frame` (`role`: `admin`/`global_mod`/`streamer`/`user`/`anon`/`external`, `profile_color`: hex, `avatar_url`, `is_ai`/`is_bot`/`filtered`: booleans, `core_username`, `display_name`); the broadcast carries `reply_to_id`, `is_global`, `auto_delete_at` and `metadata` from the body. Returns `{ok,id}`. With no TTS key, Chat uses `m<real message id>`. `dm:{to_user_id}` with `user_id` persists and delivers a direct message (the same `dm` frame as `POST /api/dm`, with the sender looked up by id), returning `{ok,id,conversation_id,to_user_id}`; a blank message is 400. Chat records the first chat in the channel (the welcome check) under `first_chat_key` when given (`user:<id>`, `anon:<anonId>` or `ext:<prefixed username>`), otherwise for a `chat` line only: `ext:<username>` with `source_platform`, else `user:<user_id>`, else `anon:<anon_id>`. |
| `POST /internal/chat/events` | `chat.live_bridge.write` | `{key,target:{kind,id?},frame:{type,...}}`, returns `{ok:true}`. Target kinds: `stream`, `channel`, `owner-streams`, `user` (positive `id`), `global`, `all` (no `id`). Only the event frame types allowlisted in `internal-ingress.js` are accepted; `dm` and delete frames are refused, and `chat` only as the news card. |
| `POST /internal/chat/moderation` | `chat.live_bridge.write` | `{key,action,...}`; actions: `delete-message`, `delete-user-messages`, `delete-anon-messages`, `delete-relay-messages`, `delete-by-range`, `review-pending-ip`, `approve-ip-messages`, `deny-ip-messages`, `relay-hide`, `relay-unhide`, `relay-record`, `tts-voice-override`, `disconnect`, `log`. Deletes return `ids` and broadcast `delete-messages` to every affected surface. |
| `POST /internal/chat/invalidate` | `chat.live_bridge.write` | `{key,user?,user_data?,approvals?,bans?,channel?}`; a cache hint, returns `{ok:true}`. Include a typed `user_data` object when Live edited the account, so Chat updates sockets and stored message names. |
| `GET /internal/chat/presence` | `chat.presence.read` | The same snapshot as `/internal/live/presence`. |

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

`events`, `moderation` and `invalidate` take `chat.live_bridge.write`, the capability Live
already holds for the same broadcasts, moderation writes and cache hints through
`/internal/live/calls`, so Live repoints with the grants it has today (`chat.message.send`,
`chat.presence.read`, `chat.live_bridge.write`). Narrower capabilities (`chat.event.publish`,
`chat.moderation.write`, `chat.cache.invalidate`; proposals in `docs/capabilities-proposal/`)
need the separate **OpenVibe.Contracts** repository to register them and add them to
`manifests/services/chat.json` first: Chat's CI `contracts` step (`openvibe-contracts-check`) refuses a guard on
a capability Contracts does not define. Then Chat switches the three guards, and Network grants
`live chat.event.publish openvibe.chat`, `live chat.moderation.write openvibe.chat` and
`live chat.cache.invalidate openvibe.chat` before that Chat release deploys.

Then Live J2 replaces its bridge writer with a typed client: repoint message producers and persisted DMs
to `messages` (with `role`/`profile_color` etc. in `frame`), card, sound, media-queue, redemption
and vibe-coding producers to `events`, the call invite/response `sendDm` calls to `events` with a
`user` target, moderation writes and disconnects to
`moderation`, cache hints to `invalidate`, and presence reads to `/internal/chat/presence`.
Await the real message id; use one stable key per operation. Drain Live's bridge outbox before
removing its sender. Live J4b moves arena-command replies into the Chat-effects response.
For deploy notices, Live publishes `live.release.deployed` through Events. If Events outbox
initialization fails, Live must leave `deploy_last_announced` unchanged so the next boot retries.
