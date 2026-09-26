# Chat cutover — Live → OpenVibe.Chat (roadmap Wave 6)

What changes at the cutover: browsers keep calling `https://openvibe.live`, but nginx sends the chat
socket and the chat REST prefixes to OpenVibe.Chat (127.0.0.1:4400), and Live runs with
`CHAT_AUTHORITY=chat`. Nothing in Live's browser code changes. Everything below is reversible
until the Live-side read mirror is retired (a later wave).

- [What is served where](#what-is-served-where)
- [Data authority](#data-authority)
- [Prerequisites](#prerequisites)
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
| `^~ /ws/chat` | the chat WebSocket (`?stream=`, `?token=`; protocol unchanged) |
| `^~ /api/chat/` | `GET gif/providers`, `GET gif/trending`, `GET gif/search`, `POST send`, `GET search`, `GET user/:userId/history`, `GET user/:username/profile`, `GET relay-user/:platform/:username`, `GET relay-user/:platform/:username/logs`, `GET anon/:anonId`, `GET anon/:anonId/logs`, `GET filters/friendly`, `GET global/history`, `GET :streamId/replay`, `GET :streamId/history`, `GET channel/:userId/history`, `GET :streamId/users`, `POST admin/purge/preview`, `DELETE admin/purge`, `GET admin/logs`, `GET admin/logs/export` |
| `^~ /api/dm/` | `GET/POST conversations`, `GET/PATCH conversations/:id`, `GET/POST conversations/:id/messages`, `DELETE conversations/:id/messages/:msgId`, `POST conversations/:id/read`, `POST conversations/:id/participants`, `DELETE conversations/:id/participants/:userId`, `GET unread`, `GET users/search`, `GET blocks`, `POST/DELETE blocks/:userId`, `GET blocks/check/:userId` |
| `^~ /api/tts/` | `GET voices`, `GET settings`, `GET/PUT admin/settings`, `POST admin/test`, `GET audio/:file` (Chat's clips; Live's arena/mod-preview clips are fetched from Live under the same URL), `GET queue`, `POST queue/skip`, `POST queue/clear`, `POST queue/:id/report` (the TTS and sound queue) |
| `= /api/sounds` and `^~ /api/sounds/` | `POST /api/sounds` (upload), `GET channel/:userId`, `GET all/:streamId`, `DELETE :id`, `PATCH command`, `GET file/:filename`, `GET alert/mine`, `POST/DELETE alert/:kind` |

Stay on Live (do not route): `/api/chat-ai/*` (the trailing slash in `/api/chat/` keeps it out),
`/api/emotes/*`, `/api/channels/*` (channel moderation dashboard), `/api/mod/*`, `/api/media/*`,
`/ws/call` (until the calls cutover, `docs/calls-cutover.md`), `/ws/broadcast`, `/ws/control`, and
everything else.

Loopback only, never routed: Chat `/internal/live/*`, `/health`, `/ready`; Live
`/internal/chat-context/*`, `/internal/chat-effects/*` (both refuse anything that came through
nginx).

## Data authority

| Table (Live baseline, target OpenVibe.Chat) | W6 authority | Notes |
| --- | --- | --- |
| `chat_messages`, `dm_conversations`, `dm_participants`, `dm_messages`, `dm_blocks`, `tts_voice_overrides`, `channel_sounds`, `relay_users`, `hidden_relay_users`, `pending_ip_messages`, `stream_first_chats`, `moderation_actions` | **Chat** | Imported with their ids. Live keeps a read mirror (Chat → `POST /internal/chat-effects/mirror`); Live's remaining writers (AI viewers, relays, donations, `/api/mod`, `/api/channels` deletes, emote renames) forward to Chat. |
| `channel_moderators`, `channel_moderation_settings`, `emotes`, `user_tags`, `chat_ai_summaries`, `chat_timeline_events` | **Live** (staged in Chat) until each is handed over | Moved one table at a time by `docs/staged-tables-cutover.md` (register C-04): at `live` Live writes and its changes reach Chat's copy over the bridge; at `chat` Live's writers call Chat and the mirror copies the table back. Chat reads the moderation tables through `live-context` while Live writes them and in place once Chat does. |
| `media_requests`, `media_request_settings` | **Live** (not moved) | Decision with evidence: every writer is `server/media/media-queue.js` / `server/media/routes.js` (`/api/media`: gold payment, yt-dlp download, playback state, the streamer's overlay and dashboard). Chat only has the `!sr/!queue/!np/!skip` entry points, which call Live (`POST /internal/chat-effects/media-queue`). Not chat-owned in practice; it moves with the queue lifecycle the charter describes, not before. The importer reports them as `not_moved`. |
| `chat_messages_new`, `emotes_new`, `channel_sounds_new` | — | Transient tables of Live's table rebuilds; empty in a consistent snapshot. Rows found there go to `import_hold`. |

Chat also keeps `ctx_users`, `ctx_streams`, `ctx_managed_streams`, `ctx_channels` — projections of
Live data maintained by `live-context` (never authority), `events_outbox`, `live_mirror_outbox`,
`bridge_applied`, `import_hold`, `import_runs`, `table_authority`.

## Prerequisites

1. **Contracts.** Register `docs/capabilities-proposal/*.json` in OpenVibe.Contracts (a new
   `openvibe-contracts` release): `live.chat_context.read`, `live.chat_effects.write`,
   `live.chat_mirror.write` (owner live), `chat.live_bridge.write`, `chat.presence.read` (owner
   chat). Add the live ones to `manifests/services/live.json`; set `manifests/services/chat.json` to
   alpha with `capabilities: ["chat.live_bridge.write", "chat.presence.read"]`,
   `eventsProduced: ["chat.message.created", "chat.dm.created", "chat.moderation.action"]` and a
   `contractRanges` that includes the release. Until then `openvibe-contracts-check` reports these
   capabilities as undefined (Live's CI with the patch, Chat's non-blocking contracts job).
2. **Network.** Create the principal and grants:
   ```bash
   sudo node server/setup/service-principal.js create chat --env-file /etc/openvibe/chat.env
   ```
   `principal_grants` (client, capability, audience): `chat live.chat_context.read openvibe.live`,
   `chat live.chat_effects.write openvibe.live`, `chat live.chat_mirror.write openvibe.live`,
   `live chat.live_bridge.write openvibe.chat`, `live chat.message.send openvibe.chat`,
   `live chat.presence.read openvibe.chat` (`chat events.event.publish openvibe.events` is already
   a default). Without `chat.message.send`, Chat refuses the bridge ops that send a message (AI
   viewer, relay and donation lines, deploy notices). Add them to
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
   `SITE_URL=https://openvibe.live`, `BASE_URL=https://openvibe.live`, `LIVE_MIRROR=1`, and
   `EVENTS_URL` if OpenVibe.Events is deployed. The unit sets `CHAT_DB_PATH`, `CHAT_CACHE_DIR`,
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
# 3. a rehearsal Chat on 4401 against production Live, mirror OFF
sudo -u ubuntu env $(sudo cat /etc/openvibe/chat.env | xargs) PORT=4401 CHAT_DB_PATH=/tmp/chat-rehearsal.db \
     CHAT_CACHE_DIR=/tmp/chat-rehearsal-cache LIVE_MIRROR=0 EVENTS_URL= node server/index.js &
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
   Chat's own new rows are already in Live (mirror) and count as `identical`; `chat_kept` counts rows
   Chat edited since pass 1 (Chat wins); `held` must be 0.
4. **Checks.**
   - `curl -s 127.0.0.1:4400/ready | jq` — `status` "ready" (`live.last_success_at` recent), `mirror.pending` near 0,
     `mirror.last_error` null.
   - Live: `sqlite3 …/live.db "select count(*) from chat_bridge_outbox"` stays near 0 (its forwarded
     writes are acknowledged); `journalctl -u openvibe-live | grep ChatRemote` shows no refusals.
   - Browser: join a stream chat, send a message (it appears for others and in history after a
     reload), `/help`, a DM between two test accounts (live delivery + unread badge), a moderator
     `/timeout` on a test account, a channel `!sound`, the global feed on the home page.
   - Live features that read chat: home page chat stats, a recap, AI viewers answering in a test
     stream, `/api/mod` chat logs and deletes (the deleted line disappears in Chat).
   - `node scripts/parity-check.js --live http://127.0.0.1:3000 --chat http://127.0.0.1:4400 …` is no
     longer meaningful (Live's chat routes answer 503 now); compare against the mirror instead with
     `sqlite3` counts: Live `chat_messages` ≈ Chat `chat_messages`.

## Rollback

Live becomes the chat authority again on its own tables, which the mirror kept complete.

1. Remove the include from nginx; `sudo nginx -t && sudo systemctl reload nginx` (chat traffic goes
   to Live, which answers 503 until step 3 — clients retry).
2. Make sure everything Chat wrote is in Live: `curl -s 127.0.0.1:4400/ready | jq .mirror.pending`
   → 0. If the service cannot run: `cd /opt/openvibe.chat && sudo -u ubuntu env $(sudo cat
   /etc/openvibe/chat.env | xargs) CHAT_DB_PATH=/var/lib/openvibe-chat/chat.db node scripts/mirror-flush.js`
   (exit 0 = drained). Live accepts mirror writes only while it still has the flag, so do this
   before step 3.
3. Remove `CHAT_AUTHORITY` from `/etc/openvibe/live.env`, restart Live. At boot Live applies any
   chat writes it had queued for Chat and never got acknowledged (`chat_bridge_outbox`).
4. `sudo systemctl stop openvibe-chat`. Keep `/var/lib/openvibe-chat/chat.db` (a later cutover starts
   from a fresh database and a fresh import; `subject_id` values are recomputed from Live's
   `linked_accounts`).

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
- **Deploy notices** are still Live's (its commits, announced in chat through the bridge); Chat's own
  deploys are not announced.
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
