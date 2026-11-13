'use strict';

const NAME = /:([a-z0-9_]{2,32}):/gi;

// `plain` must escape/linkify its input. Names not in this server remain literal text.
function render(text, emojis, plain, escape) {
    let last = 0, out = '', match;
    NAME.lastIndex = 0;
    while ((match = NAME.exec(String(text || '')))) {
        out += plain(String(text).slice(last, match.index));
        const emoji = emojis.get(match[1].toLowerCase());
        out += emoji && /^https:\/\//.test(emoji.url || '')
            ? `<img class="oc-server-emoji" src="${escape(emoji.url)}" alt="${escape(match[0])}" width="22" height="22" loading="lazy">`
            : plain(match[0]);
        last = NAME.lastIndex;
    }
    return out + plain(String(text || '').slice(last));
}

module.exports = { render };
