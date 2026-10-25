# OpenVibe.Chat

> Group chats with AI members (each on its own model, with tools), servers with text and voice channels, pictures,
> DMs, calls, Live's stream chat with TTS and audio queues, moderation and presence — one identity, every conversation.

**Status:** alpha — deployed. Since the cutover on 2026-09-23 at 02:03 UTC,
Chat is the authority for openvibe.live's chat in every mode: the service runs on `openvibe-ovh`
(unit `openvibe-chat`, 127.0.0.1:4400), Live runs no chat of its own (its `CHAT_AUTHORITY` switch was retired
on 2026-10-11), mounts no local chat routes, reads Chat's internal read API for the chat data it needs, and chat events go to OpenVibe.Events. `openvibe.chat` is Chat's own
site (global chat, messages, rooms,
settings; the service manifest records it live since 2026-09-24).  
**Domain:** `openvibe.chat` ([deploy/nginx/openvibe.chat.conf](deploy/nginx/openvibe.chat.conf)); Chat
is also served on Live's origin: `https://openvibe.live/ws/chat`, `/api/chat/`, `/api/dm/`,
`/api/tts/`, `/api/sounds`, `/api/emotes` via nginx.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §9 and §9.5.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The communication authority extracted from OpenVibe.Live. Live keeps a compatibility adapter while
browsers move to Chat directly with Network-issued tokens and authorised topic subscriptions.

## What Wave 6 did

The roadmap's method for this wave: **move the existing implementation behind a service boundary
before changing behaviour.** Browser JavaScript does not change; nginx routes the chat paths here.

- **Moved as they were** (from Live `server/chat/`): the WebSocket chat server (`/ws/chat`, every
  message type and command: `join`/`join_stream`/`leave_stream`/`get-users`/`chat`/`self-delete-history`,
  `/help /tts /color /viewers /uptime /w /me /ban /unban /timeout /clear /slow /subonly /paste /ai`, `!sr !queue
  !np !skip !sb !gotti`, channel `!sounds`, arena `!hype !beef !arena`, hardware `!forward … !say`),
  DMs (`dm.js`, `/api/dm/*`), chat history (`history-store.js`, `/api/chat/*`), TTS (`tts-engine.js`,
  `/api/tts/*`), 101soundboards and channel sounds (`/api/sounds*`), moderation utils and the word
  filter, the deploy-notice card. Changes are confined to where they touched Live's data.
- **The TTS and sound queue** (`audio-queue.js`, table `audio_requests`). TTS, channel `!sounds` and
  101soundboards clips are persisted requests played one at a time per room, across every Chat
  process (a claim holds the room's advisory lock; a partial unique index allows one `playing` row
  per room) — `queued → playing → played`, or `skipped` / `failed` — so the queue survives a Chat
  restart (what waited plays once the room has listeners again, requests older than 5 minutes
  expire) and a keyed request (the TTS of message `m<id>`) is read once. A playing row is owned:
  `claimed_by` (the process's instance id, host and port or `CHAT_AUDIO_INSTANCE_ID`) and a
  30-second `lease_until` its owner renews every 10 s. Only a dead owner's row is settled — its
  lease passed, or it is the restarted process's own — at boot and by the heartbeat's sweep; a live
  process's clip is never touched. Such a row is `played` if its delivery had started, otherwise
  queued again in its old place, once: claimed a second time and dead again undelivered, it
  `failed` (`attempts` counts claims), so a clip that crashes Chat cannot loop. The broadcaster and
  moderators control it: `/skiptts [id]`, `/cleartts`, and `GET /api/tts/queue`,
  `POST /api/tts/queue/skip|clear`, `POST /api/tts/queue/:id/report` (the playing client's
  `played`/`failed`). Browsers get the same `tts-audio` / `soundboard-audio` frames as before, now
  with `request_id` and paced by the clip's length, plus two new frames old clients ignore:
  `audio-skip { request_id }` and `audio-clear { request_ids }`.
- **One adapter to Live — `server/live-context.js`.** Accounts and roles, streams, slots and channels,
  channel moderation settings and moderators, bans and IP rules, follows, cosmetics and tags, site
  settings and anon numbers are read through it; coins, AI viewers, arena, media queue, hardware,
  pastes, translation, PowerChat, notifications, viewer counts and the IP log are effects it asks
  Live for. Reads are cached projections (`ctx_*` tables kept complete by paged syncs; TTL
  caches that serve stale while refreshing) warmed when a socket joins, so a chat message never
  waits on a network read. Live pushes invalidations when it changes cached data.
- **Live integration.** Live serves `/internal/chat-context/*` and `/internal/chat-effects/*` and
  has no chat switch. Its chat calls reach Chat through `/internal/chat/*`
  (`docs/chat-ingress.md`).
- **Own database on PostgreSQL** (ADR-035, plan T3) with Live's tables and ids, the Network subject on new
  rows, and a transactional events outbox. Chat's changes were copied into Live's tables by a read
  mirror until 2026-10-05: since Live #31 nothing in Live reads its mirror-filled chat tables in chat
  mode (every read goes to Chat's internal read API, `server/chat/internal-reads.js`), so the mirror —
  and the cutover rollback through it — is retired. `server/db/database.js` serves
  through `openvibe-sdk/db`: production needs `DATABASE_URL` (the runtime role, DML only, through
  PgBouncer) and `DATABASE_DIRECT_URL` (the owner, which applies `migrations/` at boot); without
  `DATABASE_URL` outside production it runs on an embedded PGlite in `data/pglite` (`CHAT_PGLITE_DIR`).
  `migrations/0001_initial.sql` is the whole schema (timestamps stay SQLite-format text through
  `ov_now()`/`datetime()`); `0006_stop_live_mirror_triggers.sql` dropped the twelve read-mirror capture
  triggers, and `0009_drop_live_mirror_outbox.sql` drops `live_mirror_outbox` (a contract migration,
  after 0008's SDK outbox: a held contract would hold every migration after it).
  `VALKEY_URL`/`VALKEY_PREFIX` put the per-actor rate-limit counters on Valkey instead of this process.
- **The six chat tables** (`channel_moderators`, `channel_moderation_settings`, `emotes`, `user_tags`,
  `chat_ai_summaries`, `chat_timeline_events`): Chat's own since the C-04 cutover — Chat is their only
  writer, there is no authority switch any more. Live's writers go through Chat's APIs below and the
  Chat-owned ingress (`docs/chat-ingress.md`); the Live bridge they used before is retired (T3 J3a).
- **The features on those tables, served by Chat** (plan T3, plan step 1) — built here so Live can
  stop touching them at the flip:
  - `GET /api/emotes/global`, `/channel/:userId`, `/mine`, `/defaults`, `/sources` (GET/PUT),
    `/search`, `/all/:streamId`, `/file/:filename`, `POST /api/emotes`, `PATCH/DELETE /api/emotes/:id`
    — Live's exact paths, bodies, limits and error messages; uploaded bytes go to OpenVibe.Media with
    Chat's own token (`media.object.upload` / `.delete`, namespace `chat`), the row stores
    `media_url` + `media_asset_id`, responses use `media_url`. No local emote files (`/file/…` 404s).
    `ffz`/`bttv`/`7tv` are cached provider proxies on fixed hosts.
  - `GET /api/chat/channels/moderation/mine`, `GET/POST /api/chat/channels/:id/mods`,
    `DELETE /api/chat/channels/:id/mods/:userId`, `GET/PUT /api/chat/channels/:id/moderation`,
    `…/moderation/logs`, `…/moderation/chat-search`,
    `POST …/moderation/messages/:messageId/delete` — owner/admin write, channel mods read.
  - Live's read API for what Chat owns: `GET /internal/moderation/channels/:channelId`,
    `GET /internal/moderation/users/:userId/channels`,
    `GET /internal/moderation/channels/:channelId/emote-count` — loopback + service token,
    capability `chat.moderation.read` (`chat.channel-moderation-result@1`,
    `chat.moderated-channels-result@1`, `chat.emote-count-result@1`). Live caches each answer 30 s.
  - Live's reads of Chat's message, moderation-queue and sound tables (plan T3 J4b):
    `POST /internal/chat/stats`, `GET /internal/chat/messages`, `/timeline`, `/moderation/*`,
    `/sounds` and `POST /internal/chat/sounds/asset` (`server/chat/internal-reads.js`; routes and
    capabilities in `docs/chat-ingress.md`).
  - Alert sounds: `playAlertSound(chatServer, streamerId, streamId, kind)` (`server/chat/alert-sounds.js`)
    resolves the channel's own settings row, reads the clip and broadcasts it to the channel room.
  - **The chat-AI summaries** (plan T3 step 2, decision 5) — Live's `server/ai/chat-ai.js` job moved
    here: a background poller (off unless `CHAT_AI_ENABLED=1`) that folds Chat's own messages into
    rolling global/per-user/per-relay/per-anon insights and the append-only timeline, writing
    Chat's own `chat_ai_summaries`/`chat_timeline_events` tables. The model is OpenVibe.AI
    called with Chat's own service token (`ai.run.create`/`ai.run.read`, audience `openvibe.ai`,
    namespace `chat.*`, workflows `chat.global`/`chat.profile`); when AI does not answer the job
    stores a deterministic extractive summary instead, so the routes always have something to serve.
    Routes (Live's paths, parameters, shapes and public visibility, now under `/api/chat/ai/`):
    `GET /global`, `/timeline` (`?before=&since=&q=&limit=`), `/user/:id`, `/anon/:anonId`,
    `/relay/:platform/:username`, `/timeline/:username`.

## How it fits the network

| Concern | Where it lives | How Chat reaches it |
| --- | --- | --- |
| Messages, DMs, channel sounds, TTS voice overrides, relay users, first chats, IP-approval queue, moderation log | **Chat** (authority from the cutover) | its own database on PostgreSQL (`DATABASE_URL` through `openvibe-sdk/db`; `migrations/` applies at boot); Live reads them through Chat's internal read API |
| Accounts, roles, streams, channels, bans, IP approvals, follows, cosmetics, tags, site settings | **Live** (Network for identity) | `server/live-context.js` → `GET/POST /internal/chat-context/*` (service token, `live.chat_context.read`) |
| Coins, AI viewers, arena, media queue, hardware, pastes, translation, PowerChat, notifications | **Live** | `server/live-context.js` → `POST /internal/chat-effects/*` (`live.chat_effects.write`) |
| Live's own chat pushes and writes (AI viewers, relays, donations, `/api/mod`, recaps, calls) | **Live → Chat** | the Chat-owned ingress `/internal/chat/*` (`docs/chat-ingress.md`), presence `GET /internal/chat/presence` (`chat.presence.read`); the bridge `/internal/live/*` is retired (T3 J3a) |
| The six chat tables (moderators, moderation settings, emotes, tags, AI summaries, timeline) | **Chat** (C-04 done) | Chat's own database; Live reads through `GET /internal/moderation/*` (`chat.moderation.read`), 30 s cached |
| Emote image bytes | **OpenVibe.Media** (namespace `chat`) | `server/media/client.js` (openvibe-sdk `createObjectsClient`), Chat's service token (`media.object.upload` / `.delete`); the row keeps `media_url` + `media_asset_id` |
| Chat-AI summaries (global / per-chatter insight + timeline) | **OpenVibe.AI** (namespace `chat.*`) | `server/ai/client.js` (openvibe-sdk `createAiClient`), Chat's service token (`ai.run.create` / `ai.run.read`); workflows `chat.global` / `chat.profile`; extractive fallback when AI does not answer |
| Identity | **OpenVibe.Network** | user tokens are resolved by Live (its account links); service tokens from `/oauth/token` |
| Events | **OpenVibe.Events** | `service_outbox` (openvibe-sdk outbox) → `POST /api/v1/events` when `EVENTS_URL` and `OV_OAUTH_CLIENT_SECRET` are set (`events.event.publish`); Chat's subscriptions deliver to `POST /internal/events` (`server/events/consumer.js`, `events.subscription.manage`) |

Migration 0008 copies pending `events_outbox` rows into `service_outbox`. The old table stays through the N-1 rollback window; a later contract migration removes it.
| A person's chat preferences | **OpenVibe.Network** user module `chat.preferences` (Chat owns the namespace) | `server/prefs/` → `GET/PUT/DELETE /internal/modules/chat.preferences/:subject` (`network.modules.read` / `.write`), cached per person |
| Member badges | **OpenVibe.VIP** (Billing holds the entitlement) | `server/vip/badges.js` → `POST /api/v1/entitlements/check` with `product: 'chat'` (`vip.entitlement.check`), behind the shared product cache |

### Data

Chat owns (from the cutover): `chat_messages`, `dm_conversations`, `dm_participants`, `dm_messages`,
`dm_blocks`, `tts_voice_overrides`, `channel_sounds`, `relay_users`, `hidden_relay_users`,
`pending_ip_messages`, `stream_first_chats`, `moderation_actions`. Same columns and ids as Live, plus
`subject_id` / `sender_subject_id` / `blocker_subject_id` / `actor_subject_id` /
`created_by_subject_id` (the Network `usr_…` subject, filled on new rows and by the importer).

Chat owns too (C-04 done; there is no authority switch any more): `channel_moderators`,
`channel_moderation_settings`, `emotes`, `user_tags`, `chat_ai_summaries`, `chat_timeline_events`.
Live reads them through `GET /internal/moderation/*`.

Stays in Live: `media_requests`, `media_request_settings`.

### Events

| Event | Visibility | When |
| --- | --- | --- |
| `chat.message.created` | public | every stored message in a public room (global, channel, stream) |
| `chat.dm.created` | subject | every DM; the payload names the participants, never the text |
| `chat.message.deleted` | public | every deletion of public-room messages: one message (moderation), a user's, an anon's or a relay user's history (self-delete, `/api/mod` purge), a time-range purge, and the auto-delete sweep. Only ids (`message_ids`, at most 500 per event), never the text, the author or who deleted it |
| `chat.moderation.action` | internal | every moderation log row (chat commands and Live's `/api/mod`) |

`chat.message.deleted` also carries `payload.redacts: { subject_type: "chat_message", subject_ids }`,
which makes OpenVibe.Events rewrite the stored `chat.message.created` of each id into a tombstone
(no text, no anon id, no author) on every read path, public SSE replay included. Every delete runs
in one transaction with its outbox row, and the relay publishes in outbox order, so the deletion
always follows the message it removes. Messages deleted before this existed are redacted by
OpenVibe.Events' `scripts/redact-backfill.js`.

#### Consumed

Chat subscribes (consumer `chat`) to these topics (and `network.user.token_valid_after`, `vip.membership.changed`), delivered to `POST /internal/events`
(`server/events/consumer.js`):

| Event | From | What Chat does |
| --- | --- | --- |
| `live.release.deployed` | Live (`server/events/release-events.js`), subject `{ type: release, id: <head commit> }` | stores or folds the deploy card in global chat (`server/chat/deploy-notice.js`: one rolling card, folded while nobody has spoken in any room and within 3 hours; the broadcast carries the row id; late joiners get it once) |
| `network.module.updated` | Network (`server/identity/module-events.js`) | for `chat.preferences`, a revision newer than the cached copy drops it (`prefs.handleEvent()`); an older or equal revision and other namespaces change nothing |
| `network.block.changed` | Network (`server/identity/blocks.js`, platform blocks) | keeps the newest revision per (blocker, blocked) in `network_blocks` (`server/chat/network-blocks.js`); while a block is active neither person can start a DM with the other, message them in a 1:1, add them to a group or call them, and the DM user search hides them, exactly like `dm_blocks` (same errors) |

- **One card per deploy** (compatibility register C-84, closed). The event is the only path: the
  bridge op `deployNotice` is retired (T3 J3a); `deploy_releases.first_via` / `bridge_at` keep what
  it recorded. The event claims the head commit in `deploy_releases` in the transaction that stores
  or folds the card; a later delivery for that head finds it claimed and changes nothing but its
  `event_at`. A redelivered event and Live re-announcing after a crash are the same card. A redeploy of a head already announced (a rollback to it) says nothing.
  A release event older than 6 hours (an operator replay) is `ignored:stale`.
- **Exactly once.** The openvibe-sdk inbox (`chat_event_inbox`, pruned after 35 days) claims
  `(chat, event_id)` in the same transaction as the change, and broadcasts run only after it
  commits. A failure answers 500 and rolls both back; Events retries.
- **Signature v2 only** (`parseDelivery` with `requireV2`): HMAC over `"<t>.<raw body>"` under
  `CHAT_EVENTS_SECRET`, `t` within ±300 s. A bad, stale, v1-only or unsigned delivery is 401; no secret
  is 503; a request that came through nginx (a forwarding header) is 403.
- **Subscriptions** are created at boot when missing (`server/events/subscriptions.js`: list, then
  create; Events answers 409 for a duplicate, so it is idempotent), retried in the background while
  Network or Events cannot answer. An existing subscription is left as it is, even disabled, so a
  rollback survives restarts. `CHAT_EVENTS_SUBSCRIBE=0` turns this off. Needs `EVENTS_URL`,
  `CHAT_EVENTS_SECRET`, `OV_OAUTH_CLIENT_SECRET` and the Network grant
  `chat events.subscription.manage openvibe.events`.

Platform blocks (WS-E task 5): Chat's own `dm_blocks` stay in force beside Network's. To carry them over
once, export them as subject pairs and import those on Network (`scripts/import-blocks.js` there):

```bash
node scripts/migrate-dm-blocks-to-network.js [--resolve]                        # dry run: counts and unmapped Live ids
node scripts/migrate-dm-blocks-to-network.js --apply --out /root/dm-blocks.json # write the pairs file (0600)
```

Mentions: Chat produces no mention notifications (the @mention highlight, tab flash and sound are drawn by
Live's chat client from the broadcast message), so there is nothing in Chat for a block to suppress yet.

```bash
sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js --dry-run   # list them
sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js --disable   # rollback: no more deliveries
sudo node --env-file=/etc/openvibe/chat.env scripts/subscribe-events.js --enable    # undo it
```

`/ready` reports the consumer under `events.consumer` (received, applied, duplicates, ignored, refused,
failed, the last type and outcome); `SELECT * FROM deploy_releases ORDER BY created_at DESC` shows
which path delivered each deploy first and when the other one arrived.

### Calls

Live's voice/video calls moved here (roadmap WS-I task 1, `server/calls/`). They are served with `CHAT_CALLS=1`,
which production has run since the calls cutover of 2026-10-10 (`docs/calls-cutover.md`):

- **`/ws/call`** — Live's call server with the same protocol: `?channelId=` (or a stream number),
  signalling only (full-mesh WebRTC; `offer`/`answer`/`ice-candidate` relayed, `mute`, `camera-off`,
  `speaking`, `auth-update`, `force-mute`, `force-camera-off`, `kick`, `ban`, `unban`, `end-call`), the
  permanent `public` lobby, one temporary channel per person (private for a 1:1 call), stream-linked
  channels, 8 participants, 3 sockets per address, a one-minute kick cooldown, per-channel bans, empty
  channels deleted after an hour. Sign-in is Chat's (as on `/ws/chat`); accounts, streams and cosmetics
  come through `live-context`; the voice-channel list and call invites go out through Chat's chat server.
- **REST on Live's paths** (`server/calls/routes.js`): `GET/POST /api/streams/voice-channels`,
  `GET/DELETE /api/streams/voice-channels/:channelId`, `POST …/call-user` and `…/call-user/respond`,
  `GET/PUT /api/streams/:id/call` (the streamer, checked through `live-context`).
- **Live's stream hooks** (`server/calls/internal.js`, Live `CALLS_AUTHORITY=chat`):
  `POST /internal/calls/stream-channel { stream_id, mode, user_id }` and
  `DELETE /internal/calls/stream-channel/:streamId` — a Live service token with capability
  `chat.live_bridge.write` (the name is from the retired chat bridge; Live holds the grant), loopback only.
- **From a conversation on openvibe.chat** (`server/web/pages.js`, `public/web/ring.js`, `public/web/call.js`): a 1:1
  conversation nobody blocked has **Call <name>**. It rings through `call-user` (its limits, block check and ring row)
  and opens `/call/<channel>`, the call's page. The page is for its caller and the people it invited (404 to anyone
  else), and it joins as it opens. While the caller waits it says *Ringing …* and listens on `/ws/chat` for the answer;
  declined, busy or no answer leaves the call. Every signed-in page has `ring.js`: a ring shows who is calling with
  **Answer** (tells the caller, opens the call page) and **Decline**. After 30 s it gives up with `no-answer`, and a
  person already ringing or in a call answers `busy`. The invite reaches Live's chat sockets too, so a call can start
  on one site and be answered on the other.
- **Lifecycle** (`server/calls/lifecycle.js`, table `calls`): a ring is `direct`, `pending → ringing →
  active → ended`, or `missed` (no answer within `CALL_RING_TIMEOUT_MS`, 45 s; the caller is told),
  `declined` (declined or busy) or `failed` (the invite could not be delivered, with the reason); a
  channel's occupancy is a `channel` / `stream` session, `active` while anyone is in, `ended` when it
  empties or closes. A restart closes what was open (reason `restart`).

### Rooms (openvibe.chat)

Chat's authority resource index serves `GET /api/v1/resources` (with `project`, `kind`, `cursor`,
and `limit` filters) and `GET /api/v1/resources/:ovrn` to first-party service tokens carrying
`chat.resource.read`. It lists active rooms as `chat.room` summaries. Rooms belong to people,
so they have no project ID or OVRN; the named-resource route always answers 404. The index is
loopback only and is not forwarded by the public nginx vhosts.

Rooms people create on openvibe.chat (roadmap WS-I task 4, `server/rooms/`), beside the global room and
Live's stream and channel rooms: `/api/chat/rooms` (REST), `join_room` / `room_message` on `/ws/chat`,
and the pages `/rooms`, `/r/:slug`, `/r/:slug/settings`. Public rooms: anyone reads, signed-in people
join. Private rooms: members only; to anyone else they answer exactly like a room that does not exist
(read, join, post, members, attachments, the call). Unread counts per room (`last_read_id`) and
`last_seen_at` per member (moderators see it).

Kinds: **community** (anyone starts one), **call** (the room a call happens in: its text chat, and the
voice/video channel `room-<slug>` on `/ws/call`; anyone starts one) and **system** (announcements
written by chat staff, read-only for people; only chat staff create them). Roles, and what they may do
(`rooms.access()` is the one place this is decided):

| Kind | Role | Read | Post | Join the call | Talk | Moderate | Manage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| community | owner / mod / member / viewer | all | owner, mod, member | – | – | owner, mod | owner |
| call | owner / mod / speaker / participant / viewer | all | owner, mod, speaker, participant | all | owner, mod, speaker | owner, mod | owner |
| system | owner / mod / viewer | all | owner, mod | – | – | owner, mod | owner |
| any | blocked | – | – | – | – | – | – |
| any | no role | public rooms only | – | public call rooms (listening) | – | – | – |

Chat staff (`staff.moderation.chat`) read, moderate and manage every room, post in system rooms and talk in
calls; a site ban stops posting and talking. Joining gives the kind's role: member, the call room's
`join_role` (participant by default; the owner may pick speaker or viewer) or viewer. The owner (and chat
staff) appoint mods; owners and mods set every other role; roles outside the room's kind are refused
(`rooms.role_kind`). Role changes on someone else are logged (`room_block`, `room_unblock`,
`room_mod_add|remove`, `room_speaker_add|remove`) through the moderation log. A change reaches open sockets at
once: `/ws/chat` followers get `room_access { role, can }` (or `room_left`), and a running call follows the
room (below).

**Call rooms.** The call server makes the channel `room-<slug>` on first use and keeps it; it is not in Live's
voice-channel list. Who may read the room may join its call; owner, mods and speakers talk; participants,
viewers and people without a role (anonymous too, in public rooms) join listen-only: force-muted with the
camera forced off, their own unmute ignored, and a moderator cannot lift it (make them a speaker instead).
Peers see `roomRole` / `canTalk` on each participant. Promoting, demoting or blocking someone sends them
`room-role` and the force-mute state, or drops them; a ban inside the call is also the room's block; making
the room private drops everyone who is not a member. Media is peer to peer, so listen-only is enforced by
clients honouring force-mute, as every force-mute here. openvibe.chat's room page carries an audio call
client (`public/web/call.js`), shown when `CHAT_CALLS=1`; ICE comes from `GET /api/chat/ice-servers`
(`server/net/turn.js`, Live's `turn.js` logic: STUN, plus TURN when `TURN_URL` is set with
`TURN_AUTH_SECRET` or `TURN_USERNAME`/`TURN_CREDENTIAL`).

**Attached to a Community space.** `POST /api/chat/rooms/:slug/attachments { service: "community",
resource: <space slug>, title? }` (201 created, 200 already there), `DELETE
/api/chat/rooms/:slug/attachments/community/:space` (idempotent), `GET …/attachments`. Only a person who
manages the room (owner or chat staff), with their own Network token, attaches it (API tokens are refused);
the room's managers or whoever attached it detach. Community keeps the link on the space and checks its own
side (the space's owner or staff), so one person holding both ends makes the link, and no service grant is
involved. Chat shows attachments only to the room's managers (room settings, with Detach), never as a public
claim on the room page.

**AI members** (`server/rooms/ai-members.js`, `migrations/0012_room_ai_members.sql`; the owner's ask: friend groups
and couples with AI members, and a Food household's chat with one that knows the pantry). A room's owner (or chat
staff) adds up to 3: a name (its `@handle` is the name in lowercase), how it should be, and notes it always knows.
When someone who may post writes `@handle`, it answers: the room's last 30 messages, its notes and any shared context
go to OpenVibe.AI's `chat.member.reply` with Chat's own service token, attributed to the room
(`{ service: chat, type: room }`), and the answer is a room message with `ai_member_id` set and `user_id` 0, shown with
an AI badge, never as a person. Sockets get `room_ai_typing { room, name }` first. Only the first member named answers;
it never answers an AI message; one answer at a time per room, 20 an hour from one person, and
`CHAT_AI_MEMBER_REPLIES_PER_DAY` (100) a room a day, past which it says so instead. `CHAT_AI_MEMBERS=0` keeps them
quiet (independent of the insight job's `CHAT_AI_ENABLED`). An AI member linked to an OpenVibe.Food household
(`link_service: food`) also gets the household's pantry and plan, read from Food's
`/internal/households/:plan/chat-context` with Chat's service token (`food.household.read`, at most once a minute;
`CHAT_FOOD_INTERNAL_URL`). API: `GET|POST /api/chat/rooms/:slug/ai-members`, `PATCH|DELETE …/ai-members/:id` (people
only; members see names and handles, managers the set-up); the settings page manages them without JavaScript. A room
member can also be added by account subject: `POST /api/chat/rooms/:slug/members { subject: "usr_…" }`. Deleting an
account keeps the AI members it added (they belong to the room) without its subject on them, and exports them.

**Tools** (`server/rooms/ai-tools.js`; the owner's "modular AI conversation… tool calling"). An AI member's answer
is a few turns of OpenVibe.AI's `chat.member.turn` (a Chat Completions passthrough with tools, AI#96): the model may
call `search_openvibe` (OpenVibe.Search's public results, `CHAT_SEARCH_URL`), `current_time`, `roll_dice`,
`pick_one`, and for a member linked to a Food household `household_pantry`; Chat runs them (read-only, bounded, results
at most 4,000 characters) and sends the results back, at most three rounds with four calls each, then a turn that must
answer in text. If a turn fails (a provider without tools), the member answers with `chat.member.reply` as before.
`CHAT_AI_MEMBER_TOOLS=0` turns tools off.

**Their own models** (`migrations/0014_ai_member_models.sql`, `server/ai/credentials.js`; the owner's multi-model group
chat). A person keeps an AI provider key through Chat: OpenAI, Anthropic, or any OpenAI-compatible endpoint (OpenRouter,
Groq, Together, their own server), a model and a daily budget in US dollars (0 = no cap; left out on a change, it stays).
The key goes to OpenVibe.AI (`PUT|GET|DELETE /api/v1/credentials/:subject`, Chat as its owner, Network grant
`chat ai.credential.manage`) and is never shown again, only a four-character hint and today's spend. A room's manager
sets a member to think with their own key (`engine: own`; `openvibe` is OpenVibe's model): its answers are runs that
name `credential { subject }`, so they reach that provider only, count against the key's budget and not the room's
daily cap. The room page and the API (`model`) say which model each member uses ("openai (openrouter.ai) · gpt-4o-mini,
Ann's key"). Removing the key (or the account) sends its members back to OpenVibe's model; a new model relabels them.
API: `GET|PUT|DELETE /api/chat/me/ai-key` (own sign-in only, not API tokens); pages: `/settings#oc-ai-key` and the
"Thinks with" choice on each AI member. A server's admins give a text channel AI members at `/r/<channel room>/settings`,
linked from the channel on the server's settings page.

**Servers** (`server/rooms/servers.js`, `server/rooms/server-routes.js`, `server/web/server-pages.js`,
`migrations/0013_chat_servers.sql`; the owner's Q14: friend groups and couples first, then communities with servers,
channels and voice). A server is a group of rooms, its channels, with one membership and one set of roles: a text
channel is a community room and a voice channel a call room (its call is `room-<slug>`), so messages, live delivery,
unread counts, calls and AI members work in channels unchanged. `rooms.access()` asks the server for any room with
`server_id`: the owner is the channel's owner, admins and moderators its moderators, members its members (in a voice
channel: speakers by default, or listeners when the channel says participant); a public server is read by anyone
and joined by signed-in people, a private one is a 404 to outsiders and joined only through an invite
(`/join/<code>`: any number of uses or 1/10/100, for a day, a week, a month or forever, revocable). The owner appoints
admins, admins appoint moderators and manage channels, settings and invites, moderators remove and ban members;
nobody acts on their own rank or above, and every action is logged (scope `server:<slug>`). A server starts with
`#general` and a voice Lounge; a person owns up to 5, a server has up to 50 channels and 25 live invites and keeps one
text channel. A channel's room slug is random (`ch…`); its page is `/s/<server>/<channel>` and `/r/<slug>` goes
there. Channels follow the server's visibility (going private redacts what they had published); the rooms API refuses
room-level joins, roles and visibility there, and `/rooms` leaves channels out. The page: your servers down the side
with unread counts, the channels, the channel (its call for a voice channel) and the people by rank; on a phone the
servers run across the top and the channel list folds away. API: `/api/chat/servers` (list, create, read, update,
delete, join `{ invite? }`, leave, members, channels, invites, `GET /invites/:code`). Deleting an account removes its
memberships; a server it owned stays without an owner while anyone else is in it, and goes with its channels when
nobody is.

**Pictures** (`server/rooms/pictures.js`; the owner's "files and pics" for Chat, through OpenVibe.Pics). A person who
may post sends a picture from the room's or channel's "Add a picture" form (it works without JavaScript; with it, the
file goes to `POST /api/chat/rooms/:slug/pictures`, the body the picture and an optional `X-Caption`) and Chat hands it
to OpenVibe.Pics **as that person**: their own Network token, through MediaHub on this host
(`CHAT_PICS_INTERNAL_URL`, `Host: openvibe.pics`, their address in X-Forwarded-For), so the picture is theirs on Pics
(re-encoded without its metadata, reportable, deletable, inside their Pics limits). The room gets a message with the
caption and the picture's link. Rooms and channels show OpenVibe.Pics direct links (`https://openvibe.pics/i/<slug>.<ext>`)
as thumbnails (`/i/<slug>/thumb.webp`) linked to the picture's page, at most four a message, on the page and live
(chat.js); no other host's images, and global and stream chat stay text. JPEG, PNG, GIF, WebP and AVIF up to
`CHAT_PICS_MAX_BYTES` (20 MB); `chat.room.picture` 10 a minute and 120 an hour per person; API tokens cannot send
pictures. Off (no form; the API answers 503 `pictures.off`) without `CHAT_PICS_INTERNAL_URL`.

**openvibe.chat pages.** `/` global chat, `/rooms` and `/r/:slug` (above), `/servers`, `/s/:slug[/:channel]`,
`/s/:slug/settings` and `/join/:code` (servers, above), `/messages` the DM inbox
(conversations with unread counts, refreshed every 15 s with JavaScript; who you blocked, with Unblock),
`/messages/:id` a conversation (participants only; a guessed id is the same 404 as a missing one; Block
the other person of a 1:1 conversation, which closes it both ways), `/settings`, `/updates`. The navigation
counts unread messages, room messages and server messages. Everything is server-rendered and works without JavaScript.

**Working with Live down.** Nothing on openvibe.chat waits on Live: people sign in from their Network token
and the `ctx_users` projection, pages read Chat's own tables, cosmetics are waited for at most 1.5 s, and
the only openvibe.live URLs are profile links. `test/live-down.test.js` renders every page and uses the
forms, the core APIs and the socket with Live refusing connections and with Live hanging.

### Vibe, OpenVibe's assistant (openvibe.chat/vibe)

The owner, 2026-10-24: "turn openvibe.chat into the main chat app", familiar like ChatGPT (plan track K,
`OpenVibe_Consumer_Plan_2026-10-24.md`). `/vibe` is that app: the person's chats with Vibe down the left (Today,
Yesterday, Previous 7 days…), the conversation in a readable column, one composer at the bottom, suggestions on a new
chat, and the rest of Chat (Messages, Rooms and servers, Global chat) under the list. It works without JavaScript
(forms post; the page shows Vibe's answer once written); `public/web/vibe.js` starts a chat in place, follows the room
socket, sends on Enter and keeps a draft typed while signed out through the sign-in.

- **A chat is a private room** (`server/rooms/vibe.js`, `migrations/0015_vibe_chats.sql`: `rooms.assistant = 1`) the
  person owns, with one AI member, Vibe, who answers every message without being named (`ai-members.js` afterPost).
  Messages, pictures, the socket (`join_room`, `room_message`, `room_ai_typing`), export and account deletion are the
  rooms'. Nobody can be added to it and it cannot be made public; it is not listed with rooms, does not count toward
  the 10 rooms a person may own, and is not in the unread counts. A chat is named after its first message (40
  characters, cut at a word); deleting one deletes its messages (not archived).
- **Vibe's instructions** (`vibePrompt`): a private chat with the person, Markdown answers (rendered by
  `public/web/vibe-md.js`, which escapes everything first and links only http(s)), the last 30 messages at 2,000
  characters each, answers up to 8,000 characters (1,500 tokens). Tools: `search_openvibe`, `read_page` (a page's text
  through OpenVibe.Tools' `read` tool, `CHAT_TOOLS_URL`; Tools decides what may be reached), `web_search` (the open
  web: an OpenVibe.Actor task for the person who asked, `server/rooms/web-search.js`, with Chat's own token and the
  person in `X-OV-Subject`; Network grants Chat `actor.task.create` and `actor.task.read`; `CHAT_ACTOR_INTERNAL_URL`;
  it counts against the person's Actor allowance; Vibe added to a room has it too), the time, dice, picks. It says
  plainly what it cannot do yet (make pictures, use the person's computer, reminders).
- **Pictures** (`pictures.forModel`, `ai-members.js` `picturesFor`): an AI member (Vibe included) sees the
  OpenVibe.Pics pictures a message links, or those of the asker's message just before it (picture first, then the
  question), at most two, fetched from Pics on this host (Host `openvibe.pics`, at most 4 MB each) and sent as image
  parts with the question. The app's composer has a picture button (or paste one); a new chat can start with a
  picture: `POST /api/chat/vibe/picture` (the body is the picture, the question in `X-Caption`) creates the chat and
  posts the picture through Pics as the person; a picture Pics refuses leaves no chat behind.
- **Limits:** `CHAT_VIBE_REPLIES_PER_DAY` (100) answers a person a UTC day across all their chats (`vibe_usage`;
  deleting a chat gives none back), 60 messages an hour, 500 chats kept (starting one more deletes the oldest), the
  rooms' post limits. `CHAT_VIBE=0` turns Vibe off (it also needs AI members on and Chat's OAuth secret).
- **API:** `GET /api/chat/vibe` (chats, allowance), `POST /api/chat/vibe { message }` → 201 `{ room, message }`,
  `PATCH /api/chat/vibe/:slug { name }`, `DELETE /api/chat/vibe/:slug`; then the rooms API for messages. People only
  (an API token gets 403).

### Support inboxes and the website widget (openvibe.chat/inbox)

The owner, 2026-10-24: one chat system "from your private conversations to your random live chat widget on websites",
for people and for companies, with "direct live support with an agent", "fully modular and SDK and API"
(`docs/platform.md` has the comparison with Intercom, Crisp, Chatwoot, Stream and the order of work). An **inbox**
(`server/inbox/`, `migrations/0016_support_inboxes.sql`) is a team's support desk that any website opens with one tag:

```html
<script src="https://openvibe.chat/widget.js" data-inbox="inb_…" async></script>
```

- **The widget** (`public/web/widget.js`, under 3 KB compressed): a bubble in a shadow root (the site's CSS cannot
  reach it) that opens the panel `openvibe.chat/embed/inbox/:id` in a frame on first use. `data-position="left"`,
  `data-color`, `data-open="1"`. From the page: `OpenVibeChat.open()`, `.close()`, `.toggle()`; events
  `openvibechat:open`, `:close`, `:message` (an answer arrived; the bubble shows a dot while closed). On phones the
  panel is full screen.
- **The visitor** needs no account: a random token (24 bytes) kept in the frame's own storage, stored only as its
  SHA-256, resumes their conversation; the page they wrote from is kept with it. The panel says who answers (Vibe, a
  person, waiting) and has "Talk to a person" while Vibe answers.
- **Vibe answers first** when the inbox has it on: from the inbox's instructions and up to 10 of its pages
  (`read_page`, those hosts only), with the conversation so far; it never invents prices, policies or order details,
  and ends with `[HANDOFF]` (not shown) when a person should take over, which makes the conversation `waiting`. At
  most 30 answers a conversation and `CHAT_INBOX_AI_REPLIES_PER_DAY` (500) an inbox a UTC day; then it waits for a
  person. A person's reply takes the conversation (`open`) and Vibe stays quiet in it; resolving it closes it, and the
  visitor's next message starts a new one.
- **The inbox's people** (an owner and up to 50 agents, added by username; a person makes at most 10 inboxes) work at
  `/inbox/:id`: conversations down the left (Active, Waiting, Resolved), live over the chat socket (`inbox_watch`),
  replies on Enter. The owner's settings page shows the tag, the greeting, colour, Vibe's instructions and pages, and
  **allowed sites**: once named, only those sites may frame the panel (`frame-ancestors`) or call the visitor API;
  until then any site may.
- **A site assistant** is an inbox whose people do not answer (`handoff` off in its settings): Vibe answers alone, there
  is no "Talk to a person", Vibe is told nobody else answers (it points to the contact details in the instructions
  instead of handing off), and when it cannot go on the visitor is told plainly. An inbox needs Vibe or its people.
- **Ratings:** a resolved conversation asks the visitor "How was this?" (👍 / 👎, then a line if they like:
  `POST /rating { token, rating: 1 | -1, comment?, conversation? }`); the people see it in the list and the
  conversation, live (`inbox_rating`).
- **Nobody misses a visitor:** when a conversation starts waiting (the visitor asked for a person, Vibe handed off,
  or Vibe is off) or a visitor writes while it waits or is open, and none of the inbox's people has it open live, each
  of them (or only whoever took the conversation) gets an OpenVibe notification through the Network
  (`server/inbox/notify.js`; Chat's service token, `network.notifications.push` as service `chat`), at most one per
  conversation every 10 minutes except when it starts waiting. `CHAT_INBOX_NOTIFY=0` turns it off.
- **Build your own panel** with the visitor API, which answers any site without cookies (CORS open, the token is the
  key): `GET /api/chat/widget/inbox/:id` (name, greeting, colour, whether Vibe answers), `POST /visit { token? }` → `{
  token, conversation, messages }`, `GET /messages?after=` (token in `X-Visitor-Token`), `POST /messages { token,
  message, page_url?, name? }`, `POST /handoff { token }`. Visits 60 a minute, messages 20 a minute.
- **Agents API** (signed in, or an API token acting as its person): `GET/POST /api/chat/inboxes`, `GET/PATCH/DELETE
  /api/chat/inboxes/:id` (the answer carries `embed.script`), `POST /:id/members { username }`, `GET
  /:id/conversations?status=active|bot|waiting|open|resolved`, `GET|POST /:id/conversations/:cid/messages`, `PATCH
  /:id/conversations/:cid { status }`, `POST /:id/conversations/:cid/read`. Socket: `{ type: 'inbox_watch', inbox }`
  (a person of the inbox) or `{ type: 'inbox_watch', inbox, conversation, visitor_token }` (the visitor), then
  `inbox_conversation`, `inbox_message`, `inbox_status`, `inbox_typing`.
- Export and account deletion cover inboxes: the owner's inboxes go with their conversations; an agent's replies in
  other inboxes stay, signed "A former agent".

### Feeds: vibe coding, live (openvibe.chat/feeds)

The owner, 2026-10-24: "improve the vibe coding feed feature on live and migrate that whole entire feature so it's built
into the openvibe.chat system". A **feed** (`server/feeds/`, `migrations/0017_feeds.sql`) is live activity a person
publishes into Chat; vibe coding, moved from OpenVibe.Live (its `server/vibe-coding/`, same canonical events), is the
first kind. Viewers see a card (`public/web/feed-view.js`): turns of a prompt, the steps taken (tools used, files
changed) and the answer, the newest open, a live dot while steps arrive.

- **Where it shows:** in a room its owner owns (above the messages), on the owner's Live channel slot while it is live
  (as Live's `vibe-coding` frame on the stream's chat, which Live's channel widget reads), and on any site:
  `<iframe src="https://openvibe.chat/embed/feed/fed_…">` (`?theme=light|dark`; it tells the parent its height,
  `{ ov: 'chat', type: 'feed-height' }`).
- **Publishing** with the feed's key (`ovf_…`, shown once, stored as its SHA-256; a new one on request):
  - **Claude Code**: the feed page gives a `.claude/settings.json` block of `http` hooks (SessionStart,
    UserPromptSubmit, PostToolUse, Stop, SessionEnd) that post each hook's JSON as it is to
    `POST /api/chat/feeds/:id/hooks/claude-code` with `Authorization: Bearer $OPENVIBE_FEED_KEY`. A prompt, a tool
    used (an edit is a file event), the turn's answer (`last_assistant_message`); paths become relative to the
    session's folder; nothing is read from the transcript; the answer is always `{}`, so it never blocks Claude Code.
  - **Anything else**: `POST /api/chat/feeds/:id/events` with one event, `{ events: [...] }` (at most 50) or Live's
    `vibe-coding.event` envelopes; `POST /:id/hello { sessionKey, publisher }`. `eventType` is `session.status`,
    `prompt`, `response`, `thinking`, `tool.call`, `file.change` or `file.save`; a short `{ eventType, text }` works.
    600 events a minute a feed.
- **Safety:** every event is scrubbed on the way in: API keys and tokens (OpenAI/Anthropic, GitHub, Slack, AWS,
  Google, JWTs, OpenVibe's own), `Bearer …`, `PASSWORD=`-style values, credentials in URLs, private keys, and home
  folders (`/home/<name>` → `~`). What a viewer sees is decided when they see it by the feed's settings (Live's
  projection): prompts, answers, tools, what the tools were given (off by default), files (names only by default),
  thinking (off by default), detail, paused. The **delay** is the server's: neither the socket nor the history shows
  a step before it (Live sent the delay to the browser).
- **API:** anyone: `GET /api/chat/feeds/:id` (what a viewer sees now), `GET /api/chat/feeds?channel=<username>` or
  `?slot=<id,…>` (the feeds on Live channel slots, what Live's chat asks); the owner: `GET /api/chat/feeds/mine`,
  `POST /api/chat/feeds { title, room?, slot?, settings? }` → `{ feed, key }`, `PATCH /:id`, `POST /:id/key`,
  `DELETE /:id`. The public and publishing routes answer any site without cookies. Socket: `{ type: 'feed_watch',
  feed }`, then `feed_event { feed, event }`. A feed keeps its newest 5,000 events; at most 10 feeds a person.
- **From Live:** `scripts/import-live-feeds.js --file <export.jsonl> [--apply]` copies each slot's feed (settings,
  sessions, its newest 5,000 events, scrubbed) and verifies the copy; Live then drops `vibe_coding_*`.
- Export and account deletion cover feeds (never the key's hash).

### VIP member badges

A member's messages in a creator's room (stream or offline channel chat) carry that creator's VIP
badge: a perk of the member's plan **version** with a `chat badge` product binding (VIP's network
perk `subscriber-badge` has one), unless the member turned it off in VIP (`show_badge`). The frame
gets `vip_badge: { creator, perk, name, badge, label? }` and the row's `metadata` keeps it, so history
shows it. `badge` is a short id (`subscriber`, else `member`) and `label` plain text: binding config is
written by creators, so nothing else of it passes and clients render both as text.

- **Never blocks sending.** The badge comes from the cache only (`peekEntitlement`); the lookup starts
  when a member joins a room, so their first line normally has it. On a miss the message goes out
  without a badge and, if the lookup then finds one, a `chat_vip_badge` frame `{ id, vip_badge,
  stream_id, channel_user_id }` follows to the same rooms (clients attach it by message id, as with
  `chat_translation`) and the row's metadata is updated.
- **Fails closed.** VIP unreachable or slow, no client secret, a refused grant, a malformed answer, an
  inactive or `unknown` entitlement → no badge. `CHAT_VIP_BADGES=0` turns lookups off.
- **Convergence bound.** Chat does not subscribe to VIP's events yet, so when a membership ends (Billing's
  `billing.entitlement.changed` → VIP's `vip.membership.changed`) the badge stops at most
  `CHAT_VIP_BADGE_TTL_MS` (60 s) after VIP stops granting, never past the entitlement's `expires_at`;
  end to end, add VIP's own bound (seconds with events, at most `VIP_PROJECTION_MAX_AGE_MS` without —
  OpenVibe.VIP README, "The product cache and the convergence bound"). A new member's badge appears
  within `CHAT_VIP_BADGE_DENY_TTL_MS` (30 s). `badges.handleEvent()` drops a pair at once, for when
  `vip.membership.changed` is added to the Events consumer. `test/vip-badge.test.js` drives all of this against a stub VIP with an
  injected clock.
- Needs the Network grant `chat vip.entitlement.check openvibe.vip`; without it VIP answers 403 and
  nobody gets a badge. The client is vendored from OpenVibe.VIP (`server/vip/vip-client.js`, copied
  at VIP 2accbeb) until VIP publishes a tag to pin.

### Chat preferences

`GET /api/chat/preferences` and `PUT /api/chat/preferences { preferences: { … } }` (a patch; `null`
removes a field; optional `If-Match: <revision>`) read and change the signed-in person's chat
preferences. They live in OpenVibe.Network as the user module `chat.preferences` (openvibe-contracts
namespace, schema v1: `timestamps`, `compact`, `font_scale` 0.75–2, `show_badges`, `hide_emotes`), which
Chat owns since the cutover; Network validates, versions (revision, the ETag here) and announces each
change as `network.module.updated`. Chat reads and writes with its service token (Network grants `chat
network.modules.read` and `network.modules.write` on `chat.preferences`) and names the revision it read on
every write, so another writer is never overwritten (Chat reads again and re-applies the patch; a browser
If-Match is strict: 412).

Three more modules work the same way, with `{ settings: { … } }` as the body (openvibe-contracts 0.41.0):

| Route | Module | Fields | Enforced by |
| --- | --- | --- | --- |
| `/api/chat/tts-settings` | `chat.tts_defaults` v2 | `send`, `send_while_live`, `volume`, `sounds`, `sound_volume`, `sources` | Live's chat panel |
| `/api/chat/dm-settings` | `chat.dm_settings` | `new_conversations` (`everyone`/`nobody`), `group_invites`, `previews` | the DM routes. `nobody` refuses a new direct conversation, but an existing one stays open; `group_invites: false` refuses groups (`dm.not_accepting`, `dm.no_group_invites`) |
| `/api/chat/presence` | `chat.presence_prefs` | `show_in_user_list` | the user list. A hidden person is counted in `hiddenCount`, not named |

openvibe.chat's Settings page edits all four. When Network cannot answer, an enforcement check uses the defaults, so an outage never locks anyone out.

- **Cache.** One entry per person for `CHAT_PREFS_TTL_MS` (60 s). Chat's own writes land in it at once; a
  change made through Network directly (the person's account page) shows at once: its
  `network.module.updated` reaches the Events consumer, and `prefs.handleEvent()` drops the cached copy
  when the revision is newer (without the subscription, within the TTL). Network down: the cached copy
  with `stale: true`, else 503; writes 503.
- API tokens read only. A person Live knows without a Network subject gets 409 `prefs.subject_unknown`.
## Running it

```bash
npm install
cp .env.example .env          # OV_LIVE_INTERNAL_URL, Network URLs, OV_OAUTH_CLIENT_SECRET, SOUNDS_PATH
npm start                     # 127.0.0.1:4400 — /ws/chat, /api/{chat,dm,tts,sounds}, /health, /ready (CHAT_CALLS=1: /ws/call, /api/streams/…)
npm test                      # Node 22; stub Live and Network in-process
npm run test:pg               # the same on PostgreSQL + PgBouncer + Valkey (OV_TEST_PG_URL, OV_TEST_PG_DIRECT_URL,
                              # OV_TEST_VALKEY_URL: openvibe-sdk scripts/test-services.sh up)
node scripts/subscribe-events.js --dry-run   # Chat's Events subscriptions (boot creates missing ones)
node scripts/parity.js        # chat parity scenarios: a dry run; --apply only on test accounts (docs/parity.md)
N1_LIVE_REF=<live sha> npm run n-1:record   # after a deploy: the N-1 fixtures from the deployed commit
```

`test/n-1.test.js` (roadmap WS-P task 11, in `npm test`) runs the previous release's clients against
this one and its SQL against this schema, from `test/fixtures/n-1/`: every call Chat's pages, the
openvibe.chat pages' links, scripts and forms, and Live's chat widget, messenger and pickers make
(status, JSON, the fields they read), the `/ws/chat` messages Live's chat sends with the replies it
reads, and every statement the previous release runs, which must still prepare after this release
migrated a database the previous one created. After each deploy,
record the release now in production as the next N-1 (`npm run n-1:record [ref]`, with `N1_LIVE_REF`
the Live release in production, from a Live checkout at `N1_LIVE_REPO`, default `../OpenVibe.Live`)
and commit the fixtures.

`/ready` (openvibe-shared/ready shape: `status` ready/degraded/not_ready and `checks`) is 503 only
when the `db` check (a read of `chat_messages`) fails. `live_sync` is optional: it reads degraded when
the last clean Live sync is older than `LIVE_SYNC_STALE_MS` (default 60 s) or a sync step has missed
its own interval by that much. It also reports whether events are relayed and the Events consumer's
counters.
Production: `deploy/systemd/openvibe-chat.service`, `deploy/nginx/openvibe.live-chat.locations.conf`,
`/etc/openvibe/chat.env`. The listener on 127.0.0.1:4400 belongs to `openvibe-chat.socket` (with the
`openvibe-chat.service.d/socket.conf` drop-in): HTTP requests that arrive during a restart wait for the new process
instead of getting 502s (open WebSockets still reconnect); ovhost restarts the service, never the socket.

Request telemetry: counted by route template, method and status class, not raw URL; `/shared` files,
static assets, health, readiness and `/metrics` are not counted. One `http.request` sample per key a
minute, plus the active-requests, p95 latency and event-loop-lag gauges, goes to `telemetry_samples`
(openvibe-sdk 0.46, `platform.telemetry-sample@1`; `migrations/0011_telemetry.sql`), pruned daily past
14 days. `server/app.js` mounts the SDK's `telemetryMiddleware` (a no-op until init); `server/index.js`
calls `telemetry.init()` at production start, runs the retention and flushes on stop.

### Per-actor limits

The REST API also limits who calls it (`server/net/actor-limits.js`, openvibe-sdk/limits, roadmap
WS-R task 4). A person counts as `user:usr_…` whether they call with their Network token or an `hbt_`
API token (a bot counts as its owner); anyone else by their address. Browsers call these routes
themselves, so no service speaks for many visitors here; Live's service calls (the ingress at
`/internal/chat`, the stream hooks at `/internal/calls`) carry every viewer's chat and are never
limited. The per-address `/api/` limit and the chat flood controls (the socket's: a message a second, and
the same line at most 3 times in 30 s in a room, with punctuation-only lines counted as one and commands and
the room's moderators exempt; DMs 10 a minute and 5 new conversations an hour, rooms 6 every 10 s, 6 rings a
minute) stay. Past a limit: `429`
problem+json `rate_limited` with `Retry-After`, one `[Limits]` log line and
`chat_rate_limited_total{limit,window}`.

| Routes | Per caller |
| --- | --- |
| Reads of each API (`/api/chat`, `/api/dm`, `/api/tts`, `/api/sounds`, `/api/emotes`, `/api/streams`) | `CHAT_LIMITS_MINUTE` / `CHAT_LIMITS_HOUR` (120 a minute, 3000 an hour) |
| GIF search and trending (Tenor or Giphy on the site's key) | 60 / 600 |
| Chat search, staff and streamer logs, purge preview | 30 / 600 |
| Log export, `GET /api/chat/me/export` | 5 / 30 |
| `POST /api/chat/send` (bots to global chat) | 20 / 300 |
| `DELETE /api/chat/admin/purge` | 10 / 100 |
| DM: new conversation 10 / 60; send 30 / 900; mark read 60 / 1200; members, rename, blocks 20 / 200; delete own message 60 / 600 | as listed |
| Rooms: create 10 / 60; post 60 / 1200; delete a line 60 / 600; settings, join, leave, members 30 / 300; mark read 60 / 1200; attachments 10 / 100 | as listed |
| Sounds: upload (channel or alert) 10 / 60; delete, command edit, alert clear 30 / 300 | as listed |
| TTS: admin settings 30 / 300; admin test (synthesizes) 10 / 100; queue skip and clear 60 / 600; the player's reports 60 / 1800 | as listed |
| Calls: voice channel create and delete, stream call switch 20 / 200; ring 20 / 200; answer 30 / 300 | as listed |
| Chat settings save (`PUT /api/chat/preferences` and the other modules) | 30 / 300 |

Never limited: `/health`, `/ready`, `/release.json`, `/metrics`, `/internal/*` (the ingress, the call
hooks and the signed Events deliveries, which carry account deletions and merges), `/ws/chat` and
`/ws/call`, the openvibe.chat pages, and the media files players fetch (`/api/tts/audio/…`,
`/api/sounds/file/…`, `/api/emotes/file/…`), which only the per-address limit bounds. `test/actor-limits.test.js`.

### Layout

```
server/index.js            boot: DB, first Live sync, WS server, HTTP app, relays, graceful stop
server/app.js              Live's guards for these routes: CORS, /api rate limit, IP bans, ban cookie, WS origin + IP checks
server/live-context.js     the only module that talks to Live (interface in its header)
server/chat/               moved from Live: chat-server, dm, dm-routes, routes, history-store, tts-*, sounds-*, soundboard, moderation-utils, word-filter, deploy-notice; plus the T3 APIs: emotes-routes, channel-mod-routes, internal-moderation (Live's read API), alert-sounds
server/auth/               token resolution through Live; the chat subset of Live's permissions
server/events/service-outbox.js    Chat envelopes and openvibe-sdk outbox wiring
server/events/consumer.js  POST /internal/events: Chat's Events subscriptions (live.release.deployed, network.module.updated)
server/events/subscriptions.js  creates them at boot when missing; list/disable/enable for scripts/subscribe-events.js
server/net/service-auth.js service tokens: client (Chat → others) and guard (others → Chat)
server/prefs/              chat preferences in the Network user module chat.preferences (routes, cache, migration from Live)
server/calls/              moved from Live: the call server (/ws/call), its REST routes, Live's stream hooks (/internal/calls), the calls lifecycle
server/media/client.js     OpenVibe.Media objects (namespace chat): emote image bytes, with Chat's own service token
server/ai/                 moved from Live: chat-ai.js (the rolling insight job, off unless CHAT_AI_ENABLED), client.js (OpenVibe.AI runs, namespace chat.*), extractive.js (the fallback summary)
server/db/                 database.js (Live's chat functions, same names and arguments; PostgreSQL, migrations/)
scripts/                   parity, subscribe-events, n-1-record
docs/                      calls-cutover.md, parity.md, chat-ingress.md, capabilities-proposal/
```

## Owns

- room types: global, stream, channel, community, DM, group-DM, call, system; servers (groups of rooms as text and
  voice channels, with server roles and invites)
- messages, replies/rich payloads, membership/roles, unread/read state, presence/typing (ephemeral)
- bans, timeouts, delete/purge, filters, slow/member-only modes
- TTS/audio/soundboard/media-request queues with skip/clear/failure lifecycle
- call signalling metadata and the `pending/ringing/active/ended/missed/declined/failed` lifecycle

(Wave 6 moved messages, DMs, TTS, sounds and the chat side of moderation, and gave TTS and sounds a
persisted queue with skip/clear/failed states; bans, channel moderation settings and the media-request
queue are still Live's and reached through `live-context`. Calls are ported with their lifecycle,
`server/calls/`, and switch over with `docs/calls-cutover.md`.)

## Does not own

- media bytes (attachments are Media references)
- billing of paid messages (Tips/Billing)

## Capabilities and events

Introduced here and registered in `openvibe-contracts` v0.13.0:
`chat.live_bridge.write`, `chat.presence.read` (owner chat) and `live.chat_context.read`,
`live.chat_effects.write` (owner live). `chat.live_bridge.write` now only
guards Live's stream hooks for calls (`/internal/calls/stream-channel`) and `chat.presence.read` the
presence snapshot (`GET /internal/chat/presence`); the bridge routes they were made for are retired
(T3 J3a). Enforced here as well: `chat.message.send` (`POST /internal/chat/messages`). It is owned
by `chat` and listed in the chat manifest since `openvibe-contracts` v0.30.2 (so is the
`chat.preferences` user module since v0.32.0); the check names it literally, so the contracts check
enforces it. Planned families:
`chat.room.*`, `chat.message.*`, `chat.dm.*`, `chat.moderation.*`, `chat.tts.*`, `chat.call.*`.

Events: `chat.message.created`, `chat.message.deleted`, `chat.dm.created`, `chat.moderation.action`,
`chat.room.message.created`, `chat.room.message.deleted` (produced); planned `chat.room.updated`,
`chat.call.*`, `chat.tts.queued|played|failed`. Consumed at `POST /internal/events` (signature v2,
`CHAT_EVENTS_SECRET`, openvibe-sdk inbox): `live.release.deployed`, `network.module.updated`,
`network.user.token_valid_after`, `vip.membership.changed`, `network.block.changed`,
`network.subject.merged`, `network.account.export_requested` and `network.account.deleted` (Chat's own
subscriptions, created at boot when missing).

Called elsewhere, as the service principal `chat` ([server/net/service-auth.js](server/net/service-auth.js)):

| Service | Grant | Why |
|---|---|---|
| OpenVibe.Live | `live.chat_context.read`, `live.chat_effects.write` | the chat context Live still owns (bans, channel settings) and effects |
| OpenVibe.Events | `events.event.publish`, `events.subscription.manage` | the outbox relay; the subscriptions above |
| OpenVibe.Network | `network.modules.read`, `network.modules.write` | chat preferences and the other chat user modules |
| OpenVibe.VIP | `vip.entitlement.check` | subscriber badges (fails closed) |
| OpenVibe.Tools | `tools.tool.run`, `tools.job.read` | sound uploads to MP3 (local ffmpeg is the fallback) |

## Depends on

- OpenVibe.Network (identity, service tokens, the `chat.preferences` user module)
- OpenVibe.Live (until the rest of chat's data moves)
- OpenVibe.Events
- OpenVibe.Media
- OpenVibe.VIP (member badges; optional — without it nobody has a badge)
- OpenVibe.Contracts

## Acceptance (must be true before "done")

- stream/global/DM histories preserved on import; old Live URLs and WS messages keep working through the adapter — *done on production data: 70,860 messages, 11 conversations and 1,522 DMs imported with 0 held (two passes, identical), 15/15 read paths identical at the cutover*
- restart Live without losing Chat; restart Chat's delivery plane and resume persisted messages — *seen in production (Live restarted several times on 2026-09-23 while Chat stayed up; messages and a queued outbox row survived Chat restarts); `test/restart-resume.test.js` restarts Chat as a real process (SIGTERM, new process on the same database) and proves stream, global and channel readers resume from their `after_id` cursor with no gap and no duplicate, including an ingress message Live sends again with its key after the restart (one row, the first id)*
- a call row without a working signalling/media path is not parity — *Live's `/ws/call` protocol and call routes run in Chat with a `calls` row per call (`test/calls.test.js`: two signed-in sockets exchange offer/answer/ICE, limits, kick/ban, ringing → active/declined/missed/failed, stream channels); not switched over yet (`docs/calls-cutover.md`)*
- a paid TTS request is never duplicated by a retry — *forwarded writes are applied once per idempotency key; paid TTS does not exist yet*
- after a reconnect, deleted and blocked state converge; browser parity (join, send, DM, `/tts`, moderation, popout) — *`scripts/parity.js` and `test/parity.test.js` (`docs/parity.md`): a reader that was away converges on what a connected reader saw (cursor reads carry `deleted_ids`); gaps: sub-only mode does not exist, public chat does not apply blocks*

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** People sign in with a Network session JWT, verified here with the Network's key (tokens
  issued before a subject's `token_valid_after` are refused), or an `hbt_` API token resolved through
  Live. A WebSocket upgrade authenticates with the Authorization bearer only (bots); a browser's
  socket starts anonymous and presents the token in its first message (`join`, `join_room`, the
  call's `auth-update`). Neither a cookie nor `?token=` in the URL signs a socket in (C-05/C-06
  removed 2026-10-10, after 14 days with no socket relying on either). The `ov_token` cookie only
  exempts staff from a network (IP) ban at the upgrade, because staff share home networks with
  banned people.
  Services use client-credentials tokens for audience
  `openvibe.chat`, checked per capability (`chat.live_bridge.write`, `chat.message.send`,
  `chat.presence.read`). Staff gates ask the contracts staff map.
- **Private data.** DMs are delivered only to participants, and private rooms only to members
  (`test/security-crawl.js` walks every route); network blocks count like DM blocks; a staff member
  reading someone else's chat logs is recorded as a moderation action; account export and deletion
  follow Network's events.
- **Network exposure.** `/internal/*` and `/metrics` answer 404 through nginx, which sets the client
  address from the connection only; WS upgrades check the origin and IP bans.
- **Egress.** Chat calls its configured Network, Live, Events, VIP and Tools hosts; the soundboard
  import fetches only 101soundboards' own addresses, checked on every DNS answer.
- **Secrets.** `OV_OAUTH_CLIENT_SECRET` and `CHAT_EVENTS_SECRET` live in `/etc/openvibe/chat.env` (0600),
  by name only.

## Deploy

Production deploys with `sudo ovhost deploy chat` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.chat`, install on a lockfile change, restart, wait for `/ready`).
The unit is `openvibe-chat.service` on `127.0.0.1:4400`, the env file `/etc/openvibe/chat.env`. Readiness is
`/ready` (not `/api/ready`). nginx: [deploy/nginx/openvibe.chat.conf](deploy/nginx/openvibe.chat.conf)
for openvibe.chat and [deploy/nginx/openvibe.live-chat.locations.conf](deploy/nginx/openvibe.live-chat.locations.conf),
included in openvibe.live's vhost, for Live's chat paths. After a deploy, record the N-1 fixtures
(`npm run n-1:record`). Chat is required in every mode and Live's chat routes are retired: a
rollback is a Chat release rollback, not a switch back to Live.

Rollback: ovhost puts the previous sha back by itself when `/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback chat --to <sha>`. Nothing blocks a rollback: the schema
code only adds tables and columns.

## Launch rule

This repository does not make the product real, and the domain kept its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following existed here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service. `openvibe.chat` launched on 2026-09-24 (global chat, messages, settings): it
left OpenVibe.Sites, and this repository's vhost serves it.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.212.0
- openvibe-sdk: v0.62.0
- openvibe-shared: v4.10.0
<!-- versions:end -->
