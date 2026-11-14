'use strict';
/**
 * A card's picture that does not load is dropped (public/web/chat.js, the markup from server/web/ui.js): the
 * picture goes, the card stays (its title, its description). A card never shows a broken image.
 *
 * The client is run here with a small DOM of its own, so the rule is checked as it runs: the picture the server
 * drew, the picture the client drew, and a picture that never loaded at all.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// A node of the little DOM: a card, the link that holds its picture, the picture itself.
function node(tag, cls) {
    return {
        tagName: String(tag || '').toUpperCase(), className: cls || '', attrs: {}, children: [], parentNode: null, listeners: {},
        textContent: '',
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
        hasAttribute(k) { return this.attrs[k] != null; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        closest(sel) {
            const cls = String(sel || '').replace(/^\./, '');
            let cur = this;
            while (cur) {
                if (String(cur.className || '').split(/\s+/).includes(cls)) return cur;
                cur = cur.parentNode;
            }
            return null;
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
    };
}

/** A card with its picture: the card, the link that holds the picture, the picture itself. */
function cardWithPicture({ broken = false } = {}) {
    const card = node('div', 'oc-card');
    const body = node('div', 'oc-card-body');
    const title = node('span', 'oc-card-title');
    title.textContent = 'A card';
    body.appendChild(title);
    const link = node('a', 'oc-card-pic');
    const picture = node('img');
    picture.setAttribute('data-oc-card-pic', '1');
    picture.src = 'https://openvibe.media/a/att_01J/og.png';
    picture.complete = broken;
    picture.naturalWidth = broken ? 0 : 640;
    link.appendChild(picture);
    card.appendChild(link);
    card.appendChild(body);
    return { card, body, link, picture };
}

/** The client, run with a DOM of its own. */
function runClient(pictures) {
    const docHandlers = {};
    const document = {
        documentElement: { classList: { add() {}, remove() {} } },
        hidden: false,
        cookie: '',
        getElementById: () => null,
        createElement: (tag) => node(tag),
        createTextNode: (text) => Object.assign(node('#text'), { textContent: text }),
        querySelector: () => null,
        querySelectorAll: (sel) => (String(sel).includes('data-oc-card-pic') ? pictures : []),
        addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
        body: node('body'),
    };
    const ctx = {
        window: { __OV_PAGE: { chat: { view: 'none' } }, addEventListener() {} },
        document,
        navigator: {},
        console,
        URL,
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        fetch: () => Promise.reject(new Error('no network here')),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'chat.js'), 'utf8'), ctx);
    return { document, docHandlers, window: ctx.window };
}

// ── The picture that fails to load is dropped, and the card stays ──
{
    const { card, body, link, picture } = cardWithPicture();
    const { docHandlers } = runClient([picture]);
    assert.strictEqual(picture.listeners.error && picture.listeners.error.length, 1, 'the client watches the picture');
    picture.listeners.error[0]();
    assert.strictEqual(card.children.includes(link), false, 'the picture is gone');
    assert.strictEqual(card.children.includes(body), true, 'the card stays');
    assert.strictEqual(body.children.length, 1, 'with its title');
    // The same picture, failing later (the page's own handler catches it too).
    const second = cardWithPicture();
    const client = runClient([second.picture]);
    client.docHandlers.error.forEach((fn) => fn({ target: second.picture }));
    assert.strictEqual(second.card.children.includes(second.link), false, 'a picture that fails later is dropped as well');
    assert.strictEqual(second.card.children.includes(second.body), true, 'and the card stays');
}

// ── A picture that never loaded is dropped too ──
{
    const { card, body, link, picture } = cardWithPicture({ broken: true });
    runClient([picture]);
    assert.strictEqual(card.children.includes(link), false, 'a picture that never loaded is dropped');
    assert.strictEqual(card.children.includes(body), true, 'and the card stays');
}

// ── The server draws the same picture, marked so the client can drop it ──
{
    const ui = require('../server/web/ui');
    const html = ui.embedCard({ url: 'https://example.com/page', title: 'A card', kind: 'link', image: 'https://openvibe.media/a/att_01J/og.png' });
    assert.ok(html.includes('data-oc-card-pic'), 'the server marks the picture it draws');
    assert.ok(html.includes('class="oc-card-pic"'), 'in the card picture');
    const known = ui.linkCard({ url: 'https://example.com/page', title: 'A card', image: 'https://openvibe.media/a/att_01J/og.png' });
    assert.ok(known.includes('data-oc-card-pic'), 'the known-link card marks its picture too');
}

console.log('card picture: a picture that does not load is dropped, the card stays');
