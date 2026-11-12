'use strict';
/**
 * A message's actions are one cluster at its corner (openvibe.design rule 138): edit and delete on your own rows,
 * edit in the room's shared composer, "edited" after the words, and no Edit pill, window.prompt or window.alert.
 * A real Chrome at 390 px; skipped without Chrome.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { boot } = require('./helpers');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('chat actions: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const chatJs = fs.readFileSync(path.join(ROOT, 'public/web/chat.js'), 'utf8');
const vibeJs = fs.readFileSync(path.join(ROOT, 'public/web/vibe.js'), 'utf8');
const pages = fs.readFileSync(path.join(ROOT, 'server/web/pages.js'), 'utf8');
const vibePages = fs.readFileSync(path.join(ROOT, 'server/web/vibe-pages.js'), 'utf8');
assert.ok(!/window\.prompt\s*\(|window\.alert\s*\(/.test(chatJs), 'Chat edits never prompt or alert');
assert.ok(!/window\.prompt\s*\(|window\.alert\s*\(/.test(vibeJs), 'Vibe edits never prompt or alert');
assert.ok(!/['"]oc-edit['"]/.test(chatJs), 'no Edit pill in the chat client');
assert.ok(!/['"]vb-edit['"]/.test(vibeJs) && !/vb-edit['"]/.test(vibePages), 'no Edit pill in Vibe');
assert.ok(pages.includes('data-edited-at'), 'the server says when a message was edited');
assert.ok(chatJs.includes('oc-edits-sheet') && !/window\.alert\s*\(/.test(chatJs), 'Earlier versions opens a sheet, not an alert');

(async () => {
    const t = await boot();
    const ann = t.addUser('ann', { subject: ids.newId('user') });
    const bob = t.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await t.ctx.upsertUser(t.live.users.get(u.id));
    const api = (method, p, u, body) => t.http(method, '/api/chat/rooms' + p, { token: u && u.token, body });
    let r = await api('POST', '/', ann, { name: 'Actions Room', topic: 'Rule 138' });
    assert.strictEqual(r.status, 201, r.text);
    await api('POST', '/actions-room/join', bob);
    await api('POST', '/actions-room/messages', bob, { message: 'from bob' });
    r = await api('POST', '/actions-room/messages', ann, { message: 'from me' });
    assert.strictEqual(r.status, 201, r.text);
    const mineId = r.body.message.id;
    const patched = await t.http('PATCH', '/api/chat/rooms/actions-room/messages/' + mineId, { token: ann.token, body: { message: 'from me' } });
    assert.strictEqual(patched.status, 200, 'the API saves an edit');

    let ok = false;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-actions-'));
    const browser = await h.launch({ tmpDir: tmp });
    const page = await h.openPage(browser, await browser.newContext(), { width: 390, height: 900 });
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await page.evaluate(expr); if (v) return v; await wait(50); } return false; };
    try {
        await page.send('Network.setCookie', { name: 'ov_token', value: ann.token, domain: '127.0.0.1', path: '/', httpOnly: false });
        await page.goto(`${t.base}/r/actions-room`, { maxMs: 10000 });
        assert.ok(await until(`document.querySelectorAll('#oc-feed [data-id]').length >= 2`), 'the room rows are there');
        assert.ok(await until(`!!document.querySelector('#oc-feed [data-id="${mineId}"] .ovm-act-edit')`), 'my row has the edit action');
        const shape = await page.evaluate(`(() => { const mine = document.querySelector('#oc-feed [data-id="${mineId}"]'), other = [...document.querySelectorAll('#oc-feed [data-id]')].find((x) => x.dataset.id !== '${mineId}'); return { mine: [...mine.querySelectorAll('.ovm-act')].map((b) => b.dataset.action), other: other ? [...other.querySelectorAll('.ovm-act')].map((b) => b.dataset.action) : null, pill: !!document.querySelector('.oc-edit, .ovk-btn.oc-edit') }; })()`);
        assert.deepStrictEqual(shape.mine, ['edit', 'delete'], 'my own row: edit and delete in one cluster');
        assert.deepStrictEqual(shape.other, [], 'another person\'s row has no edit');
        assert.strictEqual(shape.pill, false, 'no Edit pill');
        // A tap on a phone shows the cluster (rule 138: hover on a computer, a tap on a phone).
        await page.evaluate(`document.querySelector('#oc-feed [data-id="${mineId}"] .oc-text').click()`);
        assert.ok(await until(`document.querySelector('#oc-feed [data-id="${mineId}"]').classList.contains('is-acting')`), 'a tap shows the actions');
        // Edit in the box: the bar, the words, the send as a check.
        await page.evaluate(`document.querySelector('#oc-feed [data-id="${mineId}"] .ovm-act-edit').click()`);
        assert.ok(await until(`document.querySelector('.oc-compose, form.ovc-v2') && document.querySelector('.ovc-v2').classList.contains('is-editing')`), 'the box is editing');
        const editShape = await page.evaluate(`(() => { const f = document.querySelector('form.ovc-v2'); return { bar: f.querySelector('.ovc-bar b').textContent, value: f.querySelector('textarea').value, send: f.querySelector('[data-ovt-send]').getAttribute('aria-label') }; })()`);
        assert.deepStrictEqual(editShape, { bar: 'Editing your message', value: 'from me', send: 'Save' });
        // The browser's own PATCH would be cross-origin in this test (the page is on 127.0.0.1, the site is
        // openvibe.chat), so the client answers with the API's message shape; the real API was exercised above.
        await page.evaluate(`(() => { const real = window.fetch; window.fetch = function (url, opts) { if (opts && opts.method === 'PATCH') return Promise.resolve(new Response(JSON.stringify({ message: { id: ${mineId}, message: 'edited once', edited_at: new Date().toISOString() } }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real.apply(this, arguments); }; const t = document.querySelector('form.ovc-v2 textarea'); t.value = 'edited once'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('form.ovc-v2 [data-ovt-send]').click(); })()`);
        assert.ok(await until(`document.querySelector('#oc-feed [data-id="${mineId}"] .oc-text').textContent === 'edited once'`), 'the message shows the new words');
        const mark = await page.evaluate(`(() => { const t = document.querySelector('#oc-feed [data-id="${mineId}"] .oc-text'); const m = t.nextElementSibling; return m && m.classList.contains('ovm-edited') ? m.textContent : null; })()`);
        assert.strictEqual(mark, 'edited', '"edited" is the quiet word right after the words');
        assert.strictEqual(await page.evaluate(`document.documentElement.scrollWidth`), 390, 'nothing is wider than a phone');
        ok = true;
        console.log('chat actions: one cluster on own rows, tap to act, edit in the box, edited after the words, 390 px');
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
        await Promise.race([t.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
        fs.rmSync(tmp, { recursive: true, force: true });
        if (ok) process.exit(0);
    }
})().catch((e) => { console.error(e); process.exit(1); });
