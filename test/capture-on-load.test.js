'use strict';
/**
 * No capture until a press: the 1:1 call page (public/web/call.js) must not ask for
 * the microphone when it opens. Only pressing "Turn on microphone" (#oc-call-join)
 * may call getUserMedia. A browser test with a getUserMedia spy in the style of
 * dm-calls.test.js runScript, plus source checks.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function runCallPage(page) {
    const byId = {}, created = [], sockets = [], fetches = [];
    let gumCalls = 0;
    const node = (id = null) => ({
        id, hidden: false, disabled: false, textContent: '', className: '', children: [], attrs: {}, handlers: {},
        appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(ev, fn) { this.handlers[ev] = fn; }, remove() { this.removed = true; }, focus() {},
        querySelector: () => null,
    });
    function WebSocket(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    WebSocket.prototype.send = function (d) { this.sent.push(JSON.parse(d)); };
    WebSocket.prototype.close = function () { this.closed = true; };
    function RTCPeerConnection() { this.connectionState = 'new'; }
    RTCPeerConnection.prototype.close = function () {};
    const document = {
        cookie: '', hidden: false, title: 'Call',
        getElementById: (id) => (byId[id] = byId[id] || node(id)),
        createElement: (tag) => { const n = node(); n.tag = tag; created.push(n); return n; },
        createTextNode: (text) => ({ textContent: text }),
        querySelector: () => null, addEventListener() {}, body: node('body'),
    };
    const ctx = {
        window: { __OV_PAGE: { chat: page }, RTCPeerConnection, WebSocket, addEventListener() {} },
        WebSocket, RTCPeerConnection,
        navigator: { mediaDevices: { getUserMedia: async () => { gumCalls++; return { getTracks: () => [] }; } } },
        location: { protocol: 'https:', host: 'openvibe.chat', href: '' },
        document, JSON, Number, String, Map, Promise,
        fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({}) }; },
        setTimeout: (fn) => 0, clearTimeout: () => {}, setInterval: () => 0,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'call.js'), 'utf8'), ctx);
    return { byId, sockets, fetches, gumCalls: () => gumCalls };
}

// Loading the call page asks for nothing — even with the legacy auto flag present,
// the client must ignore it and wait for the press.
for (const page of [{ view: 'call', call: { channel: 'user-1-abc', join: true, talk: true } }, { view: 'call', call: { channel: 'user-1-abc', join: true, talk: true, auto: true } }]) {
    const s = runCallPage(page);
    assert.strictEqual(s.gumCalls(), 0, 'page load must not call getUserMedia');
    assert.ok(!s.sockets.some((x) => /\/ws\/call/.test(x.url)), 'page load must not open the call socket');
    assert.strictEqual(s.byId['oc-call-join'].hidden, false, 'the join button is shown');
    assert.ok(s.byId['oc-call-join'].handlers.click, 'the join button has a click handler');

    // The press is what opens the microphone.
    s.byId['oc-call-join'].handlers.click();
    assert.strictEqual(s.gumCalls(), 1, 'pressing Turn on microphone calls getUserMedia once');
    console.log('OK capture-on-load: no getUserMedia until the Turn on microphone click');
}

// Source checks: the server must not re-arm auto-join, and the button must be the press.
{
    const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'web', 'pages.js'), 'utf8');
    assert.ok(!/auto:\s*true/.test(pages), 'GET /call/:channel must not set auto:true');
    const callJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'call.js'), 'utf8');
    assert.ok(!/cfg\.call\.auto/.test(callJs), 'call.js must not auto-join on load');
    assert.ok(pages.includes('>Turn on microphone</button>'), 'the call page button says Turn on microphone');
    assert.ok(pages.includes('oc-call-join-note'), 'one line under the button says what it is for');
    console.log('OK capture-on-load: no auto-join in server or client source');
}

console.log('✅ capture on load test passed');
