# Your agent in Telegram, Discord and Slack (A4)

Chat answers the three chat apps. A message to the bot goes to the person's OpenVibe agent in
OpenVibe.Actor (their memory, tools and budget), and the answer comes back in the same chat.
OpenVibe.Network owns the account links; Chat keeps only its own rows (the one-time link token,
a group's rules and the buttons an approval made).

Every app is **off until the owner puts its token and its own secret in the settings**
(`/etc/openvibe/chat.env`): with one missing, the app answers 503, sets no webhook and starts no
gateway. Nothing here creates a bot account.

## What the owner creates, in two lines per app

- **Telegram:** a bot from [@BotFather](https://t.me/BotFather) (`/newbot`), then a webhook secret
  (any long random string). No other account.
- **Discord:** an application and its bot user (Developer Portal), the application's public key,
  the bot token, and the **Message Content** intent; invite it with `bot` + `applications.commands`.
- **Slack:** an app in the workspace with a bot user; the signing secret, the bot token and the
  workspace (team) id; scopes `chat:write`, `commands`, `users:read`, `team:read`.

## Settings

The owner enters the bot details in the admin panel's Setup tab (Chat apps): they are the `chat.apps`
namespace on openvibe-shared/config, sealed and write-only, each with a Test button (Telegram getMe,
Discord users/@me, Slack auth.test). A value entered there wins; the variables below stay the fallback,
read every time they are used. `CHAT_APPS_CALLBACK_SECRET` and `CHAT_TELEGRAM_SECRET_TOKEN` need not be set:
when neither the environment nor `chat.apps` has one, Chat makes it once and keeps it sealed.

| Variable | What it is |
|---|---|
| `CHAT_APPS_CALLBACK_SECRET` | signs every approval button; a long random string of its own |
| `CHAT_TELEGRAM_BOT_TOKEN` | BotFather's token |
| `CHAT_TELEGRAM_SECRET_TOKEN` | the webhook secret (Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`) |
| `CHAT_TELEGRAM_USERNAME` | the bot's @name, so `/link@another_bot` is not ours (learned from `getMe` when unset) |
| `CHAT_DISCORD_BOT_TOKEN` | the bot token |
| `CHAT_DISCORD_PUBLIC_KEY` | 64 hex characters, the application's public key (interactions are signed with it) |
| `CHAT_DISCORD_APPLICATION_ID` | the application id (commands are registered on it) |
| `CHAT_SLACK_BOT_TOKEN` | `xoxb-…` |
| `CHAT_SLACK_TEAM_ID` | the workspace id (`T…`); a delivery from another workspace is refused |
| `CHAT_SLACK_SIGNING_SECRET` | the app's signing secret (v0 over `v0:<timestamp>:<body>`) |
| `CHAT_LINK_CONFIRM_URL` | Network's confirm page, default `https://openvibe.network/chat-apps/link` |
| `CHAT_LINK_TTL_MS` | how long a `/link` token lives (default 10 min) |
| `CHAT_CALLBACK_TTL_MS` | how long an approval button lives (default 30 min) |
| `CHAT_APPS_RATE_PER_HOUR` | answers an hour a group gets (default 20) |
| `CHAT_APPS_PER_USER_RATE_PER_HOUR` | messages an hour one person gets (default 10) |

Secrets are read from `chat.apps` or the environment, used only against the provider's fixed origin and
never printed or put into an error.

## Endpoints and what to set where

The base is Chat's own origin (`CHAT_WEB_URL`, production `https://openvibe.chat`).

- Telegram: `https://openvibe.chat/hooks/chat-apps/telegram`
- Discord: `https://openvibe.chat/hooks/chat-apps/discord`
- Slack: `https://openvibe.chat/hooks/chat-apps/slack`

Register what a provider lets us register:

```bash
sudo node --env-file=/etc/openvibe/chat.env scripts/chat-apps.js            # what is on, and as which bot
sudo node --env-file=/etc/openvibe/chat.env scripts/chat-apps.js --register # Telegram webhook + commands, Discord commands
```

- **Telegram:** the script calls `setWebhook` (with `secret_token`, `allowed_updates`
  `message` and `callback_query`) and `setMyCommands` (`/link`, `/unlink`, `/help`, `/settings`).
- **Discord:** the script PUTs the global commands (`/link`, `/unlink`, `/help`, `/settings`).
  Set the **Interactions Endpoint URL** to the URL above in the app's General Information page;
  Discord checks it with a signed PING. Enable **Message Content** so an ordinary message in a
  group reaches the agent (and `Guilds`, `GuildMessages`, `DirectMessages`).
- **Slack:** the dashboard sets these: **Event Subscriptions** Request URL = the URL above,
  bot events `app_mention` and `message.im`; **Interactivity** Request URL = the same; a slash
  command per command (`/link`, `/unlink`, `/help`, `/settings`) with the same Request URL.

nginx serves `openvibe.chat` through `location /` to Chat, so no new location is needed.

## How it behaves

- **Linking is two-way.** `/link` in a direct message answers a one-time URL. The person opens it
  signed in to Network, sees that this chat account will talk to their agent and approve its
  steps, and confirms. The page then shows a **6-digit code** (10 minutes, kept only as a hash):
  the person sends that code to the bot **from the same chat** to finish. Only then is the account
  link written; a confirm URL forwarded to somebody else links nothing, because only the chat
  account that started `/link` can finish it. Three wrong codes cancel it and the code expires.
  The code is accepted only in a direct message (never in a group) and only from an unlinked
  account. `/unlink` removes the link. Until linking finishes only `/link` and `/help` answer.
  A link is used once; the token is stored only as a SHA-256 hash. A second person confirming the
  same chat account is refused; so is replacing a different linked account with the same service.
- **A message.** Group answers only when the bot is mentioned or the message replies to it.
  A direct message is a private policy: the agent may use the person's tools and memory. A group
  is `answer_only` (public tools, no acting) or `act_with_approvals`; a group never gets the
  person's private memory, computers, robots or code, and never creates memory, waits or files.
  Answers are split the app's way (Telegram 4096, Discord 2000, Slack 3000) and the agent's files
  come back as links. Chat's moderation rules (`lineOk`) apply to everything the bot says; a
  refused line becomes "I cannot share that answer under the chat rules."
- **Approvals.** An acting tool (send, post, pay, delete, deploy) never runs on its own: Actor
  writes an approval row with the exact tool and arguments, and Chat shows it as buttons
  (Telegram inline keyboard, Discord components, Slack Block Kit). A button is an id signed with
  `CHAT_APPS_CALLBACK_SECRET`; the row behind it says who may press it (the linked person in the
  same chat, as the same subject), what it does, that it is open, and when it expires. The row is
  consumed in one statement, so two presses (or a press by anyone else) decide nothing. Approving
  lets that one exact call run; the agent cannot change the arguments after consent. Arguments
  over 1200 characters are refused rather than shown truncated.
- **Groups.** `/settings off|answer_only|act_with_approvals [answers per hour]` is answered only
  to a group or workspace administrator (Telegram `getChatMember`, Discord `Manage Guild` /
  `Administrator`, Slack `is_admin`/`is_owner` in the workspace). `off` answers nothing but
  `/settings`. The hourly rate is per group; a person also has a per-hour message limit.
- **Durability.** A delivery is stored (`chat_app_deliveries`, deduped by the provider's event
  id) and acknowledged before any work: Telegram and Slack expect a fast 200, Discord a reply
  within 3 seconds. A fixed number of workers answers messages and buttons in separate lanes, so
  a slow task does not hold a button. On start, a delivery left `running` is marked failed, not
  replayed after an external effect. Buttons, tokens and deliveries are pruned.
- **Untrusted text.** In a group the text is wrapped as a stranger's suggestion, never the
  owner's words, and the tool allow-list is the group policy's. In a direct message it is the
  person's own message.

## Security notes

- Telegram's secret token, Slack's v0 signing and Discord's Ed25519 signature are checked before
  the body is parsed, in constant time, against the raw bytes (the SDK's `openvibe-sdk/chat-apps`,
  the code Watch has used since 2026-11-03). A provider the module does not know is never
  verified.
- A provider access token, an interaction token and the raw event are not stored: a delivery keeps
  only what the answer needs.
- The link POST on Network checks same-origin, the person must be signed in, and the confirm page
  shows the app and the chat name before asking. Confirming only mints a code; the link exists
  only after the same chat account sends that code to the bot. A forwarded confirm URL therefore
  cannot attach somebody else's agent to the sender's chat.
- Account deletion removes the person's link tokens, approval buttons and queued deliveries; the
  export includes their chat-app links and approvals.

## Tests

`node test/run.js chat-apps` covers the three signed payloads across the real HTTP boundary
(401 without the signature, 503 when an app is off, one delivery stored per event id), linking,
the 6-digit code finishing from the starter's chat (and a wrong chat account and a wrong code
refused), an unlinked sender refused, a wrong person's button refused, two presses deciding once,
an expired button, group mention rules, group admin settings, the moderation refusal, the rates
and the provider calls. Network's `node test/run.js chat-app-links` covers the code's hash at
rest, its 10-minute expiry, three wrong codes cancelling the link, and the real service-token
gate. `node test/run.js account-data` covers export and deletion.
