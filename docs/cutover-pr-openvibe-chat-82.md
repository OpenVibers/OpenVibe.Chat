# Cutover — drop `live_mirror_outbox` (OpenVibe.Chat PR #82)

The one data change in this PR is `migrations/0009_drop_live_mirror_outbox.sql` (phase: contract, after
0006): `DROP TABLE IF EXISTS live_mirror_outbox;`. The Live read mirror is retired; 0006 already dropped
the twelve `mirror_*` capture triggers and their functions, so since that release nothing writes to the
table, and nothing reads it (`test/no-live-mirror.test.js` keeps `server/` and `scripts/` clear of it).
The table holds only the rows queued before 0006 and never delivered. No other table, column or row is
touched.

## Order of operations

1. **Check the precondition.** Production is already past 0006 (the `mirror_*` triggers are gone), so
   nothing is still filling the table and the contract can run.
2. **Back up** `live_mirror_outbox` (below) and note the current release (`ov access run openvibe-ovh
   releases`) for the way back.
3. **Deploy** the release through its pipeline. The SDK migrator applies `migrations/` at boot as the
   owner (`DATABASE_DIRECT_URL`) and records `0009` in `ov_migrations`; it is the only thing that runs the
   `DROP`. A second boot applies nothing.
4. **Verify** (below).
5. **Way back** only if verification fails (below).

## Backup

Take the dump before the deploy, as the owner on a direct connection (not PgBouncer). The table is idle, so
the dump is small and consistent:

```bash
pg_dump "$DATABASE_DIRECT_URL" -Fc -t live_mirror_outbox \
  -f /var/backups/openvibe-chat-live-mirror-outbox-pr82.dump
pg_restore --list /var/backups/openvibe-chat-live-mirror-outbox-pr82.dump | tail
```

Keep the dump until the release has served a full cycle. No other table is part of this cutover.

## Verification

1. **Migration applied.** `SELECT id, name, phase FROM ov_migrations WHERE id = '0009';` →
   `0009 | drop_live_mirror_outbox | contract`, and `SELECT to_regclass('live_mirror_outbox');` → `NULL`.
2. **No mirror remnants.** `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE
   'mirror\_%';` → no rows (0006's work, unchanged).
3. **Readiness.** `ov access run openvibe-ovh health` and `GET /ready` on openvibe-chat report ready.
4. **Chat still writes.** Send a line in a room and a DM; both land and broadcast. `ov access run
   openvibe-ovh journal openvibe-chat.service 200` shows no `live_mirror_outbox` error: a `relation
   "live_mirror_outbox" does not exist` line would mean something still touched the table.

## Way back

Nothing reads or writes the table, so a bad deploy is undone by the previous release alone: roll the
release back through its pipeline. The migration is `DROP TABLE IF EXISTS`; rolling the release back does
not recreate the table, and the previous release does not need it (it is 0006 or later, which removed what fed it). Only if a
reader of the old rows turns up, restore the table from the dump as the owner:

```bash
pg_restore --no-owner -d "$DATABASE_DIRECT_URL" -t live_mirror_outbox \
  /var/backups/openvibe-chat-live-mirror-outbox-pr82.dump
```

Restoring does not un-record `0009` in `ov_migrations`; the table then stays until a later migration
drops it again, so leave `0009` recorded and re-run the `DROP` only after the reader is fixed.

## Rehearsal

The harness builds main's schema on a scratch PostgreSQL, applies this PR's migrations (a second run must
apply nothing), then runs the commands below: `0009` must be recorded, the table must be gone, no
`mirror_*` trigger may remain, and a Chat write must still land.

```rehearse
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL||process.env.DATABASE_URL,service:"rehearsal",max:1});(async()=>{a.strictEqual((await db.prepare("SELECT to_regclass(?) AS t").get("live_mirror_outbox")).t,null);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM ov_migrations WHERE id = ?").get("0009")).n),1);a.deepStrictEqual(await db.prepare("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE ?").all("mirror\\_%"),[]);await db.prepare("INSERT INTO chat_messages (message) VALUES (?)").run("rehearsal");a.ok(Number((await db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE message = ?").get("rehearsal")).n)>=1);console.log("0009: live_mirror_outbox dropped, recorded, no mirror triggers, chat write lands")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```
