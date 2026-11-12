'use strict';
// The composer's command list and server emoji (public/web/chat.js; designed 2026-11-11), in a real headless Chrome on a
// stand-in server channel: "/" lists the server's commands as rows (the name and what it does) above the box; the arrows
// move the mark and Enter takes it; Escape closes; the smiley opens a grid of the server's emoji and a tap puts its
// :name: in the box. Skipped (exit 0) without Chrome or with OV_SKIP_BROWSER=1.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) {
    console.log('composer-commands-chrome: skipped (no Chrome)');
    process.exit(0);
}
const chat = fs.readFileSync(path.join(__dirname, '..', 'public/web/chat.js'));
const css = fs.readFileSync(path.join(__dirname, '..', 'public/web/chat.css'));
const DOT = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="12" fill="gold"/></svg>');
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat.css">
<body class="oc"><main style="padding:300px 16px 16px"><div id="oc-feed"></div>
<form id="oc-compose" class="oc-compose" action="/send" method="post"><textarea id="oc-input" name="text"></textarea><button type="submit">Send</button></form></main>
<script>window.__OV_PAGE = { chat: { commandServer: 'game-night', serverEmojiSlug: 'game-night', serverEmojis: [{ name: 'gg', url: ${JSON.stringify(DOT)} }, { name: 'pog', url: ${JSON.stringify(DOT)} }] } };</script>
<script src="/chat.js"></script>`;
const server = http.createServer((req, res) => {
    if (req.url === '/chat.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(chat); }
    if (req.url === '/chat.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css); }
    if (req.url.startsWith('/api/chat/commands')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ commands: [{ name: 'roll', description: 'Roll a die for everyone' }, { name: 'poll', description: 'Ask the room a question' }] }));
    }
    if (req.url.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-commands-'));
    const browser = await h.launch({ tmpDir: tmp });
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    try {
        const context = await browser.newContext();
        const p = await h.openPage(browser, context, { width: 390, height: 844 });
        await p.goto(`http://127.0.0.1:${server.address().port}/`, { maxMs: 5000 });
        await p.evaluate(`(() => { const i = document.getElementById('oc-input'); i.focus(); i.value = '/'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await wait(500);
        const menu = await p.evaluate(`(() => { const m = document.querySelector('.oc-command-menu'); const r = m.getBoundingClientRect(); const f = document.getElementById('oc-compose').getBoundingClientRect();
            return { shown: !m.hidden, rows: [...m.querySelectorAll('.oc-cmd')].map((b) => b.querySelector('b').textContent + '|' + b.querySelector('span').textContent),
                above: r.bottom <= f.top + 1, marked: (m.querySelector('[aria-selected=true] b') || {}).textContent, small: [...m.querySelectorAll('.oc-cmd')].filter((b) => b.getBoundingClientRect().height < 44).length }; })()`);
        assert.deepStrictEqual(menu, { shown: true, rows: ['/roll|Roll a die for everyone', '/poll|Ask the room a question'], above: true, marked: '/roll', small: 0 });
        // Down, then Enter: the second command goes in the box.
        await p.evaluate(`(() => { const i = document.getElementById('oc-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
        await wait(100);
        assert.deepStrictEqual(await p.evaluate(`({ value: document.getElementById('oc-input').value, hidden: document.querySelector('.oc-command-menu').hidden })`), { value: '/poll ', hidden: true });
        // Escape closes an open list.
        await p.evaluate(`(() => { const i = document.getElementById('oc-input'); i.value = '/'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await wait(500);
        await p.evaluate(`document.getElementById('oc-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        assert.strictEqual(await p.evaluate(`document.querySelector('.oc-command-menu').hidden`), true, 'Escape closes the list');
        // The smiley: a grid of the server's emoji; a tap puts :name: in the box.
        await p.evaluate(`(() => { document.getElementById('oc-input').value = ''; document.querySelector('.oc-emoji-toggle').click(); })()`);
        await wait(200);
        const grid = await p.evaluate(`(() => { const c = [...document.querySelectorAll('.oc-emoji-choice')]; return { n: c.length, labels: c.map((b) => b.getAttribute('aria-label')), tile: Math.round(c[0].getBoundingClientRect().height) }; })()`);
        assert.deepStrictEqual(grid, { n: 2, labels: [':gg:', ':pog:'], tile: 44 });
        await p.evaluate(`document.querySelector('.oc-emoji-choice').click()`);
        assert.strictEqual(await p.evaluate(`document.getElementById('oc-input').value`), ':gg:');
        console.log('composer-commands-chrome: the command list above the box, arrows and Enter, Escape; the emoji grid puts :name: in the box');
    } finally {
        await browser.close();
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
