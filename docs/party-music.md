# Listening together in a party room

A watch party or a shared computer on openvibe.party can play **OpenVibe Radio** beside what it watches. The room's
control lease (the remote) is the right to change it: whoever holds the remote starts a licensed track or the Radio
station, pauses, resumes, skips and stops it. Everyone else follows the same timeline; each person's volume is their
own browser setting.

Only `https://openvibe.download`'s published Radio catalogue is playable. Nothing here accepts a free URL, and a
track is validated for its licence, its official audio URL and its published metadata every time it enters the room.

## API (Chat)

All routes are on `/api/chat/parties` and need the party's link, membership or the remote as noted.

| Route | Who | What |
|---|---|---|
| `GET /:slug/music` | member or the link's `k` | `{ music, server_time_ms }`; `music` is null when the room is quiet |
| `POST /:slug/music/play` | the remote holder | `{ track_id? , station? }`; no `track_id` starts the Radio station, a `track_id` plays one track, `station: true` makes that track the station's start |
| `POST /:slug/music/pause` / `resume` | the remote holder | stop or continue the same timeline |
| `POST /:slug/music/next` | the remote holder | the station's next licensed track; a single track leaves the room quiet |
| `POST /:slug/music/ended` | the remote holder | `{ expected_id }`; the same as next, but idempotent for the track the listener just heard end |
| `POST /:slug/music/stop` | the remote holder | the room goes quiet |

`music` is also in the party's own state (`GET /api/chat/parties/:slug`, and the page's `#party-data`).

## The state

```
{
  track: { id, title, artist, source, source_url, licence, licence_url, changes_note, ai_made, audio_url },
  station, started_by, started_by_name, started_at, started_at_ms,
  position_ms, at_ms, paused, up_next, seq
}
```

`position_ms` is where the room was at `at_ms`; while `paused` is false it moves at rate 1. A late joiner computes
`position_ms + (server_now - at_ms)` and seeks there. `started_at` is when the current track began, `started_by` is
the OpenVibe subject that started it, and `seq` is the version counter (the same as `room_parties.music_version`).

Changes are broadcast on the room socket as `{ type: 'music', room, state }`; a join also receives the current state.
Each browser keeps its volume in `localStorage` under `ov-party-volume` and never sends it to Chat.

## Storage

`migrations/0067_party_music.sql` adds `room_parties.music_state` (jsonb) and `music_version` (compare-and-set). The
module is `server/rooms/party-music.js`; the page code is in `public/web/party.js` (`paintMusic`, `applyMusic`).
