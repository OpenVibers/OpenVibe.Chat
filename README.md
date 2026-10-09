# OpenVibe.Chat

> Rooms, messages, DMs, calls, TTS and audio queues, moderation and presence — one identity, every conversation.

**Status:** alpha — deployed. Since the cutover on 2026-09-23 at 02:03 UTC (`docs/cutover.md`),
Chat is the authority for openvibe.live's chat in every mode: the service runs on `openvibe-ovh`
(unit `openvibe-chat`, 127.0.0.1:4400), Live runs with `CHAT_AUTHORITY=chat`, mounts no local chat
routes, reads Chat's internal read API for the chat data it needs, and chat events go to OpenVibe.Events. `openvibe.chat` is Chat's own
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
- **Live's side** is `docs/live-patch.diff` (applies to Live `main` with `git apply`):
  `/internal/chat-context/*` and `/internal/chat-effects/*`, and `CHAT_AUTHORITY=chat`, which stops
  Live's chat server and routes. Live's own chat calls reach Chat through the Chat-owned ingress
  (`/internal/chat/*`, `docs/chat-ingress.md`); the bridge proxy at `POST /internal/live/calls` is
  retired (T3 J3a).
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
  triggers, and `live_mirror_outbox` stays, idle, until a contract migration drops it.
  `scripts/import-sqlite-to-pg.js` moves the SQLite data over once, with a per-table count and checksum
  report (`docs/cutover.md`). `VALKEY_URL`/`VALKEY_PREFIX` put the per-actor rate-limit counters on
  Valkey instead of this process. No part of the service reads SQLite; the one-time tools that read a
  SQLite file (Live's snapshot, the import) use `node:sqlite` through `scripts/lib/sqlite.js`.
- **Import:** `scripts/import-from-live.js --live-db <snapshot> [--apply]` — a dry run unless
  `--apply` (which first copies the rows of the tables it writes to a JSON file), idempotent, never drops
  a row of Chat's tables (`import_hold`), reports counts per table.
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
| Messages, DMs, channel sounds, TTS voice overrides, relay users, first chats, IP-approval queue, moderation log | **Chat** (authority from the cutover) | its own database on PostgreSQL since the 2026-09-23 cutover (`DATABASE_URL` through `openvibe-sdk/db`, `migrations/`, the one-time `scripts/import-sqlite-to-pg.js`; `CHAT_DB_PATH` is read only by that importer); Live reads them through Chat's internal read API (the read mirror was retired on 2026-10-05 and the rollback through it is gone) |
| Accounts, roles, streams, channels, bans, IP approvals, follows, cosmetics, tags, site settings | **Live** (Network for identity) | `server/live-context.js` → `GET/POST /internal/chat-context/*` (service token, `live.chat_context.read`) |
| Coins, AI viewers, arena, media queue, hardware, pastes, translation, PowerChat, notifications | **Live** | `server/live-context.js` → `POST /internal/chat-effects/*` (`live.chat_effects.write`) |
| Live's own chat pushes and writes (AI viewers, relays, donations, `/api/mod`, recaps, calls) | **Live → Chat** | the Chat-owned ingress `/internal/chat/*` (`docs/chat-ingress.md`), presence `GET /internal/chat/presence` (`chat.presence.read`); the bridge `/internal/live/*` is retired (T3 J3a) |
| The six chat tables (moderators, moderation settings, emotes, tags, AI summaries, timeline) | **Chat** (C-04 done) | Chat's own database; Live reads through `GET /internal/moderation/*` (`chat.moderation.read`), 30 s cached |
| Emote image bytes | **OpenVibe.Media** (namespace `chat`) | `server/media/client.js` (openvibe-sdk `createObjectsClient`), Chat's service token (`media.object.upload` / `.delete`); the row keeps `media_url` + `media_asset_id` |
| Chat-AI summaries (global / per-chatter insight + timeline) | **OpenVibe.AI** (namespace `chat.*`) | `server/ai/client.js` (openvibe-sdk `createAiClient`), Chat's service token (`ai.run.create` / `ai.run.read`); workflows `chat.global` / `chat.profile`; extractive fallback when AI does not answer |
| Identity | **OpenVibe.Network** | user tokens are resolved by Live (its account links); service tokens from `/oauth/token` |
| Events | **OpenVibe.Events** | `events_outbox` → `POST /api/v1/events` when `EVENTS_URL` is set (`events.event.publish`); Chat's subscriptions deliver to `POST /internal/events` (`server/events/consumer.js`, `events.subscription.manage`) |
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
The importer no longer copies them; Live reads them through `GET /internal/moderation/*`.

Stays in Live (decided with evidence, `docs/cutover.md`): `media_requests`, `media_request_settings`.

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

Live's voice/video calls moved here (roadmap WS-I task 1, `server/calls/`), **off until the calls
cutover** (`CHAT_CALLS=1`, `docs/calls-cutover.md`):

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
- **Lifecycle** (`server/calls/lifecycle.js`, table `calls`): a ring is `direct`, `pending → ringing →
  active → ended`, or `missed` (no answer within `CALL_RING_TIMEOUT_MS`, 45 s; the caller is told),
  `declined` (declined or busy) or `failed` (the invite could not be delivered, with the reason); a
  channel's occupancy is a `channel` / `stream` session, `active` while anyone is in, `ended` when it
  empties or closes. A restart closes what was open (reason `restart`).

### Rooms (openvibe.chat)

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

**openvibe.chat pages.** `/` global chat, `/rooms` and `/r/:slug` (above), `/messages` the DM inbox
(conversations with unread counts, refreshed every 15 s with JavaScript; who you blocked, with Unblock),
`/messages/:id` a conversation (participants only; a guessed id is the same 404 as a missing one; Block
the other person of a 1:1 conversation, which closes it both ways), `/settings`, `/updates`. The navigation
counts unread messages and room messages. Everything is server-rendered and works without JavaScript.

**Working with Live down.** Nothing on openvibe.chat waits on Live: people sign in from their Network token
and the `ctx_users` projection, pages read Chat's own tables, cosmetics are waited for at most 1.5 s, and
the only openvibe.live URLs are profile links. `test/live-down.test.js` renders every page and uses the
forms, the core APIs and the socket with Live refusing connections and with Live hanging.

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
- **Migration** of what Live kept server-side (`user_preferences.chat_settings`, the browser's whole
  `chatSettings`): `scripts/migrate-chat-preferences.js`. Only choices move (`showTimestamps` →
  `timestamps`, `compactMode` → `compact`, `fontSize` small/large → `font_scale` 0.88/1.18, `showBadges`
  false → `show_badges`); a person with defaults only gets no record, and an existing record is never
  overwritten (create-only, `If-Match: 0`), so it is safe to re-run. The rest of `chatSettings` (TTS,
  volumes, cross-feed, notifications, …) has no field in schema v1 and stays in Live for now.

```bash
node scripts/migrate-chat-preferences.js --live-db /tmp/live-snapshot.db                              # dry run
node scripts/migrate-chat-preferences.js --live-db /tmp/live-snapshot.db --apply --backup /root/chat-prefs-$(date +%F).json
node scripts/migrate-chat-preferences.js --rollback /root/chat-prefs-<date>.json [--apply]            # undo that run
```

## Running it

```bash
npm install
cp .env.example .env          # OV_LIVE_INTERNAL_URL, Network URLs, OV_OAUTH_CLIENT_SECRET, SOUNDS_PATH
npm start                     # 127.0.0.1:4400 — /ws/chat, /api/{chat,dm,tts,sounds}, /health, /ready (CHAT_CALLS=1: /ws/call, /api/streams/…)
npm test                      # Node 22; stub Live and Network in-process
npm run test:pg               # the same on PostgreSQL + PgBouncer + Valkey (OV_TEST_PG_URL, OV_TEST_PG_DIRECT_URL,
                              # OV_TEST_VALKEY_URL: openvibe-sdk scripts/test-services.sh up)
node scripts/import-from-live.js --live-db /tmp/live-snapshot.db            # dry run; --apply writes
node scripts/parity-check.js --live https://openvibe.live --chat http://127.0.0.1:4401 --before "…"
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
`/etc/openvibe/chat.env`. The whole switch-over — rehearsal, import, parity checks, nginx, the flag,
rollback — is `docs/cutover.md`.

### Per-actor limits

The REST API also limits who calls it (`server/net/actor-limits.js`, openvibe-sdk/limits, roadmap
WS-R task 4). A person counts as `user:usr_…` whether they call with their Network token or an `hbt_`
API token (a bot counts as its owner); anyone else by their address. Browsers call these routes
themselves, so no service speaks for many visitors here; Live's service calls (the ingress at
`/internal/chat`, the stream hooks at `/internal/calls`) carry every viewer's chat and are never
limited. The per-address `/api/` limit and the chat flood controls (the socket's, DMs 10 a minute and
5 new conversations an hour, rooms 6 every 10 s, 6 rings a minute) stay. Past a limit: `429`
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
server/events/outbox.js    events.event-envelope@1 outbox and relay
server/events/consumer.js  POST /internal/events: Chat's Events subscriptions (live.release.deployed, network.module.updated)
server/events/subscriptions.js  creates them at boot when missing; list/disable/enable for scripts/subscribe-events.js
server/net/service-auth.js service tokens: client (Chat → others) and guard (others → Chat)
server/prefs/              chat preferences in the Network user module chat.preferences (routes, cache, migration from Live)
server/calls/              moved from Live: the call server (/ws/call), its REST routes, Live's stream hooks (/internal/calls), the calls lifecycle
server/media/client.js     OpenVibe.Media objects (namespace chat): emote image bytes, with Chat's own service token
server/ai/                 moved from Live: chat-ai.js (the rolling insight job, off unless CHAT_AI_ENABLED), client.js (OpenVibe.AI runs, namespace chat.*), extractive.js (the fallback summary)
server/db/                 database.js (Live's chat functions, same names and arguments; PostgreSQL, migrations/)
scripts/                   import-from-live, parity-check, parity, migrate-chat-preferences, subscribe-events, n-1-record
docs/                      cutover.md, calls-cutover.md, parity.md, live-patch.diff, capabilities-proposal/
```

## Owns

- room types: global, stream, channel, community, DM, group-DM, call, system
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
  Live; WebSocket upgrades use the session cookie or Authorization bearer (Live's legacy `token`
  cookie is ignored there); `?token=` on `/ws/chat` is deprecated (C-05), counted in
  `chat_ws_url_token_uses`, and stays until Live's bot guide and call client stop sending it.
  The browser clients present the token in the first message of every socket (`join`,
  `join_room`, the call's `auth-update`); J7 removes the cookie branch from `extractWsToken` once
  `chat_ws_cookie_reliant{via="jwt"|"api_token"}` (cookie-authenticated sockets whose first
  handled auth message lacked a valid token, or call sockets silent past the token grace period)
  stays 0 for one full release after that ships (`chat_ws_cookie_uses` only counts the cookie seen).
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
rollback is a Chat release rollback, not a switch back to Live (`docs/cutover.md`).

Rollback: ovhost puts the previous sha back by itself when `/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback chat --to <sha>`. Nothing blocks a rollback: the schema
code only adds tables and columns.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

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
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.17.0
<!-- versions:end -->
