/* Vibe's answers as HTML (server/web/vibe-pages.js renders them, public/web/vibe.js draws live ones): a small Markdown
 * subset, every character of the source escaped first, so the only markup in the output is the markup made here.
 *   blocks:  ``` fenced code ```, # / ## / ### headings (drawn as h3/h4), - * • lists, 1. lists, > quotes, paragraphs
 *   inline:  `code`, **bold**, *italic* / _italic_, [text](https://…), bare https:// links (rel nofollow, new tab)
 * Links are http(s) only. One file for both sides: CommonJS on the server, window.VibeMarkdown in the browser. */
(function (root) {
  'use strict';
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function link(href, text) {
    return '<a href="' + href + '" rel="nofollow ugc noopener" target="_blank">' + text + '</a>';
  }

  // Inline markup over already-escaped text. Code spans are cut out first so nothing inside them is touched.
  function inline(escaped) {
    var codes = [];
    var s = escaped.replace(/`([^`\n]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    var links = [];
    // An address ends at white space or at an escaped quote or angle bracket; trailing punctuation stays outside it.
    s = s.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s)])+)\)/g, function (_, t, u) { links.push(link(u, t)); return '\u0001' + (links.length - 1) + '\u0001'; });
    s = s.replace(/(^|[\s(])(https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s<])+)/g, function (_, pre, u) {
      var tail = /[.,;:!?)]+$/.exec(u);
      var href = tail ? u.slice(0, -tail[0].length) : u;
      if (href.length < 11) return pre + u;
      links.push(link(href, href));
      return pre + '\u0001' + (links.length - 1) + '\u0001' + (tail ? tail[0] : '');
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return links[Number(i)]; });
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }

  function render(src) {
    // The two placeholder characters inline() uses can never come from the text itself.
    var lines = String(src == null ? '' : src).replace(/[\u0000\u0001]/g, '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var list = null;   // { tag, items: [] }
    function flushPara() { if (para.length) { out.push('<p>' + para.map(function (l) { return inline(esc(l)); }).join('<br>') + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(esc(i)) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^\s*```\s*([\w+#.-]{0,20})\s*$/.exec(line);
      if (fence) {
        flushPara(); flushList();
        var code = [];
        for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
        out.push('<pre><code' + (fence[1] ? ' data-lang="' + esc(fence[1]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      var h = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) { flushPara(); flushList(); out.push((h[1].length === 1 ? '<h3>' : '<h4>') + inline(esc(h[2])) + (h[1].length === 1 ? '</h3>' : '</h4>')); continue; }
      var ul = /^\s{0,6}[-*•]\s+(.+)$/.exec(line);
      var ol = /^\s{0,6}\d{1,3}[.)]\s+(.+)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push((ul || ol)[1]);
        continue;
      }
      var q = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (q) { flushPara(); flushList(); out.push('<blockquote>' + inline(esc(q[1])) + '</blockquote>'); continue; }
      if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      flushList();
      para.push(line.trim());
    }
    flushPara(); flushList();
    return out.join('');
  }

  var api = { render: render, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VibeMarkdown = api;
})(this);
