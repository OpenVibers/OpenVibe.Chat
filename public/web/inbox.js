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
  // OpenVibe.Pics direct links in a person's reply show as pictures (only that host, at most four), like in rooms.
  var PICS = /https:\/\/openvibe\.pics\/i\/([2-9a-km-zA-HJ-NP-Z]{8})\.(?:jpg|png|gif|webp|avif)(?![\w\/.-])/g;
  function picsOf(text) {
    var box = null, m, n = 0; PICS.lastIndex = 0;
    while ((m = PICS.exec(String(text || ''))) && n < 4) {
      if (!box) box = el('span', 'oc-pics');
      var a = el('a', 'oc-pic'); a.href = 'https://openvibe.pics/i/' + m[1]; a.target = '_blank'; a.rel = 'noopener';
      var img = el('img'); img.src = 'https://openvibe.pics/i/' + m[1] + '/thumb.webp'; img.alt = 'A picture on OpenVibe.Pics'; img.loading = 'lazy';
      a.appendChild(img); box.appendChild(a); n++;
    }
    return box;
  }
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
      b.appendChild(text);
      var pics = m.author === 'agent' ? picsOf(m.body) : null; if (pics) b.appendChild(pics);
      li.appendChild(b);
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
    var li = turn(m); thread.appendChild(li); addTranslate(li);
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
      } else if (m.type === 'inbox_assigned') {
        var row2 = listItem(m.conversation); var prev = row2 && row2.querySelector('.ib-prev');
        if (prev) { var who = prev.querySelector('.ib-who-has'); if (who) who.textContent = m.assignee === cfg.me ? 'You' : 'Someone'; }
        if (m.conversation === cfg.conversation) { var sel = document.querySelector('.ib-assign select'); if (sel) sel.value = m.assignee == null ? '' : String(m.assignee); }
      } else if (m.type === 'inbox_rating') {
        var item = listItem(m.conversation), row = item && item.querySelector('.ib-row');
        if (row) { var old = row.querySelector('.ib-rate'); if (old) old.remove(); var r = el('span', 'ib-rate', m.rating > 0 ? '👍' : '👎'); if (m.comment) r.title = m.comment; row.insertBefore(r, row.querySelector('time')); }
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

  // Translation: a visitor's message into the reader's own language, and the reply draft into the visitor's.
  var myLang = String((navigator.language || 'en')).toLowerCase();
  function post(path, body) {
    return fetch('/api/chat/inboxes/' + cfg.inbox + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }
  function addTranslate(li) {
    if (!li || !li.classList.contains('ib-visitor') || !li.dataset.id || li.querySelector('.ib-tr-btn')) return;
    var body = li.querySelector('.vb-body'); if (!body) return;
    var b = el('button', 'ib-tr-btn', 'Translate'); b.type = 'button';
    b.addEventListener('click', function () {
      b.disabled = true; b.textContent = 'Translating…';
      post('/conversations/' + cfg.conversation + '/messages/' + li.dataset.id + '/translate', { to: myLang }).then(function (x) {
        if (!x.ok) { b.disabled = false; b.textContent = (x.d && x.d.error) || 'Try again'; return; }
        var p = el('p', 'ib-tr', x.d.text); p.lang = x.d.lang; b.replaceWith(p);
      }).catch(function () { b.disabled = false; b.textContent = 'Try again'; });
    });
    body.appendChild(b);
  }
  if (thread) Array.prototype.forEach.call(thread.querySelectorAll('.ib-visitor'), addTranslate);
  var picIn = document.getElementById('ib-pic');
  if (picIn && input) {
    picIn.addEventListener('change', function () {
      var f = picIn.files && picIn.files[0]; picIn.value = '';
      if (!f) return;
      var caption = input.value.trim();
      fetch('/api/chat/inboxes/' + cfg.inbox + '/conversations/' + cfg.conversation + '/picture', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type, 'X-Caption': encodeURIComponent(caption) }, body: f })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) { window.alert((x.d && x.d.error) || 'That picture did not send.'); return; }
          input.value = ''; input.dispatchEvent(new Event('input'));
          appendToThread(x.d.message); touchList(cfg.conversation, x.d.message.body, 'open');
        }).catch(function () { window.alert('You seem to be offline.'); });
    });
  }
  var trTo = document.getElementById('ib-tr-to');
  if (trTo && input) {
    trTo.closest('.ib-tr-pick').hidden = false;
    trTo.addEventListener('change', function () {
      var to = trTo.value, text = input.value.trim(); trTo.value = '';
      if (!to || !text) return;
      var was = input.value; input.disabled = true;
      post('/translate', { text: text, to: to }).then(function (x) {
        input.disabled = false;
        if (!x.ok) { window.alert((x.d && x.d.error) || 'That did not translate.'); return; }
        input.value = x.d.text; input.dataset.original = was; input.dispatchEvent(new Event('input')); input.focus();
      }).catch(function () { input.disabled = false; });
    });
  }

  // Saved replies: "/" at the start of the reply box lists them by shortcut; Enter, Tab or a click puts one in.
  var saved = Array.isArray(cfg.saved) ? cfg.saved : [], pick = null, picked = 0;
  function closePick() { if (pick) { pick.remove(); pick = null; } input && input.removeAttribute('aria-activedescendant'); }
  function showPick() {
    var m = /^\/([a-z0-9-]*)$/i.exec(input.value);
    if (!m || !saved.length) { closePick(); return; }
    var q = m[1].toLowerCase(), list = saved.filter(function (r) { return r.shortcut.indexOf(q) === 0; }).slice(0, 8);
    if (!list.length) { closePick(); return; }
    if (!pick) { pick = el('ul', 'ib-pick'); pick.setAttribute('role', 'listbox'); form.parentNode.insertBefore(pick, form); }
    pick.textContent = ''; picked = Math.min(picked, list.length - 1);
    list.forEach(function (r, i) {
      var li = el('li', i === picked ? 'is-on' : ''); li.id = 'ib-pick-' + i; li.setAttribute('role', 'option');
      li.appendChild(el('b', null, '/' + r.shortcut)); li.appendChild(el('span', null, r.body.slice(0, 90)));
      li.addEventListener('mousedown', function (e) { e.preventDefault(); usePick(r); });
      pick.appendChild(li);
    });
    pick._list = list; input.setAttribute('aria-activedescendant', 'ib-pick-' + picked);
  }
  function usePick(r) { input.value = r.body; closePick(); input.dispatchEvent(new Event('input')); input.focus(); }

  if (form && input) {
    input.addEventListener('input', function () { picked = 0; showPick(); });
    input.addEventListener('keydown', function (e) {
      if (!pick) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + pick._list.length) % pick._list.length; showPick(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); usePick(pick._list[picked]); }
      else if (e.key === 'Escape') closePick();
    });
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
  // "Answered by": choosing a person assigns at once.
  var assignSel = document.querySelector('.ib-assign select[data-autosubmit]');
  if (assignSel) assignSel.addEventListener('change', function () { assignSel.form.requestSubmit ? assignSel.form.requestSubmit() : assignSel.form.submit(); });
  app.addEventListener('click', function (e) { if (e.target.closest('[data-vb-open]')) setRail(true); else if (e.target.closest('[data-vb-close]')) setRail(false); });
  bottom();
  connect();
})();
