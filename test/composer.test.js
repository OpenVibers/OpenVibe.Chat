'use strict';
// The Chat composer on the shared one (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset chat): a room or
// conversation's form keeps its action, its Add button and its no-JS post; the words and Send become the shared
// box. Real Chrome at 390 px; skipped without Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('composer: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const SHARED = process.env.OV_SHARED_DIR || path.join(__dirname, '..', 'node_modules', 'openvibe-shared');
const SITE = path.join(__dirname, '..');
const form = `<div class="oc-dock has-add"><form class="oc-compose" method="post" action="/r/test" id="oc-compose" data-ovc-compose data-ovc-preset="chat"><label for="oc-input" class="oc-sr">Message</label>
<div class="oc-compose-box"><div class="oc-compose-tray" data-oc-tray hidden></div><div class="oc-compose-row"><button type="button" class="oc-compose-add" data-oc-attach aria-label="Add a picture">+</button><textarea id="oc-input" name="message" maxlength="500" rows="1" required placeholder="Write a message"></textarea><button type="submit" class="oc-send" aria-label="Send">Send</button></div></div></form></div>`;
let posted = '';
const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => { posted = body; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><p id="posted">posted</p>'); });
        return;
    }
    if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat</title><link rel="icon" href="data:,"></head><body style="margin:0;padding:12px;background:#0b1220;color:#e6edf7;font-family:sans-serif">${form}<script src="/ov-composer.js"></script><script src="/composer.js"></script></body></html>`);
    }
    if (req.url === '/ov-composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SHARED, 'ov-composer.js'))); }
    if (req.url === '/composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SITE, 'public/web/composer.js'))); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-composer-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = await h.openPage(browser, await browser.newContext(), { width: 390, height: 900 });
    try {
        await page.goto(base + '/', { maxMs: 6000 });
        for (let i = 0; i < 100 && !(await page.evaluate(`!!document.querySelector('form.ovc-v2')`)); i++) await wait(40);
        const shape = await page.evaluate(`(() => { const f = document.querySelector('#oc-compose'); return { preset: f.dataset.preset, cls: f.className, action: f.getAttribute('action'), text: !!f.querySelector('#oc-input[data-ovt-text]'), add: !!f.querySelector('.ovt-c-tools [data-oc-attach]'), send: f.querySelector('[data-ovt-send]').getAttribute('aria-label'), box: !!f.querySelector('.oc-compose-box') }; })()`);
        assert.deepEqual(shape, { preset: 'chat', cls: 'oc-compose ovt-composer ovc-v2', action: '/r/test', text: true, add: true, send: 'Send', box: false });
        assert.equal(await page.evaluate(`document.documentElement.scrollWidth`), 390, 'nothing is wider than a phone');
        await page.evaluate(`(() => { const t = document.querySelector('#oc-input'); t.value = 'Hello room'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#oc-compose [data-ovt-send]').click(); })()`);
        for (let i = 0; i < 100 && !posted; i++) await wait(40);
        assert.match(posted, /message=Hello\+room/, 'the form still posts its message');
        console.log('composer: the room box is the shared chat composer, keeps Add and its action, sends, 390 px');
    } finally {
        await page.close().catch(() => {});
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
