/* A support inbox, live (server/web/inbox-pages.js /inbox/:id): the inbox's people follow every conversation over the
   chat socket (inbox_watch). New conversations and messages appear in the list as they come, the open one grows, and a
   reply is sent with Enter. The page works without this file (links and forms). A visitor's or agent's text is set with
   textContent; Vibe's answers go through VibeMarkdown (vibe-md.js), which escapes everything first. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || cfg.view !== 'inbox') return;
  var app = document.getElementById('vb');
  var thread = document.getElementById('vb-thread');
  var scroll = document.getElementById('vb-scroll');
  var form = document.getElementById('vb-composer');
  var input = document.getElementById('vb-input');
  var list = document.getElementById('ib-list');
  var latest = Number(cfg.latest) || 0, ws = null, delay = 1000, typingEl = null;
  var STATUS = { bot: ['Vibe', 'vb-st-bot'], waiting: ['Waiting', 'vb-st-wait'], open: ['Open', 'vb-st-open'], resolved: ['Resolved', 'vb-st-done'] };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function token() { var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || ''); return m ? decodeURIComponent(m[1]) : undefined; }
  function chip(s) { var c = el('span', 'vb-st ' + (STATUS[s] ? STATUS[s][1] : ''), STATUS[s] ? STATUS[s][0] : s); return c; }
  function plain(t) { return String(t || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]+|^#+\s*|^>\s*/gm, '').replace(/\s+/g, ' ').trim(); }
  function bottom() { if (scroll) scroll.scrollTop = scroll.scrollHeight; }
  function clearTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  function turn(m) {
    if (m.author === 'system') { var s = el('li', 'ib-sys', m.body); s.dataset.id = String(m.id); return s; }
    var li;
    if (m.author === 'visitor') {
      li = el('li', 'vb-turn vb-ai ib-visitor');
      li.appendChild(el('span', 'ib-av', (m.author_name || 'V').slice(0, 1).toUpperCase()));
      var body = el('div', 'vb-body'); body.appendChild(el('p', 'ib-who', m.author_name || 'Visitor'));
      body.appendChild(el('div', 'vb-md', m.body)); li.appendChild(body);
    } else {
      li = el('li', 'vb-turn vb-me');
      var b = el('div', 'vb-bubble' + (m.author === 'ai' ? ' ib-ai' : ''));
      b.appendChild(el('p', 'ib-who', m.author === 'ai' ? 'Vibe (AI)' : (m.author_name || 'Agent')));
      var text = el('div', 'vb-md');
      if (m.author === 'ai' && window.VibeMarkdown) text.innerHTML = window.VibeMarkdown.render(m.body); else text.textContent = m.body;
      b.appendChild(text); li.appendChild(b);
    }
    li.dataset.id = String(m.id);
    return li;
  }
  function appendToThread(m) {
    if (!thread || thread.querySelector('[data-id="' + m.id + '"]')) return;
    // One's own reply, back over the socket before the POST answered: it is the one already shown.
    if (m.author === 'agent') { var p = thread.querySelector('.vb-me:not([data-id])'); if (p) { p.dataset.id = String(m.id); latest = Math.max(latest, Number(m.id)); return; } }
    clearTyping();
    var stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
    thread.appendChild(turn(m));
    latest = Math.max(latest, Number(m.id));
    if (stick) bottom();
  }
  function listItem(convId) { return list ? list.querySelector('[data-conv="' + convId + '"]') : null; }
  function touchList(convId, preview, status) {
    var a = listItem(convId);
    if (!a) return;
    if (preview != null) { var p = a.querySelector('.ib-prev'); if (p) p.textContent = plain(preview).slice(0, 140); var t = a.querySelector('time'); if (t) t.textContent = 'now'; }
    if (status) { var old = a.querySelector('.vb-st'); if (old) old.replaceWith(chip(status)); }
    if (convId !== cfg.conversation && preview != null) a.classList.add('ib-unread');
    var li = a.parentNode; if (li && li.parentNode && preview != null) li.parentNode.insertBefore(li, li.parentNode.firstChild);
  }
  function addConversation(c) {
    if (listItem(c.id)) return;
    if (!list) {
      var nav = document.querySelector('.vb-rail-list'); var empty = document.getElementById('ib-empty'); if (empty) empty.remove();
      list = el('ul', 'vb-chats'); list.id = 'ib-list'; nav.appendChild(list);
    }
    var li = el('li'); var a = el('a', 'vb-chat ib-conv ib-unread'); a.href = '/inbox/' + cfg.inbox + '?c=' + c.id; a.dataset.conv = c.id;
    var row = el('span', 'ib-row'); row.appendChild(el('b', null, c.visitor_name || 'Visitor')); row.appendChild(chip(c.status)); row.appendChild(el('time', null, 'now'));
    a.appendChild(row); a.appendChild(el('span', 'ib-prev', ''));
    li.appendChild(a); list.insertBefore(li, list.firstChild);
  }

  function connect() {
    if (!window.WebSocket) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'inbox_watch', inbox: cfg.inbox, token: token() })); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.inbox !== cfg.inbox) return;
      if (m.type === 'inbox_conversation') addConversation(m.conversation);
      else if (m.type === 'inbox_message') {
        touchList(m.conversation, m.message.body, null);
        if (m.conversation === cfg.conversation) appendToThread(m.message);
      } else if (m.type === 'inbox_status') {
        touchList(m.conversation, null, m.status);
        if (m.conversation === cfg.conversation) { var h = document.querySelector('.vb-title .vb-st'); if (h) h.replaceWith(chip(m.status)); }
      } else if (m.type === 'inbox_typing' && m.conversation === cfg.conversation && thread) {
        clearTyping(); typingEl = el('li', 'ib-sys', (m.who || 'Vibe') + ' is writing…'); thread.appendChild(typingEl); bottom();
        setTimeout(clearTyping, 60000);
      }
    };
    ws.onclose = function () { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
  }

  if (form && input) {
    var grow = function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.submit(); } });
    form.addEventListener('submit', function (e) {
      var text = input.value.trim(); if (!text) { e.preventDefault(); return; }
      if (!window.fetch) return;
      e.preventDefault();
      var pending = turn({ id: 0, author: 'agent', author_name: 'You', body: text }); pending.removeAttribute('data-id'); thread.appendChild(pending); bottom();
      input.value = ''; grow();
      fetch('/api/chat/inboxes/' + cfg.inbox + '/conversations/' + cfg.conversation + '/messages', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) { pending.remove(); input.value = text; grow(); window.alert((x.d && x.d.error) || 'That did not send.'); return; }
          if (thread.querySelector('[data-id="' + x.d.message.id + '"]')) pending.remove(); else pending.dataset.id = String(x.d.message.id);
          touchList(cfg.conversation, text, 'open');
        })
        .catch(function () { pending.remove(); input.value = text; grow(); });
    });
  }
  // The rail on phones.
  function setRail(open) {
    app.classList.toggle('is-open', open);
    var scrim = app.querySelector('.vb-scrim'); if (scrim) scrim.hidden = !open;
    var btn = app.querySelector('[data-vb-open]'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  app.addEventListener('click', function (e) { if (e.target.closest('[data-vb-open]')) setRail(true); else if (e.target.closest('[data-vb-close]')) setRail(false); });
  bottom();
  connect();
})();
