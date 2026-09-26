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
| `purge` | the dashboard's range purge (ISO `from`/`to`): the stream's sockets get the `purge` frame, a channel-room popout and the global feed drop the same ids (`delete-messages`), channel and global cursor reads name them in `deleted_ids`; the range is gone from history, the line before it stays | destructive |
| `slow` | `/slow 2`: a new socket reads the saved value back; a viewer's second line inside the window is refused and reaches nobody; the moderator's two lines 1.2 s apart both go out | destructive |
| `subonly` | `/subonly`: the room gets the `subonly` frame and a new socket's `auth` says `sub_only`; B (no subscription) and an anonymous viewer are refused and reach nobody; A (an active subscriber) and MOD talk; after `/subonly off` B talks again | destructive |
| `popout` | a live popout (stream join) and a channel-room popout (join by `channelUserId`) read their histories, get the stream's lines, and the channel popout's line reaches the stream; `get-users` answers | write |
| `reconnect` | A stays, B leaves; a line is deleted and another written while B is away; B reconnects and reads `?after_id=<cursor>`: B's view equals A's, and a fresh page agrees | destructive |
| `blocked` | A blocked B on the network (one-way): B's lines never reach A's stream socket or global feed; A reconnects and reads `?after_id=` as A: B's lines are left out and the cursor still moves past them; fresh pages read as A (channel, stream, global) leave them out, read as MOD they are there; A's lines reach B; after the unblock B reaches A again | destructive |

## Running it

```bash
npm test -- parity                     # the scenarios against Chat with stubs

# Against a running Chat. Without --apply it only prints the plan (no connection is opened).
OV_PARITY_BASE=http://127.0.0.1:4401 OV_PARITY_STREAM=<live stream of a test channel> \
OV_PARITY_TOKEN_A=… OV_PARITY_TOKEN_B=… OV_PARITY_TOKEN_MOD=… OV_PARITY_TOKEN_STREAMER=… \
OV_PARITY_TEST_ACCOUNTS=parity_a,parity_b,parity_mod,parity_streamer OV_PARITY_SOUND=honk \
OV_PARITY_SUBSCRIBER=a OV_PARITY_A_BLOCKS_B=1 \
node scripts/parity.js [--apply] [--only join,send]
```

Roles: A and B are viewers (B is the one banned, timed out and reconnecting), MOD moderates the
stream's channel, STREAMER owns it (needed for `purge` only). `OV_PARITY_SOUND` names a channel sound
command (else `soundboard` is skipped); `OV_PARITY_ORIGIN` (default `https://openvibe.live`) is the
WebSocket origin; `OV_PARITY_CHANNEL_USER_ID` saves looking up the owner's id.
`OV_PARITY_SUBSCRIBER=a` says A holds an active Live subscription to the test channel and B none
(else `subonly` is skipped); `OV_PARITY_A_BLOCKS_B=1` says A has blocked B on openvibe.network (else
`blocked` is skipped; the test sets the block itself). Both leave the account in that state.

**Safety.** With `--apply` the script first signs each token in and reads the stream's channel
owner, and runs **nothing** (exit 2) unless every one of those accounts is named in
`OV_PARITY_TEST_ACCOUNTS`. Bans, timeouts, slow mode, purges and deletes then only touch dedicated
test accounts and their own channel. Do not run it against a real channel. Tokens are never printed.
Exit 1 when a scenario fails; gaps and skips are reported, not failed.

## Known gaps (2026-09-26)

- **A channel-room popout's users panel is not the channel's.** `getUserList(null)` is everyone
  outside a stream: global chat and every offline channel room. The `popout` scenario notes it.

## Closed (2026-09-26)

The gaps the script found on 2026-09-25, with the product decisions taken for them:

- **Sub-only mode.** A channel setting (`channel_moderation_settings.sub_only`, in Live and Chat),
  set by `/subonly` and `/subonly off` (the streamer, channel moderators and chat staff) and by the
  dashboard's moderation settings, written where that table's authority says (Live's
  `channel-settings` effect while it is at `live`, Chat's `upsertChannelModerationSettings` once Chat
  writes it). When it is on, only people with an **active Live channel subscription** to the streamer
  (Live's `subscriptions`: status active, the paid period not over; Billing's entitlement under
  `BILLING_AUTHORITY=billing`), the streamer, channel moderators and chat staff may chat; Network VIP
  does not count and anonymous viewers cannot chat. Chat asks Live `GET
  /internal/chat-context/subscriber` (`live-context.js` `isSubscriber`, cached a minute, asked again
  before a line when unknown or when a "no" is five seconds old) and **fails closed**: when Live
  cannot be asked, a non-moderator is told sub-only is on. The rule is in `_chatRulesBlock` (chat
  lines, `/me`, `/tts`); `!` commands follow the same rules as under followers-only (not gated).
- **Blocks in public chat**, one-way: someone who blocked a person on the network
  (`network.block.changed`, `network-blocks.js`) no longer gets that person's lines (chat, `/me`,
  `/tts` and its audio): every broadcast skips their sockets, and history pages and cursor reads
  (global, channel, stream; and openvibe.chat's first page) leave them out for that reader, with
  `latest_id` and `deleted_ids` unchanged so the cursor moves on. Everyone else, the blocked person
  included, is unaffected; moderation logs and exports show everything; DMs and calls keep their rule
  (blocked either way). Chat's own messenger blocks (`dm_blocks`) stay DM-only.
- **Slow mode is the saved `slow_mode_seconds`.** `/slow N` and `/slow off` write it (as above) and
  the room hears it once saved; Chat reads it back from the channel's policy (at join, after its own
  write, and when Live says the channel changed), so a restart keeps slow mode and the dashboard's
  value is enforced; a change made in the dashboard is announced to the room. Live's dashboard sent
  and read `slowmode_seconds`, which no writer knew, so its slow mode was never saved; it uses
  `slow_mode_seconds` now (the old name is still accepted). Moderators stay exempt.
- **Purges and deletes reach every surface.** A range purge sends the `purge` frame to the stream's
  sockets and the purged ids (`delete-messages`) to the whole channel room (other slots, the offline
  room, a channel popout) and the global feed; single deletes (Chat's own and Live's dashboard) reach
  the channel room and the global feed too. Cursor reads name them in `deleted_ids`.
- **`/clear` clears screens** (Twitch semantics) and now says so to the moderator: "Chat cleared on
  screen; messages stay in history — use purge to remove them."

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
