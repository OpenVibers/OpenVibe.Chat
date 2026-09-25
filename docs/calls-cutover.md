# Calls cutover — Live → OpenVibe.Chat (roadmap WS-I task 1)

What changes at the cutover: browsers keep calling `https://openvibe.live`, but nginx sends the call
socket and the call REST routes to OpenVibe.Chat (127.0.0.1:4400), Chat runs with `CHAT_CALLS=1` and
Live with `CALLS_AUTHORITY=chat`. Nothing in Live's browser code changes (`public/js/call.js`,
`voice-channels.js`, the ringing overlays in `chat.js`); ICE servers still come from Live's
`GET /api/auth/ice-servers`. Everything below is reversible.

- [What is served where](#what-is-served-where)
- [The two switches](#the-two-switches)
- [Prerequisites](#prerequisites)
- [Cutover](#cutover)
- [Checks](#checks)
- [Rollback](#rollback)
- [Behaviour that is not byte-for-byte identical](#behaviour-that-is-not-byte-for-byte-identical)

## What is served where

nginx locations (`deploy/nginx/calls/openvibe.live-calls.locations.conf`, included in Live's
`server { … server_name openvibe.live … }` block next to the chat include, above `location /api/`):

| nginx location | Chat serves (`server/calls/`) |
| --- | --- |
| `^~ /ws/call` | the call WebSocket (`?channelId=` — or the legacy `?streamId=` / a bare stream number — and `?token=`; every message type unchanged) |
| `^~ /api/streams/voice-channels` | `GET/POST /api/streams/voice-channels`, `GET/DELETE /api/streams/voice-channels/:channelId`, `POST /api/streams/voice-channels/call-user`, `POST /api/streams/voice-channels/call-user/respond` |
| `~ ^/api/streams/[0-9]+/call$` | `GET/PUT /api/streams/:id/call` |

Everything else under `/api/streams/` (go-live, stream end, VODs, channels, …) stays on Live.

Loopback only, never routed: Chat `POST /internal/calls/stream-channel` and
`DELETE /internal/calls/stream-channel/:streamId` (Live's stream hooks; they refuse anything that came
through nginx).

**The file is in `deploy/nginx/calls/` on purpose.** Live's vhost already has
`include /opt/openvibe.chat/deploy/nginx/*.locations.conf;` (the chat cutover). A calls file in that
directory would route calls to Chat at the first nginx reload after a Chat deploy, before either
switch below. The flip is adding its own include line; the rollback is removing it.

## The two switches

| Where | Variable | Off (default) | On |
| --- | --- | --- | --- |
| Chat, `/etc/openvibe/chat.env` | `CHAT_CALLS=1` | `/api/streams/…` answers 404, `/ws/call` upgrades are refused, `/internal/calls/*` answers 409 `calls.off`; Chat never pushes a voice-channel list or a call invite | Chat serves the paths above and owns the lifecycle rows (`calls`) |
| Live, `/etc/openvibe/live.env` | `CALLS_AUTHORITY=chat` | Live's call server makes and removes stream voice channels, exactly as before | go-live with a call mode, stream end, the WHIP teardown and the admin force-end call Chat's `/internal/calls/stream-channel` instead |

Chat needs its own switch because its chat sockets and openvibe.chat's `/api/` are already public:
without it, `POST https://openvibe.chat/api/streams/voice-channels…` would reach the new routes and
push Chat's voice-channel list and call invites into openvibe.live's chat sockets while calls were
still Live's.

Live → Chat authentication is the chat bridge's: a Network service token for audience
`openvibe.chat` carrying `chat.live_bridge.write` (Live already holds that grant since the chat
cutover; no new grant, no new secret). Live retries a hook after a network error or a 5xx (1 s, 5 s,
15 s), never after a 4xx, and drops a retry that a later hook for the same stream superseded.

Optional: `CALL_RING_TIMEOUT_MS` (Chat, default 45000) — a direct call nobody answers is `missed`
after this long and the caller is told (see below).

## Prerequisites

- Chat deployed with `server/calls/` (this release), `curl -s 127.0.0.1:4400/ready | jq .status` →
  `"ready"`.
- Live deployed with `server/streaming/calls-authority.js` and the `notify/call-invite` chat effect
  (the cross-site "X is calling you" notification is Live's to push).
- Live's bridge works: `journalctl -u openvibe-live --since -1h | grep ChatRemote` shows no refusals.
- A quiet moment. Voice channels are memory, in Live as in Chat: calls in progress at the flip drop
  (clients reconnect to Chat and rejoin), user channels are not carried over, and **a stream that is
  live with calls on at the flip has no voice channel in Chat** until the streamer goes live again
  (or `PUT /api/streams/:id/call`). Check there is none:
  ```bash
  sqlite3 /opt/openvibe.live/data/live.db "select id, user_id, call_mode from streams where is_live = 1 and call_mode is not null"
  ```

## Cutover

1. **Chat serves calls.** Add `CHAT_CALLS=1` to `/etc/openvibe/chat.env`, restart Chat (chat clients
   are told it restarts and reconnect):
   ```bash
   sudo systemctl restart openvibe-chat
   journalctl -u openvibe-chat -n 50 | grep CallServer        # "Voice channels initialized (serving)"
   curl -s 127.0.0.1:4400/api/streams/voice-channels | jq '.channels[].id'   # "public"
   curl -s -o /dev/null -w '%{http_code}\n' -X DELETE 127.0.0.1:4400/internal/calls/stream-channel/1   # 401 (mounted, guarded)
   ```
2. **Live hands its stream hooks to Chat.** Add `CALLS_AUTHORITY=chat` to `/etc/openvibe/live.env`
   and restart Live (socket activation: no 502s; boot about 6 s):
   ```bash
   sudo systemctl restart openvibe-live
   until curl -sf https://openvibe.live/api/ready >/dev/null; do sleep 1; done
   journalctl -u openvibe-live -n 200 | grep 'CALLS_AUTHORITY=chat'
   ```
3. **Route the paths.** In `/etc/nginx/sites-enabled/openvibe.live.conf`, next to the chat include:
   ```nginx
   include /opt/openvibe.chat/deploy/nginx/calls/openvibe.live-calls.locations.conf;
   ```
   On openvibe.chat (`/etc/nginx/sites-available/openvibe.chat.conf` and this repo's reference
   `deploy/nginx/openvibe.chat.conf`) its `location /api/` already reaches Chat; add the socket:
   ```nginx
   location ^~ /ws/call {
       proxy_pass http://127.0.0.1:4400;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header CF-Connecting-IP $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 3600s;
       proxy_send_timeout 3600s;
   }
   ```
   (Every `proxy_set_header` is repeated inside the location on purpose: a location that sets any of
   them inherits none from the server block.) Then:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
   Between steps 2 and 3, `/ws/call` still reaches Live's (now empty) call server; streams that go live
   in that window get their channel in Chat, where browsers land after the reload.

## Checks

- `curl -s https://openvibe.live/api/streams/voice-channels | jq '.channels[].id'` → `"public"` and
  whatever users created since the flip.
- Two test accounts in the Chat tab: join the Public voice channel, hear and see each other, mute
  shows on the other side, leave. `sqlite3 /var/lib/openvibe-chat/chat.db "select id, kind, state,
  channel_id, end_reason from calls order by id desc limit 5"` shows the `channel` session `active`,
  then `ended` / `empty`.
- Call one test account from the other (user menu → Call): the callee rings (and gets the
  notification), accept → connected; the row is `direct`, `ringing` → `active` → `ended`. Decline →
  `declined`; busy → `declined` / `busy`; let it ring out → `missed` (`no-answer` from the callee's
  browser at 30 s, else `timeout` at 45 s, and the caller sees "No answer").
- A test stream with calls on: go live with a call mode, the stream page's call joins
  `stream-<id>`, `GET /api/streams/<id>/call` shows the mode and participants; end the stream →
  everyone gets `call-ended`, the row is `stream` / `ended` / `stream_ended`. An admin force-end does
  the same. `journalctl -u openvibe-live | grep '\[Calls\]'` shows no "Chat refused".
- Moderation: in a test channel, kick (the kicked account cannot rejoin for a minute) and ban/unban.

After one release without a rollback: remove Live's call server and routes (a later change) and move
the include into `deploy/nginx/` so the glob carries it.

## Rollback

1. Remove the include line from openvibe.live's nginx (and the `/ws/call` location from
   openvibe.chat's); `sudo nginx -t && sudo systemctl reload nginx`. Browsers are back on Live's
   `/ws/call` and routes; `call.js` reconnects with backoff.
2. Remove `CALLS_AUTHORITY` from `/etc/openvibe/live.env`, restart Live. From the next go-live on,
   Live's call server makes stream channels again (the ones Chat held are not copied back: a stream
   live at that moment needs its streamer to go live again).
3. Optional: remove `CHAT_CALLS` from `/etc/openvibe/chat.env` and restart Chat, so it stops
   answering the call routes on openvibe.chat too. Chat keeps its `calls` rows.

## Behaviour that is not byte-for-byte identical

The wire protocol is the same: query parameters, every frame type and field, the REST paths, bodies,
answers and error texts. What differs:

- **The ring times out on the server.** A direct call nobody answers becomes `missed` after
  `CALL_RING_TIMEOUT_MS` (45 s), and the caller gets the `vc-call-response` frame with
  `status: 'no-answer'` — the same frame the callee's browser sends when it gives up at 30 s. With an
  offline callee, Live left the caller ringing until they cancelled.
- **Client address.** The per-address cap (3) and anonymous ids use Chat's rule (CF-Connecting-IP only
  when nginx's peer is Cloudflare, as on `/ws/chat`); Live's call server believed CF-Connecting-IP and
  X-Forwarded-For from anyone.
- **Socket setup is asynchronous.** Sign-in is Chat's cached resolution through Live (and the stream
  and cosmetics are warmed, at most 2.5 s on a cold cache); frames a client sends before its `welcome`
  are handled after it, in order. `auth-update` resolves its token the same way.
- **A reconnect as the only participant** keeps a reachable room (Live's replaced-socket path dropped
  the room from its map, so the next person to join landed in a different one).
- **Call mode** in `GET /api/streams/:id/call` is the mode of the stream's channel in Chat. Live still
  writes `streams.call_mode` at go-live, but Chat's `PUT` does not write it back (nothing else reads it).
- **Cosmetics** (`nameFX`, `particleFX`, `hatFX`) come from live-context's decor cache (60 s).
- **Pushes** (the voice-channel list, invites, responses) go to Chat's chat sockets directly; before
  they went Live → bridge → Chat.
- **Every call is a row** of `calls` (lifecycle in `server/calls/lifecycle.js`); a Chat restart closes
  what was open (`pending` → `failed`, `ringing` → `missed`, `active` → `ended`, reason `restart`).
