'use strict';
/**
 * openvibe.chat/developers: one page for everyone building on OpenVibe Chat (docs/platform.md, the owner 2026-10-24:
 * "fully modular and SDK and API"): the tag for a support inbox or a room, verified visitors, a panel of your own,
 * feeds from Claude Code or anything, acting as a person with the SDK, webhooks, and the limits. Public and indexed.
 */
const { esc } = require('./layout');

const code = (s) => `<pre class="ib-snippet" tabindex="0"><code>${esc(s)}</code></pre>`;

function body(base) {
    return `<h1>Build with OpenVibe Chat</h1>
<p class="oc-lead">One chat system, from a private chat with Vibe to a chat bubble on your website. Everything here is open: a tag for any site, a REST API and socket, the <code>openvibe-sdk/chat</code> package, and signed webhooks. Free to use; open source.</p>
<nav class="oc-toc" aria-label="On this page"><a href="#widget">Chat on your site</a> · <a href="#verified">Verified visitors</a> · <a href="#panel">Your own panel</a> · <a href="#feeds">Feeds from Claude Code</a> · <a href="#sdk">The SDK</a> · <a href="#webhooks">Webhooks</a> · <a href="#limits">Limits</a></nav>

<h2 id="widget">Chat on your site</h2>
<p>A <strong>support inbox</strong>: make one at <a href="/inbox">openvibe.chat/inbox</a>, then add one line before <code>&lt;/body&gt;</code>. Vibe answers first from your instructions and pages; visitors can ask for a person, and your team answers from the inbox (or turn people off for a site assistant).</p>
${code(`<script src="${base}/widget.js" data-inbox="inb_…" async></script>`)}
<p>A <strong>public room</strong>, as a bubble or inside your page. Anyone reads; people sign in with OpenVibe to write, and the room's moderation applies.</p>
${code(`<script src="${base}/widget.js" data-room="your-room" async></script>
<script src="${base}/widget.js" data-room="your-room" data-target="#chat" data-height="520" async></script>`)}
<p>Options: <code>data-position="left"</code>, <code>data-color="#ff7a1a"</code>, <code>data-open="1"</code>. From your page: <code>OpenVibeChat.open()</code>, <code>.close()</code>, <code>.toggle()</code>, <code>.identify(user)</code>; it says what happens with the events <code>openvibechat:open</code>, <code>openvibechat:close</code> and <code>openvibechat:message</code> on <code>window</code>. The panel runs on openvibe.chat's own origin, in a frame your site's CSS cannot reach; an inbox's allowed sites decide who may frame it.</p>

<h2 id="verified">Verified visitors</h2>
<p>When your site has its own accounts, turn on verified visitors in the inbox's settings and keep its secret on your server. For a signed-in visitor, sign their id; your team then sees their verified name and email, and their conversation follows them to every device.</p>
${code(`// Node
const hash = crypto.createHmac('sha256', SECRET).update(String(user.id)).digest('hex');
// in the page
<script src="${base}/widget.js" data-inbox="inb_…" data-user-id="42" data-user-name="Dana Lee"
        data-user-email="dana@example.com" data-user-hash="…" async></script>`)}

<h2 id="panel">Your own panel</h2>
<p>The visitor API answers any site with no cookies: the visitor's token is the key. Build your own chat UI on it, in the browser or on your server.</p>
${code(`import { createClient } from 'openvibe-sdk';
import { createInboxVisitor } from 'openvibe-sdk/chat';

const visitor = createInboxVisitor(createClient(), { inbox: 'inb_…', token: localStorage.getItem('chat') });
const { token, conversation, messages } = await visitor.visit();   // keep the token: it is the visitor
localStorage.setItem('chat', token);
await visitor.send('Where is my order?', { page_url: location.href });
const { messages: next } = await visitor.messages({ after: lastId });
await visitor.handoff();          // "Talk to a person"
await visitor.rate(1, { comment: 'Quick!' });`)}
<p>Over HTTP: <code>GET ${esc(base)}/api/chat/widget/inbox/:id</code>, <code>POST …/visit</code>, <code>GET|POST …/messages</code>, <code>POST …/handoff</code>, <code>POST …/rating</code>.</p>

<h2 id="feeds">Feeds from Claude Code (or anything)</h2>
<p>Show what you are building, live: in a room, on your OpenVibe Live channel while you stream, or on your own site. Make a feed at <a href="/feeds">openvibe.chat/feeds</a>; it gives you a key and this block for <code>.claude/settings.json</code>, Claude Code's own <code>http</code> hooks (no extension). Secrets and home folders are wiped before anyone sees a step.</p>
${code(`{ "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "http",
    "url": "${base}/api/chat/feeds/fed_…/hooks/claude-code",
    "headers": { "Authorization": "Bearer $OPENVIBE_FEED_KEY" }, "allowedEnvVars": ["OPENVIBE_FEED_KEY"] }] }],
  "PostToolUse": […the same…], "Stop": […], "SessionStart": […], "SessionEnd": […] } }`)}
<p>From anything else, with the same key:</p>
${code(`import { createFeedPublisher } from 'openvibe-sdk/chat';
const feed = createFeedPublisher(createClient(), { feed: 'fed_…', key });
await feed.publish({ eventType: 'prompt', text: 'Add a dark mode' });
await feed.publish([{ eventId: 'e1', eventType: 'tool.call', summary: 'Ran the tests', tool: { name: 'Bash' } }]);`)}
<p>On any page: <code>&lt;iframe src="${esc(base)}/embed/feed/fed_…" style="width:100%;height:320px;border:0"&gt;&lt;/iframe&gt;</code></p>

<h2 id="sdk">The SDK: act as a person or a bot</h2>
<p>With a person's sign-in or an OpenVibe API token, <code>createChatClient</code> covers global chat, rooms, direct messages, Vibe, inboxes (conversations, replies, saved replies, verified visitors, webhooks) and feeds.</p>
${code(`npm install openvibe-sdk

import { createClient } from 'openvibe-sdk';
import { createChatClient } from 'openvibe-sdk/chat';
const chat = createChatClient(createClient({ token: process.env.OPENVIBE_TOKEN }));

const { conversations } = await chat.inboxes.conversations('inb_…', { status: 'waiting' });
await chat.inboxes.reply('inb_…', conversations[0].id, 'Hi! I can help with that.');
await chat.rooms.send('builders', 'Shipping now');`)}
<p>Live delivery is the chat socket, <code>wss://openvibe.chat/ws/chat</code>: <code>join_room</code>, <code>inbox_watch</code> and <code>feed_watch</code>.</p>

<h2 id="webhooks">Webhooks</h2>
<p>An inbox's owner adds up to three https addresses. A Slack or Discord webhook gets a line when a visitor waits for a person, writes while waiting, or rates a conversation. Any other address gets every event as JSON, signed like OpenVibe.Events deliveries: <code>chat.inbox.conversation.created</code>, <code>.waiting</code>, <code>.resolved</code>, <code>.rated</code> and <code>chat.inbox.message.created</code>.</p>
${code(`import { parseDelivery } from 'openvibe-sdk/events';

app.post('/hooks/openvibe', express.raw({ type: 'application/json' }), (req, res) => {
    const d = parseDelivery(req.body, req.headers, process.env.WEBHOOK_SECRET, { requireV2: true });
    if (!d) return res.sendStatus(401);
    if (d.event.type === 'chat.inbox.conversation.waiting') page(d.event.data.conversation);
    res.sendStatus(204);
});`)}

<h2 id="limits">Limits</h2>
<table class="oc-table"><thead><tr><th>What</th><th>Limit</th></tr></thead><tbody>
<tr><td>Visitor writes (one address)</td><td>20 a minute</td></tr>
<tr><td>Vibe's answers in an inbox</td><td>30 a conversation, 500 an inbox a day</td></tr>
<tr><td>Inboxes, people, saved replies, webhooks</td><td>10 a person; 50 people, 100 saved replies and 3 webhooks an inbox</td></tr>
<tr><td>Feed events</td><td>600 a minute a feed (a batch of 50 is one request); a feed keeps its newest 5,000</td></tr>
<tr><td>Feeds</td><td>10 a person</td></tr>
</tbody></table>
<p class="oc-muted">The full reference is Chat's README on GitHub (<a href="https://github.com/OpenVibers/OpenVibe.Chat#support-inboxes-and-the-website-widget-openvibechatinbox">support inboxes</a>, <a href="https://github.com/OpenVibers/OpenVibe.Chat#feeds-vibe-coding-live-openvibechatfeeds">feeds</a>); the whole platform's building blocks are on <a href="https://openvibe.services">openvibe.services</a>.</p>`;
}

function mountDeveloperPages(router, { page, config }) {
    router.get('/developers', async (req, res) => await page(req, res, 200, {
        title: 'Build with OpenVibe Chat', path: '/developers', robots: 'index, follow',
        description: 'Add a support inbox or a chat room to any website with one tag, build your own panel on the open API, show Claude Code sessions live with feeds, and hear events through signed webhooks.',
        body: body(config.web.baseUrl),
    }));
}

module.exports = { mountDeveloperPages };
