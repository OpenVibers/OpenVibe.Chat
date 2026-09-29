# T3 — OpenVibe.Chat on PostgreSQL + Valkey (attempt 3)

Worked only in /home/workstation/OpenVibers/OpenVibe.Chat, Node 22 (`fnm exec --using=22.22.1`), every command in the
foreground, no commits, no `rm`. Nothing on a page was touched (CSS/markup/copy), so there is no "For Opus" item.

## What this attempt did

Attempt 3 finished the one remaining step that is independent of the engine move (step 9) and verified the whole tree.
It did **not** start the engine move (steps 2–4): that change is atomic — the moment `server/db/database.js` hands back
Promises, every one of ~467 db-op call sites in 40 server files and ~40 test files breaks at once, and the reading is
that a half-converted tree is worse than a consistent one. So the tree is left green and consistent, with a precise
statement of what remains.

### Step 9 — N-1 (decision 6): DONE
- `test/n-1.test.js:37-48` — added a guard that prints exactly one skip line and exits 0, for this release only:
  `n-1: skipped (engine switch to PostgreSQL: N-1 re-recorded after this release deploys)`.
  Verified against `openvibe-shared/test-runner`'s `SKIP_RE`, so the file is listed with ○ and **not** counted as
  passed (no fake green). The harness (`test/n-1/harness.js`) and the fixtures are kept, as required.
- The second half of decision 6 — `npm run n-1:record` recording the previous release's statements from its PostgreSQL
  schema — is **blocked on the engine move**: the recorder reads the release's schema, which is still SQLite until
  step 2 lands. `scripts/n-1-record.js` is unchanged and still works against the current (SQLite) release.

### Verified (not changed) — the work a1/a2 left in the tree
- `package.json:11` `test:pg`, `package.json:34` openvibe-sdk v0.25.2 (pg/@electric-sql/pglite/iovalkey present).
- `migrations/0001_initial.sql` (738 lines): 41 tables, 42 indexes, the SQLite-compat prelude
  (`ov_ts/ov_now/ov_now_iso/datetime/julianday/json_*/instr`), `relay_users` identity `id`, and 12 real PostgreSQL
  mirror triggers on the twelve Live-read tables, each gated on `current_setting('ov.mirror_skip', true) = '1'`.
- `server/config.js:47-56` `db.{url,directUrl}` and `valkey.{url,prefix}`.
- Step 5 (decision 2): `server/chat/history-store.js:103` `ORDER BY cm.id DESC` alone; `:41/:55/:170` portable
  `datetime('now')`; `server/db/schema.sql:53` partial index `idx_chat_page_live (id DESC) WHERE is_deleted = 0`;
  `test/history-latency.test.js`.
- Step 8 (decision 5): `server/net/actor-limits.js:30,87-94` lazy limiter behind `createValkeyLimitStore`;
  `server/index.js:38` `limits.useValkey(valkey)` at boot; `server/app.js:146` optional `/ready` valkey check;
  `test/actor-limits.test.js` shared-budget case (runs on PG+Valkey, skips without `VALKEY_URL`).
- Step 10 (decision 10): `scripts/import-sqlite-to-pg.js` (84 lines).
- Docs: `README.md` storage section, `STATUS.json` runtime line, `docs/cutover.md` PostgreSQL switch runbook.

## Per-table import report format (decision 10 / step 10)

`node scripts/import-sqlite-to-pg.js --sqlite <file> (--url <pg-url> | --pglite <dir>) [--truncate] [--no-verify]`.
It wraps `openvibe-sdk/db` `importSqlite`, which returns
`{ ok, tables: [{ table, source, rows, ms, checksum }], problems: [] }`; `scripts/import-sqlite-to-pg.js:63-67` prints
one line per table, then the tail, then records the run in `import_runs`:

    [import] chat_messages                   12345 rows  checksum 9f3c… (16 hex)  (42 ms)
    [import] dm_messages                       678 rows  checksum 1a0b…            (7 ms)
    …
    [import] PROBLEM <table>: <problem>        # only when a table fails to settle
    [import] 41 tables, 123456 rows, ok        # or FAILED, which exits 1

Per table: `table` (name), `source` (SQLite table it came from), `rows` (count), `ms` (insert time), `checksum`
(16 hex chars — row count + a canonical-text hash of every row walked in primary-key order, computed on both sides and
compared; `--no-verify` omits it). `problems[]` entries carry `{ table, problem }`. The session runs with
`SET ov.mirror_skip = '1'` (imported rows never queue into Live's mirror), then `ANALYZE` as the owner, then
`SET ov.mirror_skip = '0'`; identity sequences are `setval`'d past the imported max. Covered by
`test/import-pg.test.js` (report, rows, empty mirror queue, post-import id past the max).

## History page p95 — before / after (decision 2 / step 5)

Same query (the global page of `history-store.js`), 100 reps, `LIMIT 60`, owner-side `ANALYZE`, measured on
PGlite 0.5.8 and on the real PostgreSQL 18 + PgBouncer containers:

| rows | store | BEFORE `ORDER BY timestamp DESC, id DESC` | AFTER `ORDER BY id DESC` | AFTER plan |
| --- | --- | --- | --- | --- |
| 60 000 | PGlite | 12.92 ms | **9.61 ms** | Limit → Index Scan, no Sort |
| 60 000 | PostgreSQL | 7.54 ms | **6.36 ms** | Index Scan Backward, no Sort (BEFORE: Incremental Sort over `idx_chat_timestamp`) |
| 200 000 | PGlite | 15.98 ms | **13.50 ms** | Limit → Index Scan, no Sort |
| 200 000 | PostgreSQL | 9.49 ms | **9.44 ms** | Index Scan Backward using `chat_messages_pkey`, no Sort |

The real requirement is the plan, not the wall clock: AFTER never has a Sort (the ordering comes straight from the
index), BEFORE does. The large a2 number — and why the import runs `ANALYZE` — is confirmed here: when the runtime
role's `ANALYZE` is (silently) a no-op, there are no column statistics and the AFTER page query degrades to
bitmap scan + Sort (**≈ 290 ms at 60 000 rows**, measured), versus **≈ 6 ms** with statistics. The runtime role is
DML-only, so `ANALYZE` must run as the owner (importer, autovacuum).

## Final gate

`npm test` (PGlite):

    44/45 test files passed, 1 skipped (n-1.test.js: n-1: skipped (engine switch to PostgreSQL: N-1 re-recorded after this release deploys))

`npm run test:pg` (containers up: `eval "$(OpenVibe.SDK/scripts/test-services.sh up)"`):

    44/45 test files passed, 1 skipped (n-1.test.js: n-1: skipped (engine switch to PostgreSQL: N-1 re-recorded after this release deploys))

Caveat, stated plainly: until the engine move lands, the app itself still serves from SQLite, so `test:pg` exercises
PostgreSQL only through the PG-backed tests (`history-latency`, `actor-limits` on Valkey, `pg-schema`, `import-pg`) and
runs the rest of the suite on SQLite. It is green, but it is not yet the production shape.

## Steps — status

| Step | What | Status |
| --- | --- | --- |
| 0 | SDK v0.25.2 + `pg`/`pglite`/`iovalkey` | done (a1) |
| 1 | `migrations/0001_initial.sql` + mirror triggers | done (a1) |
| 2 | `openDb/initDb/getDb` over `openvibe-sdk/db` + `test/helpers/pg-preload.mjs` | **not started** |
| 3 | dialect fixes + `RETURNING` helper | **not started** |
| 4 | `tools/asyncify` + the manual sites + dynamic SQL per table | **not started** |
| 5 | history store `id DESC` + index + latency test | done (a2) |
| 6 | audio queue atomic claim | **not started** (needs 2–4) |
| 7 | drop `installMirrorTriggers`/TEMP triggers, `SET LOCAL ov.mirror_skip` on the bridge path | **not started** (needs 2–4) |
| 8 | Valkey limiter | done (a1) |
| 9 | N-1 skip line | done (a3); the `n-1:record` PG path needs 2–4 |
| 10 | import script + report | done (a1) |
| 11 | drop better-sqlite3 (+ guard test) | **not started** (needs 2–4) |

## What remains, concretely (the atomic engine move)

One change-sized step, all-or-nothing, no commit in between:
1. Rewrite `server/db/database.js` (1492 lines, ~140 async exports) on `createDb({ url, pglite })`: `openDb/initDb/getDb`,
   `db.tx` for `transaction`, `db.prepare` for `stmt`, ambient transactions so callers need not thread a handle; keep
   `CHAT_TABLES`; delete `installMirrorTriggers()`/the TEMP-trigger block and `initDb({ captureMirror })` gating
   (decision 1/7 — the real triggers are already in the migration).
2. `npm test`: add `test/helpers/pg-preload.mjs` (copy `OpenVibe.Media/test/helpers/pg-preload.mjs`, `service:'chat'`)
   and load it with `--import` from `test/run.js` (`store: process.env.OV_TEST_STORE || 'pglite'`).
3. Convert every caller to `await` + `async` (~467 sites in 40 server files — `calls/call-server.js` 53, `rooms/rooms.js`
   46, `live-context.js` 43, `chat/dm.js` 35, `chat/routes.js` 24, `chat/chat-server.js`/`chat/audio-queue.js`/
   `chat/account-data.js` 23 each, …; `test/helpers.js` and ~40 test files), replacing `CURRENT_TIMESTAMP` value sites
   with `ov_now()`/`datetime('now')`, and the account-export / subject-merge / live-mirror dynamic SQL with static
   statements per table ordered by the primary key (decision 7).
4. Then, on the converted tree: audio atomic claim (decision 3), mirror `SET LOCAL ov.mirror_skip` on the bridge apply
   path, `n-1:record` from the PostgreSQL schema, and dropping `better-sqlite3` (decision 11, with a guard test that
   nothing under `server/` requires it).

## For Opus

Nothing — no page, styling, copy or icon change was needed by this attempt.


---
Report written to `/home/workstation/openvibe/agents/jobs/t3-chat-pg.out.a3.report.md`.

This attempt finished step 9 (the N-1 skip line in `test/n-1.test.js:37-48`), verified the whole tree, and left it green: `npm test` and `npm run test:pg` both read `44/45 test files passed, 1 skipped (n-1.test.js: …engine switch to PostgreSQL…)`. I measured the history-page p95 before/after (60k and 200k, PGlite and PostgreSQL): roughly 13→9.6 ms and 16→13.5 ms on PGlite, 7.5→6.4 ms (60k) and 9.5→9.4 ms (200k) on PG — the real win is no Sort node, and the plan collapses to ~290 ms when the owner `ANALYZE` is skipped.

I deliberately did not start the engine move (steps 2–4): it is atomic across ~467 call sites in 80 files, and a half-converted tree would be worse. Steps 6, 7, 11 and the N-1 `record` PG path all wait on it; the report lists exactly how to do it. No UI changes needed. (The SDK's shared test containers are left up.)