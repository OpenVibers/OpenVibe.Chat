'use strict';
/**
 * A guest asks Vibe on openvibe.chat/vibe (2026-11-20; the plan's §V.1 guests, the owner's register #801). Signed out,
 * the box said "you will sign in first" and sent the visitor to sign in. In a real Chrome, with openvibe-shared's guest
 * core (ov-guest-ask.js) stood in for:
 *   - a question is answered in the page's own thread (the answer rendered, how many are left, the sign-in link), and
 *     the visitor stays on /vibe;
 *   - the day's limit says so with the sign-in, and the words do not come back to the box;
 *   - with no guest core (an older openvibe-shared), the visitor signs in as before.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { boot, suite } = require('./helpers');
let chromium;
try { ({ chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright')); } catch { /* optional browser harness */ }
const t = suite('vibe guest Chrome');
if (!chromium || !fs.existsSync('/usr/bin/google-chrome')) { console.log('vibe guest Chrome: skipped (Chrome unavailable)'); process.exit(0); }
const STUB = `window.__asks = []; window.OpenVibeGuestAsk = {
  ask: function (text, o) { window.__asks.push([text, o && o.site]);
    if (window.__mode === 'limit') return Promise.reject(Object.assign(new Error("That was today's 3 guest questions. Sign in (free) to ask up to 100 a day."), { status: 429, code: 'guest.limit' }));
    return Promise.resolve({ answer: '**Yes.** Press Go live on openvibe.live.', model: 'cheap', left: 2 }); },
  limited: function (e) { return !!e && (e.status === 429 || e.status === 503); } };`;
let h, browser;
t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: 'https://openvibe.chat' } });
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
});
t('a guest is answered in the thread; the limit says to sign in', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/shared/ov-guest-ask.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
    await page.goto(h.base + '/vibe', { waitUntil: 'load' });
    const box = page.locator('#vb-composer [data-ovt-text]');
    assert.equal(await box.getAttribute('placeholder'), 'Ask Vibe: three free questions a day');
    await box.fill('Can I stream without OBS?');
    await page.locator('#vb-composer [data-ovt-send]').click();
    await page.locator('.vb-guest-note').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.ovt-you .ovt-bubble').last().getAttribute('data-raw'), 'Can I stream without OBS?');
    assert.equal(await page.locator('.ovt-answer strong').first().innerText(), 'Yes.', 'the answer is rendered');
    assert.match(await page.locator('.vb-guest-note').innerText(), /^2 more today as a guest\. Sign in \(free\) for 100 a day$/);
    assert.equal(await page.locator('.vb-guest-signin').getAttribute('href'), '/auth/login?next=%2Fvibe');
    assert.equal(new URL(page.url()).pathname, '/vibe', 'the visitor stays');
    assert.deepEqual(await page.evaluate(() => window.__asks), [['Can I stream without OBS?', 'chat']]);
    assert.equal(await box.inputValue(), '', 'the box is cleared');

    await page.evaluate(() => { window.__mode = 'limit'; });
    await box.fill('And clips?');
    // The send button comes back in with its own motion as the words are typed; the form is sent the way the button
    // sends it (a click at the moment it moves lands on the form).
    await page.evaluate(() => document.getElementById('vb-composer').requestSubmit(document.querySelector('#vb-composer [data-ovt-send]')));
    await page.locator('.vb-guest-note.oc-error').waitFor({ timeout: 5000 });
    assert.match(await page.locator('.vb-guest-note.oc-error').innerText(), /Sign in \(free\) to ask up to 100 a day\. Sign in \(free\)$/);
    assert.equal(await box.inputValue(), '', 'a limit does not put the words back');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.close();
});
t('no guest core (an older openvibe-shared): sign in as before', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('**/shared/ov-guest-ask.js', (route) => route.fulfill({ status: 404, body: '' }));
    await page.route('**/auth/login**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>sign in</p>' }));
    await page.goto(h.base + '/vibe', { waitUntil: 'load' });
    await page.locator('#vb-composer [data-ovt-text]').fill('Hello?');
    await page.locator('#vb-composer [data-ovt-send]').click();
    await page.waitForURL('**/auth/login?next=%2Fvibe', { timeout: 5000 });
    await page.close();
});
t('done', async () => { await browser.close(); await h.close(); });
t.run();
