'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright')); } catch { /* optional browser harness */ }
if (!chromium || !fs.existsSync('/usr/bin/google-chrome')) { console.log('agent-run card Chrome: skipped (Chrome unavailable)'); process.exit(0); }

const id = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const url = `https://openvibe.network/api/frame/agent-runs/actor/${id}`;
const shared = path.dirname(require.resolve('openvibe-shared/agent-session'));
const server = http.createServer((req, res) => {
    const file = req.url === '/shared/agent-session.js' ? path.join(shared, 'agent-session.js')
        : req.url === '/shared/agent-session.css' ? path.join(shared, 'agent-session.css')
            : req.url === '/agent-run-card.js' ? path.join(__dirname, '../public/web/agent-run-card.js') : null;
    if (file) { res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'application/javascript' }); return fs.createReadStream(file).pipe(res); }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'ov_token=test-bearer; Path=/' });
    res.end(`<!doctype html><html><head><script src="/agent-run-card.js" defer></script></head><body><div class="oc-agent-run" data-ov-run-url="${url}" data-ov-events-url="${url}/events" data-ov-run-title="Read the sources"><a href="https://openvibe.actor/tasks/${id}">Read the sources</a></div></body></html>`);
});

(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
        const seen = [], errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('https://openvibe.network/api/frame/agent-runs/actor/**', async (route) => {
            seen.push({ url: route.request().url(), auth: route.request().headers().authorization, last: route.request().headers()['last-event-id'] });
            if (!route.request().url().endsWith('/events')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ title: 'Read the sources', status: 'running' }) });
            return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,last-event-id' }, body: 'id: 1\nevent: STEP_STARTED\ndata: {"type":"STEP_STARTED","stepName":"read","metadata":{"ov":{"title":"Read the sources"}}}\n\n' });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
        await page.locator('.ovas--card').waitFor();
        await page.getByText('Read the sources').first().waitFor();
        assert.ok(seen.some((r) => r.url.endsWith('/events') && r.auth === 'Bearer test-bearer' && r.last === '0'));
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
        await page.close();
        console.log('agent-run card Chrome: owner stream rendered at 390 px, Last-Event-ID 0, no page errors');
    } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error(e); server.close(); process.exitCode = 1; });
