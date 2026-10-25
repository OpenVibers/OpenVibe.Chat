'use strict';
/**
 * Every list laid out as a grid in public/web/chat.css sizes its columns so they can shrink to the screen: minmax(0, 1fr),
 * or a minimum wrapped in min(…, 100%), never a bare length and never no columns at all. Without it a column is as
 * wide as its longest unbreakable line: a pasted link in a conversation preview made /messages 939 px wide on a 412 px
 * phone, and the navbar's menu, placed against that wider page, opened off-screen (the owner, 2026-10-25: "Missing menu").
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'web', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const lists = rules.filter((r) => /list-style:\s*none/.test(r.body) && /display:\s*grid/.test(r.body));
assert.ok(lists.length >= 7, `found ${lists.length} list grids`);
const unsized = lists.filter((r) => {
    const cols = (/grid-template-columns:\s*([^;]+)/.exec(r.body) || [])[1];
    return !cols || /minmax\(\s*\d/.test(cols.replace(/minmax\(\s*0\s*,/g, ''));
}).map((r) => r.selector);
assert.deepStrictEqual(unsized, [], `list grids whose columns cannot shrink to a phone: ${unsized.join(', ')}`);
console.log(`css-phone-grids: ${lists.length} list grids sized`);
