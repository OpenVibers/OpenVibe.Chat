'use strict';
/**
 * Calls from direct messages on openvibe.chat: a 1:1 conversation's Call button (not in a group, not after a block),
 * POST /messages/:id/call ringing the other person through the call-user route (a `direct` row, then the call page),
 * GET /call/:channel for its caller ("Calling …", with the ring) and the person it invited ("Call with …") and nobody
 * else; ring.js on signed-in pages (Answer → accepted and the call page, Decline, no answer after 30 s, busy while
 * already ringing) and call.js on the caller's page (ringing until the answer: declined, busy or no-answer leave it).
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('dm-calls');
let h, alice, bob, carol, dm, callServer, lifecycle;
const SITE = 'https://openvibe.chat';
const cookie = (u) => ({ cookie: `ov_token=${u.token}` });
const req = async (method, path, { headers = {}, raw } = {}) => {
    const r = await fetch(`${h.base}${path}`, { method, headers, body: raw, redirect: 'manual' });
    return { status: r.status, headers: r.headers, text: await r.text() };
};
const form = (u, fields = {}) => ({ headers: { ...cookie(u), 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, raw: new URLSearchParams(fields).toString() });
const pageJson = (html) => JSON.parse((/window\.__OV_PAGE = (\{.*?\});\n/.exec(html) || [])[1].replace(/\\u003c/g, '<')).chat;

/** A page script in a small fake DOM: elements by id (kept), created nodes, sockets, fetches and timers. */
function runScript(file, page, { docCookie = '', leaveVisible = false } = {}) {
    const byId = {}, created = [], sockets = [], fetches = [], timers = [];
    const node = (id = null) => {
        const n = { id, hidden: id === 'oc-call-leave' ? !leaveVisible : false, disabled: false, textContent: '', className: '', children: [], attrs: {}, handlers: {},
            appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
            addEventListener(ev, fn) { this.handlers[ev] = fn; }, remove() { this.removed = true; }, focus() {}, querySelector: () => null };
        return n;
    };
    function WebSocket(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    WebSocket.prototype.send = function (d) { this.sent.push(JSON.parse(d)); };
    WebSocket.prototype.close = function () { this.closed = true; };
    const location = { protocol: 'https:', host: 'openvibe.chat', href: '' };
    const document = {
        cookie: docCookie, hidden: false, title: 'Messages · OpenVibe.Chat',
        getElementById: (id) => (byId[id] = byId[id] || node(id)),
        createElement: (tag) => { const n = node(); n.tag = tag; created.push(n); return n; },
        createTextNode: (text) => ({ textContent: text }),
        querySelector: (sel) => { if (sel !== '#oc-call-leave:not([hidden])') return null; const n = document.getElementById('oc-call-leave'); return n.hidden ? null : n; },
        addEventListener() {}, body: node('body'),
    };
    function RTCPeerConnection() { this.connectionState = 'new'; }
    RTCPeerConnection.prototype.close = function () {};
    const ctx = {
        window: { __OV_PAGE: { chat: page }, RTCPeerConnection, WebSocket, fetch: true, addEventListener() {} },
        WebSocket, RTCPeerConnection, navigator: {}, location, document, JSON, Number, String, Map, Promise,
        fetch: async (url, opts) => { fetches.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return { ok: true, json: async () => ({}) }; },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].cleared = true; }, setInterval: () => 0,
    };
    require('vm').runInNewContext(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'web', file), 'utf8'), ctx);
    return { byId, created, sockets, fetches, timers, location, document };
}
const tick = () => new Promise((r) => setImmediate(r));

t('boot (CHAT_CALLS=1)', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE, CHAT_CALLS: '1', CALL_RING_TIMEOUT_MS: '60000' } });
    dm = require('../server/chat/dm');
    callServer = require('../server/calls/call-server');
    lifecycle = require('../server/calls/lifecycle');
    alice = h.addUser('alice', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    carol = h.addUser('carol', { subject: ids.newId('user') });
    for (const u of [alice, bob, carol]) { await h.ctx.upsertUser(h.live.users.get(u.id)); h.netModules.subjects.add(u.subject_id); }
    assert.strictEqual(require('../server/config').calls.enabled, true);
});

let conv, channelId;
t('a 1:1 conversation has a Call button; a group or a blocked one has none; signed-in pages load ring.js', async () => {
    conv = await dm.getOrCreateDirect(alice.id, bob.id);
    const page = await req('GET', `/messages/${conv}`, { headers: cookie(alice) });
    assert.strictEqual(page.status, 200);
    assert.match(page.text, new RegExp(`<form class="oc-inline oc-dm-call" method="post" action="/messages/${conv}/call"><button type="submit" class="oc-icon-btn" aria-label="Call Bob"`, 'i'));
    assert.match(page.text, /<script src="\/web\/ring\.js\?v=[^"]+" defer><\/script>/);
    assert.doesNotMatch((await req('GET', '/')).text, /ring\.js/, 'no ring listener for a guest');
    const group = await dm.createConversation(alice.id, [alice.id, bob.id, carol.id], 'Trio');
    assert.doesNotMatch((await req('GET', `/messages/${group}`, { headers: cookie(alice) })).text, /oc-dm-call/);
    const withCarol = await dm.getOrCreateDirect(alice.id, carol.id);
    await dm.blockUser(carol.id, alice.id);
    assert.doesNotMatch((await req('GET', `/messages/${withCarol}`, { headers: cookie(alice) })).text, /oc-dm-call/, 'blocked either way: no call');
    const r = await req('POST', `/messages/${withCarol}/call`, form(alice));
    assert.strictEqual(r.status, 303);
    assert.match(decodeURIComponent(r.headers.get('location')), /\?error=You cannot call this user/);
    const g = await req('POST', `/messages/${group}/call`, form(alice));
    assert.match(decodeURIComponent(g.headers.get('location')), /Only a one-to-one conversation/);
});

t('Call rings the other person (a direct row) and opens the call page with the ring', async () => {
    const r = await req('POST', `/messages/${conv}/call`, form(alice));
    assert.strictEqual(r.status, 303);
    const loc = r.headers.get('location');
    const m = /^\/call\/(user-[^?]+)\?to=(\d+)&from=(\d+)$/.exec(loc);
    assert.ok(m, loc);
    channelId = decodeURIComponent(m[1]);
    assert.deepStrictEqual([Number(m[2]), Number(m[3])], [Number(bob.id), Number(conv)]);
    assert.ok(callServer.hasInvite(channelId, Number(bob.id)), 'bob is invited');
    const [row] = await lifecycle.list({ channelId, kind: 'direct' });
    assert.ok(row && ['pending', 'ringing'].includes(row.state), JSON.stringify(row));

    const mine = await req('GET', loc, { headers: cookie(alice) });
    assert.strictEqual(mine.status, 200);
    assert.match(mine.text, /<h1 id="oc-call-h">Calling Bob/);
    assert.match(mine.text, /<script src="\/web\/call\.js\?v=[^"]+" defer><\/script>/);
    assert.match(mine.text, new RegExp(`href="/messages/${conv}"`), 'back to the conversation');
    assert.match(mine.text, /<meta name="robots" content="noindex, nofollow">/);
    assert.deepStrictEqual(pageJson(mine.text).call, { channel: channelId, join: true, talk: true, auto: true, ring: { id: Number(bob.id), name: 'Bob' } });

    const his = await req('GET', `/call/${encodeURIComponent(channelId)}`, { headers: cookie(bob) });
    assert.strictEqual(his.status, 200);
    assert.match(his.text, /<h1 id="oc-call-h">Call with Alice/);
    assert.strictEqual(pageJson(his.text).call.ring, null, 'the callee is not ringing anyone');
    assert.strictEqual((await req('GET', `/call/${encodeURIComponent(channelId)}`, { headers: cookie(carol) })).status, 404, 'a private call is nobody else\'s');
    assert.strictEqual((await req('GET', '/call/user-1-nothing', { headers: cookie(alice) })).status, 404);
    assert.strictEqual((await req('GET', '/call/public', { headers: cookie(alice) })).status, 404, 'the public lobby is not a 1:1 call page');
    const anon = await req('GET', `/call/${encodeURIComponent(channelId)}`);
    assert.strictEqual(anon.status, 303, 'sign in first');
});

t('ring.js: a ring shows Answer and Decline; answering tells the caller and opens the call page', async () => {
    const signed = `ov_token=${encodeURIComponent(bob.token)}`;
    const invite = { type: 'vc-call-invite', channelId: 'user-7-abc', channelName: "Alice's call", fromUserId: 7, fromDisplayName: 'Alice' };
    let s = runScript('ring.js', { view: 'inbox' }, { docCookie: signed });
    assert.strictEqual(s.sockets.length, 1);
    s.sockets[0].onopen();
    assert.deepStrictEqual(s.sockets[0].sent[0], { type: 'join', token: bob.token });
    s.sockets[0].onmessage({ data: JSON.stringify(invite) });
    const box = s.document.body.children[0];
    assert.ok(box && box.className === 'oc-ring' && box.attrs.role === 'alertdialog', 'the ring is shown');
    assert.strictEqual(box.attrs['aria-label'], 'Alice is calling you');
    assert.match(s.document.title, /^Alice is calling · /);
    const [answer] = box.children[1].children;
    answer.handlers.click();
    await tick(); await tick();
    assert.deepStrictEqual(s.fetches[0], { url: '/api/streams/voice-channels/call-user/respond', body: { caller_user_id: 7, channel_id: 'user-7-abc', channel_name: "Alice's call", status: 'accepted' } });
    assert.strictEqual(s.location.href, '/call/user-7-abc');
    assert.ok(box.removed);

    s = runScript('ring.js', { view: 'inbox' }, { docCookie: signed });
    s.sockets[0].onmessage({ data: JSON.stringify(invite) });
    s.document.body.children[0].children[1].children[1].handlers.click();
    await tick();
    assert.strictEqual(s.fetches[0].body.status, 'declined');

    s = runScript('ring.js', { view: 'inbox' }, { docCookie: signed });
    s.sockets[0].onmessage({ data: JSON.stringify(invite) });
    const ringTimer = s.timers.find((x) => x.ms === 30000);
    assert.ok(ringTimer, 'a ring gives up after 30 seconds');
    s.sockets[0].onmessage({ data: JSON.stringify({ ...invite, channelId: 'user-9-xyz', fromUserId: 9 }) });
    await tick();
    assert.deepStrictEqual([s.fetches[0].body.status, s.fetches[0].body.caller_user_id], ['busy', 9], 'a second ring while ringing: busy');
    ringTimer.fn();
    await tick();
    assert.strictEqual(s.fetches[1].body.status, 'no-answer');

    s = runScript('ring.js', { view: 'call' }, { docCookie: signed, leaveVisible: true });
    s.sockets[0].onmessage({ data: JSON.stringify(invite) });
    await tick();
    assert.strictEqual(s.fetches[0].body.status, 'busy', 'in a call on the call page: busy');
    assert.strictEqual(s.document.body.children.length, 0);

    assert.strictEqual(runScript('ring.js', { view: 'inbox' }, { docCookie: '' }).sockets.length, 0, 'signed out: no socket');
});

t('call.js on the caller\'s page: ringing until the answer; a decline, busy or no answer leaves the call', async () => {
    const signed = `ov_token=${encodeURIComponent(alice.token)}`;
    for (const [status, text] of [['declined', 'Bob declined the call.'], ['busy', 'Bob is in another call.'], ['no-answer', 'No answer from Bob.']]) {
        const s = runScript('call.js', { view: 'call', call: { channel: 'user-1-abc', join: true, talk: true, auto: true, ring: { id: 2, name: 'Bob' } } }, { docCookie: signed });
        const chat = s.sockets.find((x) => /\/ws\/chat$/.test(x.url));
        assert.ok(chat, 'the caller listens for the answer on /ws/chat');
        chat.onopen();
        assert.deepStrictEqual(chat.sent[0], { type: 'join', token: alice.token });
        await tick(); await tick();
        const call = s.sockets.find((x) => /\/ws\/call\?channelId=user-1-abc$/.test(x.url));
        assert.ok(call, 'and joins its call as the page opens');
        call.onopen();
        call.onmessage({ data: JSON.stringify({ type: 'welcome', peerId: 'p1', participants: [{ peerId: 'p1', displayName: 'Alice' }] }) });
        assert.strictEqual(s.byId['oc-call-status'].textContent, 'Ringing Bob…');
        assert.strictEqual(s.byId['oc-call-leave'].textContent, 'Cancel', 'while it rings, leaving is cancelling');
        chat.onmessage({ data: JSON.stringify({ type: 'vc-call-response', status: 'accepted', channelId: 'user-1-other', fromUserId: 2 }) });
        assert.strictEqual(s.byId['oc-call-status'].textContent, 'Ringing Bob…', 'an answer to another call is not this one');
        chat.onmessage({ data: JSON.stringify({ type: 'vc-call-response', status, channelId: 'user-1-abc', fromUserId: 2 }) });
        assert.strictEqual(s.byId['oc-call-status'].textContent, text);
        assert.ok(chat.closed && call.closed, `${status}: the call is left and the ring socket closed`);
    }
    const s = runScript('call.js', { view: 'call', call: { channel: 'user-1-abc', join: true, talk: true, auto: true, ring: { id: 2, name: 'Bob' } } }, { docCookie: signed });
    const chat = s.sockets[0];
    await tick(); await tick();
    const call = s.sockets.find((x) => /\/ws\/call/.test(x.url));
    call.onmessage({ data: JSON.stringify({ type: 'welcome', peerId: 'p1', participants: [{ peerId: 'p1' }] }) });
    chat.onmessage({ data: JSON.stringify({ type: 'vc-call-response', status: 'accepted', channelId: 'user-1-abc', fromUserId: 2 }) });
    assert.strictEqual(s.byId['oc-call-status'].textContent, 'Bob answered. Connecting…');
    call.onmessage({ data: JSON.stringify({ type: 'peer-joined', peerId: 'p2', displayName: 'Bob' }) });
    assert.strictEqual(s.byId['oc-call-status'].textContent, 'You are in the call.');
    assert.ok(chat.closed, 'answered: the ring socket closes');
    assert.strictEqual(s.byId['oc-call-leave'].textContent, 'Leave the call');
});

t.run(async () => { if (h && h.close) await h.close(); });
