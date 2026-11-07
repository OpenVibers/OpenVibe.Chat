# A room's shared clock and control lease (B3/B4)

Two common blocks Party stands on, both carried by Chat's room socket (`/ws/chat`, `join_room`):

- **B4 `common.sync-clock@1`** — one timeline for every player in the room.
- **B3 `common.control-lease@1`** — who holds the room's controls (the remote).

The state shapes are in OpenVibe.Contracts (`contracts/common/sync-clock.v1.json`,
`contracts/common/control-lease.v1.json`). This file is the Wire protocol and the decisions Chat makes; the browser
half of B4 is `ov-sync.js` in OpenVibe.Shared.

## Storage: memory and the durable copy

| State | Live copy | Durable copy |
|---|---|---|
| Clock | `server/rooms/sync-clock.js`, a `Map` keyed by room id | `room_sync_clocks` (migration `0042_room_shared_state.sql`) |
| Lease | `server/rooms/control-lease.js`, a `Map` keyed by room id | `room_control_leases` (same migration) |

Every accepted clock set writes the whole row in the same operation that returns the stamped state, so a restart
reads the latest timeline back. The lease is written on every control change (grant, release, take, expiry); its
`watchers` are live presence recomputed from the sockets in the room and are deliberately not a durable membership
list. `seq` is the version of the control change, so a client ignores a state with a lower `seq`; watcher-only
changes do not bump it.

`evict(roomId)` in either module drops the memory copy and reads the row back; tests use it to prove the durable
copy.

## B4: the shared clock

State:

```json
{ "room": "friday-film", "media": "https://media.openvibe.network/vod/friday-film.webm",
  "position_ms": 61234, "rate": 1, "paused": false, "at_ms": 1794067200123,
  "set_by": "usr_01JAB2C3D4E5F6G7H8J9K0MNPS", "seq": 7 }
```

`media` is a `media.media-ref@1` object or an `https` URL. A player is at
`position_ms + (serverNow - at_ms) * rate` while `paused` is false, and at `position_ms` while it is true. `at_ms`
is always Chat's clock when Chat accepted the set; a player measures that clock with `time` (below).

### Setting the clock

Client → Chat:

```json
{ "type": "sync", "media": "https://…", "position_ms": 61234, "rate": 1, "paused": false }
```

`media` may be left out to keep the room's current media. `position_ms` may be left out to pause or resume where the
timeline is now. `rate` and `paused` may be left out to keep their current values. The first set needs `media` and
`position_ms`.

Chat → room, and to a member when they join:

```json
{ "type": "sync", "room": "friday-film", "state": { … } }
```

Only the current **person** holder of the room's control lease may set it. Chat refuses everyone else with:

```json
{ "type": "sync_error", "room": "friday-film", "code": "sync.not_holder", "message": "Only the person with the remote can move the room" }
```

Other codes: `sync.sign_in`, `sync.not_joined`, `sync.media`, `sync.position`, `sync.rate`, `sync.paused`, `rate`.

### Clock measurement

Client → Chat (five of them, about 120 ms apart, once on attach and again every 60 s):

```json
{ "type": "time", "id": "t1-0-ab12cd", "t0": 1794067198123 }
```

Chat → that socket:

```json
{ "type": "time", "id": "t1-0-ab12cd", "t0": 1794067198123, "t_server": 1794067198127 }
```

`ov-sync.js` computes `offset = t_server - (t0 + t3) / 2` for each sample, keeps the five with the smallest round
trip, and uses the best one. `serverNow()` is `Date.now() + offset`.

## B3: the control lease

State:

```json
{ "thing": "chat.room:friday-film",
  "holder": { "kind": "person", "subject": "usr_01JAB2C3D4E5F6G7H8J9K0MNPS" },
  "since_ms": 1794067200000, "expires_ms": null,
  "watchers": ["usr_01JAB2C3D4E5F6G7H8J9K0MNPS", "usr_01JAB2C3D4E5F6G7H8J9K0MNPX"], "seq": 4 }
```

A room is one thing; Chat names it `chat.room:<slug>`. Every room has a lease: a room with no control history is
`nobody` at `seq` 1, with the signed-in people connected to the room as `watchers`.

### Messages

All on the same room socket, all fanned out to the room by Chat:

| Client sends | Chat broadcasts | Who may send it |
|---|---|---|
| `{ "type": "lease.request", "expires_ms": … }` | `{ "type": "lease", "room", "state", "granted": true }` when the controls were free; otherwise `{ "type": "lease.request", "room", "request": { requester, holder, since_ms, expires_ms, seq } }` | any signed-in member |
| `{ "type": "lease.grant", "to": { "kind": "person", "subject": "usr_…" }, "expires_ms": … }` | `{ "type": "lease", "room", "state", "granted": true }` | the current holder |
| `{ "type": "lease.release" }` | `{ "type": "lease", "room", "state", "granted": true }` | the current holder |
| `{ "type": "lease.take", "expires_ms": … }` (also `lease.take_back` and `lease.revoke`) | `{ "type": "lease", "room", "state", "taken": true }` | the room's owner, or chat staff |

`to` may also be `{ "kind": "ai", "subject": "ai:vibe" }` or `{ "kind": "nobody", "subject": null }`. A `person`
target must be one of the room's current watchers, so a remote never goes to somebody who is not there. An `ai`
target is accepted as the room owner names it; Chat has no socket for it, so the owner takes it back to end the AI's
turn.

`expires_ms` is an absolute epoch instant within the next 24 hours. At that instant Chat makes the holder `nobody`,
increments `seq` and broadcasts the state with `"reason": "expired"`. A person holder who leaves the room (their
last socket closes, or they are removed) is released the same way. Take-back always wins and needs no consent.

Errors:

```json
{ "type": "lease_error", "room": "friday-film", "code": "lease.not_holder", "message": "Only the current holder can hand the controls on" }
```

Codes: `lease.sign_in`, `lease.not_joined`, `lease.not_holder`, `lease.not_owner`, `lease.not_watching`,
`lease.target`, `lease.expiry`, `rate`.

### Decisions

- **Free controls go to the first request.** When `holder.kind` is `nobody`, `lease.request` grants at once; this is
  how a party's host picks up the remote on arrival and how the next person takes it after a release.
- **A held remote is never grabbed by request**, only granted by its holder or taken back by the owner.
- **Watchers are the room, live.** They are the signed-in subjects connected to the room now; joining or leaving
  refreshes them, and they do not bump `seq`.
- **A leave releases a person holder.** There is no grace period: the next request finds the remote free, and the
  owner can always take it.

## Client use

```js
const a = OVSync.attach(video, { room: 'friday-film', socket, self: subject });
// a.drift()          ms ahead of the room (positive = ahead)
// a.isHolder()       whether the control lease says this subject holds the room
// a.clock()          { offset, rtt, ready }
// a.destroy()
```

Shared serves the file as `/shared/ov-sync.js` and exports it as `openvibe-shared/ov-sync`. The page opens one
`socket` that has already sent `join_room` (Chat sends the first `sync` and `lease` frames in answer to that join);
`self` is optional when the socket's `room_joined` frame carries `subject`.
