'use strict';
/**
 * openvibe.chat/developers (server/web/developer-pages.js): one public, indexed page for builders: the tags for an
 * inbox and a room, verified visitors, a panel of your own, feeds from Claude Code, the SDK, webhooks and the limits,
 * with every code sample escaped; the sitemap and llms.txt name it.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('developers page');
const SITE = 'https://openvibe.chat';
let h;

t('boot', async () => { h = await boot({ env: { CHAT_WEB_URL: SITE } }); });

t('the page: every way to build on Chat, its samples escaped, indexed', async () => {
    const r = await fetch(`${h.base}/developers`);
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('<h1>Build with OpenVibe Chat</h1>') && /<meta name="robots" content="index, follow"/.test(html));
    const wants = ['data-inbox=&quot;inb_…&quot;', 'data-room=&quot;your-room&quot;', 'data-user-hash', 'createInboxVisitor', '/hooks/claude-code', 'createFeedPublisher', 'createChatClient', 'parseDelivery', 'chat.inbox.conversation.waiting'];
    const missing = wants.filter((w) => !html.includes(w));
    assert.deepStrictEqual(missing, [], 'the page shows every sample');
    assert.ok(!/<script src="https:\/\/openvibe\.chat\/widget\.js"/.test(html), 'the tags are shown, not run');
    assert.ok(html.includes('href="/inbox"') && html.includes('href="/feeds"'));
});

t('search engines and AI crawlers find it', async () => {
    assert.ok((await (await fetch(`${h.base}/sitemap.xml`)).text()).includes(`${SITE}/developers`));
    assert.ok((await (await fetch(`${h.base}/llms.txt`)).text()).includes(`${SITE}/developers`));
});

t.run(async () => { if (h && h.close) await h.close(); });
