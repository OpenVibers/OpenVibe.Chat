# OpenVibe's own computers for parties

`openvibe.party` can run a party's shared computer on the person's own Link machine, or on OpenVibe's own Link
machines (message 11, 2026-11-08). This document covers the second path: the pool, its owner switch, placement, the
holds it keeps, and the machine-facing assignment contract.

A pool machine is one of the owner's Link machines. Nothing here rents capacity or spends money: there is no quote,
price, budget or provider call in `server/rooms/party-pool.js`. It chooses only among machines the owner registered.

## The owner turns it on and registers machines

The switch is the one row in `party_pool_settings`, written from `openvibe.party/pool` by a session with the owner
rank. It starts **off**. `CHAT_PARTY_POOL=1` is an operator override for a development box; the panel's value wins
otherwise.

The owner adds a machine with its Link principal (`lnk_…`, shown on `openvibe.network/machines`), a name, what it can
run (`desktop`, and optionally `browser`), and how many desktops it may host at once (`1–50`). The row is the
machine's advertisement:

```
principal_id  the node principal in the machine's node token
name          what the party page calls it
can_run       ["desktop"] (a party needs desktop)
desktops      capacity: how many parties it may hold at once
last_seen_at  when its Link last asked for an assignment
```

Removing a machine releases its holds and stops those rooms' desktops.

## A party asks the pool

`POST /api/chat/parties` with `desktop_hosting: "openvibe"` asks the pool before the room is made:

1. The switch is off → 503 `party.pool_off`.
2. No machine is registered → 503 `party.pool_empty`.
3. A machine has a free desktop → a `held` hold, the room is created, and the room view's `desktop.where` names it.
4. Every machine is full → a `queued` hold with `desktop.where.queue_position` (1 is next) and a plain line. A
   released machine seats the oldest queued room on the next sweep.

Placement is serialized on the settings row. It picks the machine with the most free desktops, then the least loaded
(used / capacity), never a disabled one. Load is the number of `held`, `hosting` and `ready` holds on the machine.

The person has at most `CHAT_PARTY_POOL_MAX_PER_ACTOR` (default 2) waiting or running OpenVibe parties at once; the
start route already carries the per-actor rate limit (`chat.party.create`), and the pool's management routes carry
`chat.party.pool`.

## The hold and the room

`party_pool_holds` is one room's reservation:

| state | meaning |
| --- | --- |
| `queued` | no free desktop; the room waits in line |
| `held` | a machine is reserved; its Link has not claimed the party yet |
| `hosting` | the machine's Link claimed it (its claim moves the hold) |
| `ready` | the machine's Connect share is up |
| `released` | the room ended, a machine was removed, the hold went idle, or the place in line expired |

The partial unique index keeps one open hold per room. Released rows stay as the record.

`GET /api/chat/parties/:slug` adds `party.desktop.where` for every desktop party:

```json
{ "state": "ready", "machine": "Dell tower 1", "queue_position": null,
  "line": "Running on Dell tower 1, an OpenVibe computer." }
```

A Link-hosted party gets `{ "state": "link", …, "line": "Runs on the host's computer through OpenVibe Link." }`.

## Releasing

- The host ends the party → the hold is released and the room's desktop is stopped.
- The machine stops or its Link says `stopped` → released.
- A `held`/`hosting`/`ready` hold with no renewal for `CHAT_PARTY_POOL_IDLE_MS` (default 10 minutes) is released as
  idle and the room says so. Link renews by asking for the party's `access` every three seconds while it hosts.
- A `queued` hold older than `CHAT_PARTY_POOL_QUEUE_MS` (default 30 minutes) is released as `queue_expired`.

A minute sweep on the server (`start()` in the module) does the idle and queue expiry and seats the line; tests call
`sweep()` directly.

## The machine-facing assignment

A pool machine's Link presents its own node token (`sub: link:lnk_…`) and asks what to host:

```
GET /api/chat/parties/desktop/assignment
→ { "assignment": { "party": "party-0123abcd", "hold": "ph_…", "title": "Friday film" } }
→ { "assignment": null }
```

The poll also updates the machine's `last_seen_at`. The answer names the oldest `held` party for that principal whose
room is still waiting; once its claim moves the hold to `hosting`, the next poll says null.

On the machine, `party_pool: { "enabled": true }` in the Link's `config.json` turns the poll on (off by default). Link
asks every five seconds and starts the same host path as `openvibe-link party host <party>`: it claims the party,
creates the Connect share, reports ready and polls `access` while it hosts. The owner still registers the machine's
principal on the panel; the machine itself is not trusted to join the pool.

## Routes

| Route | Who | Meaning |
| --- | --- | --- |
| `GET /api/chat/parties/pool` | owner | the switch, machines with load/free, open holds |
| `PUT /api/chat/parties/pool/enabled` | owner | `{ enabled }` → the panel |
| `POST /api/chat/parties/pool/machines` | owner | `{ principal_id, name, desktops, can_run? }` → 201 |
| `PATCH /api/chat/parties/pool/machines/:principal` | owner | change name, desktops, can_run or enabled |
| `DELETE /api/chat/parties/pool/machines/:principal` | owner | remove it and release its holds |
| `GET /api/chat/parties/desktop/assignment` | the machine | what to host next |
| `GET /pool` | owner page | the plain panel (design pass owns its look) |

Tests: `test/party-pool.test.js` drives the placement engine with a fake registry (capacity, load, queue, promotion,
idle release), then the HTTP flow around it (switch, owner-only registration, party start, claim, ready, end, queue,
per-person cap and the panel page).
