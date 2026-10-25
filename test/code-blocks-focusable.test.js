'use strict';
/**
 * Every code block Chat's pages render can be reached from the keyboard: a <pre> scrolls sideways when its line is long
 * (a snippet, a secret), and axe's scrollable-region-focusable (WCAG 2.1, serious) failed /developers on 10-25 until each
 * one carried tabindex="0". This keeps a new one from coming without it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'server', 'web');
const missing = [];
fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    (src.match(/<pre\b[^>]*>/g) || []).filter((tag) => !/tabindex="0"/.test(tag)).forEach((tag) => missing.push(`${f}: ${tag}`));
});
assert.deepStrictEqual(missing, [], `code blocks without tabindex="0":\n${missing.join('\n')}`);
console.log('code blocks focusable: every <pre> in server/web has tabindex="0"');
