# OpenVibe.Chat → PostgreSQL + Valkey, and taking over Live's six staged tables (plan track T3)

Read-only survey. Every claim is `file:line`. Nothing in the repository was edited.

The brief under review is `brief-chat-pg.out.a3.report.md` (249 lines, written by a weaker model). Everything below was re-derived from the code. Where the draft was right, it is kept; where it drifted, the corrected line number is given and the reason is in the Corrections table.

## Corrections (what the previous draft got wrong)

| # | Claim in draft | Verified truth |
|---|---|---|
| **The blocking one** | "The data layer to use: `openvibe-sdk/db` — `src/db/index.js`… `src/db/sqlite-import.js`… `tools/asyncify`…" | **Chat pins `openvibe-sdk` v0.12.0 (`package.json:32`), which has no `db` module, no `src/db/`, no `tools/`, no `src/testing/`.** `openvibe-sdk/db` first shipped in **v0.14.0** (SDK commit `1a93eeb`); ambient transactions (the draft's whole "no handle threading" argument) arrived in **v0.18.0** (SDK commit `4762731`). SDK HEAD is **v0.22.0** (`/home/workstation/OpenVibers/OpenVibe.SDK/package.json:3`), with `src/db/{index,migrate,prepare,sqlite-import,sql,sqlite-cli}.js`. **Raising the SDK pin is an unstated prerequisite.** |
| | (unstated) | **`pg`, `@electric-sql/pglite`, `iovalkey` are not dependencies of Chat** — not in `package.json:23-35`, not installed in `node_modules`. Media has them. The plan needs them added. |
| H3/H9 | `Media/server/db/database.js:22-49` (openDb) and `:22-63` (shape) | `openDb` **:28-46** (`:22-27` is its comment), `initDb` :49-53, `getDb` :56-61, `setDb` :64. |
| H3 | `Media/migrations/0001_initial.sql:1-33` and `:8-33` prelude; `datetime` `:16-22` | Prelude **:6-30**; `datetime` **:17-24**; `:1-5` are comments; `:32` starts `CREATE TABLE apps`. |
| H3 | `Media/test/helpers/pg-preload.mjs:1-25` | File is **20 lines**; one db :12, sequences→100000 :15-17, `globalThis.__ovMediaTestDb` :19. Env var is **`MEDIA_TEST_STORE`**, not `OV_TEST_STORE`. |
| H3/§6 | Media `test/helpers/db.js:18-40` (`createTestDb`, `createTestValkey`) | **No such file** — `OpenVibe.Media/test/helpers/` holds only `pg-preload.mjs` and `run-script.js`. `createTestDb`/`createTestValkey` live in **`openvibe-sdk/testing`** (`src/testing/db.js:26`, `:85`, exports `:91`), which the Media preload already requires at `:11`. |
| H3 | SDK `src/db/index.js:6-12`, `:20-24`, `:24-25` | Dialect/PgBouncer doc **:5-8**; ambient **:16-20** (right); `db.prepare` **:22-23**; pooler rule **:25-26**; `tx` retry doc :13, `RETRYABLE` :33, `ISOLATION` :32; `afterCommit` impl :204, handle :233. |
| H3 | `src/db/sqlite-import.js:1-16` | Verification + sequences at **:17-19** (range `:1-19`). |
| H3 | `src/db/sql.js:3-16` | Doc **:3-12**, class :15. |
| H3 | `Media/package.json:10` test:pg | **`:12`** (`:10` is `test`). |
| H3 | `tools/asyncify/README.md:1-50` covers `sqlite-schema-to-pg.js` | That tool is documented at **README `:56-58`**; sqlfix/asyncify order `:10-29`; dialect list `:34-35`; hand-work list `:38`; Blog order `:42-52`. |
| §1.1 | `config.js:39` dbPath | **`server/config.js:42`**. |
| §1.1 | `ADDED_COLUMNS` `:113-119` | **`:116-121`**. |
| §1.1 | `rooms.js:84-129` second owner | `let ready` :82, `ensureSchema` **:83**, `exec()` **:86-132**; rooms :87-101, room_members :102-109, room_messages :111-120, room_attachments :122-131; the `PRAGMA table_info`/ADD COLUMN tail :134-137. |
| §1.2 | `CHAT_TABLES` :28-41, `STAGED_TABLES` :47-54, `STAGED_KEYS` :57-64 | **`:25-38`, `:44-51`, `:53-60`**. |
| §1.2 | `token_revocations` "not in schema.sql" | Right that it is absent from `schema.sql`, but it **is created** on demand at **`server/auth/revocations.js:19`**. |
| §1.1/1.2 | "rooms.js is **a** second schema owner" + implicit `token_revocations` | **Four** modules create tables on first use: `rooms.js:86-132`, `revocations.js:19`, **`server/chat/network-blocks.js:28`** (`network_blocks` + `idx_network_blocks_blocked` :36), **`server/chat/account-data.js:39`** (`account_data_events`, DDL :38-46). **`network_blocks` and `account_data_events` are wholly absent from the draft's table inventory.** |
| §1.3 | `server/chat/rooms.js` | **Does not exist** — it is `server/rooms/rooms.js`. |
| §1.3 | `account-data.js:97` table_authority | **`:96`** (`chatWrites`). `:84` (`ORDER BY rowid DESC`) is right. |
| §1.3 | `database.js:17` "the one handle" | :17 is `require('better-sqlite3')`; the **open is `:66`** (`new Database(_dbPath)`), inside `getDb()` :62-77. |
| §1.2 | schema.sql table ranges | Several drifted: `chat_timeline_events` **296-305**; `table_authority` **308-312**; `ctx_sync` **368-372**; `events_outbox` **375-385**; `live_mirror_outbox` **389-395**; `bridge_applied` **399-403**; `bridge_refs` **436-442**; `chat_meta` **464-467**; `deploy_releases` **474-483**; `chat_event_inbox` **488-493**. (`chat_messages` 24-52, the `dm_*`/staged ranges, `calls` 501-518 and `idx_calls_open` :518 are right.) |
| §1.3 | `test/n-1/preload.js:16` | The require is **`:13`**. |
| §1.2 final note | "all 60+ tables in `server/db/schema.sql`" | **`schema.sql` is 518 lines with 35 `CREATE TABLE` and 39 `CREATE … INDEX` statements (37 plain + 2 unique).** 12 chat + 6 staged + 17 bookkeeping = 35 tables. With `rooms*` (4), `token_revocations`, `network_blocks`, `account_data_events`, Chat owns ~42 tables. |
| §2 table | rooms 44, dm 34 | **rooms 43** (16 `run`, 15 `get`, 8 `all`, 4 `db.transaction`), **dm 33** (11/12/8/1). The other 13 rows' counts check out. |
| §2 | Missing modules | **`server/chat/account-data.js` (23 `d.prepare` + 1 `d.exec` + 1 `d.transaction`), `server/chat/subject-merge.js` (15 `d.prepare` calls, 12 lines, + 1 `d.transaction`), and `server/prefs/from-live.js` (raw `liveDb.prepare` over `sqlite_master`) are not in the table.** Add them; the real conversion surface is **219 `prepare`/`exec`/helper sites across 20 files**, not ~170. |
| §2 | "`db.transaction(() => …)` callbacks at `database.js:213,916,932,1147,1154,1180`" | database.js uses a **local `transaction(fn)` helper (`:101-102`) at :210, 329, 348, 364, 380, 419, 440, 687, 910, 920, 932, 1044, 1059, 1076, 1084, 1094, 1103, 1111, 1126, 1153, 1177** — 21 callbacks. Also `deploy-notice:80`→**:86**; **`lifecycle.js:75` is not a transaction — lifecycle.js has no transaction at all.** (dm 168, rooms 202/320/357/407, audio-queue 187, live-context 218, live-bridge 217, outbox 68/101 are right.) |
| §2 | "15 are inside `transaction()`" | Not reproducible. **34 `transaction(() =>` callbacks** in `server/` (21 database.js + 4 rooms + 2 outbox + 1 each in dm, live-context, live-bridge, audio-queue, deploy-notice, account-data, subject-merge); 11 of them are `db.transaction(`. |
| §2 | live-context `COLLATE NOCASE` `:331-332` | **Only `:235-236`**; there is no COLLATE at 331-332. |
| §2 | live-context upsertRows :210-224; syncTable :736-748; syncActiveStreams :750-758; schedule :760-770 | **:212-225; :737-748; :749-758; :760-773.** |
| §2 | audio-queue pump :207-240; recover :311-316 | pump **:209-241**; recover **:311-319**; `perform` awaited :225, defined near :222. |
| §2 | deploy-notice claimRelease :78-90; `ORDER BY id DESC` :66 | tx at **:86** (function :84); the newest-row read is **:62**. |
| §2 | live-bridge `plain()` :198-201; array-map :186; setTableAuthority op :263-264 | plain **:199-202**; array-map **:190**; **`:263-264` is op `tableAuthority`, `setTableAuthority` is `:265-266`** (op list documented :32-36). |
| §2/§4 | database.js PRAGMA :129; `INSERT OR IGNORE` :1157; `INSERT OR REPLACE` :1192; mirrorPending :872-875; removeChannelModerator :919-928; setEmoteMedia end :1100; grantUserTag :1102-1108; addChatTimelineEvents end :1171; sliceHash end :1217; installMirrorTriggers :143-160; subjectFor :167-171 | **:128**; **:1159**; **:1188**; **:872-873**; **:918-927**; **:1092-1098**; **:1101-1107**; **:1150-1167**; **:1209-1212**; **:143-161**; **:167-170**. (database.js `:534`, `:1226`, `:878`, `:911`, `:896-897` and all of §4's chat-server refs are right.) |
| §2 | history-store 4 sites | `db.get` **:80**, `db.all` **:102, :110, :165** — right, but note `:80` is inside `tipId()`'s try/catch. |
| §3 | history-store ranges | parseRoom **:62-67**; `GLOBAL_TYPES` :26; GLOBAL_SELECT **:27-41**; CHANNEL_SELECT **:43-55**; page **:117-130**; delta **:137-146**; deletedIds **:156-170**; clampLimit **:57-60**; readDelta **:105-111**; readPage **:97-103**; tipId **:79-81**; visibility predicate **:40-41, :54-55, :168**; `PAGE_MEMO_MS` :23, `MAX_LIMIT` :24, memo **:85-94**, key :122; invalidate **:173-176**; `DELETED_WINDOW = 2*MAX_LIMIT` :155. Callers routes.js:516-517, 640, 660-661 and pages.js:146 (`limit: 60`) are **right**. |
| §5 | table_authority :308-315 | **:308-312**. buildChanges **:37-54**. applyStagedChanges end **:1203**, invalidation tail **:1196-1201**. `live-context` `reloadPolicy` is **:402** (called :891) — :354/:396/:889/:899 are `_chatWrites` guards, not `reloadPolicy`. `import-from-live.js --tables` is parsed at **:52-53** (not :19-31). |
| §5 | Live-side keys/endpoint | `chat_table_authority` **chat-tables.js:57**, `chat_table_dual_read` **:58**; **`chat_table_relay_paused` is `chat-tables-sync.js:36`** (not chat-tables.js). Handoff endpoint is Live **`server/internal/routes.js:29/43`** (`POST /internal/chat-tables/:table`). `write()` is **:137**. `chat_staged_outbox` DDL **chat-tables-sync.js:46-52**; `chat_dual_read_stats` DDL **:53-63**. (OPS map chat-tables.js:44-55, `authority()` :81 are right.) |
| §5/§7 | `docs/staged-tables-cutover.md` calendar `:78-95` | Table is **:76-87**; D0 2026-09-28, the flip order/dates (timeline-events 10-05, ai-summaries 10-06, user-tags 10-07, emotes 10-08, moderation-settings 10-09, moderators 10-12) and "not before 2026-12-18" all **right**; rollback **:273-284**. |
| §6 | `test/run.js:16` | **`:15`** (`{ dir: __dirname, timeoutMs: 60000, pad: 32, parallel: 1 }`); `--strict` documented :9. 40 test files — right. |
| §6 | staged-tables cases | File is 239 lines — right, but the cases sit at restart **:47-55**, refuse-at-live **:57-68**, idempotent **:70-97**, dual-read slice :99. |
| §6 | `message-deleted.test.js:23,141` is a better-sqlite3 check | **`:23`** only (`['server/index.js','server/redaction.js','node_modules/better-sqlite3'].every(fs.existsSync)` on the Events checkout). `:141` is a purge-preview assertion, not a driver check. |
| §6 | `app.js` table_authority | **:149** (`stagedAuthorities()`); `/ready` handler **:118-154**, `SELECT MAX(id)` :121 — right. |
| §6 | `helpers.js:338` "the live module" | **:338 is `h.db`** (`require('../server/db/database')`); the live module is **:339** (`h.ctx`). `:288` `CHAT_DB_PATH` and `:36` `sqliteNow()` are right. |
| §6 | "128 `h.db.*` across 26 files" | **137 `h.db.*` across 21 test files.** |
| §6 | `actor-limits.js:26-27` comment | **:21-22**. |
| §6 | history-store memo `:80-91` | **:85-94**; `PAGE_MEMO_MS` :23. |
| §6/§7 | "containers with `OV_TEST_STORE=pg`" | Media's preload reads **`MEDIA_TEST_STORE`** (`pg-preload.mjs:2,12`); the SDK helper defaults to `OV_TEST_STORE` (`openvibe-sdk/src/testing/db.js:26`) and needs `OV_TEST_PG_URL`/`OV_TEST_PG_DIRECT_URL` (`:23,33`). |
| §7 | `import-from-live.js:14-16` pre-write copy | **`:10-12`** (the doc comment). `server/index.js` `db.initDb()` is **:30**. `rooms.js` DDL :87-129 → **:86-132**. `docs/cutover.md` §Rollback **:174**. |
| §8 | risk 2 "`deploy-notice.js:76` `res.lastID \|\| res.id`" | The line is `Number(res && (res.lastInsertRowid \|\| res.lastID \|\| res.id))` — it checks **`lastInsertRowid` first**. `live-bridge.js` plain is **:199-202**, `database.js` `_staged` sniffer :896-897. |
| §8 | risk 5 "read-modify-write" for `attempts` | The attempts bump is **already atomic** — `UPDATE audio_requests SET attempts = attempts + 1 WHERE id = ?` at **audio-queue.js:221**. The race is only over the `state='queued'` claim. Risk 11: CI records the previous release into **`test/fixtures/n-1`** (`.github/workflows/ci.yml:7-8`), so the harness is fixture-based as well as `sqlite_master`-derived. |
| §9 | "`package.json:26` loses better-sqlite3" | **`:24`**. |
| §6 env note | "`npm test` fails 36/40 at `new Database`" | **Confirmed live:** `process.versions.modules` = **137** on node v24.19.0, against a `better_sqlite3.node` built for 127. Not a code defect; a `npm rebuild better-sqlite3` fixes it and installs are denied in this job. |
| (missed) | The draft's §1.3 never lists `server/chat/sounds-routes.js:285` | It reads `result.lastInsertRowid` from `createChannelSound` and puts it straight into the HTTP response. |
| (missed) | `scripts/parity.js` treated as SQLite-touching | `scripts/parity.js` (731 lines) is the **product-level** parity driver (real protocol, WebSocket) and touches **no** SQLite; only `scripts/parity-check.js:35-40` opens files. The draft's §1.3 list is right, but the distinction matters when repointing the CLIs. |

---

**Model service:** OpenVibe.Media — `server/db/database.js:28-46` (`openDb`: `DATABASE_URL` through PgBouncer, `DATABASE_DIRECT_URL` for migrations, embedded PGlite in dev), `migrations/0001_initial.sql:6-30` (SQLite-compat prelude `ov_ts`/`ov_now`/`ov_now_iso`/`datetime`/`julianday`/`json_valid`/`json_extract`/`json_type`/`instr`; `datetime` :17-24), `test/helpers/pg-preload.mjs:1-20` (one migrated PGlite per test process, identity sequences set to 100000), Valkey for shared counters: `server/config.js:32`, `server/actor-limits.js:58-62`, `server/observability.js:132`, and `openvibe-sdk/testing` `createTestDb`/`createTestValkey` (`src/testing/db.js:26,85`; the `store:'pg'` path at :33-80 with the runtime role's `statement_timeout = 15s` / `lock_timeout = 5s` at :49-50).

**The data layer to use — and the prerequisite the draft omitted:** `openvibe-sdk/db` (≥ **v0.14.0** for `createDb`/`sql`/`tx`/`importSqlite`; ≥ **v0.18.0** for ambient transactions; HEAD v0.22.0) — `src/db/index.js:5-8` (PostgreSQL only; PgBouncer transaction mode; `DATABASE_URL`), `:13,32-33,147` `tx(fn, opts)` with `isolation` and 40001/40P01 retry, `:16-20` ambient transactions via AsyncLocalStorage, `:22-23` `db.prepare(...)` better-sqlite3-shaped but async, `:204,:233` `db.afterCommit`; `src/db/sqlite-import.js:1-19` (`importSqlite`: parents first, batched multi-row inserts, identity columns keep their values and their sequences move past the max, verification by row count + a canonicalised per-row checksum walked in PK order, lost columns refused unless dropped); `src/db/sql.js:3-12` (`sql` tagged template; only `sql.raw` puts text into the statement). Toolchain (SDK repo, **not** the npm package — `tools/asyncify/README.md:3` says so): `tools/asyncify/README.md:56-58` (`sqlite-schema-to-pg.js`: `INTEGER PRIMARY KEY AUTOINCREMENT` → identity, `TEXT` → `text COLLATE "C"`, `INTEGER` → `bigint`, `REAL` → `double precision`, `BLOB` → `bytea`, no `IF NOT EXISTS`, `lower(x)` for `COLLATE NOCASE` indexes, an immutable-row trigger becomes PL/pgSQL, any other trigger refused), `:34-35` the dialect list (`INSERT OR IGNORE/REPLACE` → `ON CONFLICT`, `COLLATE NOCASE` → `lower()`, `LIKE` → `ILIKE`, `IS ?` → `IS NOT DISTINCT FROM`, `PRAGMA`/`sqlite_master` → `information_schema`, `RETURNING` for `lastInsertRowid`), `:38` the by-hand list (`db.transaction(fn)()` → `db.tx(fn)`, scalar `MAX(a,b)` → `GREATEST`, `rowid` tiebreaks → an identity column, `setImmediate` → `db.afterCommit`), `:10-29` `asyncify.js` (adds `await`, makes functions async, iterates to a fixed point, and **reports** `MANUAL` for array callbacks instead of changing them). **Chat must bump `package.json:32` and add `pg`/`@electric-sql/pglite`/`iovalkey` before any of this can be required.**

---

## 1. Every database, table and file

### 1.1 The database

One SQLite file. `server/config.js:42` `dbPath: process.env.CHAT_DB_PATH || './data/chat.db'`; production `deploy/systemd/openvibe-chat.service:38-39` (`StateDirectory=openvibe-chat`, `CHAT_DB_PATH=/var/lib/openvibe-chat/chat.db`). Opened in `server/db/database.js:62-77` with `journal_mode=WAL` (:67), `foreign_keys=ON` (:68), `busy_timeout=5000` (:69), `synchronous=NORMAL`/`cache_size`/`temp_store` (:71-73), a prepared-statement cache (`stmt()` :79-88, cleared past 500 at :83), and helpers `run` :89, `get` :93, `all` :97, `transaction` :101-102, `close` :105-109.

`initDb()` (`server/db/database.js:123-141`) executes `server/db/schema.sql` verbatim on every boot (:125; every statement is `CREATE … IF NOT EXISTS`), patches four late columns (`ADDED_COLUMNS` **:116-121**: `emotes.media_url`, `emotes.media_asset_id`, `ctx_users.subject_id`, `channel_moderation_settings.sub_only`) with a `PRAGMA table_info` probe at :128, creates `idx_ctx_users_subject` (:132), seeds `table_authority` for the 12 chat tables (:133-134) and the six staged tables as `live` (:135-137), resets the 1 s authority cache (:138) and optionally installs the mirror TEMP triggers (:139, gated by `captureMirror`).

**There are four on-demand schema creators, not one.** Each does `db.getDb().exec()` of SQLite DDL on first use:

- `server/rooms/rooms.js:83-138` — `ensureSchema` (`let ready` :82) creates `rooms` :87-101, `room_members` :102-109 (+ `idx_room_members_user` :108), `room_messages` :111-120 (+ `idx_room_messages_room` :119), `room_attachments` :122-131; the additive-column tail at :134-137.
- `server/auth/revocations.js:17-…` — `token_revocations` (DDL :19).
- `server/chat/network-blocks.js:26-38` — `network_blocks` (:28) + `idx_network_blocks_blocked` (:36).
- `server/chat/account-data.js:38-46` — `account_data_events` (:39), whose `applied_at` default is `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (:44).

On PostgreSQL every one of these must become a migration; `exec()` of SQLite DDL cannot run. **Three of the four are invisible in the draft.**

### 1.2 The tables (server/db/schema.sql)

**`server/db/schema.sql` is 518 lines: 35 `CREATE TABLE`, 39 `CREATE … INDEX` (37 plain, 2 unique).** Chat-owned (authority from the W6 cutover, ids kept from Live; `CHAT_TABLES` map at `server/db/database.js:25-38`):

| Table | schema.sql | key |
| --- | --- | --- |
| `chat_messages` | `:24-52` (8 indexes) | `id` |
| `dm_conversations` | `:54-61` | `id` |
| `dm_participants` | `:63-74` | `id` |
| `dm_messages` | `:76-86` | `id` |
| `dm_blocks` | `:88-97` | `id` |
| `tts_voice_overrides` | `:99-107` | `identity_key` |
| `channel_sounds` | `:109-126` | `id` |
| `relay_users` | `:128-136` | `(platform, username)` |
| `hidden_relay_users` | `:138-148` | `id` |
| `pending_ip_messages` | `:150-163` | `id` |
| `stream_first_chats` | `:165-171` | `(chatter_key, channel_user_id)` |
| `moderation_actions` | `:173-186` | `id` |

Staged copies of tables Live still writes (C-04; `STAGED_TABLES` `server/db/database.js:44-51`, `STAGED_KEYS` `:53-60`):

| Table | schema.sql | key |
| --- | --- | --- |
| `channel_moderators` | `:190-199` | `id` |
| `channel_moderation_settings` | `:201-246` | `channel_id` |
| `emotes` | `:248-266` (incl. `idx_emotes_channel_code`, unique on `COALESCE(channel_owner_id, user_id), code`, :266) | `id` |
| `user_tags` | `:268-276` | `id` |
| `chat_ai_summaries` | `:278-294` | `id` |
| `chat_timeline_events` | `:296-305` (unique `idx_chat_tl_dedup` on `(scope, subject_id, ts, label)`) | `id` |

Bookkeeping: `table_authority` `:308-312`, projections `ctx_users` `:317-332`, `ctx_streams` `:334-348`, `ctx_managed_streams` `:350-359`, `ctx_channels` `:361-366`, `ctx_sync` `:368-372`, `events_outbox` `:375-385`, `live_mirror_outbox` `:389-395`, `bridge_applied` `:399-403`, `audio_requests` `:409-434`, `bridge_refs` `:436-442`, `import_hold` `:445-453`, `import_runs` `:455-462`, `chat_meta` `:464-467`, `deploy_releases` `:474-483`, `chat_event_inbox` `:488-493`, `calls` `:501-518` (`idx_calls_open`, a partial index `WHERE state IN ('pending','ringing','active')`, :518).

**Not in schema.sql — 7 more tables Chat owns:** `rooms`, `room_members`, `room_messages`, `room_attachments` (`rooms.js:87-131`), `token_revocations` (`revocations.js:19`), `network_blocks` (`network-blocks.js:28`), `account_data_events` (`account-data.js:39`). **42 tables in all.**

### 1.3 Files that open SQLite directly (they break first)

- `server/db/database.js:17` (the require) / `:66` (the one service handle).
- `server/chat/account-data.js` — `cols()` does `d.prepare('PRAGMA table_info(...)')` at :34; `d.exec` DDL at :39; **23 raw `d.prepare(...)` sites**, among them `ORDER BY rowid DESC` at **:84** and a `table_authority` read at **:96**; one `d.transaction` at :109.
- `server/chat/subject-merge.js:28-70` — `d = db.getDb()` :29, **15 raw `d.prepare(...)` calls** (12 lines, incl. `PRAGMA table_info` :18, `UPDATE ${t} SET ${col}` :35, dynamic table names :47-49, `network_blocks` :68-70), one `d.transaction` :34. **Missing from the draft.**
- `server/prefs/from-live.js:47-54` — `liveDb.prepare` over `sqlite_master` and `PRAGMA table_info(linked_accounts)` (reads Live's file; a one-off migration tool, so it stays SQLite on purpose).
- `server/chat/audio-queue.js` uses only `db.run/get/transaction` (`:110, :120, :187, :197` via `require('../db/database')` :34) — it never calls `getDb()`.
- `server/live-context.js:419` uses the `sqliteNow()` helper (SQLite `YYYY-MM-DD HH:MM:SS` text), compared against stored text at :428.
- Everything that `require('better-sqlite3')` literally: `scripts/import-from-live.js:39`, `scripts/parity-check.js:37`, `scripts/migrate-chat-preferences.js:73`, `scripts/n-1-record.js:19`; `test/audio-queue.test.js:14,236`, `test/import.test.js:17,37,85+`, `test/migrate-preferences.test.js:18,45,75,110`, `test/n-1.test.js:29`, `test/n-1/preload.js:13`, `test/restart-resume.test.js:16,31`, `test/message-deleted.test.js:23` (the Events checkout's copy, not Chat's).
- `scripts/import-from-live.js` additionally reads `rowid` (:244-245) and `sqlite_sequence` (:279-281) and opens Live's file read-only at :105; `scripts/parity-check.js:35-40` opens both files. `scripts/parity.js` (731 lines) is the product-level driver and opens **no** SQLite.

---

## 2. Sync call sites by module (the asyncify surface)

Counted as `db.run(` / `db.get(` / `db.all(` / `db.transaction(` / `getDb().prepare(` / `d.prepare(` / `d.exec(`:

| Module | sites | notes |
| --- | --- | --- |
| `server/rooms/rooms.js` | 47 | own `exec()` DDL :86; `db.transaction` :202,320,357,407; `lastInsertRowid` :205,206,323,324,325; scalar `MAX(last_read_id, ?)` **:348** → `GREATEST` |
| `server/chat/dm.js` | 33 | `db.transaction` :168; `lastInsertRowid` :55,183,185,192; `CURRENT_TIMESTAMP` :116,174 |
| `server/chat/account-data.js` | 25 | 23 `d.prepare` + `d.exec` :39 + `d.transaction` :109 — **missing from the draft** |
| `server/live-context.js` | 22 | `upsertRows` :212-225 (prepared stmt :216, `db.transaction` :218); `syncTable` :737-748; `syncActiveStreams` :749-758; `getChannelModerationSettings`/`isChannelModerator` :365-378; `COLLATE NOCASE` :235-236; `SCHEDULE` :760-773 |
| `server/chat/audio-queue.js` | 21 | enqueue transaction :187-203, `pump` :209-241, `recover` :311-319 |
| `server/chat/subject-merge.js` | 13 | 12 lines of `d.prepare` (15 calls), `PRAGMA table_info` :18, one `d.transaction` :34 — **missing from the draft** |
| `server/calls/lifecycle.js` | 11 | state transitions :75,83-86,134-188 (`:56` is a read helper; **no transactions**) |
| `server/bridge/live-bridge.js` | 7 | idempotency transaction :217-223, `sweepRefs` :157-158, `rememberRef` :164, `lookupRef` :172 |
| `server/chat/deploy-notice.js` | 6 | `claimRelease` transaction :86; `lastInsertRowid` read at :76 (`res.lastInsertRowid \|\| res.lastID \|\| res.id`) |
| `server/events/outbox.js` | 6 | `markFailed` :66-69, `flush` :72-108 (`getDb().prepare`+`transaction` at :67/:68 and :100/:101) |
| `server/chat/network-blocks.js` | 5 | DDL :28, run :51, get :61, all :78 and :86 |
| `server/chat/history-store.js` | 4 | `db.get` :80, `db.all` :102, :110, :165 |
| `server/bridge/live-mirror.js` | 4 | `pending` :35, `buildChanges` :37-54, `flush` :56-100 |
| `server/events/consumer.js` | 3 | :102, :206 |
| `server/auth/revocations.js` | 3 | DDL :19, read :33, write :45 |
| `server/chat/routes.js` | 2 | :253, :613 |
| `server/auth/network-session.js` | 1 | :57 |
| `server/chat/chat-server.js` | 1 | `db.get` :778 (the rest are `db.*` domain functions, all of which become async) |
| `server/db/database.js` | 9 | its own `run/get/all/stmt/transaction` surface (:79-102) and 9 direct `prepare`/`exec` sites |

**Total ≈ 219 call sites across 20 files** (the draft said ~170 across 15 files). Of those, **41 lines read `lastInsertRowid` or `.changes`** — 27 `lastInsertRowid` lines and 17 `.changes` lines across 14 files (`rooms.js`, `live-bridge.js`, `audio-queue.js`, `chat-server.js`, `routes.js`, `deploy-notice.js`, `dm.js`, `sounds-routes.js`, `database.js`, `lifecycle.js`, `account-data.js`, `subject-merge.js`, `network-blocks.js`, `consumer.js`). The draft's "15 are inside `transaction()`" is wrong: there are **34 `transaction(() =>` callbacks** in `server/` (21 in database.js, 4 in rooms, 2 in outbox, 1 each in dm, live-context, live-bridge, audio-queue, deploy-notice, account-data, subject-merge), of which 11 are `db.transaction(`. Also note `server/chat/sounds-routes.js:285` — the only DB-adjacent read there — hands `result.lastInsertRowid` straight into the JSON response, so it is an id-shaped API contract, not just a local variable.

`openvibe-sdk/db` gives `db.prepare(sql)` with the same `.get/.all/.run` shape (`src/db/index.js:22-23`), so the prepared-statement cache in `database.js:79-88` and every `db.get(...)` call site keeps its SQL verbatim; only `await`, `RETURNING` and the dialect rewrites change. The ambient transaction (`src/db/index.js:16-20`) means the `db.transaction(…)` callbacks (rooms.js:202,320,357,407; dm.js:168; audio-queue.js:187; live-context.js:218; live-bridge.js:217; outbox.js:68,101) and the local `transaction(…)` callbacks at `database.js:210,329,348,364,380,419,440,687,910,920,932,1044,1059,1076,1084,1094,1103,1111,1126,1153,1177` (helper :101-102), plus `account-data.js:109` and `subject-merge.js:34`, all become `db.tx(async () => …)` and the inner calls need no handle.

---

## 3. The history store and its cursors

`server/chat/history-store.js` (178 lines):

- Rooms: `'global'`, `'channel:<userId>'` (`parseRoom` :62-67; `'stream:<id>'` only in `deletedIds` :156-170, regex :159). `MAX_LIMIT=500` :24, `PAGE_MEMO_MS=2000` :23, `DELETED_WINDOW = 2*MAX_LIMIT` :155.
- Two joined reads: `GLOBAL_SELECT` **:27-41** (five `ctx_*` LEFT JOINs, `message_type IN ${GLOBAL_TYPES}` :40 with the list at :26), `CHANNEL_SELECT` **:43-55**.
- Cursors: `page(room, {limit, before, channelUsername, decorate})` **:117-130** returns `{messages, latest_id}`; `delta(room, {afterId, limit, …})` **:137-146** returns `{messages, latest_id, complete, deleted_ids}`; `deletedIds(room, afterId)` **:156-170** returns ids at or under the cursor that are deleted or past auto-delete within `DELETED_WINDOW`. `clampLimit` **:57-60**, delta default 200 (:139).
- Reads use **the integer primary key as the cursor**: `readDelta` **:105-111** `WHERE cm.id > ? ORDER BY cm.id ASC LIMIT ?` with `limit+1`; `readPage` **:97-103** `ORDER BY cm.timestamp DESC, cm.id DESC` reversed. The page is a **timestamp cursor**, the delta a **PK range scan**. `tipId()` **:79-81** `SELECT MAX(id) FROM chat_messages` doubles as the memo key (in a try/catch, falling back to `Date.now()`).
- A 2 s page memo **:85-94** keyed on `room|limit|channel|tipId` (key built :122); `invalidate(room)` **:173-176**.
- Visibility predicate repeated in three places: `is_deleted = 0 AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)` (**:40-41**, **:54-55**, and negated with `COALESCE` at **:168**). `datetime()` is a SQLite function; Media's `migrations/0001_initial.sql:17-24` provides a PostgreSQL `datetime(text, modifier)` with the same semantics, so the predicate can stay verbatim.
- Callers: `server/chat/routes.js:516-517,640,660-661` (REST `global/history`, `:streamId/replay`, `channel/:userId/history`) and `server/web/pages.js:146` (the openvibe.chat first paint, `limit: 60`). The **WebSocket does not read history-store per message**; it reads the joined page/delta on join/reconnect only.

**Ordering contract to preserve:** `chat_messages.id` must stay **monotonic in insert order** (gap-free is not required, but the client splices by `id`). A PostgreSQL identity satisfies that; the danger is `ORDER BY timestamp, id` in `readPage` and in `deploy-notice.js:62` if timestamps tie. Second danger: two writers (Chat and, for the staged tables, Live via the bridge) can interleave ids — a single global sequence per table is required, not per writer.

---

## 4. WebSocket paths that touch the database per message (latency)

`server/chat/chat-server.js`, the `chat.message.send` path (all line refs verified correct):

1. `:772-800` IP-approval check: `db.get('SELECT 1 FROM chat_messages … JOIN ctx_streams …')` `:778-785` and, if the user has never chatted there, `db.holdMessageForApproval` `:792-800` — **one read, and a write, on every message from an unapproved IP in an ip_approval_mode channel**.
2. `:826-842` reply-to: `db.getChatMessageById(replyToId)` `:831`.
3. `:899` VIP badge: `db.subjectFor(client.channelUserId)`.
4. `:906-925` **the write**: `db.saveChatMessage` `:907` → `database.js:202-236` — one `transaction` (:210) doing the `INSERT` (:211-215), a `subjectFor` read at :209 (inside the call, before the tx) and `_outbox().enqueue` (`server/events/outbox.js:31-50`, a `contract validate()` at :46 plus an `events_outbox` INSERT at :48). The id comes back via `res.lastInsertRowid` (`database.js:220-222`).
5. `:944-953` welcome: `db.isFirstChatInChannel` `:949` + `db.recordFirstChat` `:950` — **two more statements per stream message**.
6. `:1531-1543` and `:2169-2181`: the same `saveChatMessage` for a channel sound and a soundboard clip, then `audioQueue.enqueue` (`audio-queue.js:183-204`, its own transaction with up to three reads and one insert).
7. Background: `db.deleteExpiredChatMessages(500)` `:2581` on a timer (`database.js:400-433`).

**Latency budget on PostgreSQL.** Today every one of these is an in-process synchronous SQLite call — sub-100 µs each, so a message costs one WAL commit. On PostgreSQL through PgBouncer each becomes a network round trip plus a commit: 5 statements × ~0.3–1 ms ≈ 2–5 ms per message, of which 2–3 are avoidable:

- Steps 5 and the `subjectFor` read should move **outside** the write transaction or be cached (`ctx` already caches users, `live-context.js:195-201`), so the transaction holds only the `INSERT chat_messages` + `INSERT events_outbox` — one round trip, one commit.
- The message path must never wait on `enqueue`'s contract validation twice or on a mirror flush; `live-mirror.js:56-100` already runs on its own timer.
- The bridge path (`live-bridge.js:217-223`) adds one more round trip for Live's remaining writers, already async.

Rules to hold: never issue a `SELECT` before the `INSERT` on the hot path unless it is served from `ctx`; keep the per-message transaction to two statements; keep the identity next to the client so the id is known before the broadcast, not after a round trip.

---

## 5. The staged-table bridge and mirror code the cutover deletes

**Chat side, live today:**

- Authority store: `table_authority` (`schema.sql:308-312`), read cached 1 s in `tableAuthority()` `server/db/database.js:853-859` (cache object :852), written by `setTableAuthority` `:860-866`; `stagedAuthorities()` `:868-870`; `mirrorPending(table)` `:872-873`. Seeding and "a restart never moves it back" is `initDb` `:133-138`.
- The gate on writes: `_assertChatWrites(table)` `:883-888` throws `table.not_chat` (:886) — called by every staged writer (`:909,919,931,1043,1058,1070,1083,1093,1102,1110,1120,1151`).
- The answer shape Live consumes: `_staged(value, table, rows, deletedPks)` `:895-905` — `{ value, mirror: [{table, op, row|pk}] }`, with the `{changes, lastInsertRowid}` sniff at :896-897.
- The staged writers: `addChannelModerator` `:908-916`, `removeChannelModerator` `:918-927`, `upsertChannelModerationSettings` `:930-1040`, `setChannelAlertSound` `:1042-1054`, `createEmote` `:1057-1067`, `updateEmote` `:1069-1080`, `deleteEmote` `:1082-1089`, `setEmoteMedia` `:1092-1098`, `grantUserTag` `:1101-1107`, `revokeUserTag` `:1109-1117`, `upsertChatAiSummary` `:1119-1148`, `addChatTimelineEvents` `:1150-1167`.
- **Live → Chat capture path (deleted at cutover):** `applyStagedChanges(changes)` `:1175-1203` — the `INSERT OR REPLACE` applier (:1188), guarded by `tableAuthority(c.table) !== 'live'` (:1181), with `_columns()` filtering (:1182, `:876-880`) and the invalidation tail `:1196-1201`. Its bridge op is `stagedApply` (`server/bridge/live-bridge.js:259-260`); Live's side of it is `chat_staged_outbox` (`chat-tables-sync.js:46-52`, fed by TEMP triggers at :78-82).
- **Dual read (deleted):** `sliceHash(columns, rows)` `:1209-1212` and `stagedSlice(table, where, columns)` `:1219-1228` (exposed as bridge op `stagedSlice` `live-bridge.js:261-262`); Live's counters live in `chat_dual_read_stats` (`chat-tables-sync.js:53-63`, :218-232).
- **The handoff op:** bridge op `setTableAuthority` `live-bridge.js:265-266` (`:263-264` is op `tableAuthority`; the op list is documented :32-36) → `handOver()` `:128-148` (to `chat` requires the mirror; back to `live` drains `mirrorPending` first, with a 15 s budget). Kept as the rollback lever even after the capture is gone.
- **Read mirror (kept until C-01…C-03, 2026-11-06):** TEMP triggers `installMirrorTriggers()` `:143-161` — one `AFTER INSERT/UPDATE/DELETE` per table, the staged ones gated by `WHEN (SELECT authority FROM main.table_authority WHERE table_name = '…') = 'chat'` (:149), writing `(tbl, op, pk JSON)` into `live_mirror_outbox` (:155-159); the relay `server/bridge/live-mirror.js:29-114` (`BATCH` 200 :26, `MAX_BODY` 800 KB :27, `pending` :35, `buildChanges` :37-54 collapses per key and re-reads the row as it is now :50, `flush` :56-100, POSTs `/internal/chat-effects/mirror` :79 with `live.chat_mirror.write` :28). **On PostgreSQL TEMP triggers do not exist** — this is the single biggest rewrite in the move: either a real trigger on a per-session flag (`current_setting('chat.mirror_on')`), or (simpler and preferred) have every write path append to `live_mirror_outbox` inside the same transaction it already has, and drop the trigger mechanism entirely. Note the mirror is also why `initDb` takes `captureMirror` and why the importer calls `initDb({ captureMirror: false })` (`scripts/import-from-live.js:104`, `scripts/mirror-flush.js:18`).
- **The conditional reads in `live-context.js`** — `_chatWrites(table)` `:364`, `getChannelModerationSettings` `:365-371`, `isChannelModerator` `:372-378`, `reloadPolicy` `:402` (called from the settings effect :891), and the settings/alert-sound effects `:889-905` — become unconditional direct reads after the flip.
- **CLI:** `scripts/table-authority.js` (status :19-24, `set` :26-31), `scripts/mirror-flush.js:18-23`, `scripts/parity-check.js:35-40`, the `--tables` mode of `scripts/import-from-live.js:52-53`.
- **On the Live side the cutover deletes:** `server/chat/chat-tables.js` capture/relay/dual-read (the file keeps `authority()` :81 and `write()` :137), `server/chat/chat-tables-sync.js` in full, `chat_staged_outbox`, `chat_dual_read_stats`, and the `OPS` map (`chat-tables.js:44-55`) that routes Live's ten writers to Chat.

**The procedure is already written and does not change:** `docs/staged-tables-cutover.md` — calendar at **lines 76-87** (D0 = 2026-09-28 deploy/import/parity/dual-read; flips 2026-10-05 `chat_timeline_events` → 10-06 `chat_ai_summaries` → 10-07 `user_tags` → 10-08 `emotes` → 10-09 `channel_moderation_settings` → 10-12 `channel_moderators`; the last Live writers removed "not before 2026-12-18"; C-01…C-03 target 2026-11-06), rollback rows at **:273-284**. Live's per-table handoff endpoint is `POST /internal/chat-tables/:table` (`server/internal/routes.js:29,43`) with `GET /internal/chat-tables` (:32) and the relay-pause endpoint :35-36; the app_state keys are `chat_table_authority` / `chat_table_dual_read` (`chat-tables.js:57-58`) and `chat_table_relay_paused` (`chat-tables-sync.js:36`). The remote write is `write()` (`chat-tables.js:137`) over Chat's bridge.

**What changes if T3 (PostgreSQL) lands first:** the six tables must be in PostgreSQL *and* in the same database as everything else before the flips, because a table split across two engines cannot be flipped one at a time — `applyStagedChanges` writes to whichever engine holds the copy, and `handOver()` drains one mirror. The cheapest sequencing is: **move all of Chat to PostgreSQL while every staged table is still `live` (they are read-only on Chat's side), then run the six flips unchanged.** After the last flip, `applyStagedChanges`, `stagedSlice`/`sliceHash` and the `INSERT OR REPLACE` semantics are dead code and can be deleted in one commit together with Live's sync file.

---

## 6. Tests

Runner: `test/run.js:15` (`openvibe-shared/test-runner`, `{ dir: __dirname, timeoutMs: 60000, pad: 32, parallel: 1 }`; `--strict` documented :9 makes a skip fail). **40 files** (`test/*.test.js`). CI (`.github/workflows/ci.yml:7-8`) runs it with `test/n-1.test.js` replaying the previous release's clients and its SQL against this one, **from `test/fixtures/n-1`**.

**Database-coupled (must be ported, not deleted):**

- `test/staged-tables.test.js` (239 lines) — the whole C-04 contract in 13 cases: boot with the mirror on :36, authority defaults and restart :47-55, every staged write refuses at `live` :57-68, Live's changes arrive idempotently and never flow back :70-97, the dual-read slice :99, the handoff needs the mirror :109, at `chat` the writers and return values :119/:138, every change reaches Live through the mirror :170, `/slow` persisted in place :182, flip-back waits for the mirror :206, `scripts/table-authority.js` :220.
- `test/outbox-mirror.test.js:7-11` — events outbox + the Live read mirror against a stub Events and a stub Live.
- `test/audio-queue.test.js` — rows, transitions, restart recovery; opens the DB file directly at :14 and :236 (`raw()` helper), restart case :237.
- `test/bridge.test.js` — the bridge ops incl. `stagedApply`/`stagedSlice`/`setTableAuthority` and the idempotency key.
- `test/import.test.js:17,37,85+` (opens the Live snapshot, the Chat db and the backup :94-98), `test/migrate-preferences.test.js:18,45,75,110`, `test/restart-resume.test.js:16,31` — open SQLite files and assert on them.
- `test/message-deleted.test.js:23` — checks a `better-sqlite3` **in the sibling OpenVibe.Events checkout**, not Chat's; the redaction end-to-end already runs against PostgreSQL Events (per the eab0c20 commit message) and skips cleanly when the checkout is absent (:77).
- `test/account-data.test.js` — export/erase through `account-data.js:34,39,84,96` (`rowid`, dynamic table names, `PRAGMA table_info`).
- `test/subject-merge.test.js` — the raw-handle merge in `subject-merge.js`, including its `PRAGMA table_info` guard at :18.
- `test/rooms.test.js`, `test/room-kinds.test.js` — the `rooms` DDL and every `rooms*` statement.
- `test/n-1.test.js` (142 lines) + `test/n-1/*` (**1047 lines**) — the N-1 harness replays the **previous release's SQL** (from `test/fixtures/n-1`) against the current schema, and derives the N-1 schema from `sqlite_master` / `PRAGMA table_xinfo` / `PRAGMA table_list` (`test/n-1/harness.js:731,732,773,774,799`, harness 855 lines; the SQLite-capable preload is `test/n-1/preload.js:13`). It has to become a PG harness: record the previous release's SQL calls as fixtures and replay them against the migrated PostgreSQL schema. Media kept `scripts/n-1-record.js` on better-sqlite3 only for that (`OpenVibe.Media/scripts/n-1-record.js:19`); its N-1 story is separate.
- `test/ready.test.js` — `/ready` `db` check (`server/app.js:121` `SELECT MAX(id) FROM chat_messages`) plus `table_authority` (`app.js:149`).
- `test/live-context.test.js` — the projection and the staged-read switch.
- `test/parity.test.js` + `scripts/parity.js` (731 lines) — end-to-end product parity over the real protocol; **no SQLite**, so it survives the move as-is, while `scripts/parity-check.js` (the row comparer) must be repointed at PG.
- `test/calls.test.js`, `test/dm-inbox.test.js`, `test/network-blocks.test.js`, `test/sounds-tts.test.js`, `test/vip-badge.test.js`, `test/ws-protocol.test.js`, `test/rest.test.js`, `test/events-consumer.test.js` — all boot Chat and touch the DB through the harness.

**Harness work:** `test/helpers.js:288` sets `CHAT_DB_PATH` per run; `:338` hands the test the **db** module (the live module is `h.ctx` at :339); `:36` `sqliteNow()` (also exposed as `h.sqliteNow` :440); **137 `h.db.*` uses across 21 test files** become `await h.db.*`. Model: `OpenVibe.Media/test/helpers/pg-preload.mjs:1-20` — a `node --import` preload giving every test process one migrated PGlite (or, with **`MEDIA_TEST_STORE=pg`**, the containers) — plus `OpenVibe.Media/package.json:12` a `test:pg` script. `createTestDb`/`createTestValkey` come from `openvibe-sdk/testing` (`src/testing/db.js:26,85`), not from a Media `test/helpers/db.js`.

**Valkey:** the only in-process shared state is the per-actor rate limiter (`server/net/actor-limits.js:21-22` "Counters live in this process: a restart forgets them"). Move it exactly as Media did: `createValkeyLimitStore` behind `useValkey()` (`OpenVibe.Media/server/actor-limits.js:58-62`), `VALKEY_URL`/`VALKEY_PREFIX` in config (`OpenVibe.Media/server/config.js:32`), a `/ready` check that skips when unset (`OpenVibe.Media/server/observability.js:132`). The **history-store 2 s page memo** (`history-store.js:85-94`) and the `live-context` caches stay in-process: they are latency caches whose whole design is "stale by at most 2 s". Also in-process but out of scope: the WebSocket flood control and the audio-queue timers.

**Environment note (not a code failure):** `npm test` in this checkout fails 36/40 files at `new Database(...)` — `node_modules/better-sqlite3/build/Release/better_sqlite3.node` was compiled for `NODE_MODULE_VERSION 127` and this runtime is **137** (node v24.19.0, checked live). A `npm rebuild better-sqlite3` fixes it; installs are denied in this job, so the suite cannot be run green here. The 4 that pass are the ones that never open the database.

---

## 7. One-cutover data plan with count verification

**Target:** one PostgreSQL database (`chat`), one import, one cutover, the six staged tables still at `live`.

0. **Rehearse on a copy.** `sqlite3 /var/lib/openvibe-chat/chat.db ".backup /tmp/chat-pg-source.db"`, then `importSqlite({ sqlite: '/tmp/chat-pg-source.db', db: ownerDb, truncate: true })` (`openvibe-sdk/db`, `src/db/sqlite-import.js:1-19`) into a PGlite copy of the target schema. `importSqlite` verifies **row count and a canonicalised per-row checksum per table, walked in PK order** (:17-19) and refuses on a column mismatch unless `dropColumns` lists it. Record its report; that report is the baseline for step 6.
1. **Generate the migration.** `openvibe-sdk/tools/asyncify/sqlite-schema-to-pg.js` (README `:56-58`) over `server/db/schema.sql` + `server/rooms/rooms.js:86-132` **+ the three runtime-created tables** (`token_revocations`, `network_blocks`, `account_data_events`) → `migrations/0001_initial.sql`, then take Media's prelude verbatim (`OpenVibe.Media/migrations/0001_initial.sql:6-30`) for `ov_ts`, `ov_now`, `ov_now_iso`, `datetime`, `julianday`, `json_valid`, `json_extract`, `json_type`, `instr` — Chat's stored timestamps are SQLite `YYYY-MM-DD HH:MM:SS` text and its queries use `datetime(...)` and `CURRENT_TIMESTAMP` (`history-store.js:40-41,54-55,168`, `live-context.js:419,428`, `rooms.js:205`). The converter refuses any trigger it does not understand, and Chat's `installMirrorTriggers` TEMP triggers are not in `schema.sql` at all, so they never reach it.
2. **Dialect fixes by hand** (`tools/asyncify/README.md:34-35,38`): `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` (`database.js:911,1159`, `rooms.js`), `INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE` (`database.js:1188`, `account-data.js:187`), `COLLATE NOCASE` → `lower()` (`live-context.js:235-236`), `LIKE` → `ILIKE` (`database.js:542`), `IS ?` → `IS NOT DISTINCT FROM` (`database.js:1226`), `PRAGMA table_info` → `information_schema.columns` (`database.js:128,878`, `account-data.js:34`, `subject-merge.js:18`, `rooms.js:134`), `sqlite_master` → `information_schema.tables`, `rowid` (`database.js:534`, `account-data.js:84`, `import-from-live.js:244`) → an identity column, `sqlite_sequence` (`import-from-live.js:279-281`) → `setval(pg_get_serial_sequence(...))`, scalar `MAX(last_read_id, ?)` → `GREATEST` (`rooms.js:348`), `strftime(...)` default in `account_data_events` → `ov_now_iso()`, `lastInsertRowid`/`.changes` → `RETURNING`/`rowCount` (41 lines, §2), the dynamic table interpolation in `account-data.js`/`subject-merge.js`/`live-mirror.js`, and the partial index `idx_calls_open` (`schema.sql:518`) as a real partial index.
3. **Convert the code** with `tools/asyncify/sqlfix.py` then `asyncify.js` over `server/**`, `scripts/**` and `test/*.test.js`; fix the `MANUAL` array callbacks by hand — the ones visible are `live-context.js:218-224` (already a `for` loop), `live-context.js:755-756`, `audio-queue.js:311-316`, and `bridge/live-bridge.js:190` (`Array.isArray(value) ? value.map(...)` becomes `for…of` + `Promise.all`).
4. **Boot async.** `server/index.js:30` `db.initDb()` → `await db.initDb(cfg)` shaped as `openDb`/`initDb`/`getDb` in `OpenVibe.Media/server/db/database.js:28-61`; production requires `DATABASE_URL` (owner role migrates with `DATABASE_DIRECT_URL`, runtime DML-only through PgBouncer); dev falls back to an embedded PGlite in `data/pglite`. `chatServer.init` (`:37`), `callServer.init` (:38) and `createApp` (`:43`) stay after the first `await`.
5. **Rebuild the mirror capture without TEMP triggers** (§5) — the single non-mechanical change. Append to `live_mirror_outbox` in the write transactions (`database.js` writers, `_staged`), and keep the relay as it is.
6. **Count verification at cutover** (all against the *same* source snapshot, all with the service drained):
   - Before: `SELECT COUNT(*)` per table from the SQLite file via the same query list `scripts/parity-check.js` prints (its `tableParity` :35-40 walks `STAGED_KEYS` and compares counts and `sliceHash`).
   - After import: `importSqlite`'s per-table count + checksum on the PostgreSQL side, compared to the same numbers from the SQLite snapshot (the importer does this internally — make the report land in `import_runs`, `schema.sql:455-462`).
   - Sequences: assert `last_value` of every identity ≥ the SQLite `sqlite_sequence` high-water mark, so a post-cutover id can never collide with an imported row. (Chat's own importer already reasons this way: `import-from-live.js:275-283` takes `max(liveMax + headroom, chatMax)` and writes `sqlite_sequence` — on PostgreSQL that is `setval`, and the `+ 10000` headroom becomes a `setval` above the imported max.)
   - After cutover: `GET /ready` (`server/app.js:118-154`) must be `ready` with `db.detail.max_message_id` equal to the pre-cutover `SELECT MAX(id) FROM chat_messages`, `table_authority` all six `live` (:149), `mirror.pending` 0 (:134).
   - Spot parity: `scripts/parity-check.js` (repointed at PG) on the six staged tables; the same command the plan already runs at `docs/staged-tables-cutover.md` step 2.
   - Then run the six flips **unchanged** (`docs/staged-tables-cutover.md` §4, calendar :76-87).
7. **Backups.** `scripts/import-from-live.js:10-12` already takes a `VACUUM INTO` copy before writing; the same applies: the SQLite file is retained, read-only, for the rollback window; `docs/cutover.md` §Rollback (:174) plus `scripts/mirror-flush.js` cover the staged tables.

---

## 8. Risks

1. **Message ordering.** `chat_messages.id` is the client splice cursor (`history-store.js:105-111`) and `deploy-notice.js:62` reads "the newest row in ANY room" by `ORDER BY id DESC`. A PostgreSQL identity preserves insert order; but a **cache-pool sequence gap** is invisible to `delta()` (which only needs `id > afterId`) while `readPage`'s `ORDER BY timestamp DESC, id DESC` can reorder rows that share a second — `timestamp` is second-precision text in SQLite. Give `chat_messages.timestamp` sub-second precision in the migration, or make the page order `id DESC` alone.
2. **Ids.** 41 lines read `lastInsertRowid`; several already tolerate a different shape (`deploy-notice.js:76` `res.lastInsertRowid || res.lastID || res.id`; `live-bridge.js:199-202` and `database.js:896-897` both sniff `{changes, lastInsertRowid}`). `sounds-routes.js:285` puts the raw `result.lastInsertRowid` into an HTTP body. `_staged` and the bridge `plain()` must keep returning *something* Live's `chat-tables.js:write()` applies — Live reads the id from the answer, so `RETURNING id` must be shaped back into that field until C-01…C-03 retire the mirror.
3. **TEMP triggers.** `installMirrorTriggers()` (`database.js:143-161`) is per-connection, per-temp-schema, and gated on `main.table_authority`. None of that exists on PostgreSQL; a naive port loses the mirror silently — Live's copy goes stale and nobody notices until a rollback.
4. **Transactions across statements.** `db.transaction(fn)()` is synchronous; the ambient `db.tx` in `openvibe-sdk/db` is async and retries 40001/40P01. `audio-queue.js:187-203` and `live-bridge.js:217-223` read-then-write; under `READ COMMITTED` with two chat processes (or a bridge caller) a retry can double-count `bridge_applied` unless the read and the insert are in the same retryable transaction. `bridge_applied`'s insert-on-conflict is the idempotency guarantee — keep it, and consider `SERIALIZABLE` for the `enqueue` dedupe check (`audio-queue.js:188`).
5. **The audio-queue race the plan mentions.** `audio-queue.js:209-241` `pump()` reads the next queued row, increments `attempts` (already an atomic `UPDATE … attempts = attempts + 1` at :221), awaits the synth (`perform` at :225), then transitions to `playing` and schedules the finish timer. On SQLite the whole read-modify-write is synchronous and single-process. On PostgreSQL, with `await` inside the transaction and a second process (or a retry), two `pump()` invocations can both read the same `state='queued'` row and both play it — a duplicate TTS clip. The existing test tolerance (`test/audio-queue.test.js:237` restart case; the flake noted in commit 4c517a5) becomes a much wider window once the round trip is added. Fix by making the claim atomic, not by loosening the test: `UPDATE audio_requests SET state='playing', attempts=attempts+1 WHERE id=$1 AND state='queued' RETURNING *` inside the transaction, and treat zero rows as "someone else took it". `enqueue`'s dedupe and its per-room/per-requester caps (`audio-queue.js:188-201`) need the same treatment (`ON CONFLICT` on a unique `(room, dedupe_key)`, and the counts inside the tx).
6. **Read latency in the page path.** `GLOBAL_SELECT` (`history-store.js:27-41`) is a five-join aggregate filtered on `message_type IN (…) AND is_deleted = 0 AND (auto_delete_at IS NULL OR datetime(...) > CURRENT_TIMESTAMP)` ordered by `timestamp, id`. On SQLite this ran on a local file; on PostgreSQL it is a remote query whose plan depends on `idx_chat_ts_deleted` (`schema.sql:51`) and `idx_chat_channel_user_ts` (`:48`) surviving the conversion. Measure `page('global')` p95 before and after; if it regresses, add a partial index on `(timestamp DESC, id DESC) WHERE is_deleted = 0` or move the auto-delete filter to a retention sweep (there is already `deleteExpiredChatMessages`, `database.js:400-433`, on a timer) so the read is a plain range.
7. **PgBouncer in transaction mode forbids session state** (`src/db/index.js:25-26`): no `SET`, no `LISTEN`, no advisory locks held across transactions. Chat's pragmas (`database.js:67-73`) disappear; any `statement_timeout`/`lock_timeout` must come from the role (as `createTestDb` does, `openvibe-sdk/src/testing/db.js:49-50`).
8. **`ctx_*` projection write amplification.** `live-context.js:212-225` upserts every Live page inside one transaction; on PostgreSQL the transaction is fine, but `SCHEDULE` (`:760-773`) runs 9 steps every 10 s–30 min against a remote server. It is already off the message path, so this is a load question, not a latency one.
9. **Valkey only fixes the rate limiter.** Making the limiter shared changes the numbers people see after a deploy (a restart no longer resets the budget) — that is the point, but it is a user-visible change and needs a line in the release note.
10. **The six staged tables straddle two engines if T3 lands mid-flip.** `handOver()` (`live-bridge.js:128-148`) drains `live_mirror_outbox` for one table; if that table's copy is in SQLite and the relay reads a PostgreSQL connection, the flip silently no-ops. Sequence the work so **all** tables move to PostgreSQL before the first flip (see §7), and keep `docs/staged-tables-cutover.md` as the authority for the flip itself.
11. **The N-1 harness** replays the previous release's SQL (from `test/fixtures/n-1`) against the current schema, deriving the old schema from `sqlite_master` (`harness.js:731,774`); after the move there is no `sqlite_master`, and the previous release's SQL is SQLite dialect. The recording format must change (record calls, not a schema) or the mixed-version guarantee CI runs is lost.
12. **A version/dependency prerequisite is missing from the draft.** Chat's `openvibe-sdk` pin v0.12.0 has no `db`, no `src/testing` helpers, and no `tools`; `pg`/`pglite`/`iovalkey` are not installed. Landing the plan as written cannot even import its data layer. Bump the SDK (≥0.18.0; ideally 0.22.0) and add the three drivers as step 0, and treat the SDK's own release notes as the contract for `createDb`/`importSqlite`/`asyncify`.
13. **Dynamic SQL is a real dialect hazard, not a mechanical one.** `account-data.js:34,84,106-153`, `subject-merge.js:18,35,47-70`, `live-mirror.js:50` and `applyStagedChanges` (`database.js:1185-1188`) all interpolate table and column names into SQL text. The asyncify tools leave those alone, and `openvibe-sdk/db`'s safe path (`sql`, `sql.ident`) is a tagged template — so these are hand conversions with no codemod behind them, and they are the places where a "converted" service silently changes behaviour.

---

## 9. Step-by-step plan with tests

Each step is one commit; `npm test` (and `npm run test:pg` once it exists) after every one.

0. **Prerequisites.** Raise `openvibe-sdk` (`package.json:32`) to a version that ships `openvibe-sdk/db` and ambient transactions (≥0.18.0), add `pg`, `@electric-sql/pglite`, `iovalkey`, and vendor/checkout `tools/asyncify` from the SDK repo. **Test:** `node -e "require('openvibe-sdk/db')"` loads; the existing suite still passes on SQLite.
1. **Migrations scaffold.** `migrations/0001_initial.sql` from `sqlite-schema-to-pg.js` over `schema.sql` + `rooms.js:86-132` + the three runtime tables, plus Media's SQLite-compat prelude. `server/config.js` gains `db: { url, directUrl }` and `valkey: { url, prefix }`. Boot stays SQLite. **Test:** `test/ready.test.js` unchanged; a new `test/pg-schema.test.js` that opens a PGlite, migrates, and asserts every one of the 35 tables and 39 indexes (from a list, not from `sqlite_master`) exists.
2. **`openDb`/`initDb`/`getDb` + `test/helpers/pg-preload.mjs`.** Media's `server/db/database.js:28-61` verbatim in shape; `CHAT_DB_PATH` still works as the SQLite path behind a `CHAT_STORE=sqlite|pglite|pg` switch for the transition. **Test:** every existing test file passes on PGlite; add `test/pg-boot.test.js` asserting `/ready`'s `db` check is `ok` on both stores.
3. **Dialect fixes in SQL only, SQLite still serving.** `sqlfix.py` rules, `lastInsertRowid` → `RETURNING` behind a helper that returns `{ changes, lastInsertRowid }` on both engines so no caller changes shape — including `sounds-routes.js:285`, which puts it in an HTTP body. **Test:** the whole suite on PGlite; `test/import.test.js` and `test/restart-resume.test.js` ported to read through the same abstraction.
4. **Asyncify.** `asyncify.js` over `server/**`, `scripts/**`, `test/*.test.js`; the `MANUAL` array callbacks fixed by hand, and the dynamic-SQL sites of risk 13 rewritten. **Test:** the whole suite, no test file changed in meaning; `test/bridge.test.js` and `test/staged-tables.test.js` are the sensitive ones (their HTTP bodies must not change).
5. **History store on PostgreSQL.** `history-store.js` async, `readPage` ordered by `id` (or a new `(timestamp, id)` index with sub-second `timestamp`). **Test:** a new `test/history-latency.test.js` measuring `page('global')` and `delta` over 200 k imported rows on PGlite, asserting the p95 and the plan (`EXPLAIN` shows an index scan, not a seq scan); `test/rest.test.js` covers the routes.
6. **Audio queue claim atomicity** (risk 5). **Test:** `test/audio-queue.test.js` unchanged **plus** a new case that runs two `pump()` loops concurrently over the same room on a real PG connection and asserts exactly one play per request; the restart case gets an `await` between the claim and the synth so the window is deterministic instead of load-dependent.
7. **Mirror capture without TEMP triggers.** Appends to `live_mirror_outbox` in the write transactions; `installMirrorTriggers` deleted; `scripts/mirror-flush.js` and `scripts/table-authority.js` repointed. **Test:** `test/outbox-mirror.test.js` and the mirror half of `test/staged-tables.test.js` pass on PGlite, including "Live's changes never come back" and "pending 0 after a flush".
8. **Live-side staged sync deletion, part 1.** With every table still `live`: remove `stagedSlice`/`sliceHash`/dual-read from both sides, keep `applyStagedChanges` + the `stagedApply` relay, add the PG identity key of the capture. **Test:** `test/staged-tables.test.js` loses the dual-read assertions (:99) and gains a PG-specific capture test; Live's `chat-tables-sync.js` relay interval and pause behaviour unchanged.
9. **The data move and the cutover**, run once, in the order of `docs/staged-tables-cutover.md` §0–§3: import (with the counts/checksums of §7), parity, dual-read for one release. **Test:** `scripts/parity-check.js` on PG; `/ready` `table_authority` all six `live`.
10. **The six flips**, one per day, unchanged procedure. **Test:** `test/staged-tables.test.js` extended to cover the flip-back with a non-empty mirror queue (`live-bridge.js:138-145`) on PG.
11. **Delete the bridge and mirror code** (C-01…C-03, 2026-11-06; the staged capture not before 2026-12-18). **Test:** the suite with `applyStagedChanges`, `sliceHash`, `stagedSlice`, the `stagedApply`/`stagedSlice` bridge ops and Live's `chat-tables-sync.js` removed; `docs/staged-tables-cutover.md` gains a closing section.
12. **Valkey for the rate limiter.** Media's `createValkeyLimitStore` + `useValkey` + `VALKEY_URL`/`VALKEY_PREFIX` + a `/ready` check that skips when unset. **Test:** `test/actor-limits.test.js` extended with two handles sharing one budget against `createTestValkey`, and a skip line when the Valkey URL is absent.
13. **N-1 harness on PostgreSQL** (risk 11). **Test:** `test/n-1.test.js` replays the recorded previous-release calls against the migrated schema and reports the same `MANUAL` cases.
14. **Drop better-sqlite3 from the service.** `package.json:24` loses it; `CHAT_DB_PATH` becomes `DATABASE_URL`. **Test:** nothing in `server/` requires it — assert that in `test/security-secrets.test.js` or a new guard test.

---

## Open questions for Opus

1. Does T3 land **before** the first staged flip (my recommendation, §7) or is there schedule pressure that forces a flip first? If forced, which of the six goes first and does `handOver()` get a two-engine mode?
2. Is the mirror allowed to become an explicit `live_mirror_outbox` append in every write transaction, or must it stay a database trigger (on PostgreSQL a real trigger gated by a session GUC, and then a per-transaction `SET LOCAL`, which `asyncify.js` will not insert for us)?
3. Should `chat_messages.timestamp` gain sub-second precision in the migration, or should `readPage` order by `id` alone? This decides whether the global page keeps its `idx_chat_ts_deleted`.
4. The audio-queue claim: is an atomic `UPDATE … WHERE state='queued' RETURNING *` acceptable, or does the queue need a lease (a `claimed_until` column) because a synth can outlive `statement_timeout = 15 s` on the runtime role?
5. Which `openvibe-sdk` version is the target (HEAD is v0.22.0; the data layer assumes ≥0.18.0), and does that bump ride with the move or land first on its own?
6. Is the `MAX(last_read_id, ?)` in `rooms.js:348` the only scalar-`MAX` site? I checked every `MAX(` in `server/rooms/rooms.js` and the other two (`SELECT MAX(id) … room_messages` at :241 and :346) are aggregates, so yes — but a repo-wide `MAX(` sweep has not been done.
7. Does Valkey also take the history-store memo, or does that stay a 2 s in-process cache (my assumption: it stays)?
8. `test/n-1/*` records the previous release's SQL and derives its schema from `sqlite_master` (from `test/fixtures/n-1`). Is the accepted replacement "record the calls and replay them against the migrated schema" (a rewrite of ~1000 lines of harness), or is the N-1 guarantee allowed to lapse for one release while the engine moves?
9. `server/chat/account-data.js:34,84,96` and `subject-merge.js:18,35` interpolate table and column names and read `PRAGMA table_info`; account export orders by `rowid`. Are dedicated, static queries acceptable there, or must account export keep the "most recent N by insertion order" semantics exactly?
10. The `relay_users` table has no id column — its key is `(platform, username)` and Chat uses `rowid AS id` (`database.js:534`). Does the PG migration give it a real identity column and keep the rowid-shaped answer, or does `CHAT_TABLES.relay_users` change?
11. Who runs the production import: is a Chat-maintained `scripts/import-sqlite-to-pg.js` (wrapping `openvibe-sdk/db.importSqlite`) acceptable, or does the move use `OpenVibe.Host roles/data` tooling like Media's `add-service.sh`?

---

*Method note: this is a read-only job. Nothing in `/home/workstation/OpenVibers/OpenVibe.Chat` was edited (working tree clean). The brief under review is `/home/workstation/openvibe/agents/jobs/brief-chat-pg.out.a3.report.md` (249 lines). Every `file:line` in the Corrections table was re-checked against the code, against `openvibe-sdk` HEAD (v0.22.0) and `openvibe-media`, and against `openvibe-live`'s `server/chat/chat-tables{,-sync}.js` and `server/internal/routes.js`. The `npm test` ABI failure was reproduced live (`process.versions.modules` = 137 vs a 127 build).*


---
The report is written to `/home/workstation/openvibe/agents/jobs/check-brief-chat-pg.out.a2.report.md`.

I re-verified every `file:line`, count and "exists / does not exist" claim in the draft against the code, SDK HEAD v0.22.0, Media and Live. The Corrections table has ~50 rows. The blocking error: Chat pins `openvibe-sdk` **v0.12.0**, which has no `db` module, no `tools/asyncify` and no `src/testing` — those arrived in 0.14.0 and 0.18.0 — and `pg`/`pglite`/`iovalkey` are not dependencies at all. Also corrected: the draft invents a Media `test/helpers/db.js` that does not exist, claims ~170 call sites when there are 219, and misses `network_blocks`, `account_data_events` and `token_revocations` as runtime-created tables (four schema owners, not two). I added what the draft missed: every SQLite call-site group, the 34 transaction callbacks, and the 13 test cases of the staged-tables contract.