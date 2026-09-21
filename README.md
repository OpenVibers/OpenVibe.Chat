# OpenVibe.Chat

> Rooms, messages, DMs, calls, TTS and audio queues, moderation and presence — one identity, every conversation.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.chat`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §9 and §9.5.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The communication authority extracted from OpenVibe.Live. Live keeps a compatibility adapter while browsers move to Chat directly with Network-issued tokens and authorised topic subscriptions.

## Owns

- room types: global, stream, channel, community, DM, group-DM, call, system
- messages, replies/rich payloads, membership/roles, unread/read state, presence/typing (ephemeral)
- bans, timeouts, delete/purge, filters, slow/member-only modes
- TTS/audio/soundboard/media-request queues with skip/clear/failure lifecycle
- call signalling metadata and the `pending/ringing/active/ended/missed/declined/failed` lifecycle

## Does not own

- media bytes (attachments are Media references)
- billing of paid messages (Tips/Billing)

## Planned surfaces

- `api/` rooms, history, DMs, moderation, settings; `realtime/` WS/SSE delivery; `calls/`; `speech/`; `soundboard/`; `moderation/`; `adapters/live/`

## Data (authority tables / families)

- see above

## Capabilities and events

- `chat.room.*`, `chat.message.*`, `chat.dm.*`, `chat.moderation.*`, `chat.tts.*`, `chat.call.*`

Events: ``chat.message.created|deleted``, ``chat.room.updated``, ``chat.call.*``, ``chat.tts.queued|played|failed``

## Depends on

- OpenVibe.Network
- OpenVibe.Events
- OpenVibe.Media
- OpenVibe.Contracts

## Acceptance (must be true before "done")

- stream/global/DM histories preserved on import; old Live URLs and WS messages keep working through the adapter
- restart Live without losing Chat; restart Chat's delivery plane and resume persisted messages
- a call row without a working signalling/media path is not parity
- a paid TTS request is never duplicated by a retry

## Bootstrap / extraction source

Live's chat, DM, TTS, soundboard and WebRTC call modules, imported with stable legacy IDs.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
