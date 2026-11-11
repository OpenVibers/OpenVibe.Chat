#!/usr/bin/env node
'use strict';
/**
 * Screenshot the Chat V2/V3 app shell for PR #432.
 *
 * Usage: node /tmp/ov-chat-shots.js
 * Outputs 20 PNGs to ~/openvibe/research-2026-11-09/chat/shots/:
 *   home, server-channel, members, explore, start-sheet
 *   each at 390/1280 in dark/light.
 *
 * The harness boots Chat on a fresh PGlite dir, seeds a server + DMs,
 * then Playwright opens the pages with a signed-in cookie.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const shotsDir = path.join(os.homedir(), 'openvibe/research-2026-11-09/chat/shots');
fs.mkdirSync(shotsDir, { recursive: true });

const chromium = (() => {
    try { return require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright').chromium; } catch { return null; }
})();
if (!chromium || !fs.existsSync('/usr/bin/google-chrome')) {
    console.error('Chrome or Playwright unavailable');
    process.exit(1);
}

(async () => {
    // Use a fresh PGlite dir so the "up to 5 servers" limit never trips.
    const pgliteDir = path.join(os.tmpdir(), 'ov-chat-shots-pglite');
    fs.rmSync(pgliteDir, { recursive: true, force: true });
    fs.mkdirSync(pgliteDir, { recursive: true });
    process.env.CHAT_PGLITE_DIR = pgliteDir;

    const { boot } = require('../test/helpers');
    const { ids } = require('openvibe-contracts');
    const h = await boot();
    const dee = h.addUser('dee', { subject: ids.newId('user') });
    const bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [dee, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));

    // Seed a public server with text + voice channels and a message.
    const api = (method, p, u, body) => h.http(method, `/api/chat/servers${p}`, { token: u && u.token, body });
    const made = await api('POST', '/', dee, { name: 'Saturday Raiders', description: 'Raids on Saturdays' });
    const slug = made.body.server.slug;
    await api('POST', `/${slug}/channels`, dee, { name: 'planning' });
    await api('POST', `/${slug}/channels`, dee, { name: 'Lounge', kind: 'voice' });
    await api('POST', `/${slug}/join`, bob);
    await h.http('POST', `/s/${slug}/planning`, { token: dee.token, raw: new URLSearchParams({ message: 'Who is bringing snacks?' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

    // Seed a DM so Home has something in the side column.
    const conv = await h.http('POST', '/api/dm/conversations', { token: dee.token, body: { user_ids: [bob.id] } });
    const convId = conv.body.conversation.id;
    await h.http('POST', `/api/dm/conversations/${convId}/messages`, { token: dee.token, body: { message: 'Saturday?' } });

    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });

    async function shot(name, url, { width, members = false, startSheet = false } = {}) {
        for (const theme of ['dark', 'light']) {
            const page = await browser.newPage({ viewport: { width, height: width <= 760 ? 844 : 900 } });
            await page.context().addCookies([
                { name: 'ov_token', value: dee.token, url: h.base },
                { name: 'ov_theme', value: theme, url: h.base },
            ]);
            await page.goto(`${h.base}${url}`, { waitUntil: 'networkidle' });
            if (startSheet) {
                await page.evaluate(() => {
                    const sheet = document.getElementById('oc-new-server');
                    if (sheet) sheet.open = true;
                });
                await page.waitForTimeout(200);
            }
            if (members && width > 760) {
                await page.evaluate(() => {
                    const app = document.querySelector('[data-oc-app]');
                    if (app) app.setAttribute('data-oc-panel', 'members');
                });
                await page.waitForTimeout(200);
            }
            const out = path.join(shotsDir, `${name}-${width}-${theme}.png`);
            await page.screenshot({ path: out, fullPage: false });
            console.log(out);
            await page.close();
        }
    }

    await shot('home', '/messages', { width: 390 });
    await shot('home', '/messages', { width: 1280 });
    await shot('server-channel', `/s/${slug}/planning`, { width: 390 });
    await shot('server-channel', `/s/${slug}/planning`, { width: 1280 });
    await shot('members', `/s/${slug}/planning`, { width: 390, members: true });
    await shot('members', `/s/${slug}/planning`, { width: 1280, members: true });
    await shot('explore', '/servers', { width: 390 });
    await shot('explore', '/servers', { width: 1280 });
    await shot('start-sheet', '/servers#oc-new-server', { width: 390, startSheet: true });
    await shot('start-sheet', '/servers#oc-new-server', { width: 1280, startSheet: true });

    await browser.close();
    await h.close();
    process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
