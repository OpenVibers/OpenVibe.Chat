# Vibe personas

Each Vibe conversation on OpenVibe.Chat has a persona: a name and a face made from what the chat is about,
remade when the topic changes. The owner, 2026-11-12: "for each vibe chat, it should generate a name based on
whatever the conversation or the vibe of the chat is, and then it'll generate an avatar for that chat bot …
and update every once in a while if the topic changes … the cheapest model possible, but configurable on the
admin panel."

## The shape

Every persona is exactly this object, on `GET /api/vibe/conversations` (each item) and on `chat` in
`GET /api/vibe/chat`:

```json
{
  "name": "Keyboard Scout",
  "glyph": "keyboard",
  "hue": 210,
  "image_url": null,
  "topic": "mechanical keyboards and switches",
  "made_at": "2026-11-12T09:31:26.431Z"
}
```

- `name`: 1–3 Title Case words that say what the chat is about, as a character. No real person's name, no slur,
  no digits. It is also the conversation's title until the person renames it.
- `glyph`: one name from the OpenVibe glyph registry (`require('openvibe-shared/glyphs').NAMES`). A model answer
  with any other name is retried once, then replaced from the registry, so no consumer ever receives an unknown
  icon.
- `hue`: 0–359, the colour that fits the topic.
- `image_url`: null while avatar pictures are off (the default); otherwise a small public OpenVibe.Media URL.
- `topic`: at most 12 words saying what the chat is about.
- `made_at`: UTC ISO timestamp.

`persona` is `null` for a chat whose first answer has not happened yet, and for a chat past the monthly cap.

## When it is made

- After the first answer. The second message (Vibe's answer) is stored, then a `setImmediate` due check makes the
  persona. A reply never waits for it.
- Then every `check_every` messages (default 8): the cheapest chat model reads the current topic and the recent
  messages and answers exactly `YES` or `NO`. `NO` keeps the persona; `YES` makes a new one.
- One generation per room at a time, with an idempotency key on every model call, so a retry or a restart replays
  the same answer rather than paying twice.
- If the person renamed the chat (`PATCH /api/chat/vibe/:slug`), `rooms.vibe_title_locked` is set and a persona
  never writes over their title.

## Models and money

Every model call is OpenVibe.AI's `ai.complete` (Chat's own Network grant, namespace `chat.*` + `ai.complete`) with
an explicit Exchange catalogue model. `text_model` empty means Auto: the cheapest chat model in
`GET /api/v1/exchange/catalog`, chosen by input + output price. Avatar pictures use the Chat-owned
`chat.persona.image` workflow (the same image step as `ai.image`, under Chat's namespace) with the cheapest image
model when `image_model` is empty; the bytes are uploaded to OpenVibe.Media as Chat and the public URL is stored on
the persona. A failed picture never loses the name.

The runs are Chat's own (not the person's allowance). Each run's `usage.cost_usd` is recorded in
`vibe_persona_spend`; the owner's monthly cap is checked before every call and read from that table. `0` stops
persona spending. At the cap, existing personas stay and new chats get no persona until the cap is raised or the
month turns (UTC).

## Owner settings

The page is **https://openvibe.chat/admin/persona** (owner only: an admin with Network's owner flag). It shows this
month's spend next to the cap, the model choices with their prices, the interval, and every recent conversation
with a **Remake** button. The same values are a revisioned configuration namespace, `chat.persona`, in
`openvibe-shared/config`, so they are auditable and Network's owner settings proxy can read them.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | make and check personas at all |
| `text_model` | `''` | catalogue model for names and checks; empty = Auto (cheapest chat model) |
| `images` | `false` | make an avatar picture too |
| `image_model` | `''` | catalogue model for the avatar; empty = Auto (cheapest image model) |
| `check_every` | `8` | messages between topic checks (2–100) |
| `monthly_cap_usd` | `5` | most Chat may spend on personas in a UTC month; 0 stops it |

API, for scripts and the page:

```http
GET  /api/admin/persona                 { settings, defaults, spend, models, conversations, month, revision }
POST /api/admin/persona                 { enabled?, text_model?, images?, image_model?, check_every?, monthly_cap_usd? }
POST /api/admin/persona/remake          { slug } → { persona, conversations }
```

All three are owner sign-in only (an API token is refused) and return 403 to anyone else. `spend` is
`{ month, usd, cap_usd, remaining_usd, reached }`.

## Storage

- `vibe_personas` (migration `0078_vibe_personas.sql`): one row per room, the six fields and the check cursor
  (`checked_count`, `checked_at`), generation number, cascade with the room.
- `vibe_persona_spend`: one row per model call with month, kind (`text`/`image`), model, run id and the run's cost.
- `rooms.vibe_title_locked`: set by `server/rooms/vibe.js` `rename`; personas leave the title alone after that.

The engine is `server/persona/index.js`; the settings store `server/persona/settings.js`; the page
`server/web/persona-admin.js`; the JSON API `server/rooms/persona-api.js`.

## Tests

`test/vibe-persona.test.js` uses recorded model answers (`test/fixtures/vibe-persona/recorded.json`) through
`aiClient._setClient()` and an injected catalogue (`aiClient._setCatalog()`), with a stand-in Media client, so no
test touches the network. It covers the first persona, the API shape and title, a NO check, a YES change, an
invalid glyph, the monthly cap, images, and the owner-only settings and remake.
