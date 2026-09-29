Repository: /home/workstation/OpenVibers/OpenVibe.Chat (work ONLY here). Never open .env files or anything holding secrets; never commit, push, deploy, or touch other repositories (read others freely). Use Node 22: prefix node/npm with `fnm exec --using=22.22.1`. Run every command in the foreground. Build fake keys in tests at runtime. Never change how any page looks. `rm` is denied: delete files with `git rm`. Migrations: new files under `migrations/`; never edit one another commit added. Work in commits-sized steps and keep `npm test` green after each; you do not commit — list the steps in your report. End with what you changed per step (file:line), the per-table import report format, the p95 numbers of the history page before/after, and the final summary lines of `npm test` and `npm run test:pg`.

# Plan T3 (last part): OpenVibe.Chat on PostgreSQL + Valkey

Read first: docs/pg-port/research.md (the verified research: every table, file,
sync call site, risk and step). It was written BEFORE T3 finished; the facts below override it.

## What changed since the brief (facts)
- T3 is done: Chat has been the only writer of the six tables since 2026-09-29 14:46 UTC; the staged machinery
  (stagedApply/stagedSlice/tableAuthority ops, sliceHash, applyStagedChanges, scripts/table-authority.js,
  docs/staged-tables-cutover.md) and `table_authority` are DELETED. Brief steps 8, 10 and 11 and risks 10 and the
  staged half of 3 no longer apply; open question 1 is moot.
- STILL LIVE: the C-02/C-03 bridge and the mirror of the TWELVE non-staged tables into Live's copies
  (`live_mirror_outbox`, `installMirrorTriggers()` TEMP triggers gated per connection, `scripts/mirror-flush.js`).
- Chat pins openvibe-sdk v0.23.1 today; the target is v0.25.2 (ships `openvibe-sdk/db`, `/testing`, `/limits`,
  `/valkey`, and `tools/asyncify` in the SDK repo at the tools/asyncify folder of github.com/OpenVibers/OpenVibe.SDK (clone it)).
- Patterns to copy (read-only): OpenVibe.Media `server/db/database.js` (openDb/initDb/getDb, PGlite dev fallback) and
  `migrations/0001_initial.sql` prelude (ov_ts, ov_now, datetime(), json_* compat); OpenVibe.Events/OpenVibe.Community
  test/helpers for the per-process migrated test database and `npm run test:pg`.

## Decisions (Opus; build exactly these)
1. Mirror capture: real PostgreSQL triggers (plpgsql, in the migration) on the twelve mirrored tables append to
   `live_mirror_outbox`, skipped when `current_setting('ov.mirror_skip', true) = '1'`; the bridge's apply path (Live's
   writes) runs `SET LOCAL ov.mirror_skip = '1'` inside its transaction so Live's changes never come back.
   `installMirrorTriggers()` and the TEMP-trigger code go. Test: "Live's changes never come back", "every Chat writer is
   captured", "pending 0 after a flush", on PGlite and PostgreSQL.
2. `chat_messages` page order is `id DESC` alone (ids are preserved by the import, so order is too); keep `timestamp`
   as SQLite-format text via `ov_now()` for display. Index to match; EXPLAIN in the latency test shows an index scan.
3. Audio queue: the claim is one atomic `UPDATE audio_requests SET state='playing', attempts=attempts+1 WHERE id=$1 AND
   state='queued' RETURNING *` (zero rows = someone else took it); the synth runs OUTSIDE any transaction; enqueue's
   dedupe is a unique index + `ON CONFLICT DO NOTHING` with the caps counted inside the transaction. Boot keeps today's
   handling of rows left 'playing'. Test: two concurrent pump() loops on real PostgreSQL → exactly one play per
   request.
4. SDK v0.25.2 first (step 0, its own step), with `pg`, `@electric-sql/pglite`, `iovalkey`.
5. Valkey backs the per-actor rate limiter (`openvibe-sdk/limits` + `createValkeyLimitStore`, `VALKEY_URL`/
   `VALKEY_PREFIX`, a /ready check that reports `skipped` when unset). The history-store memo stays in-process.
6. N-1: the engine-switch release cannot replay SQLite-dialect SQL. `test/n-1.test.js` prints one
   `skipped (engine switch to PostgreSQL: N-1 re-recorded after this release deploys)` line for this release only
   (the ○ convention), and `npm run n-1:record` must work against PostgreSQL afterwards (record the previous
   release's statements from its PostgreSQL schema). Do not delete the harness.
7. Account export / subject merge / live-mirror dynamic SQL: dedicated static queries per table (no interpolated
   identifiers), ordered by the primary key where the SQLite code used rowid ("most recent N" = highest id).
8. `relay_users` gets a real identity column `id` (the answers keep their `id` field; `CHAT_TABLES.relay_users` keys
   by id).
9. Timestamps stay SQLite-format text (the compat prelude), like Media and Live's decision; booleans stay integers
   where the code compares with 0/1.
10. Production import: `scripts/import-sqlite-to-pg.js` wrapping `openvibe-sdk/db` `importSqlite` (per-table count +
    checksum report written to `import_runs`, sequences `setval` above the imported max), runnable with
    `--pglite <dir>` as a dry run. It is run later by Opus through Host's switch tooling; you only build and test it
    (a test imports a SQLite fixture into PGlite and checks the report and a post-import insert id).
11. Production requires `DATABASE_URL` (runtime, PgBouncer) and `DATABASE_DIRECT_URL` (owner, migrations); dev and
    `npm test` use embedded PGlite; `npm run test:pg` uses `eval "$(a local PostgreSQL 16 + Valkey (install with apt in this session if missing) up)"`.
    Last step: better-sqlite3 leaves `package.json` and nothing in `server/` requires it (a guard test).

## Steps (brief §9, renumbered): 0 SDK+drivers → 1 migrations scaffold (+ triggers of decision 1) → 2 open/init/get +
test preload → 3 dialect fixes + RETURNING helper → 4 asyncify (+ the MANUAL sites, + dynamic SQL per decision 7) →
5 history store (decision 2, latency test over 200k rows) → 6 audio queue (decision 3) → 7 mirror on triggers
(decision 1) → 8 Valkey limiter → 9 N-1 (decision 6) → 10 import script (decision 10) → 11 drop better-sqlite3.

Gate: `npm test` (PGlite) and `npm run test:pg` both green at the end; `test/live-down.test.js`, `test/bridge.test.js`,
`test/outbox-mirror.test.js`, `test/audio-queue.test.js`, `test/chat-apis.test.js`, `test/chat-ai.test.js` unchanged in
meaning. Update README.md (storage section), STATUS.json and docs/cutover.md (the PostgreSQL switch runbook: backup,
drain, import with the report, switch env, verify /ready and counts, rollback = previous release + the SQLite file).
