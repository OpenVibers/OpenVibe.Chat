'use strict';
/**
 * Vibe on openvibe.chat's front page (server/web/pages.js, home.js vibeSection; plan track K: "turn openvibe.chat into
 * the main chat app"): the hero's first action is Chat with Vibe, an Ask Vibe box opens /vibe with the question in its
 * box (never sent for the person), and the questions answer what Vibe is (in the page's FAQ JSON-LD too).
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('home vibe');
let h;

t('boot', async () => { h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } }); });

t('the front page leads to Vibe: the first action, an Ask Vibe box, the question in the FAQ', async () => {
    const page = await fetch(`${h.base}/`).then((r) => r.text());
    assert.match(page, /<p class="oc-hero-actions"><a class="oc-button" href="\/vibe">Chat with Vibe<\/a> /, 'the first action');
    assert.match(page, /<form class="oc-vibe-ask" action="\/vibe" method="get" role="search"><label for="oc-vibe-q" class="oc-sr">Ask Vibe<\/label><input id="oc-vibe-q" name="ask" /);
    assert.ok(page.indexOf('oc-vibe-card') < page.indexOf('id="oc-h">Global chat'), 'before global chat');
    assert.match(page, /<summary>What is Vibe\?<\/summary>/);
    assert.match(page, /"name":"What is Vibe\?"/, 'in the FAQ JSON-LD');
    assert.match(page, /<summary>Can Vibe use my own model\?<\/summary>/, 'your own key or computer (AI on your own machines)');
    assert.ok(page.includes('a model on your own computer (Ollama, LM Studio or llama.cpp through the OpenVibe Node'));
});

t('the box opens Vibe with the question in it, signed out too', async () => {
    const vibe = await fetch(`${h.base}/vibe?ask=${encodeURIComponent('Plan a picnic for six')}`).then((r) => r.text());
    assert.match(vibe, /<textarea id="vb-input"[^>]*>Plan a picnic for six<\/textarea>/);
});

t.run(async () => { if (h && h.close) await h.close(); });
