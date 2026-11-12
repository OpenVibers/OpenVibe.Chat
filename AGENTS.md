# AGENTS.md — OpenVibe.Chat

## Project overview

The communication authority of the OpenVibe network: rooms, messages, DMs, group DMs, voice channels
and calls, TTS/sounds, moderation, presence, and both of Live's chat paths. It was moved out of Live
behind a service boundary (Wave 6) and has been the authority for `openvibe.live` chat in every mode
since 2026-09-23; Live runs no chat of its own. Node.js/Express + `ws`, PostgreSQL, CommonJS, **no
build step**.

- Origin `https://openvibe.chat`; also served on **Live's origin**: nginx routes `/ws/chat`,
  `/api/chat/`, `/api/dm/`, `/api/tts/`, `/api/sounds`, `/api/emotes` (and, after the calls cutover,
  `/ws/call` and the call routes under `/api/streams`) to Chat.
- Port `4400`, unit `openvibe-chat.service`, release root `/opt/openvibe.chat`; `openvibe.party` is
  Chat's Watch Together host.

## What it owns

- Rooms: global, stream, channel, community, DM/group DM, call, system; servers (groups of rooms as
  text and voice channels, with roles and invites).
- Messages, replies/rich payloads, edit history, membership/roles, unread/read state, presence and
  typing (ephemeral).
- Moderation state: bans, timeouts, delete/purge, filters, slow/member-only modes, the moderation
  audit and the moderation read API Live uses (`GET /internal/moderation/*`).
- TTS/audio/soundboard/channel-sound queues with skip/clear/failure; the call signalling metadata and
  the `pending/ringing/active/ended/missed/declined/failed` lifecycle.
- The tables moved from Live: `chat_messages`, the DM tables, `tts_voice_overrides`,
  `channel_sounds`, `relay_users`, `hidden_relay_users`, `pending_ip_messages`,
  `stream_first_chats`, `moderation_actions`, plus `channel_moderators`,
  `channel_moderation_settings`, `emotes`, `user_tags`, `chat_ai_summaries`,
  `chat_timeline_events`. Live keeps no copy and reads through the internal API.
- Rooms, Vibe (the assistant), support inboxes, the website widget, feeds, `openvibe.party`, agent
  rooms and chat apps.

**Stays in Live:** `media_requests` and `media_request_settings`. Do not grow Live's chat tables back.

## Who calls it, and whom it calls

- Callers: browsers on `openvibe.chat` and Live's origin; Live (internal reads, bridge and event
  consumer); Bot (chat-app bridge); Actor (asks); other services with a Network service token
  audience `openvibe.chat` and a `chat.*` capability.
- Depends on: Network (identity, SSO, service tokens, the `chat.preferences` module, VIP badges),
  Live (channel/stream context through `server/live-context.js` — the only module that talks to Live),
  Events (outbox and subscriptions), Media (emote image bytes, namespace `chat`), AI
  (`server/ai/`, off unless enabled), VIP (optional; without it nobody has a badge), Tools/Search
  where the assistant needs them.

## Repository map

- **Entry:** [server/index.js](server/index.js) — database, first Live sync, chat and call WebSocket
  servers, HTTP app with the Events consumer and `POST /internal/events`, background loops,
  subscription check, graceful stop (tells clients the chat is restarting).
- **App:** [server/app.js](server/app.js) — Live's guards for these routes: credentialed CORS for an
  exact origin list, `/api` rate limit, IP/network bans, `ov_banned` cookie, WS origin+IP checks.
- **Config:** [server/config.js](server/config.js); database [server/db/database.js](server/db/database.js)
  (`openDb`, migrations via `DATABASE_DIRECT_URL`).
- **Chat core:** [server/chat/](server/chat/) — `chat-server.js`, `dm.js`, `dm-routes.js`,
  `history-store.js`, `moderation-utils.js`, `word-filter.js`, `deploy-notice.js`, the T3 APIs.
- **Calls:** [server/calls/](server/calls/) — call server, lifecycle, REST routes, Live stream hooks.
- **Rooms/servers:** [server/rooms/](server/rooms/) — `rooms.js`, `servers.js`, `vibe.js`,
  `workspace.js`, parties, memory, feeds.
- **Events:** [server/events/](server/events/) — `service-outbox.js`, `consumer.js`, `subscriptions.js`.
- **Auth/net:** [server/auth/](server/auth/), [server/net/](server/net/) (service tokens, client IP).
- **Browser:** [public/web/](public/web/) — `chat.js`, `chat-shell.js`, `call.js`, `vibe.js`,
  `widget.js`, `embed.js`, `party.js`, `feed-view.js`, plus their CSS.
- **Deploy:** [deploy/systemd/openvibe-chat.service](deploy/systemd/openvibe-chat.service),
  [deploy/nginx/openvibe.chat.conf](deploy/nginx/openvibe.chat.conf),
  [deploy/nginx/openvibe.live-chat.locations.conf](deploy/nginx/openvibe.live-chat.locations.conf),
  [deploy/nginx/calls/openvibe.live-calls.locations.conf](deploy/nginx/calls/openvibe.live-calls.locations.conf).

## Commands

```bash
npm ci
npm run dev                 # NODE_ENV=development node server/index.js
npm start                   # node server/index.js, http://127.0.0.1:4400
npm test                    # test/run.js: every file in its own process, PGlite per process
npm run test:pg             # same on PostgreSQL + PgBouncer + Valkey (containers)
npm test -- ws import       # filter by file name; --strict makes a skip fail
npm run n-1:record          # record the N-1 fixtures after a deploy
ov test                     # the harness's sharded run of what the change reaches
```

## Database and migrations

Chat's own PostgreSQL database on the host's data role (`add-service.sh chat`); development and
tests use embedded PGlite, PostgreSQL in production through PgBouncer. Migrations are
`migrations/NNNN_*.sql`, applied at boot with the owner connection (`DATABASE_DIRECT_URL`), then the
app serves through the pooled runtime role (`DATABASE_URL`, DML only). Never edit an applied
migration. The moved tables keep Live's ids and columns plus Network subject columns
(`subject_id`, `sender_subject_id`, …). `docs/parity.md` records the parity method.

## Auth and the WebSocket rules

- People sign in with a Network session JWT, verified against the Network key; tokens issued before a
  subject's `token_valid_after` are refused. `hbt_` API tokens are resolved through Live.
- A WebSocket upgrade authenticates with an `Authorization: Bearer` header only (bots); a browser's
  socket starts anonymous and presents its token in the first message (`join`, `join_room`,
  `auth-update`). **Neither the `ov_token` cookie nor `?token=` in the URL signs a socket in** (removed
  2026-10-10); a token in the URL gets a `system` frame saying to use the header or `join`.
- The `ov_token` cookie only exempts staff from a network/IP ban at upgrade.
- Services use client-credentials tokens for audience `openvibe.chat`, checked per capability
  (`chat.live_bridge.write`, `chat.message.send`, `chat.presence.read`, `chat.moderation.read`, …).
- DMs go only to participants, private rooms only to members; network blocks count like DM blocks; a
  staff member reading someone else's chat is recorded as a moderation action.

## Frontend loading model

Browsers load plain, no-build scripts from [public/web/](public/web/) on Chat's own site; Live's
origin keeps Live's existing chat JavaScript and talks to the same sockets/APIs (the Wave 6 rule was
"move behind a service boundary before changing behaviour"). There is no SPA, bundler or transpiler.
`openvibe-shared` supplies the Frame and `/shared/*` from the pinned node_modules. The widget is a
shadow-root bubble under 3 KB compressed; embeds and `openvibe.party` are separate pages/scripts.

## Deploy

`sudo ovhost deploy chat` (git-checkout: fetch, fast-forward `/opt/openvibe.chat`, install on a
lockfile change, restart, wait for **`/ready`**, not `/api/ready`). Unit `openvibe-chat.service` on
`127.0.0.1:4400`, env `/etc/openvibe/chat.env`; vhosts
[deploy/nginx/openvibe.chat.conf](deploy/nginx/openvibe.chat.conf) and the Live locations include
(inside Live's `server { … }`). After a deploy, record the N-1 fixtures (`npm run n-1:record`).
Rollback is a Chat release rollback (`sudo ovhost rollback chat --to <sha>`), never a switch back to
Live. Migrations only add tables and columns.

## Tests

`npm test` runs each `test/*.test.js` in its own process (60 s) against one migrated PGlite database
per process (`test/helpers/pg-preload.mjs`); `npm run test:pg` uses the PostgreSQL/PgBouncer/Valkey
containers. The suite covers the WS gates and commands, DMs and privacy, history latency, moderation
and staff audit, calls and capture-on-load, TTS/audio queues, rooms/servers/Vibe, the widget/embeds,
feeds, chat apps, Events consumption, account export/deletion and the N-1 fixtures. `ov test` runs the
same.

## Conventions

- CommonJS; 4-space indent in the newer modules, Live's original style preserved in the moved files.
- `server/live-context.js` is the **only** module that talks to Live; do not call Live from routes.
- Errors are problem+json or the chat frames' own stable codes; never leak a DM, a staff log or a
  token into a response or a log.
- CORS and WS origins are exact origins; no wildcard for credentialed requests.

## Pitfalls

- **A token in the socket URL or a cookie must not sign the socket in** (C-05/C-06). Keep the
  first-message auth and the `Authorization` header for bots.
- **Chat is required in every mode.** Live's chat routes are retired; do not add a fallback to Live.
- **The CORS/WS origin list is exact.** `*.openvibe.tools` must not be honoured: a credentialed grant
  would let it read signed-in DMs.
- **`/internal/*` and `/metrics` must stay unreachable through nginx** (404 there); nginx sets the
  client address from the connection only.
- **DM privacy:** participants only, block-aware, and staff reads are audited moderation actions.
- **Bans/mutes are Chat's**, and Live reads moderation through the internal API; `media_requests`
  remains Live's.
- **Readiness is `/ready`**, not `/api/ready` — the standard deploy probe assumes the latter.
- **Do not "fix" a message by editing the store**: the Live bridge mirrors changes; use the service
  paths so events, the bridge and Search stay consistent.
- **N-1 fixtures** are part of shipping: record them after the deploy.

## Documentation

- [README.md](README.md) — the product, cutover, data, events, rooms, Vibe, inboxes, feeds, deploy.
- [docs/platform.md](docs/platform.md) — agent rooms and the digest Code/Chat/Actor use.
- [docs/vibe-personas.md](docs/vibe-personas.md) — the persona shape, the topic check, models, spend cap, owner page and tests.
- [docs/chat-ingress.md](docs/chat-ingress.md) — `/internal/chat/*` tickets and reads.
- [docs/calls-cutover.md](docs/calls-cutover.md), [docs/parity.md](docs/parity.md),
  [docs/chat-apps.md](docs/chat-apps.md), [docs/party-pool.md](docs/party-pool.md).
- `openvibe-contracts` holds `chat.*` shapes and capabilities.
