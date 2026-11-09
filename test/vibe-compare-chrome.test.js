'use strict';
/** A phone can choose three models without a sideways page or a fourth selection. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let chromium;
try { ({ chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright')); } catch { /* optional browser harness */ }
const t = suite('vibe compare Chrome');
if (!chromium || !fs.existsSync('/usr/bin/google-chrome')) { console.log('vibe compare Chrome: skipped (Chrome unavailable)'); process.exit(0); }
let h, browser, user;
t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    user = h.addUser('browser', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(user.id));
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
});
t('the sheet caps Compare at three and a 390 px page does not scroll sideways', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.context().addCookies([{ name: 'ov_token', value: user.token, url: h.base }]);
    await page.route('**/api/vibe/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [
        { slug: 'maker/one', name: 'One', family: 'Maker' }, { slug: 'maker/two', name: 'Two', family: 'Maker' },
        { slug: 'maker/three', name: 'Three', family: 'Maker' }, { slug: 'maker/four', name: 'Four', family: 'Maker' },
    ] }) }));
    await page.goto(h.base + '/vibe', { waitUntil: 'load' });
    await page.locator('#vb-model-chip').click();
    await page.locator('#vb-model-compare').check();
    for (const name of ['One', 'Two', 'Three', 'Four']) await page.getByRole('button', { name, exact: true }).click();
    assert.equal(await page.locator('#vb-model-chip').innerText(), '3 models ▾');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.close();
});
t('done', async () => { await browser.close(); await h.close(); });
t.run();
