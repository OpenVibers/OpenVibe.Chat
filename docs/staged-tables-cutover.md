# Staged tables cutover — Live → OpenVibe.Chat (WS-I task 2, register C-04)

Six chat tables are still written by Live since the Wave 6 cutover (`docs/cutover.md`). This moves
their authority to Chat **one table at a time**, each move reversible:

| Table | Live's writers today | After the flip |
| --- | --- | --- |
| `chat_timeline_events` | `server/ai/chat-ai.js` (global timeline, seeding) | Live's chat AI calls Chat's `addChatTimelineEvents` |
| `chat_ai_summaries` | `server/ai/chat-ai.js` (global, user, relay-user, anon insights) | Live's chat AI calls Chat's `upsertChatAiSummary` |
| `user_tags` | none (chat tags are read-only in Live since the game moved to OpenVibe.Games) | data only; Chat has `grantUserTag` / `revokeUserTag` |
| `emotes` | `POST/PATCH/DELETE /api/emotes`, Media asset-sync (`media_url`, `media_asset_id`) | Live's routes and asset-sync call Chat's `createEmote`, `updateEmote`, `deleteEmote`, `setEmoteMedia` |
| `channel_moderation_settings` | `PUT /api/channels/:id/moderation` (dashboard), Chat's `/slow`, `/subonly` and alert sounds (Live's `/internal/chat-effects/channel-settings` and `alert-sound`) | the dashboard calls Chat's `upsertChannelModerationSettings`; `/slow`, `/subonly` and alert sounds are written by Chat itself |
| `channel_moderators` | `POST/DELETE /api/channels/:id/mods` | Live's routes call Chat's `addChannelModerator` / `removeChannelModerator` |

`media_requests` is **not** part of this: it is not a chat table. Its writers are Live's media
queue (`server/media/media-queue.js`, `server/media/routes.js`, `server/tips/delivery-routes.js`:
gold payment, yt-dlp download, playback state); Chat only has the `!sr/!queue/!np/!skip` entry
points, which call Live; the plan's own media namespaces list it as `live.media_requests`. The
decision of `docs/cutover.md` ("Data authority") stands.

- [How it works](#how-it-works)
- [Calendar](#calendar)
- [Shell helpers](#shell-helpers)
- [0. Deploy](#0-deploy)
- [1. Import](#1-import)
- [2. Parity](#2-parity)
- [3. Dual read for one release](#3-dual-read-for-one-release)
- [4. Flip each table](#4-flip-each-table)
- [5. Live stops writing](#5-live-stops-writing)
- [6. Rollback](#6-rollback)

## How it works

Two records say who writes each table, and they move together:

- **Chat:** `table_authority` in `chat.db` (`scripts/table-authority.js`, `GET /ready` →
  `table_authority`). A restart never changes it.
- **Live:** app_state `chat_table_authority` (JSON; a missing table is `live`), read by
  `server/chat/chat-tables.js`; `GET /internal/chat-tables` shows both sides. Without
  `CHAT_AUTHORITY=chat` Live treats every table as `live`.

**At `live`** (every table after the deploy): Live writes its own table as before. TEMP triggers
capture every change into `chat_staged_outbox`, and a relay sends the rows as they are now to Chat's
bridge (`POST /internal/live/calls`, op `stagedApply`, capability `chat.live_bridge.write`) every
2 s, so Chat's copy stays current. Chat's staged writes refuse (`table.not_chat`). Chat's chat
server reads moderators and settings through Live (`live-context`), as it has since Wave 6. With a
table's **dual-read** flag on, Live's reads of it are compared in the background with Chat's copy
(op `stagedSlice`: row count and a sha256 over the rows) and counted in `chat_dual_read_stats`;
Live's answers never change.

**The flip** (`POST /internal/chat-tables/:table {"authority":"chat"}` on Live, never automatic):
the table's writers wait; Live's queued changes reach Chat; Chat takes the table (op
`setTableAuthority`; refused if `LIVE_MIRROR` is off); Live records `chat` and stops capturing.

**At `chat`:** Live's writers call Chat's write of the same name over the bridge (awaited, with an
idempotency key); Chat answers Live's own return value plus the rows, which Live applies to its copy
at once. Live's table is from then on a read mirror: Chat's triggers queue every change of the table
in `live_mirror_outbox` and the mirror sends it to Live (`/internal/chat-effects/mirror`, as for
Chat's own tables), which takes staged rows only for a table Chat writes. Live's readers do not
change. Chat's chat server reads `channel_moderators` and `channel_moderation_settings` in place,
and writes `/slow`, `/subonly` and alert sounds itself.

**The flip back** (`{"authority":"live"}`): Chat sends Live every queued change of the table and
refuses to give it back while any is left; then Live records `live` and captures again. Running a
flip again is safe: it brings both sides back into agreement after a failed attempt.

## Calendar

The plan (WS-I task 2) asks for dual read during one release before the flip. Live's rollback
window is a week (`test/rollback-newer-writes.test.js`: production may roll back to any release of
the last seven days), and a Live release from before this change would write a flipped table itself.
So a table is flipped only when **both** hold: the dual-read counters stayed at 0 mismatches
through at least one Live release shipped after D0, and every Live release of the last seven days
has this change (at the earliest D0 + 7 days).

| When (D0 = 2026-09-28) | What |
| --- | --- |
| D0, Mon 2026-09-28 | Deploy Chat, then Live. Import (dry run, apply). Parity. Dual read on for all six tables. |
| D0 … D0 + 7 | Watch the counters daily. At least one more Live release ships in this week (any deploy counts), with dual read still on. |
| Mon 2026-10-05 | Flip `chat_timeline_events`. |
| Tue 2026-10-06 | Flip `chat_ai_summaries`. |
| Wed 2026-10-07 | Flip `user_tags`. |
| Thu 2026-10-08 | Flip `emotes`. |
| Fri 2026-10-09 | Flip `channel_moderation_settings`. |
| Mon 2026-10-12 | Flip `channel_moderators` (last: it decides who may moderate). |
| until 2026-11-06 | Keep the flip back available. C-01 to C-03 (Live's chat mirror and bridge) have that target date and carry these tables too. |
| not before 2026-12-18 | Contract step (register C-04 target): remove Live's local write path, the capture and the relay for the staged tables, after 30 days on `chat` without a flip back. |

If the deploy slips, shift every date by the same number of days. If the counters show mismatches,
the flips wait until a full release passes without any.

## Shell helpers

Live's internal routes answer only on loopback with `X-Internal-Key`. The helper takes the key from
the running service and passes it to curl on stdin, so it is never printed or put on a command line.

```bash
live_tables() {
    local key
    key="$(sudo cat /proc/"$(systemctl show -p MainPID --value openvibe-live)"/environ | tr '\0' '\n' | sed -n 's/^INTERNAL_API_KEY=//p')"
    printf 'X-Internal-Key: %s\n' "$key" | curl -sS -H @- -H 'Content-Type: application/json' "$@"
}
LT=http://127.0.0.1:3000/internal/chat-tables
# Chat's side (same database as the service)
chat_tables() { (cd /opt/openvibe.chat && sudo -u ubuntu env CHAT_DB_PATH=/var/lib/openvibe-chat/chat.db node scripts/table-authority.js "$@"); }
STAGED=channel_moderators,channel_moderation_settings,emotes,user_tags,chat_ai_summaries,chat_timeline_events
# The overview used below
status() { live_tables "$LT" | jq '{relay, chat_error, tables: (.tables | map_values({authority, chat_authority, disagree, dual_read, outbox_pending, dr: (.dual_read_stats | {compared, matched, mismatched, inconclusive, errors, last_mismatch_at})}))}'; }
```

## 0. Deploy

Chat first (it must know the new bridge ops before Live starts relaying), then Live. Nothing changes
for users: every table stays at `live`.

```bash
cd /opt/openvibe.chat && sudo -u ubuntu git pull --ff-only
sudo systemctl restart openvibe-chat && until curl -sf 127.0.0.1:4400/ready >/dev/null; do sleep 1; done
curl -s 127.0.0.1:4400/ready | jq '{status, table_authority, mirror}'

cd /opt/openvibe.live/current && sudo deploy/scripts/deploy.sh --wait-idle
until curl -sf https://openvibe.live/api/ready >/dev/null; do sleep 1; done
journalctl -u openvibe-live -n 300 | grep ChatTables
status
```

Look at:

- Chat `/ready`: `status` `ready`, every `table_authority` value `live`, `mirror.last_error` null.
- Live's journal: `[ChatTables] staged tables: channel_moderators=live, …` (the capture and relay
  started). No `relay to Chat waiting` lines after the first minute.
- `status`: every table `authority` and `chat_authority` `live`, no `disagree`, `relay.pending`
  near 0, `relay.last_error` null, `relay.paused` false.

## 1. Import

Chat's copy was last filled at the Wave 6 cutover. The import makes it equal to Live's: refreshed
rows, missing rows added, rows Live no longer has removed (`pruned`). The relay is held meanwhile
(Live keeps capturing), so every change made after the pause reaches Chat after the import and the
import never undoes one.

```bash
# 1a. hold the relay
live_tables -X POST -d '{"paused":true}' "$LT/relay" | jq .relay          # paused: true
# 1b. snapshot Live (online, consistent)
sqlite3 /opt/openvibe.live/data/live.db ".backup /tmp/live-staged-import.db"
# 1c. dry run (the default: nothing is written)
cd /opt/openvibe.chat
sudo -u ubuntu node scripts/import-from-live.js --live-db /tmp/live-staged-import.db \
     --chat-db /var/lib/openvibe-chat/chat.db --tables "$STAGED" --no-projections | tee /tmp/staged-import-dry.json | jq '.tables, .held_total'
# 1d. apply (copies chat.db to /var/lib/openvibe-chat/chat.db.pre-import-<time> first)
sudo -u ubuntu node scripts/import-from-live.js --live-db /tmp/live-staged-import.db \
     --chat-db /var/lib/openvibe-chat/chat.db --tables "$STAGED" --no-projections --apply | tee /tmp/staged-import.json | jq '.backup, .tables, .held_total'
# 1e. release the relay: the changes since 1a go now
live_tables -X POST -d '{"paused":false}' "$LT/relay" | jq .relay
sleep 5; status
```

Look at:

- Dry run and apply report the same numbers. Per table: `authority` `live`; `inserted + identical +
  refreshed` = `live` (the snapshot's rows); `pruned` = rows only Chat had (removed moderators,
  deleted emotes since 2026-09-23); `held` 0. `held_total` unchanged from before the run (anything
  new: `sqlite3 /var/lib/openvibe-chat/chat.db "select source_table, reason from import_hold order by id desc limit 5"`).
- `backup` names the copy of `chat.db` taken before the write.
- After 1e: `relay.paused` false, `relay.pending` back near 0, `relay.last_error` null.
- A second dry run (1c again) reports `inserted` 0 and `pruned` 0 for every table (idempotent).

## 2. Parity

Row counts and a content hash per table, on two snapshots taken back to back:

```bash
status | jq .relay.pending                                                  # 0 (nothing on its way)
sqlite3 /opt/openvibe.live/data/live.db ".backup /tmp/live-parity.db"
sudo -u ubuntu sqlite3 /var/lib/openvibe-chat/chat.db ".backup /tmp/chat-parity.db"
cd /opt/openvibe.chat && sudo -u ubuntu node scripts/parity-check.js --tables --live-db /tmp/live-parity.db --chat-db /tmp/chat-parity.db
```

Look at: `all staged tables are the same`, one `same` line per table with its row count and
authority `(live)`. A `DIFFERENT` line lists the keys only in Live, only in Chat, or different. A
write between the two snapshots shows up this way once: run the three commands again a minute
later. A key that differs twice is real: look at both rows
(`sqlite3 … "select * from <table> where id = <key>"`), then repeat step 1 for that table
(`--tables <table>`) and step 2. Afterwards delete the snapshots (they hold user data):
`rm -f /tmp/live-staged-import.db /tmp/live-parity.db /tmp/chat-parity.db /tmp/staged-import*.json`.

## 3. Dual read for one release

```bash
for t in ${STAGED//,/ }; do live_tables -X POST -d '{"dual_read":true}' "$LT/$t" | jq -c '{t: "'$t'", dual_read: .table.dual_read}'; done
status
```

Every day until the flips (D0 … D0 + 7, and through at least one more Live release — each release
restarts Live; the counters are kept in `chat_dual_read_stats` and survive it):

```bash
status
journalctl -u openvibe-live --since -24h | grep -E 'ChatTables\] (dual read|relay)'
ls /opt/openvibe.live/releases                                              # a release after D0 has shipped
```

Look at:

- `dr.mismatched` stays **0** for every table; `dr.compared` grows for the tables Live reads
  (`channel_moderation_settings`, `channel_moderators`, `emotes`, `chat_ai_summaries`,
  `chat_timeline_events`). `user_tags` has no reader in Live, so it compares nothing: parity (step
  2) is its check — run step 2 again the day before its flip.
- `dr.inconclusive` counts comparisons made while a change was on its way to Chat; it is not a
  mismatch. `dr.errors` counts Chat not answering; a few during Chat restarts are expected.
- `relay.pending` near 0 and `relay.last_error` null at every look.
- A mismatch: `live_tables "$LT" | jq '.tables.<table>.dual_read_stats.last_mismatch'` gives the
  slice (`where`), both counts and hashes, and the keys (`only_live`, `only_chat`, `differ`). Find
  the cause, repeat steps 1 and 2 for that table, reset its counters
  (`live_tables -X POST -d '{"reset_counters":true}' "$LT/<table>"`) and start the release over.

## 4. Flip each table

One table per day, in the order of the calendar. Before each flip:

```bash
status                                                     # this table: mismatched 0, outbox_pending 0, no disagree
curl -s 127.0.0.1:4400/ready | jq '{status, mirror}'       # mirror.enabled true, pending near 0, last_error null
C04=d6480da   # the Live commit of this change (git -C /opt/openvibe.live/repo log --oneline --grep 'C-04')
for r in /opt/openvibe.live/releases/*; do git -C /opt/openvibe.live/repo merge-base --is-ancestor "$C04" "${r##*-}" && echo "has it  $r" || echo "OLDER   $r"; done
```

Every release of the last seven days must say `has it` (`--rollback` must never land on one that
writes the table itself). Then flip:

```bash
T=chat_timeline_events        # the table of the day
live_tables -X POST -d '{"authority":"chat","by":"'"$USER"'"}' "$LT/$T" | jq
```

Look at:

- The answer: `ok` true, `handoff.authority` `chat`, `table.authority` and `table.chat_authority`
  both `chat`, `table.outbox_pending` 0. `ok` false: nothing moved (`error` says why; Chat not
  reachable, `LIVE_MIRROR is off`, Live's queue not drained). Fix it and run the same command again.
- `journalctl -u openvibe-live -n 50 | grep "ChatTables\] $T"` → `live → chat`;
  `journalctl -u openvibe-chat -n 50 | grep "$T: Chat writes it now"`.
- `chat_tables` → `"$T": { "authority": "chat", … }`; `curl -s 127.0.0.1:4400/ready | jq .table_authority`.

## 5. Live stops writing

The flip is the moment Live stops writing the table: its writers call Chat and Live's copy only
takes Chat's rows. Check it the same day, with a real write through the feature:

| Table | A write to make | Then |
| --- | --- | --- |
| `chat_timeline_events`, `chat_ai_summaries` | none: the chat AI writes within 30 minutes while chat is active (`journalctl -u openvibe-live \| grep ChatAI`) | the newest row by `id` / `updated_at` is the same in both databases |
| `user_tags` | none | step 2 for `user_tags` |
| `emotes` | upload a test emote on a test channel, rename it, delete it (dashboard → Emotes) | each step shows in Chat's `emotes` with the same `id` as in Live's, then in Live's |
| `channel_moderation_settings` | change a setting on a test channel in the dashboard; `/slow 5` then `/slow off` as its moderator | Chat's row changes first, Live's copy follows; slow mode works in the stream chat |
| `channel_moderators` | add and remove a test moderator in the dashboard | the moderator can `/timeout` a test account in that channel's chat, and cannot after removal |

```bash
sudo -u ubuntu sqlite3 /var/lib/openvibe-chat/chat.db "select * from $T order by rowid desc limit 3"
sqlite3 /opt/openvibe.live/data/live.db "select * from $T order by rowid desc limit 3"
status | jq ".tables.$T"                                   # outbox_pending stays 0: Live captures nothing now
curl -s 127.0.0.1:4400/ready | jq .mirror                  # pending near 0, last_error null
journalctl -u openvibe-live --since -1h | grep -E "ChatTables|refused" | grep -v 'staged tables:'
```

Look at: the same rows (same ids) on both sides; `outbox_pending` 0; no `OpenVibe.Chat refused`
and no `not applied here` lines; Chat's mirror queue drains. For the emote, settings and moderator
checks, also run step 2 for the table (the `same` line says `(chat)`). A write that fails while Chat
is unreachable answers an error to the user and changes nothing in Live: that is the table being
Chat's. After the last table (2026-10-12), run step 2 for all six.

## 6. Rollback

| Step | Rollback | Look at |
| --- | --- | --- |
| 0. Deploy | Nothing to undo while every table is `live`. Before rolling Live (`deploy.sh --rollback`) or Chat back past these changes, every table must be `live` again (row 4). | `status`: no table at `chat` |
| 1. Import | The staged copy in Chat is read by nothing while its table is `live`, so a bad import has no effect on users. Repeat step 1 (pause, fresh snapshot, `--apply`, resume). **Never copy the `.pre-import-*` backup over `chat.db`**: it would drop the chat messages written since; it is for looking at. If step 1 stopped between 1a and 1e, release the relay: `live_tables -X POST -d '{"paused":false}' "$LT/relay"`. | `status`: `relay.paused` false, pending drains |
| 2. Parity | Read-only. | — |
| 3. Dual read | `for t in ${STAGED//,/ }; do live_tables -X POST -d '{"dual_read":false}' "$LT/$t" >/dev/null; done`. It never changed an answer. | `status`: `dual_read` false |
| 4. Flip | `live_tables -X POST -d '{"authority":"live","by":"'"$USER"'"}' "$LT/$T" \| jq`: Chat sends its queued changes of the table to Live first, then Live writes it again. Refused while any change is still queued (`not in Live yet`): look at `curl -s 127.0.0.1:4400/ready \| jq .mirror` and run it again. | answer `table.authority` / `chat_authority` `live`; `outbox_pending` counting Live's new writes, then draining |
| 4, Chat down | 1) send Chat's queue to Live: `cd /opt/openvibe.chat && sudo -u ubuntu env $(sudo cat /etc/openvibe/chat.env \| xargs) CHAT_DB_PATH=/var/lib/openvibe-chat/chat.db node scripts/mirror-flush.js` (exit 0 = drained; Live takes the rows only while the table is still `chat` there, so this comes first); 2) Chat's side: `chat_tables set $T live --force`; 3) Live's side: `live_tables -X POST -d '{"authority":"live","force":true}' "$LT/$T"`. | `status`: `authority` `live`; once Chat runs again `chat_authority` `live`, no `disagree` |
| 5. Live stops writing | Same as step 4: the flip back makes Live the writer again. | as step 4 |
| Wave 6 rollback | Before `docs/cutover.md` "Rollback", flip every table back (row 4). If Chat cannot run, its mirror flush there (step 2 of that rollback) carries the staged tables at `chat` too; then set each table back with the "Chat down" row. | `status` |

If `status` shows `disagree` for a table (one side `chat`, the other `live`, after a failed or forced
flip), run the flip that states the side you want once more; Live's relay keeps any change Chat
refused in the meantime and sends it once both sides agree.
