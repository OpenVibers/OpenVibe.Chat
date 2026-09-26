# OpenVibe.Chat

> Rooms, messages, DMs, calls, TTS and audio queues, moderation and presence — one identity, every conversation.

**Status:** alpha — deployed. Since the cutover on 2026-09-23 at 02:03 UTC (`docs/cutover.md`),
Chat is the authority for openvibe.live's chat: the service runs on `openvibe-ovh` (unit
`openvibe-chat`, 127.0.0.1:4400, release `45f2b1f`), Live runs with `CHAT_AUTHORITY=chat` and keeps
a read mirror, and chat events go to OpenVibe.Events. `openvibe.chat` still shows its placeholder.  
**Domain:** `openvibe.chat` (placeholder); Chat is served on Live's origin:
`https://openvibe.live/ws/chat`, `/api/chat/`, `/api/dm/`, `/api/tts/`, `/api/sounds` via nginx.  
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
  `/help /tts /color /viewers /uptime /w /me /ban /unban /timeout /clear /slow /paste /ai`, `!sr !queue
  !np !skip !sb !gotti`, channel `!sounds`, arena `!hype !beef !arena`, hardware `!forward … !say`),
  DMs (`dm.js`, `/api/dm/*`), chat history (`history-store.js`, `/api/chat/*`), TTS (`tts-engine.js`,
  `/api/tts/*`), 101soundboards and channel sounds (`/api/sounds*`), moderation utils and the word
  filter, the deploy-notice card. Changes are confined to where they touched Live's data.
- **The TTS and sound queue** (`audio-queue.js`, table `audio_requests`). TTS, channel `!sounds` and
  101soundboards clips are persisted requests played one at a time per room — `queued → playing →
  played`, or `skipped` / `failed` — so the queue survives a Chat restart (what was playing is
  finished, what waited plays once the room has listeners again, requests older than 5 minutes
  expire) and a keyed request (the TTS of message `m<id>`) is read once. The broadcaster and
  moderators control it: `/skiptts [id]`, `/cleartts`, and `GET /api/tts/queue`,
  `POST /api/tts/queue/skip|clear`, `POST /api/tts/queue/:id/report` (the playing client's
  `played`/`failed`). Browsers get the same `tts-audio` / `soundboard-audio` frames as before, now
  with `request_id` and paced by the clip's length, plus two new frames old clients ignore:
  `audio-skip { request_id }` and `audio-clear { request_ids }`.
- **One adapter to Live — `server/live-context.js`.** Accounts and roles, streams, slots and channels,
  channel moderation settings and moderators, bans and IP rules, follows, cosmetics and tags, site
  settings and anon numbers are read through it; coins, AI viewers, arena, media queue, hardware,
  pastes, translation, PowerChat, notifications, viewer counts and the IP log are effects it asks
  Live for. Reads are cached projections (SQLite `ctx_*` tables kept complete by paged syncs; TTL
  caches that serve stale while refreshing) warmed when a socket joins, so a chat message never
  waits on a network read. Live pushes invalidations when it changes cached data.
- **Live's side** is `docs/live-patch.diff` (applies to Live `main` with `git apply`):
  `/internal/chat-context/*` and `/internal/chat-effects/*`, and `CHAT_AUTHORITY=chat`, which stops
  Live's chat server and routes and turns `require('./chat/chat-server')` into a proxy that forwards
  Live's own chat calls here (`POST /internal/live/calls`).
- **Own database** (`CHAT_DB_PATH`, systemd `StateDirectory=openvibe-chat`) with Live's tables and
  ids, the Network subject on new rows, a transactional events outbox and a read mirror back into Live.
- **Import:** `scripts/import-from-live.js --live-db <snapshot> [--apply]` — a dry run unless
  `--apply` (which backs Chat's database up first), idempotent, never drops a row of Chat's tables
  (`import_hold`), reports counts per table.
- **Staged tables** (`channel_moderators`, `channel_moderation_settings`, `emotes`, `user_tags`,
  `chat_ai_summaries`, `chat_timeline_events`): Live writes them until each is handed to Chat, one
  table at a time (`table_authority`, register C-04). Runbook: `docs/staged-tables-cutover.md`.

## How it fits the network

| Concern | Where it lives | How Chat reaches it |
| --- | --- | --- |
| Messages, DMs, channel sounds, TTS voice overrides, relay users, first chats, IP-approval queue, moderation log | **Chat** (authority from the cutover) | its own SQLite; Live keeps a read mirror (`POST /internal/chat-effects/mirror`) |
| Accounts, roles, streams, channels, bans, IP approvals, follows, cosmetics, tags, site settings | **Live** (Network for identity) | `server/live-context.js` → `GET/POST /internal/chat-context/*` (service token, `live.chat_context.read`) |
| Coins, AI viewers, arena, media queue, hardware, pastes, translation, PowerChat, notifications | **Live** | `server/live-context.js` → `POST /internal/chat-effects/*` (`live.chat_effects.write`) |
| Live's own chat pushes and writes (AI viewers, relays, donations, `/api/mod`, recaps, calls) | **Live → Chat** | `POST /internal/live/calls` (`chat.live_bridge.write`), presence `GET /internal/live/presence` (`chat.presence.read`) |
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

Staged here, still written by Live in this wave (their routes have not moved): `channel_moderators`,
`channel_moderation_settings`, `emotes`, `user_tags`, `chat_ai_summaries`, `chat_timeline_events` —
imported (and refreshed by later import runs) so their move is a switch; Chat reads the live values
through `live-context`. `table_authority` records which is which.

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
| `live.release.deployed` | Live (`server/events/release-events.js`), subject `{ type: release, id: <head commit> }` | stores or folds the deploy card in global chat, exactly as the bridge op `deployNotice` does (`server/chat/deploy-notice.js`: one rolling card, folded while nobody has spoken in any room and within 3 hours; the broadcast carries the row id; late joiners get it once) |
| `network.module.updated` | Network (`server/identity/module-events.js`) | for `chat.preferences`, a revision newer than the cached copy drops it (`prefs.handleEvent()`); an older or equal revision and other namespaces change nothing |
| `network.block.changed` | Network (`server/identity/blocks.js`, platform blocks) | keeps the newest revision per (blocker, blocked) in `network_blocks` (`server/chat/network-blocks.js`); while a block is active neither person can start a DM with the other, message them in a 1:1, add them to a group or call them, and the DM user search hides them, exactly like `dm_blocks` (same errors) |

- **One card per deploy, whichever path comes first** (compatibility register C-84). Until the bridge
  op is removed, Live sends each deploy twice: `deployNotice` over the bridge (commits newest first,
  so the first is the head) and the event. Both claim the head commit in `deploy_releases` in the
  transaction that stores or folds the card; the second finds it claimed and changes nothing but its
  `bridge_at` / `event_at`. A retried bridge op, a redelivered event and Live re-announcing after a
  crash are the same card. A redeploy of a head already announced (a rollback to it) says nothing.
  A release event older than 6 hours (an operator replay) is `ignored:stale`.
- **Exactly once.** The openvibe-sdk inbox (`chat_event_inbox`, pruned after 35 days) claims
  `(chat, event_id)` in the same SQLite transaction as the change, and broadcasts run only after it
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
  `DELETE /internal/calls/stream-channel/:streamId` — the bridge's service token and capability
  (`chat.live_bridge.write`), loopback only.
- **Lifecycle** (`server/calls/lifecycle.js`, table `calls`): a ring is `direct`, `pending → ringing →
  active → ended`, or `missed` (no answer within `CALL_RING_TIMEOUT_MS`, 45 s; the caller is told),
  `declined` (declined or busy) or `failed` (the invite could not be delivered, with the reason); a
  channel's occupancy is a `channel` / `stream` session, `active` while anyone is in, `ended` when it
  empties or closes. A restart closes what was open (reason `restart`).

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
node scripts/import-from-live.js --live-db /tmp/live-snapshot.db            # dry run; --apply writes
node scripts/parity-check.js --live https://openvibe.live --chat http://127.0.0.1:4401 --before "…"
node scripts/parity-check.js --tables --live-db /tmp/live-snapshot.db --chat-db /tmp/chat-snapshot.db
node scripts/table-authority.js           # who writes each staged table (the handoff is Live's)
node scripts/mirror-flush.js  # rollback helper: push queued mirror rows to Live
node scripts/subscribe-events.js --dry-run   # Chat's Events subscriptions (boot creates missing ones)
```

`/ready` (openvibe-shared/ready shape: `status` ready/degraded/not_ready and `checks`) is 503 only
when the `db` check (a read of `chat_messages`) fails. `live_sync` is optional: it reads degraded when
the last clean Live sync is older than `LIVE_SYNC_STALE_MS` (default 60 s) or a sync step has missed
its own interval by that much. It also reports the mirror queue, whether events are relayed, and the
Events consumer's counters.
Production: `deploy/systemd/openvibe-chat.service`, `deploy/nginx/openvibe.live-chat.locations.conf`,
`/etc/openvibe/chat.env`. The whole switch-over — rehearsal, import, parity checks, nginx, the flag,
rollback — is `docs/cutover.md`.

### Layout

```
server/index.js            boot: DB, first Live sync, WS server, HTTP app, relays, graceful stop
server/app.js              Live's guards for these routes: CORS, /api rate limit, IP bans, ban cookie, WS origin + IP checks
server/live-context.js     the only module that talks to Live (interface in its header)
server/chat/               moved from Live: chat-server, dm, dm-routes, routes, history-store, tts-*, sounds-*, soundboard, moderation-utils, word-filter, deploy-notice
server/auth/               token resolution through Live; the chat subset of Live's permissions
server/bridge/             Live → Chat calls + presence (live-bridge.js); Chat → Live read mirror (live-mirror.js)
server/events/outbox.js    events.event-envelope@1 outbox and relay
server/events/consumer.js  POST /internal/events: Chat's Events subscriptions (live.release.deployed, network.module.updated)
server/events/subscriptions.js  creates them at boot when missing; list/disable/enable for scripts/subscribe-events.js
server/net/service-auth.js service tokens: client (Chat → others) and guard (others → Chat)
server/prefs/              chat preferences in the Network user module chat.preferences (routes, cache, migration from Live)
server/calls/              moved from Live: the call server (/ws/call), its REST routes, Live's stream hooks (/internal/calls), the calls lifecycle
server/db/                 schema.sql, database.js (Live's chat functions, same names and arguments)
scripts/                   import-from-live, parity-check, mirror-flush, table-authority, migrate-chat-preferences, subscribe-events
docs/                      cutover.md, calls-cutover.md, staged-tables-cutover.md, live-patch.diff, capabilities-proposal/
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
`live.chat_effects.write`, `live.chat_mirror.write` (owner live). Enforced here as well:
`chat.message.send` — a service or app principal whose `/internal/live/calls` op sends a chat
message (a `saveChatMessage` write, the deploy notice, or a pushed `chat`/`dm` frame) must hold it
beside `chat.live_bridge.write`; without it that op is refused (`capability.denied`) and the rest of
the batch runs. It is owned by `chat` and listed in the chat manifest since `openvibe-contracts`
v0.30.2 (so is the `chat.preferences` user module since v0.32.0); the check names it literally, so
the contracts check enforces it. Planned families:
`chat.room.*`, `chat.message.*`, `chat.dm.*`, `chat.moderation.*`, `chat.tts.*`, `chat.call.*`.

Events: `chat.message.created`, `chat.message.deleted`, `chat.dm.created`, `chat.moderation.action`
(produced); planned `chat.room.updated`, `chat.call.*`, `chat.tts.queued|played|failed`. Consumed:
`live.release.deployed`, `network.module.updated` (Chat's own subscriptions: Network grant
`chat events.subscription.manage openvibe.events`).

## Depends on

- OpenVibe.Network (identity, service tokens, the `chat.preferences` user module)
- OpenVibe.Live (until the rest of chat's data moves)
- OpenVibe.Events
- OpenVibe.Media
- OpenVibe.VIP (member badges; optional — without it nobody has a badge)
- OpenVibe.Contracts

## Acceptance (must be true before "done")

- stream/global/DM histories preserved on import; old Live URLs and WS messages keep working through the adapter — *done on production data: 70,860 messages, 11 conversations and 1,522 DMs imported with 0 held (two passes, identical), 15/15 read paths identical at the cutover*
- restart Live without losing Chat; restart Chat's delivery plane and resume persisted messages — *seen in production (Live restarted several times on 2026-09-23 while Chat stayed up; messages and a queued outbox row survived Chat restarts); `test/restart-resume.test.js` restarts Chat as a real process (SIGTERM, new process on the same database) and proves stream, global and channel readers resume from their `after_id` cursor with no gap and no duplicate, including Live bridge placeholders that straddle the restart (kept in `bridge_refs`)*
- a call row without a working signalling/media path is not parity — *Live's `/ws/call` protocol and call routes run in Chat with a `calls` row per call (`test/calls.test.js`: two signed-in sockets exchange offer/answer/ICE, limits, kick/ban, ringing → active/declined/missed/failed, stream channels); not switched over yet (`docs/calls-cutover.md`)*
- a paid TTS request is never duplicated by a retry — *forwarded writes are applied once per idempotency key; paid TTS does not exist yet*

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
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
