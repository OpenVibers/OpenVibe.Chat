'use strict';
/**
 * server/web/ui.js draws the Network presence dot (network.presence@1) the same way openvibe-shared's
 * .ovp-dot does: an 11 px dot (14 px in a page header), the state in the avatar's accessible name, and
 * no dot at all for offline or invisible. The server-rendered lists and the client (public/web/chat.js)
 * draw the same markup, so this is the one place the look and the names are pinned.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../server/web/ui');
const { suite } = require('./helpers');

const t = suite('ui presence');

t('online, away, dnd and live draw the dot; offline and invisible draw nothing', () => {
    const cases = [
        ['online', { state: 'online' }, 'online', '#22c55e'],
        ['away', { state: 'away' }, 'away', '#f59e0b'],
        ['dnd', { state: 'dnd' }, 'do not disturb', '#ef4444'],
        ['live', { state: 'online', live: true }, 'live', '#ef4444'],
    ];
    for (const [state, presence, name, color] of cases) {
        const html = ui.initials('Alice', presence);
        assert.match(html, new RegExp(`role="img" aria-label="Alice, ${name}"`), state);
        assert.match(html, new RegExp(`<span class="oc-pdot" data-state="${state}" style="--ovp:${color}" aria-hidden="true"></span>`), state);
        assert.match(html, /aria-hidden="true"><\/span></, 'the dot is hidden from assistive technology');
    }
    for (const presence of [null, { state: 'offline' }, { state: 'invisible' }]) {
        const html = ui.initials('Alice', presence);
        assert.doesNotMatch(html, /oc-pdot/);
        assert.doesNotMatch(html, /role="img"/);
        assert.match(html, /aria-hidden="true">AL<\/span>/, 'a plain picture is decorative');
    }
});

t('the state line and the member-list order', () => {
    assert.strictEqual(ui.presenceLine({ state: 'online' }), 'Online');
    assert.strictEqual(ui.presenceLine({ state: 'online', status_text: 'Around' }), 'Online · Around');
    assert.strictEqual(ui.presenceLine({ state: 'away' }), 'Away');
    assert.strictEqual(ui.presenceLine({ state: 'dnd' }), 'Do not disturb');
    assert.strictEqual(ui.presenceLine({ state: 'online', live: true }), 'Live now');
    assert.strictEqual(ui.presenceLine({ state: 'online', live: true }, { liveHref: 'https://openvibe.live/@alice' }), '<a href="https://openvibe.live/@alice">Live now</a>');
    assert.strictEqual(ui.presenceLine({ state: 'online' }, { liveHref: 'javascript:alert(1)' }), 'Online');
    assert.strictEqual(ui.presenceLine({ state: 'offline' }), '');
    assert.strictEqual(ui.presenceLine({ state: 'invisible' }), '');
    assert.deepStrictEqual(
        [{ state: 'online' }, { state: 'away' }, { state: 'offline' }, null, { state: 'online', live: true }].map(ui.presenceOrder),
        [0, 1, 2, 2, 0],
    );
});

t('the dot CSS copies Shared\'s .ovp-dot', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'chat.css'), 'utf8');
    for (const rule of [
        '.oc-pdot { position: absolute; right: -1px; bottom: -1px; width: 11px; height: 11px; border-radius: 50%; box-sizing: border-box;',
        'border: 2.5px solid var(--oc-pdot-ring, var(--oc-panel));',
        '.oc-pdot[data-state="dnd"]::after',
        '.oc-pdot[data-state="away"] { background: radial-gradient(circle at 70% 30%, var(--oc-pdot-ring, var(--oc-panel)) 0 2.2px, var(--ovp) 2.6px); }',
        '.oc-av-lg .oc-pdot { width: 14px; height: 14px; }',
    ]) assert.ok(css.includes(rule), rule);
});

t('a page header takes the avatar beside its title', () => {
    const avatar = ui.initials('Alice', { state: 'online' }, { large: true, id: 'oc-dm-avatar' });
    const html = ui.head({ title: 'Alice', sub: '<span id="oc-dm-status">Online</span>', avatar });
    assert.match(html, /<span class="oc-av oc-av-lg"[^>]*id="oc-dm-avatar"[^>]*role="img" aria-label="Alice, online">/);
    assert.ok(html.indexOf('id="oc-dm-avatar"') < html.indexOf('class="oc-page-id"'), 'the picture comes before the title');
    assert.match(html, /<p class="oc-page-sub"><span id="oc-dm-status">Online<\/span><\/p>/);
});
