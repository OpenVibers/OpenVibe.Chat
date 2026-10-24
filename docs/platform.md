# OpenVibe Chat as a platform: every conversation, on any website

The owner, 2026-10-24: "make open vibe chat more like a multi-purpose full AI supported chat system that you can use
across any website, with rich support for attaching images, videos, files, a full AI assistant, multi-user support, one
global system that handles it all, from your private conversations to your random live chat widget on websites… a
product both for consumers and enterprises… the support box… the DM style system which can be used for direct live
support with an agent… the global chat type system and other use cases too… fully modular and SDK and API". Also: move
Live's vibe coding feed into Chat and improve it.

## What the market does (October 2026)

| Product | Strength | Gap we close |
|---|---|---|
| Intercom (Fin AI agent) | The strongest AI deflection; procedures; voice; handoff after a request, frustration or a three-turn loop | $0.99 per resolution on top of seats; closed; one inbox per company, nothing for the visitor |
| Crisp | Flat price, co-browsing (MagicBrowse, visitor permission first), LLM translation, knowledge base | AI limited; no community rooms |
| Chatwoot | Open source (MIT), shared inbox for chat, email, WhatsApp; self-hosted | Needs engineers; no consumer side, no creator side |
| Stream, Sendbird | Chat APIs and SDKs for apps | Priced per MAU (Sendbird from ~$399/month), no product of their own for people |
| RumbleTalk, Roomlio, Chatango | A group chat room embedded on any page, moderation | No support inbox, no AI assistant, separate accounts |

Sources: comparisons on featurebase.app, abmatic.ai, eesel.ai, wonderchat.io (handoff), Crisp's April 2026 update and help
center (MagicBrowse privacy), getstream.io (Stream vs Sendbird), rumbletalk.com, alternativeto.net (Roomlio).

## What OpenVibe Chat is

**One conversation engine, three faces**, each a module behind the same API, SDK and socket:

1. **For people** (openvibe.chat): Vibe, OpenVibe's assistant (`/vibe`), direct messages, rooms with AI members,
   servers with voice, the global room and stream chat. One OpenVibe account.
2. **For any website** (`<script src="https://openvibe.chat/widget.js" data-…>`), one tag with three modes:
   - **Support inbox**: a team's inbox. A visitor writes; Vibe answers first from the team's own instructions and pages
     (with sources, never inventing), and hands off to a person on request ("Talk to a person") or when it cannot help.
     Agents answer from openvibe.chat/inbox; offline, the visitor is told when people are back.
   - **Community room**: a room, server channel or stream chat embedded inline or as a bubble, with OpenVibe's global
     moderation standard and AI members.
   - **Site assistant**: Vibe alone, answering from the site's pages.
3. **For developers** (openvibe.services): REST + WebSocket, the SDK (`openvibe-sdk/chat`), webhooks through
   OpenVibe.Events, bots, and **feeds**: structured live activity cards in any room (vibe coding is the first feed type:
   an editor or agent publishes sanitized prompts, responses, tool calls and file events; viewers see a compact card).

**What nobody else does:**
- **One identity everywhere.** A signed-in visitor is recognised on every site's widget, and their conversations with every
  site land in their own Messages: the visitor finally has an inbox too.
- **Live-native.** A streamer's support inbox and their stream chat embed on their own site; fans get answers from the
  creator or Vibe; a stream's vibe coding feed is a Chat feed any room can show.
- **Rich media by default**: pictures (OpenVibe.Pics), video (OpenVibe.Video), files (OpenVibe.Download), voice and video
  calls and screen share from Chat's own WebRTC, for support as well as friends.
- **Open, at cost**: open source, a free tier, bring-your-own model key (OpenVibe.AI credentials) instead of a fee per
  resolution, self-hostable.

## Order of work

1. **Support inbox + widget (first)**: inboxes, agents, visitor conversations, Vibe as first responder with handoff,
   the agent inbox page, `widget.js` + `/embed/inbox/:id`, allowed sites (frame-ancestors), the API.
2. **Feeds**: Live's vibe coding feed moves into Chat as the first feed type (publisher socket, settings, viewer cards in
   any room and in Live's channel chat); Live's tables are copied, verified and dropped (convert-verify-delete).
3. **Community room and site assistant modes** of the widget; pictures, video and files in the embed (signed-in
   visitors first, then anonymous once Pics/Video take anonymous uploads); call escalation from a support conversation.
4. **Developer platform**: capabilities in OpenVibe.Contracts (`chat.inbox.*`, `chat.conversation.*`, `chat.feed.*`),
   `openvibe-sdk/chat`, Events types (`chat.conversation.created`, `.handoff_requested`, `.resolved`), webhooks.
5. **Enterprise**: verified visitor identity (an HMAC of the site's user id, like Intercom's identity verification),
   teams and routing, canned replies, CSAT, retention and export settings, translation, page-context sharing with the
   visitor's permission (co-browsing-lite), procedures (Vibe calls a site's webhook to look up an order).
