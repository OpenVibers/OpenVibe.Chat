'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) {
    console.log('widget-sheet-chrome: skipped (no Chrome)');
    process.exit(0);
}
const widget = fs.readFileSync(path.join(__dirname, '..', 'public/web/widget.js'));
const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eef1f6}main{height:1800px}</style><main>Host page</main><script src="/widget.js" data-room="general"></script>';
const server = http.createServer((req, res) => {
    if (req.url === '/widget.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(widget); }
    if (req.url && req.url.startsWith('/embed/room/general')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><main style="height:1800px;background:#141b2d;color:white">Chat messages</main>'); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-widget-sheet-'));
    const browser = await h.launch({ tmpDir: tmp });
    try {
        const context = await browser.newContext();
        for (const width of [390, 1280]) {
            const p = await h.openPage(browser, context, { width, height: 900 });
            await p.goto(`http://127.0.0.1:${server.address().port}/`, { maxMs: 5000 });
            await p.evaluate('scrollTo(0,400);window.__before=scrollY;document.querySelector("[data-openvibe-chat]").shadowRoot.querySelector(".b").click()');
            await new Promise((ok) => setTimeout(ok, 200));
            if (width === 390) {
                assert.strictEqual(await p.evaluate('document.body.style.position'), 'fixed', 'phone page is locked');
                assert.strictEqual(await p.evaluate('document.body.style.top'), await p.evaluate('`${-__before}px`'), 'phone keeps its position');
                assert.strictEqual(await p.evaluate('document.querySelector("[data-openvibe-chat]").shadowRoot.querySelector(".p").getAttribute("aria-modal")'), 'true', 'phone chat is modal');
                assert.strictEqual(await p.evaluate('document.activeElement.shadowRoot?.activeElement?.getAttribute("aria-label")'), 'Close chat', 'focus moves into the phone panel');
            } else assert.strictEqual(await p.evaluate('document.body.style.position'), '', 'desktop panel leaves page usable');
            if (process.env.OV_SHEETS_SHOTS) {
                fs.mkdirSync(process.env.OV_SHEETS_SHOTS, { recursive: true });
                const shot = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                fs.writeFileSync(path.join(process.env.OV_SHEETS_SHOTS, `chat-widget-${width}.png`), Buffer.from(shot.data, 'base64'));
            }
            if (width === 390) {
                await p.evaluate(`(() => {const head=document.querySelector('[data-openvibe-chat]').shadowRoot.querySelector('.h');
                    const fire=(type,y)=>head.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',pointerId:4,clientY:y}));
                    fire('pointerdown',200);fire('pointermove',320);fire('pointerup',320);})()`);
                assert.strictEqual(await p.evaluate('document.body.style.position'), '', 'header swipe unlocks page');
                assert.strictEqual(await p.evaluate('Math.round(scrollY)'), await p.evaluate('Math.round(__before)'), 'close restores scroll position');
                assert.strictEqual(await p.evaluate('document.activeElement.shadowRoot?.activeElement?.className'), 'b', 'focus returns to chat button');
            } else {
                await p.evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true}))');
                assert.strictEqual(await p.evaluate('document.querySelector("[data-openvibe-chat]").shadowRoot.querySelector(".p").classList.contains("on")'), false, 'outside pointer closes desktop chat');
            }
            await p.close();
        }
        console.log('widget-sheet-chrome: phone scroll, swipe, focus and desktop outside close ok');
    } finally { await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
