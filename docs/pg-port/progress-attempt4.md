# [cloud] t3-chat-pg-engine: Chat serves from PostgreSQL (openvibe-sdk/db; PGlite for dev and npm test)

Plan T3, last step: the engine move (brief steps 2–4 and what follows from them). One coherent change on top of
`83497e7` (a1–a3: SDK v0.25.2, `migrations/0001_initial.sql`, the import script, the Valkey limiter, the N-1 skip).

## What I built

**Database layer** — `server/db/database.js` on `openvibe-sdk/db`:
- `openDb/initDb/getDb/setDb` in Media's shape: `DATABASE_URL` (runtime role through PgBouncer, `DATABASE_POOL_MAX`
  optional) with `migrations/` applied first as the owner on `DATABASE_DIRECT_URL`; outside production without
  `DATABASE_URL`, an embedded PGlite in `data/pglite` (`CHAT_PGLITE_DIR`). Production refuses to start without both URLs.
- `run/get/all/transaction` (and `tx`) are async with better-sqlite3's shapes: `run()` answers
  `{ changes, lastInsertRowid }` — an `INSERT` into a table with an `id` column gets `RETURNING id` appended — so
  no caller, bridge answer or HTTP body changes shape. `transaction(fn)` is `db.tx` with ambient transactions.
- `installMirrorTriggers()`, the TEMP-trigger code, `ADDED_COLUMNS`/`PRAGMA` patching and `initDb({ captureMirror })`
  are gone; the four runtime schema creators (`rooms`, `token_revocations`, `network_blocks`,
  `account_data_events`) are no-ops (their tables are in the migration). `server/db/schema.sql` is removed.
- Boot awaits `initDb()`; background loops that now await the database log a rejection instead of ending the process.

**Every call site async** — `tools/asyncify` of OpenVibe.SDK over `server/**`, `scripts/**`, `test/**` (config
with `asyncGlobals` for the helpers and `apis` for `db`/`ctx`/`chatServer`/…); a scratch patch to the tool taught it
class methods (`this.x()`), and the rest by hand: `db.transaction(…)` → `db.tx`, the MANUAL sites
(`.filter/.some` callbacks → loops or one `= ANY(?)` read), computed calls in the bridge (`db[fn]`, `chatServer[op]`),
a getter that became async (`slowModeByStream()`), factory instances (`mirror.pending()`, `eventsConsumer.apply()`),
and write loops the tool had turned into `Promise.all` put back in order. The Events inbox is the SDK's
`createPgInbox`. Two orderings that used to be one synchronous tick are kept: a call's session row ends before
anyone hears `call-ended`, and the channel leaves memory before the database is written.

**SQL dialect** — `CURRENT_TIMESTAMP` → `ov_now()` (text in SQLite's shape, so comparisons with stored text stay
right); `INSERT OR IGNORE/REPLACE` → `ON CONFLICT`; `LIKE` → `ILIKE`; `COLLATE NOCASE` → `lower()`; `IS ?` →
`IS NOT DISTINCT FROM`; `MAX(a, ?)` → `GREATEST`; `"window"` quoted; `datetime(?, 'unixepoch')` → `to_timestamp`;
`HAVING` on expressions and complete `GROUP BY`; `SUM` cast to bigint; derived-table aliases; qualified columns in
`ON CONFLICT DO UPDATE`; a safe anon-id cast; `ORDER BY id` where SQLite's rowid order was relied on.

**Decisions**
1. Mirror: the migration's triggers capture all twelve tables; `live-mirror.js` reads rows with one static statement
   per table; with `LIVE_MIRROR` off the queue is emptied on the relay's cadence (as when capture was off). The
   importers set `ov.mirror_skip`. The bridge's `stagedApply` apply path was deleted on main before this change, so
   no bridge op applies Live's own rows any more (see For Opus).
2. History: `id DESC` page (a2), and `deletedIds()` now windows by `id DESC` too.
3. Audio queue: `claim(id)` = `UPDATE … SET state='playing', attempts=attempts+1 WHERE id=? AND state='queued'
   RETURNING *`; the synth runs outside any transaction; skip/clear of a row still being made send no skip frame;
   enqueue: caps counted in the transaction, dedupe by the unique `(room, dedupe_key)` + `ON CONFLICT DO NOTHING`.
   Boot keeps today's handling of rows left `playing`. `test/audio-claim.test.js`: two pumps (two module instances,
   separate pool connections on PostgreSQL) over 40 rooms → every request played exactly once (PostgreSQL: pump a
   29–33, pump b 7–11 across runs), one claim wins, concurrent enqueues of one key store one row.
5. Valkey limiter (a1) unchanged; `/ready` valkey check skips when unset.
6. N-1: `npm run n-1:record` records a release on PostgreSQL (booted on its own PGlite dir; its applied migrations
   with their text; its statements as PostgreSQL received them, hooked on `openvibe-sdk/db`; source literals
   compiled to `$n`); `test/n-1.test.js` skips while the fixture is from a SQLite release (the same line as a3) and
   replays a PostgreSQL fixture by itself (rebuilds N-1's database from its migrations, this release migrates and
   serves it, every N-1 statement `PREPARE`s, no INSERT misses a new required column). Verified locally: recorded
   from this commit → 319 statements, all checks pass; a migration dropping `relay_users.display_name` fails it. The
   committed fixture is still the SQLite one, so this release reports the skip.
7. Account export/erase, subject merge and the mirror are static statements per table (`= ANY(@param)`), export
   "most recent N" by primary key.
8. `relay_users.id` is a real identity; `CHAT_TABLES.relay_users` keys by `id`.
10. `scripts/import-sqlite-to-pg.js` reads the file with `node:sqlite`, applies `migrations/` first (also for
    `--url`), then imports, `ANALYZE`s and records the report in `import_runs`.
11. better-sqlite3 leaves `package.json` (the lock keeps it only as an optional peer of another package, never
    installed). One-time tools read SQLite through `scripts/lib/sqlite.js` (`node:sqlite`, better-sqlite3's shape).
    `test/no-sqlite.test.js` guards it. `scripts/import-from-live.js` (Live snapshot → Chat) is ported too: a
    savepoint per row, `setval` instead of `sqlite_sequence`, and a JSON copy of the tables it writes instead of
    `VACUUM INTO`.

**Migration changes** (`0001_initial.sql` is not on main yet, so it was still editable): identities
`GENERATED BY DEFAULT` (the bridge, the importers and tests keep ids); `moderation_actions.scope_id` and
`chat_messages.deleted_by` are `text` — SQLite's INTEGER columns held ids *and* names (a room slug, a purge's display
name), and an id reads back as a number wherever a row leaves Chat (`moderationRow`/`chatMessageRow`).

**Tests** — `test/helpers/pg-preload.mjs` (`node --import`, from `test/run.js`) gives every test process one migrated
database: an in-memory PGlite, or with `OV_TEST_STORE=pg` a schema and roles of its own through PgBouncer. A Chat or a
script the test spawns reaches the same database (`h.childDbEnv()`: the run's URLs, or this process's PGlite served
over the wire protocol by `@electric-sql/pglite-socket`, new dev dependency, with a one-connection pool). Tests that
opened SQLite files read through that handle; `ready.test.js` changes the schema as the owner. Docs: README storage
section, STATUS.json runtime, `docs/cutover.md` (PostgreSQL switch runbook refreshed, rollback flush command).

## How I tested it

PostgreSQL 16 (port 55432, superuser `ov`, database `ovtest`), PgBouncer 1.22 in transaction mode with `auth_query`
(56432) and Valkey 7.2 (56379), installed with apt in the session:

    export OV_TEST_PG_URL=postgres://ov:…@127.0.0.1:56432/ovtest
    export OV_TEST_PG_DIRECT_URL=postgres://ov:…@127.0.0.1:55432/ovtest
    export OV_TEST_VALKEY_URL=redis://127.0.0.1:56379/0

    npm test
    45/47 test files passed, 2 skipped (message-deleted.test.js: message-deleted end-to-end: skipped (no OpenVibe.Events with redaction at /home/user/OpenVibe.Events) | n-1.test.js: n-1: skipped (engine switch to PostgreSQL: N-1 re-recorded after this release deploys))

    npm run test:pg
    45/47 test files passed, 2 skipped (message-deleted.test.js: message-deleted end-to-end: skipped (no OpenVibe.Events with redaction at /home/user/OpenVibe.Events) | n-1.test.js: n-1: skipped (engine switch to PostgreSQL: N-1 re-recorded after this release deploys))

    N1_LIVE_REPO=<Live clone> npm run n-1:record   # then node test/n-1.test.js on that fixture → "n-1: all checks passed" (fixture not committed)

Every test file was also run alone with every failing statement logged: the only SQL errors are the expected ones
(the import dry run's foreign-key holds, `ready.test.js`'s renamed table). The message-deleted end-to-end half skips
because there is no OpenVibe.Events checkout here (it skipped before this change too).

**History page p95, 200 000 rows** (the global page of `history-store.js`, `LIMIT 60`, 200 repetitions after 10
warm-up reads, `ANALYZE` as the owner; one chat message in 50 deleted):

| store | query | p50 | p95 | plan |
| --- | --- | --- | --- | --- |
| BEFORE: SQLite (main, better-sqlite3, in-process) | `ORDER BY timestamp DESC, id DESC` | 0.91 ms | **1.19 ms** | `SCAN cm USING INDEX idx_chat_ts_deleted` + temp B-tree for the ORDER BY |
| PostgreSQL 16 via PgBouncer | old order | 2.38 ms | 3.39 ms | Limit → Incremental Sort → Index Scan Backward `idx_chat_timestamp` |
| AFTER: PostgreSQL 16 via PgBouncer | `ORDER BY id DESC` | 1.99 ms | **2.74 ms** | Limit → Index Scan `idx_chat_page_live`, no Sort |
| PGlite (dev, `npm test`) | old order | 5.62 ms | 8.08 ms | Incremental Sort |
| AFTER: PGlite | `ORDER BY id DESC` | 4.88 ms | **7.11 ms** | Index Scan `idx_chat_page_live`, no Sort |

The move adds a network round trip (≈1.5 ms here, loopback) to an in-process read; the new order removes the Sort.
Readers see it at most once per 2 s per room (the page memo in front of it).

## For Opus

- **Push/PR access**: this session could not push (`OpenVibers/OpenVibe.Chat` is not in its authorized repository
  set; the git proxy refused a credential) and `codeload.github.com` is blocked by egress policy (npm installed the
  three GitHub-tag dependencies from git clones at the same tags; `package.json`/lock keep the codeload URLs). The
  branch is delivered as `t3-chat-pg.bundle` (see the session's message).
- **The cutover** (not attempted): `docs/cutover.md` § PostgreSQL switch — drain the mirror, stop, keep
  `chat.db.pre-pg`, `node scripts/import-sqlite-to-pg.js --sqlite /var/lib/openvibe-chat/chat.db --url
  "$DATABASE_DIRECT_URL"` (migrates, imports, verifies per table, `ANALYZE`, writes `import_runs`), check counts,
  set `DATABASE_URL`/`DATABASE_DIRECT_URL`/`VALKEY_URL`/`VALKEY_PREFIX` in `/etc/openvibe/chat.env` (roles from Host's
  `roles/data add-service.sh chat`; the runtime role needs `USAGE, SELECT, UPDATE` on sequences), start,
  `/ready`, then `npm run n-1:record` from the deployed commit and commit the fixture. Rollback: previous release on
  `chat.db.pre-pg` (loses Chat-only writes made after the switch: rooms, calls, audio queue).
- **Decision 1, the bridge half**: `SET LOCAL ov.mirror_skip` is on the importers only. The bridge no longer has an
  apply path for Live's own rows (`stagedApply` went with f7bf6a6); its `db` ops are Chat writes made for Live's
  current release, which the old per-connection TEMP triggers also captured, so they are still mirrored.
- **Decision 8 and Live's mirror**: mirror changes for `relay_users` now carry `pk: { id }`; upserts still carry
  `platform`/`username` in the row, and Chat never deletes `relay_users` rows, but Live's applier should key that
  table by `(platform, username)` (its copy has no `id`).
- **Two column types changed from the brief's migration** (`moderation_actions.scope_id`, `chat_messages.deleted_by`
  → text), because production rows hold names in them; identities are `BY DEFAULT`. Both need your nod since the
  migration becomes immutable once merged.
- **Erasure**: account deletion now erases the person's own chat-AI summaries/timeline (`scope='user'`, by Live id).
  On SQLite that statement compared a bigint to `usr_…` subjects and matched nothing.
- `/ready` and behaviour notes: a restart no longer resets per-actor limits when `VALKEY_URL` is set (a1); an
  unhandled rejection in a background loop is now logged instead of ending the process.
