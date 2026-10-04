# T3 cutover: closeout evidence — OpenVibe.Chat

What the read-only interfaces can actually prove about the Chat PostgreSQL cutover (plan T3, ADR-035). The
cutover ran **2026-09-23 02:03 UTC** (`README.md`, `docs/cutover.md`); production serves the
PostgreSQL-only release. Checked **2026-10-04 23:03Z (UTC)**; the values below were captured then by the
orchestrator through `ov access run openvibe-ovh <action>` — `health`, `releases`, `env-set`. Every result
below is a literal output of one of those actions or of a read-only Git query.

Nothing here was deployed, restarted, rolled back or imported; no credential, URL or env **value** was
read. Checks that need an interface the broker does not expose are marked **pending** in their own
section and were not guessed. SHAs are printed as `ovhost` reports them (12 hex characters).

## Release and readiness — verified

- `health chat` (exit 0): `chat 1d8c8aa14e69 ready  openvibe-chat=active chat sockets=2`. `ovhost` needs
  the service's `/api/ready` to answer before it calls the service `ready`.
- `releases chat` (exit 0): `c88d5814d7df → 0e00f50d6ba9 → 1d8c8aa14e69 deployed` (2026-10-04T12:03Z,
  2026-10-04T21:23Z, 2026-10-04T22:43Z). `1d8c8aa14e69` is the release running in production; the
  PostgreSQL cutover itself deployed 2026-09-23 02:03 UTC (`docs/cutover.md`).

**Why this is a PostgreSQL-only release.** `server/db/database.js` serves through `openvibe-sdk/db`,
which in production requires `DATABASE_URL` (runtime, through PgBouncer) and `DATABASE_DIRECT_URL` (the
owner role, for `migrations/`) and only falls back to embedded PGlite outside production. A release that
is `active`/`ready` therefore booted with both set. `better-sqlite3` is not a dependency and nothing the
service loads opens SQLite, guarded by `test/no-sqlite.test.js`; the schema is `migrations/0001_initial.sql`.

## Env presence and mode — verified

- `env-set chat` (names only, file `/etc/openvibe/chat.env`): **`DATABASE_URL`**, **`DATABASE_DIRECT_URL`**,
  **`VALKEY_URL`**, **`VALKEY_PREFIX`**, `EVENTS_URL`, `LIVE_MIRROR`, `OV_NETWORK_INTERNAL_URL`,
  `OV_LIVE_INTERNAL_URL`, `BASE_URL`, `SITE_URL`, `PORT` and the rest present, none empty. `CHAT_DB_PATH`
  comes from the unit and is read only by the one-time importer.

## Import and row parity — pending

The SQLite→PostgreSQL import and its per-table count+checksum report live in
`docs/pg-port/progress-attempt4.md`; the production import report (`scripts/import-sqlite-to-pg.js`,
recorded in `import_runs`) and the rollback copy (`chat.db.pre-pg`) are not exposed by any read-only
action. **Not checked.**

## Valkey ACL scope — pending

Presence of `VALKEY_URL`/`VALKEY_PREFIX` is provable (above). The scope of the Valkey user (commands,
`~ov:chat:*` confinement in `/etc/valkey/services.acl`) needs a connection no read-only action opens.
**Not checked.**

## Reproduce

```bash
ov access run openvibe-ovh health chat
ov access run openvibe-ovh service-status chat
ov access run openvibe-ovh plan chat
ov access run openvibe-ovh releases chat
ov access run openvibe-ovh validate chat
ov access run openvibe-ovh env-set chat
ov access run openvibe-ovh journal openvibe-chat.service 200
```

Every one of these is a low-risk read. `deploy`, `rollback`, `restart` and `db-backup` were not used.
