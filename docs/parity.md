# Chat parity script (WS-I task 6)

`scripts/parity.js` runs the chat product end to end over the real protocol (`/ws/chat` and the
REST routes Live's `chat.js` and popout use), with two or three people connected, and checks what
each of them sees. `test/parity.test.js` runs the same scenarios against Chat booted with stubs
(part of `npm test`), and adds what only a test can reach: Live's moderator paths through the
bridge and the CLI's own safety checks.

| Scenario | What is checked | Kind |
| --- | --- | --- |
| `join` | anonymous and signed-in joins get their `auth` frame; the user list names the signed-in people and counts the anonymous one | write |
| `send` | the sender's echo and every other viewer's copy carry the same stored id; the line is in the stream history | write |
| `dm` | the other participant's socket gets the `dm` frame, the sender's is not echoed, a non-participant gets nothing and is refused the conversation (`dm.isParticipant`) | write |
| `tts` | `/tts` reaches the room as a `tts` line and is a request in the channel's TTS queue (`GET /api/tts/queue`); its audio frame follows when it plays | write |
| `soundboard` | `!<sound>` gives the room the "played !sound" line and the `soundboard-audio` frame, through the queue | write |
| `ban` | `/ban`: everyone sees the notice, the banned person's next line is refused and reaches nobody, `/unban` lifts it | destructive |
| `timeout` | `/timeout B 2`: refused inside the two seconds, talking again after | destructive |
| `purge` | the dashboard's range purge (ISO `from`/`to`): the room gets the `purge` frame, the range is gone from history, the line before it stays | destructive |
| `slow` | `/slow 2`: a viewer's second line inside the window is refused and reaches nobody; the moderator's two lines 1.2 s apart both go out | destructive |
| `subonly` | **gap**: there is no sub-only mode (below) | — |
| `popout` | a live popout (stream join) and a channel-room popout (join by `channelUserId`) read their histories, get the stream's lines, and the channel popout's line reaches the stream; `get-users` answers | write |
| `reconnect` | A stays, B leaves; a line is deleted and another written while B is away; B reconnects and reads `?after_id=<cursor>`: B's view equals A's, and a fresh page agrees | destructive |
| `blocked` | **gap**: public chat does not apply blocks (below) | — |

## Running it

```bash
npm test -- parity                     # the scenarios against Chat with stubs

# Against a running Chat. Without --apply it only prints the plan (no connection is opened).
OV_PARITY_BASE=http://127.0.0.1:4401 OV_PARITY_STREAM=<live stream of a test channel> \
OV_PARITY_TOKEN_A=… OV_PARITY_TOKEN_B=… OV_PARITY_TOKEN_MOD=… OV_PARITY_TOKEN_STREAMER=… \
OV_PARITY_TEST_ACCOUNTS=parity_a,parity_b,parity_mod,parity_streamer OV_PARITY_SOUND=honk \
node scripts/parity.js [--apply] [--only join,send]
```

Roles: A and B are viewers (B is the one banned, timed out and reconnecting), MOD moderates the
stream's channel, STREAMER owns it (needed for `purge` only). `OV_PARITY_SOUND` names a channel sound
command (else `soundboard` is skipped); `OV_PARITY_ORIGIN` (default `https://openvibe.live`) is the
WebSocket origin; `OV_PARITY_CHANNEL_USER_ID` saves looking up the owner's id.

**Safety.** With `--apply` the script first signs each token in and reads the stream's channel
owner, and runs **nothing** (exit 2) unless every one of those accounts is named in
`OV_PARITY_TEST_ACCOUNTS`. Bans, timeouts, slow mode, purges and deletes then only touch dedicated
test accounts and their own channel. Do not run it against a real channel. Tokens are never printed.
Exit 1 when a scenario fails; gaps and skips are reported, not failed.

## Known gaps (2026-09-25)

- **Sub-only mode does not exist**, in Chat or in Live: no channel setting, no command, no check
  (followers-only exists). Chat also has no subscriber lookup: subscriptions are Live's. A product
  decision (what "sub" means: Live subscriptions, VIP membership), then a Live context read and a
  rule in `_chatRulesBlock`.
- **Blocks do not apply to public chat.** `network.block.changed` and `dm_blocks` are honoured for
  DMs and calls only. A blocked person's lines reach the blocker live and in every history read,
  before and after a reconnect, and Live's `chat.js` hides nothing either. Needs a decision (hide
  for the blocker only? both ways? not for moderators?), then per-recipient filtering in the
  broadcasts and the history reads.
- **A channel-room popout's users panel is not the channel's.** `getUserList(null)` is everyone
  outside a stream: global chat and every offline channel room. The `popout` scenario notes it.
- **Slow mode lives in memory.** `/slow` is written to the channel's `slow_mode_seconds`, but that
  setting is never read back: a Chat restart turns slow mode off, and the dashboard's value is not
  enforced.
- `/clear` only clears screens; the lines stay in history and return on a reload. A range purge
  reaches only sockets joined to that stream (not a channel-room popout, not the global feed that
  showed the forwarded copies).

## Fixed while building it

- Timeouts ended at midnight UTC: `expires_at` (ISO) was compared as text with SQLite's time.
  `live-context.js` now reads it as an instant. (Live's own ban queries still compare text.)
- A ban or timeout took effect only after an unawaited cache refresh, so the target's next line could
  still go out; the refresh now finishes before the moderator is answered, also when one was
  already in flight.
- The dashboard's range purge, its preview and the log filter compared ISO bounds with SQLite
  timestamps as text: a same-day range matched nothing. They use `datetime(?)`.
- Moderators were slowed by slow mode (they could not even turn it off inside the window). The
  room's moderators now keep only the 1 s flood limit.
- A cursor read (`?after_id=`) never said what was deleted under the cursor, so a reader that
  reconnected kept deleted lines. Cursor reads now carry `deleted_ids` (among the room's newest 1000
  rows); openvibe.chat applies them. Live's floating widget (`hydrateWidgetOnly`) should too.
