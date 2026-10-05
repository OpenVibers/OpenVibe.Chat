# Chat cutover — Live → OpenVibe.Chat (roadmap Wave 6)

What changes at the cutover: browsers keep calling `https://openvibe.live`, but nginx sends the chat
socket and the chat REST prefixes to OpenVibe.Chat (127.0.0.1:4400), and Live runs with
`CHAT_AUTHORITY=chat`. Nothing in Live's browser code changes. Chat is required in every mode:
Live's local chat routes and mounts are inert under the flag and are being removed, and the rollback
that returned chat to Live is retired, so there is no unset-flag mode in which Live serves chat
again (see [Rollback](#rollback)). The Live-side read mirror was retired on 2026-10-05: since
Live #31 nothing in Live reads its mirror-filled chat tables in chat mode — every read goes to
Chat's internal read API — so Chat no longer copies its writes into Live, and the cutover rollback
through the mirror no longer exists (see [Rollback](#rollback)).

The cutover itself ran on 2026-09-23; the rehearsal, flip and check steps below record that deploy.

**The Live chat bridge is retired (T3 J3a).** Live #20/#21 route every producer through Chat's own
ingress (`/internal/chat/*`, `docs/chat-ingress.md`) and dropped Live's bridge outbox, so Chat no
longer mounts `POST /internal/live/calls` or `GET /internal/live/presence`, and deploy notices arrive
only as `live.release.deployed`. Where the steps below mention the bridge, they record the cutover as
it ran. Its tables `bridge_applied` / `bridge_refs` stayed as data until J3b dropped them
(`migrations/0005_drop_bridge_tables.sql`).

## Rehearsal

`ov rehearse` loads this seed after main's migrations, then this branch's migrations:

```rehearse
# Chat's PostgreSQL seed; test/fixtures/live-chat-schema.sql is Live's SQLite schema for the import tests
seed: test/rehearsal/seed.sql
```

- [What is served where](#what-is-served-where)
- [Data authority](#data-authority)
- [Prerequisites](#prerequisites)
- [Rehearsal](#rehearsal)
- [Rehearsal on a live.db snapshot](#rehearsal-on-a-livedb-snapshot)
- [Cutover](#cutover)
- [Rollback](#rollback)
- [Behaviour that is not byte-for-byte identical](#behaviour-that-is-not-byte-for-byte-identical)
- [Live quirks moved as they are](#live-quirks-moved-as-they-are)

## What is served where

nginx locations (`deploy/nginx/openvibe.live-chat.locations.conf`, included in Live's
`server { … server_name openvibe.live … }` block above `location /api/`):

| nginx location | Chat serves |
| --- | --- |
| `^~ /ws/chat` | the chat WebSocket (`?stream=`; session cookie or Authorization bearer; the deprecated `?token=` still works; protocol unchanged) |
| `^~ /api/chat/` | `GET gif/providers`, `GET gif/trending`, `GET gif/search`, `POST send`, `GET search`, `GET user/:userId/history`, `GET user/:username/profile`, `GET relay-user/:platform/:username`, `GET relay-user/:platform/:username/logs`, `GET anon/:anonId`, `GET anon/:anonId/logs`, `GET filters/friendly`, `GET global/history`, `GET :streamId/replay`, `GET :streamId/history`, `GET channel/:userId/history`, `GET :streamId/users`, `POST admin/purge/preview`, `DELETE admin/purge`, `GET admin/logs`, `GET admin/logs/export` |
| `^~ /api/dm/` | `GET/POST conversations`, `GET/PATCH conversations/:id`, `GET/POST conversations/:id/messages`, `DELETE conversations/:id/messages/:msgId`, `POST conversations/:id/read`, `POST conversations/:id/participants`, `DELETE conversations/:id/participants/:userId`, `GET unread`, `GET users/search`, `GET blocks`, `POST/DELETE blocks/:userId`, `GET blocks/check/:userId` |
| `^~ /api/tts/` | `GET voices`, `GET settings`, `GET/PUT admin/settings`, `POST admin/test`, `GET audio/:file` (Chat's clips; Live's arena/mod-preview clips are fetched from Live under the same URL), `GET queue`, `POST queue/skip`, `POST queue/clear`, `POST queue/:id/report` (the TTS and sound queue) |
| `= /api/sounds` and `^~ /api/sounds/` | `POST /api/sounds` (upload), `GET channel/:userId`, `GET all/:streamId`, `DELETE :id`, `PATCH command`, `GET file/:filename`, `GET alert/mine`, `POST/DELETE alert/:kind` |

> **WebSocket credentials.** C-05 shipped in `2dcca25`: a `/ws/chat` upgrade authenticates with the
> session cookie or an `Authorization` bearer, and Live's legacy `token` cookie is ignored there. The
> deprecated `?token=` query param is still honoured for Live's bot guide and call client, counted in
> `chat_ws_url_token_uses`. C-06 — dropping the `ov_token` cookie fallback so upgrades authenticate by
> bearer only — is gated on `chat_ws_cookie_reliant`: the browser clients now send their token in the
> first message of every socket (`join`, `join_room`, the call's `auth-update`), and a socket the
> cookie signed in whose first handled auth message has no valid token counts there, once; call
> sockets silent past the token grace period count too. J7 removes the cookie
> branch from `extractWsToken` once `chat_ws_cookie_reliant` stays 0 for one full release after this
> ships. `chat_ws_cookie_uses` is only the raw "cookie seen" series: browsers send the cookie on every
> same-origin upgrade, so it never reads 0.

Stay on Live (do not route): `/api/chat-ai/*` (the trailing slash in `/api/chat/` keeps it out),
`/api/emotes/*`, `/api/channels/*` (channel moderation dashboard), `/api/mod/*`, `/api/media/*`,
`/ws/call` (until the calls cutover, `docs/calls-cutover.md`), `/ws/broadcast`, `/ws/control`, and
everything else.

Loopback only, never routed: Chat `/internal/live/*`, `/internal/chat/*`, `/health`, `/ready`; Live
`/internal/chat-context/*`, `/internal/chat-effects/*` (both refuse anything that came through
nginx).

The additive Chat-owned ingress at `/internal/chat/{messages,events,moderation,invalidate,presence}`
is documented in [chat-ingress.md](chat-ingress.md). Live keeps using `/internal/live/*` until its
writers are repointed; deploy the three new capability grants before that Live release.

## Data authority

| Table (Live baseline, target OpenVibe.Chat) | W6 authority | Notes |
| --- | --- | --- |
| `chat_messages`, `dm_conversations`, `dm_participants`, `dm_messages`, `dm_blocks`, `tts_voice_overrides`, `channel_sounds`, `relay_users`, `hidden_relay_users`, `pending_ip_messages`, `stream_first_chats`, `moderation_actions` | **Chat** | Imported with their ids. Live read a mirror of them (Chat → `POST /internal/chat-effects/mirror`) until 2026-10-05, when it moved to Chat's internal read API (`server/chat/internal-reads.js`); Live's remaining writers (AI viewers, relays, donations, `/api/mod`, `/api/channels` deletes, emote renames) forward to Chat (the bridge at the cutover; Chat's ingress since T3 J3a). |
| `channel_moderators`, `channel_moderation_settings`, `emotes`, `user_tags`, `chat_ai_summaries`, `chat_timeline_events` | **Chat** (C-04 done) | Chat's own tables; Chat is their only writer. Live reads what it needs through `GET /internal/moderation/*` (`chat.moderation.read`), and Live's writers call Chat's APIs and ingress (the bridge op `db` they used is retired, T3 J3a). There is no authority switch any more. |
| `media_requests`, `media_request_settings` | **Live** (not moved) | Decision with evidence: every writer is `server/media/media-queue.js` / `server/media/routes.js` (`/api/media`: gold payment, yt-dlp download, playback state, the streamer's overlay and dashboard). Chat only has the `!sr/!queue/!np/!skip` entry points, which call Live (`POST /internal/chat-effects/media-queue`). Not chat-owned in practice; it moves with the queue lifecycle the charter describes, not before. The importer reports them as `not_moved`. |
| `chat_messages_new`, `emotes_new`, `channel_sounds_new` | — | Transient tables of Live's table rebuilds; empty in a consistent snapshot. Rows found there go to `import_hold`. |

Chat also keeps `ctx_users`, `ctx_streams`, `ctx_managed_streams`, `ctx_channels` — projections of
Live data maintained by `live-context` (never authority), `events_outbox`, `live_mirror_outbox` (the retired read mirror's queue: no code path writes or drains
it since 2026-10-05; the table stays until a later contract migration drops it), `import_hold`,
`import_runs`. The retired bridge's `bridge_applied` / `bridge_refs` are dropped
(`migrations/0005_drop_bridge_tables.sql`).

## Prerequisites

1. **Contracts.** Register `docs/capabilities-proposal/*.json` in OpenVibe.Contracts (a new
   `openvibe-contracts` release): `live.chat_context.read`, `live.chat_effects.write`,
   `chat.live_bridge.write`, `chat.presence.read` (owner chat). Add the live ones to `manifests/services/live.json`; set `manifests/services/chat.json` to
   alpha with `capabilities: ["chat.live_bridge.write", "chat.presence.read"]`,
   `eventsProduced: ["chat.message.created", "chat.dm.created", "chat.moderation.action"]` and a
   `contractRanges` that includes the release. Until then `openvibe-contracts-check` reports these
   capabilities as undefined (Live's CI with the patch, Chat's non-blocking contracts job).
2. **Network.** Create the principal and grants:
   ```bash
   sudo node --env-file=/etc/openvibe/network.env server/setup/service-principal.js create chat --write-env /etc/openvibe/chat.env
   ```
   Network's env file goes **before** the script name so Node loads it as configuration;
   `--write-env` names the file the secret is written to (Chat's). Never put `--env-file`
   after the script name — Node consumes it as environment, which can point the script at
   Chat's database instead of Network's (`ov_network`).
   `principal_grants` (client, capability, audience): `chat live.chat_context.read openvibe.live`,
   `chat live.chat_effects.write openvibe.live`,
   `live chat.live_bridge.write openvibe.chat`, `live chat.message.send openvibe.chat`,
   `live chat.presence.read openvibe.chat` (`chat events.event.publish openvibe.events` is already
   a default). Without `chat.message.send`, Chat refused the bridge ops that sent a message (AI
   viewer, relay and donation lines, deploy notices); since T3 J3a it guards
   `POST /internal/chat/messages`. Add them to
   `DEFAULT_GRANTS` in `server/identity/principals.js` so every boot keeps them.
   VIP member badges (after this cutover, any time): `chat vip.entitlement.check openvibe.vip`;
   without it no message carries a badge (README, "VIP member badges").
3. **Live.** Apply `docs/live-patch.diff` to Live `main` (`git apply docs/live-patch.diff`), run its
   tests (`node test/chat-context.test.js`, `npm test`), deploy it **without** `CHAT_AUTHORITY` —
   nothing changes for users; the new internal routes answer only service tokens and every effect
   answers 409 while the flag is off. Add `OV_CHAT_INTERNAL_URL=http://127.0.0.1:4400` to
   `/etc/openvibe/live.env`.
4. **Chat.** `git clone … /opt/openvibe.chat && cd /opt/openvibe.chat && npm ci --omit=dev`;
   `/etc/openvibe/chat.env` from `.env.example` (0600): `OV_LIVE_INTERNAL_URL`, Network URLs,
   `BASE_URL=https://openvibe.live` and `EVENTS_URL` if OpenVibe.Events is deployed. The unit sets `CHAT_DB_PATH`, `CHAT_CACHE_DIR`,
   `SOUNDS_PATH=/opt/openvibe.live/data/sounds` and allows writes there. ffmpeg/ffprobe and
   espeak-ng are the host's (Live uses the same).
   ```bash
   sudo cp deploy/systemd/openvibe-chat.service /etc/systemd/system/ && sudo systemctl daemon-reload
   ```
   Do not start it before the rehearsal is signed off.

## Rehearsal on a live.db snapshot

Nothing here touches production data. A rehearsal Chat may read production Live
(`/internal/chat-context/*` is read-only), but every effect is refused while Live's flag is off —
no coins, AI replies or pastes happen; anon numbers come out temporary (`anon9xxxxxxxx`).

```bash
# 1. snapshot (online, consistent)
sqlite3 /opt/openvibe.live/data/live.db ".backup /tmp/live-rehearsal.db"
SNAP_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"

# 2. import into a scratch database
cd /opt/openvibe.chat
node scripts/import-from-live.js --live-db /tmp/live-rehearsal.db --chat-db /tmp/chat-rehearsal.db
node scripts/import-from-live.js --live-db /tmp/live-rehearsal.db --chat-db /tmp/chat-rehearsal.db --apply --no-backup
```

Check the report: per table `live` = `inserted` (first run), `held_total` 0 (anything held: look at
`import_hold.reason`), `media_requests.not_moved`, `chat_messages.next_id` = Live's max + headroom.
Cross-check: `sqlite3 /tmp/live-rehearsal.db "select count(*) from chat_messages"` against the
report. Run the import again: every `inserted` must be 0 (idempotent).

```bash
# 3. a rehearsal Chat on 4401 against production Live (the mirror is retired: reads go to Chat's
#    internal read API)
sudo -u ubuntu env $(sudo cat /etc/openvibe/chat.env | xargs) PORT=4401 CHAT_DB_PATH=/tmp/chat-rehearsal.db \
     CHAT_CACHE_DIR=/tmp/chat-rehearsal-cache EVENTS_URL= node server/index.js &
curl -s http://127.0.0.1:4401/ready | jq     # status: "ready" once a Live sync pass succeeded

# 4. parity: the same reads answer the same (history pinned before the snapshot)
node scripts/parity-check.js --live https://openvibe.live --chat http://127.0.0.1:4401 --before "$SNAP_AT" \
     --stream <a live stream id> --stream <an ended stream id> --channel <streamer user id> --channel <another> \
     --token <a test account's Network JWT>
```

Expected: `all paths answer the same`. Then by hand against 4401 (`wscat -H 'Origin: https://openvibe.live'
-c ws://127.0.0.1:4401/ws/chat?stream=<id>`): `{"type":"join","streamId":<id>}` → `auth`; a join
with a token → `authenticated: true`; `/help`; a message → stored in `/tmp/chat-rehearsal.db` and
returned by `/api/chat/<id>/history` on 4401. Stop the rehearsal Chat and delete `/tmp/chat-rehearsal*`.

## Cutover

Pick a quiet moment (`curl -s https://openvibe.live/api/streams`: restarting Live drops RTMP
streamers; `deploy.sh --wait-idle` waits for none).

1. **Start Chat on an empty database, import.**
   ```bash
   sudo systemctl start openvibe-chat && curl -s http://127.0.0.1:4400/ready | jq
   sqlite3 /opt/openvibe.live/data/live.db ".backup /tmp/live-cutover-1.db"
   sudo -u ubuntu node scripts/import-from-live.js --live-db /tmp/live-cutover-1.db --chat-db /var/lib/openvibe-chat/chat.db --apply
   ```
   Chat now holds everything up to snapshot 1 and its id sequences start 10000 above Live's
   (`--headroom`), so rows Live writes until the flip still fit below.
2. **Flip.** Set `CHAT_AUTHORITY=chat` in `/etc/openvibe/live.env`, restart Live (it tells chat
   clients it restarts), and as soon as `https://openvibe.live/api/ready` answers, add the include
   to nginx and reload:
   ```bash
   sudo systemctl restart openvibe-live            # or deploy.sh --wait-idle
   # add: include /opt/openvibe.chat/deploy/nginx/openvibe.live-chat.locations.conf;
   sudo nginx -t && sudo systemctl reload nginx
   ```
   Between the two steps `/ws/chat` on Live answers 503 and clients retry with backoff; afterwards
   they land on Chat.
3. **Second import pass** — rows Live wrote between snapshot 1 and its restart:
   ```bash
   sqlite3 /opt/openvibe.live/data/live.db ".backup /tmp/live-cutover-2.db"
   sudo -u ubuntu node scripts/import-from-live.js --live-db /tmp/live-cutover-2.db --chat-db /var/lib/openvibe-chat/chat.db --apply
   ```
   Chat's own new rows were already in Live through the mirror at the cutover and count as `identical`; `chat_kept` counts rows
   Chat edited since pass 1 (Chat wins); `held` must be 0.
4. **Checks.**
   - `curl -s 127.0.0.1:4400/ready | jq` — `status` "ready" (`live.last_success_at` recent).
   - Live: `sqlite3 …/live.db "select count(*) from chat_bridge_outbox"` stays near 0 (its forwarded
     writes are acknowledged); `journalctl -u openvibe-live | grep ChatRemote` shows no refusals.
   - Browser: join a stream chat, send a message (it appears for others and in history after a
     reload), `/help`, a DM between two test accounts (live delivery + unread badge), a moderator
     `/timeout` on a test account, a channel `!sound`, the global feed on the home page.
   - Live features that read chat: home page chat stats, a recap, AI viewers answering in a test
     stream, `/api/mod` chat logs and deletes (the deleted line disappears in Chat).
   - `node scripts/parity-check.js --live http://127.0.0.1:3000 --chat http://127.0.0.1:4400 …` is no
     longer meaningful (Live mounts no chat routes); Live's readers now use Chat's internal read API
     (`server/chat/internal-reads.js`).

## Rollback

There is no rollback to Live. Chat is required in every mode: Live runs with `CHAT_AUTHORITY=chat`
and mounts no chat routes, so unsetting the flag would leave `/ws/chat` and the chat REST prefixes
unanswered, not served by Live. The nginx include stays in place through any rollback.

1. A bad Chat release is undone on Chat's side: `sudo ovhost rollback chat --to <sha>` (README,
   "Deploys") restarts the previous release. nginx, the routing include and `/etc/openvibe/live.env`
   are untouched, so chat keeps being served — a socket reconnects after the restart. Nothing blocks
   this: the migrations are additive and the previous release reads the same database.
2. If Chat cannot run at all, chat is down until it is restored: Live has no copy of the sockets,
   the DMs, the TTS and sound queue or the moderation log to serve from. There is no rollback
   through the read mirror any more (retired 2026-10-05): Live's readers call Chat's internal read
   API, so while Chat is down those reads fail too. Restore `openvibe-chat.service` and confirm
   `/ready`; there is no mirror queue to drain and no `scripts/mirror-flush.js`.
3. Keep the database and the sounds. `/var/lib/openvibe-chat/chat.db` (PostgreSQL after the switch
   below) is the only copy of chat's own state — rooms, DMs and their read state, the audio queue,
   calls — and the clips under `SOUNDS_PATH` are the only copy of the sound files; keep both for
   any later recovery.

## Behaviour that is not byte-for-byte identical

- **Ordering of Live's reactions.** The OpenCoins chat bonus (`coin_earned`), AI-viewer reactions,
  translations and the PowerChat relay happen in Live after the message is broadcast (one call per
  message); before, the coin reply was sent before the broadcast. Arena and media-queue replies
  arrive a round trip later.
- **Freshness of Live data.** Chat answers from caches: changes made in Live reach Chat at once
  through invalidations (channel moderators/settings and alert sounds via Live's db writes, IP
  approvals, role/avatar pushes, admin user edits, bans followed by a disconnect) and otherwise
  within the TTL — bans 10 s, channel policy 15 s, settings 30 s, follows/cosmetics/tags 60 s,
  new users 30 s (all users every 15 min), live/ended streams 10 s. Live's synchronous reads of
  chat presence (viewer counts, AI-viewer pacing, `getConnectedUserIp` in `/api/mod` bans) are up
  to 3 s old.
- **Placeholder ids.** A chat row Live's own modules create (AI viewers, relays, donations) gets its
  id from Chat; the Live caller sees a placeholder (≤ -2^40), mapped to the real id for everything it
  sends to chat afterwards. What such a caller stores itself keeps the placeholder:
  `ai_viewer_log.chat_message_id` and the PowerChat message id of AI-viewer lines.
- **Separate rate-limit budget.** The chat REST routes count against Chat's own `/api` limiter
  (same numbers) instead of sharing Live's; Live's request analytics no longer see them.
- **Live unreachable.** Chat keeps serving rooms from its caches; new sign-ins resolve as anonymous
  and new anonymous visitors get a temporary number (`anon9xxxxxxxx`) until Live answers; effects are
  skipped (coins, AI viewers) or answer an error (`/color`, media commands).
- **Deploy notices** are still Live's (its commits, announced in chat through the OpenVibe.Events
  event `live.release.deployed`; the bridge op is retired, T3 J3a); Chat's own deploys are not announced.
- **Responses** carry the same fields as before; Chat's `*subject_id` columns are stripped from API
  answers.

## Live quirks moved as they are

Found while moving; deliberately not fixed in this wave (fix after the cutover, in one place):

- `GET /api/chat/search` always reports `total: 0` (its count regex does not cross the SELECT's line
  break).
- `POST /api/chat/send` never attaches cosmetics (Live required a module that does not exist).
- A `/timeout` stores an ISO `expires_at` that Live compares as TEXT with SQLite's
  `'YYYY-MM-DD HH:MM:SS'`, so a timeout lasts at least until the end of that UTC day.
- `/api/tts/admin/settings` masks credentials in the TTS engine's cached settings object, so for up
  to 30 s after an admin views them the owner's view — and Google/AWS synthesis — see the mask.
- `/paste` announces "Anonymous shared a paste" and titles it "Chat paste by anon" (it reads
  fields the chat client object does not have).
- The AI-viewer / PowerChat "is moderator" flag passes the channel owner's user id where a channel
  id belongs (`canModerateChannel(user, channelUserId)`).

## PostgreSQL switch (plan T3, ADR-035)

Chat's own database moves from the SQLite file to PostgreSQL; the Live read mirror (retired
2026-10-05) and the bridge (retired, T3 J3a) were unchanged in meaning. This is a runbook for that one deploy — the schema is `migrations/0001_initial.sql`
(applied by `openvibe-sdk/db` at boot, owner role) and the data moves once.

**Prerequisites.** `DATABASE_URL` (the runtime role, through PgBouncer — DML only, no session state) and
`DATABASE_DIRECT_URL` (the owner role, a direct connection, for migrations). `VALKEY_URL` / `VALKEY_PREFIX`
are optional: with them the per-actor rate-limit counters are shared across processes and hosts, without
them they stay in this process (as before). The role pair is the one `openvibe-sdk/testing`'s `store:'pg'`
creates, so `npm run test:pg` rehearses the same shape.

**Rehearse on a copy.** Take a consistent copy of the running database and import it into a local PGlite:

    sqlite3 /var/lib/openvibe-chat/chat.db ".backup /tmp/chat-pg-source.db"
    node scripts/import-sqlite-to-pg.js --sqlite /tmp/chat-pg-source.db --pglite ./data/pglite

The import (`openvibe-sdk/db` `importSqlite`, reading the file with `node:sqlite`) copies every table the
migration has, parents first, ids kept; identity sequences are `setval`'d past the imported maximum; each
table is verified (row count + a checksum walked in primary-key order) and printed as one line
(`[import] <table> <rows> rows checksum <16 hex> (<ms> ms)`), then the tail
(`[import] <n> tables, <rows> rows, ok|FAILED`); the whole report is recorded in `import_runs`. It runs with
`ov.mirror_skip = '1'`, so the imported rows are never queued into the (retired) Live read mirror's
outbox, and ends with
`ANALYZE` as the owner (the runtime role's ANALYZE is a no-op; without statistics the history page plans a
Sort). A problem (a source column with no target, a verification mismatch) makes it exit 1.

**Switch.**
1. On the old release: stop the unit (drained: nothing writes the file any more). Before 2026-10-05
   this also waited for `.mirror.pending` → 0; the mirror is retired, so `/ready` reports no mirror.
2. Keep the file as it is (`cp -a /var/lib/openvibe-chat/chat.db /var/lib/openvibe-chat/chat.db.pre-pg`) and
   import it as the owner (the script applies `migrations/` first, then copies):

       node scripts/import-sqlite-to-pg.js --sqlite /var/lib/openvibe-chat/chat.db --url "$DATABASE_DIRECT_URL"

3. Check the counts: the report's rows per table against `sqlite3 /var/lib/openvibe-chat/chat.db "select
   count(*) from <table>"` for `chat_messages`, `dm_messages`, `rooms`, `room_messages`, `audio_requests`;
   `ok` on the tail line.
4. Set `DATABASE_URL` and `DATABASE_DIRECT_URL` (and `VALKEY_URL`, `VALKEY_PREFIX`) in
   `/etc/openvibe/chat.env`; deploy and start the new release (it applies `migrations/` as the owner at boot:
   nothing to do, the import's schema is current). `GET /ready`: `db` ok with `max_message_id` equal to the
   file's `select max(id) from chat_messages`, `valkey` ok (skipped without `VALKEY_URL`). (`/ready` no
   longer reports a mirror queue: it was retired on 2026-10-05.)
5. From the deployed commit, `npm run n-1:record` and commit `test/fixtures/n-1`: the N-1 test then replays
   this release's PostgreSQL statements again (it reports itself skipped until then).

**Rollback** is the previous release plus the retained SQLite file: stop Chat, unset `DATABASE_URL` /
`DATABASE_DIRECT_URL` (the old release reads `CHAT_DB_PATH`, which the unit still sets), and start the old
release on `chat.db.pre-pg`. The twelve chat tables Live once mirrored lose nothing Live has already seen; rows
written on PostgreSQL after the switch to Chat's own tables (rooms, calls, the audio queue, DMs' read
state) are not in the file — export them from PostgreSQL first if the rollback comes after real traffic.
Keep the SQLite file read-only for the rollback window; do not delete it until the PostgreSQL deploy has
served a full release.

The read-only closeout record — release/readiness, env presence, the pending checks — is `docs/cutover-evidence-t3.md`.
