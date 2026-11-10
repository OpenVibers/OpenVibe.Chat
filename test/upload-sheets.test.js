'use strict';
/**
 * The three places Chat asks for a file (Vibe's "Add a picture or a text file", the support inbox's "Send a picture",
 * and the embedded widget's) are one sheet:
 *   - Vibe and the inbox are on the network's kit, so theirs is the kit's sheet (a bottom sheet on a phone, a centred
 *     dialog on a computer; its head can be swiped down), with the kit's icon button to close it;
 *   - the widget on someone else's site has no kit, so embed.css draws the same sheet from the bottom of its frame,
 *     and gives the kit's picker the widget's own colours (its label was near-invisible on a light page: the picker
 *     reads --text-primary, which the widget never set).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');
const t = suite('upload-sheets');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

t('Vibe and the inbox use the kit sheet', () => {
    const vibe = read('server/web/vibe-pages.js'), inbox = read('server/web/inbox-pages.js');
    assert.match(vibe, /<dialog class="ovk-sheet vb-upload" data-vb-upload-dialog[^>]*><div class="ovk-sheet-head" data-ov-sheet-head>/);
    assert.match(vibe, /<button type="button" class="ovk-icon-btn" data-vb-upload-close aria-label="Close">\$\{thread\.icon\('close'\)\}<\/button>/);
    assert.match(vibe, /<div class="ovk-sheet-body"><div data-vb-upload /);
    assert.match(inbox, /<dialog class="ovk-sheet ib-upload" data-ib-upload-dialog[^>]*><div class="ovk-sheet-head" data-ov-sheet-head>/);
    assert.match(inbox, /<div class="ovk-sheet-body"><div data-ib-upload [^>]*><\/div><div data-ib-progress hidden><\/div><\/div><\/dialog>/);
    for (const f of ['public/web/vibe.css', 'public/web/inbox.css']) assert.ok(!/upload-head/.test(read(f)), `${f}: no second copy of the sheet's styles`);
});

t('the widget draws its own sheet and lends the picker its colours', () => {
    const css = read('public/web/embed.css'), page = read('server/web/inbox-pages.js');
    assert.match(css, /dialog\.em-upload \{[^}]*margin: auto 0 0;[^}]*border-radius: 16px 16px 0 0;/, 'from the bottom of the frame');
    assert.match(css, /\.em-upload-head button \{[^}]*width: 44px; height: 44px;/, 'a full-size close button');
    assert.match(css, /\.em-upload-body \{[^}]*env\(safe-area-inset-bottom/, 'room for the home bar');
    assert.match(css, /:root \{ --text-primary: var\(--text\); --text-secondary: var\(--muted\); --text-muted: var\(--muted\); --border: var\(--line\); \}/, 'the picker reads the widget\'s colours');
    assert.match(page, /<dialog class="em-upload"[^>]*><div class="em-upload-head"><h2 id="em-upload-h">Send a picture<\/h2><button type="button" data-em-upload-close aria-label="Close"><svg /);
    assert.ok(!page.includes('aria-label="Close">✕'), 'no text glyph for a close button');
});

t.run();
