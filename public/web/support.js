/* A visitor's own support conversation on openvibe.chat (server/web/inbox-pages.js /support/:cid): what the inbox's
   people and Vibe answer appears as it comes, over the chat socket (inbox_watch with the conversation; the server
   checks it is theirs). The page works without this file (the form posts). Text is set with textContent; Vibe's
   answers go through VibeMarkdown (vibe-md.js), which escapes everything first. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || cfg.view !== 'support') return;
  var thread = document.getElementById('sp-thread');
  var latest = Number(cfg.latest) || 0, ws = null, delay = 1000;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function token() { var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || ''); return m ? decodeURIComponent(m[1]) : undefined; }
  function render(m) {
    if (!m || thread.querySelector('[data-id="' + m.id + '"]')) return;
    var li;
    if (m.author === 'system') li = el('li', 'oc-muted sp-sys', m.body);
    else {
      li = el('li', 'sp-msg' + (m.author === 'visitor' ? ' sp-me' : ''));
      li.appendChild(el('b', null, m.author === 'visitor' ? 'You' : m.author === 'ai' ? 'Vibe' : (m.author_name || 'Support')));
      li.appendChild(document.createTextNode(' '));
      var t = el('span', 'sp-text');
      if (m.author === 'ai' && window.VibeMarkdown) t.innerHTML = window.VibeMarkdown.render(m.body); else t.textContent = m.body;
      li.appendChild(t);
    }
    li.dataset.id = String(m.id);
    thread.appendChild(li);
    latest = Math.max(latest, Number(m.id) || 0);
    li.scrollIntoView({ block: 'nearest' });
  }
  function connect() {
    if (!window.WebSocket) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'inbox_watch', inbox: cfg.inbox, conversation: cfg.conversation, token: token() })); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.conversation !== cfg.conversation) return;
      if (m.type === 'inbox_message') render(m.message);
    };
    ws.onclose = function () { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
  }
  connect();
})();
