/* Vibe's answers as HTML (server/web/vibe-pages.js renders them, public/web/vibe.js draws live ones): a small Markdown
 * subset, every character of the source escaped first, so the only markup in the output is the markup made here.
 *   blocks:  ``` fenced code ```, # / ## / ### headings (drawn as h3/h4), - * • lists and 1. lists (nested by indenting,
 *            4 deep), | pipe | tables | (with :-: alignment; they scroll inside their own box), > quotes, paragraphs
 *   inline:  `code`, **bold**, *italic* / _italic_, [text](https://…), <https://…>, bare https:// links (rel nofollow, new tab)
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
    // <https://…>, Markdown's autolink: escaped to &lt;…&gt; above, the brackets go and the address is the link.
    s = s.replace(/&lt;(https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s<])+)&gt;/g, function (_, u) { links.push(link(u, u)); return '\u0001' + (links.length - 1) + '\u0001'; });
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

  // A table row's cells: split on pipes not escaped as \|, one optional outer pipe on each side.
  function cells(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.slice(-1) === '|' && t.slice(-2) !== '\\|') t = t.slice(0, -1);
    var out = [];
    var cur = '';
    for (var k = 0; k < t.length; k++) {
      if (t.charAt(k) === '\\' && t.charAt(k + 1) === '|') { cur += '|'; k++; continue; }
      if (t.charAt(k) === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += t.charAt(k);
    }
    out.push(cur.trim());
    return out;
  }
  // The alignments of a table's delimiter row (| --- | :-: | --: |), or null when the line is not one.
  function delimiter(line) {
    if (!line || line.indexOf('|') < 0 || !/^[\s|:-]+$/.test(line)) return null;
    var cs = cells(line);
    var al = [];
    for (var k = 0; k < cs.length; k++) {
      if (!/^:?-+:?$/.test(cs[k])) return null;
      var l = cs[k].charAt(0) === ':', r = cs[k].slice(-1) === ':';
      al.push(l && r ? 'c' : r ? 'r' : l ? 'l' : '');
    }
    return al.length <= 32 ? al : null;
  }
  function cell(tag, text, a) { return '<' + tag + (a ? ' class="al-' + a + '"' : '') + '>' + inline(esc(text || '')) + '</' + tag + '>'; }

  var MAX_DEPTH = 4;   // lists nest this deep; a deeper item joins the deepest list

  function render(src) {
    // The two placeholder characters inline() uses can never come from the text itself. Leading tabs count 4 columns.
    var lines = String(src == null ? '' : src).replace(/[\u0000\u0001]/g, '').replace(/\r\n?/g, '\n').split('\n')
      .map(function (l) { return l.replace(/^\t+/, function (t) { return new Array(t.length + 1).join('    '); }); });
    var out = [];
    var para = [];
    // Open lists, outermost first: { tag, indent, items: [{ text, sub }] }. A deeper item opens a list inside the last one.
    var stack = [];
    function flushPara() { if (para.length) { out.push('<p>' + para.map(function (l) { return inline(esc(l)); }).join('<br>') + '</p>'); para = []; } }
    function listHtml(l) { return '<' + l.tag + '>' + l.items.map(function (it) { return '<li>' + inline(esc(it.text)) + it.sub + '</li>'; }).join('') + '</' + l.tag + '>'; }
    function closeDeeperThan(indent) {
      while (stack.length > 1 && stack[stack.length - 1].indent > indent) {
        var done = stack.pop();
        var parent = stack[stack.length - 1];
        parent.items[parent.items.length - 1].sub += listHtml(done);
      }
    }
    function flushList() { if (stack.length) { closeDeeperThan(-1); out.push(listHtml(stack[0])); stack = []; } }
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
      // A pipe table: a header row whose cells match the delimiter row under it; rows run to a blank or pipe-less line.
      var al = line.indexOf('|') >= 0 ? delimiter(lines[i + 1]) : null;
      var head = al ? cells(line) : null;
      if (head && head.length === al.length) {
        flushPara(); flushList();
        var rows = [];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0 && rows.length < 500; i++) rows.push(cells(lines[i]));
        i--;
        // A wide table scrolls inside its own box on a phone: a labelled region keyboard users can reach.
        out.push('<div class="md-table" tabindex="0" role="region" aria-label="Table"><table><thead><tr>'
          + head.map(function (c, k) { return cell('th', c, al[k]); }).join('') + '</tr></thead><tbody>'
          + rows.map(function (r) { return '<tr>' + al.map(function (a, k) { return cell('td', r[k], a); }).join('') + '</tr>'; }).join('')
          + '</tbody></table></div>');
        continue;
      }
      var ul = /^(\s{0,24})[-*•]\s+(.+)$/.exec(line);
      var ol = ul ? null : /^(\s{0,24})\d{1,3}[.)]\s+(.+)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var m = ul || ol;
        var tag = ul ? 'ul' : 'ol';
        var indent = m[1].length;
        var top = stack[stack.length - 1];
        if (top && indent > top.indent + 1 && top.items.length && stack.length < MAX_DEPTH) {
          stack.push({ tag: tag, indent: indent, items: [] });
        } else if (top) {
          closeDeeperThan(indent);
          top = stack[stack.length - 1];
          if (top.tag !== tag) {
            if (stack.length === 1) { flushList(); stack.push({ tag: tag, indent: indent, items: [] }); }
            else { var done = stack.pop(); stack[stack.length - 1].items[stack[stack.length - 1].items.length - 1].sub += listHtml(done); stack.push({ tag: tag, indent: indent, items: [] }); }
          }
        } else {
          stack.push({ tag: tag, indent: indent, items: [] });
        }
        stack[stack.length - 1].items.push({ text: m[2], sub: '' });
        continue;
      }
      var q = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (q) { flushPara(); flushList(); out.push('<blockquote>' + inline(esc(q[1])) + '</blockquote>'); continue; }
      if (stack.length && /^\s{2,}\S/.test(line)) { var last = stack[stack.length - 1]; last.items[last.items.length - 1].text += ' ' + line.trim(); continue; }
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
