/* A support inbox, live (server/web/inbox-pages.js /inbox/:id), on the network's conversation kit (openvibe-shared
   thread and kit.sidebar; ov-thread.js grows the reply box, sends on Enter and keeps the thread at the bottom). The
   inbox's people follow every conversation over the chat socket (inbox_watch): new conversations and messages appear
   in the list as they come, and the open one grows. The page works without this file (links and forms). A visitor's
   or agent's text is set with textContent; Vibe's answers go through VibeMarkdown (vibe-md.js), which escapes
   everything first. Rows and turns are drawn with the same markup as the server's. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || cfg.view !== 'inbox') return;
  var thread = document.querySelector('[data-ovt-thread]');
  var form = document.getElementById('ib-composer');
  var input = form ? form.querySelector('[data-ovt-text]') : null;
  var rail = document.getElementById('ib-rail');
  var list = rail ? rail.querySelector('.ovk-sidebar-sec') : null;
  var latest = Number(cfg.latest) || 0, ws = null, delay = 1000, typingEl = null;
  var STATUS = { bot: ['Vibe', 'ib-st-bot'], waiting: ['Waiting', 'ib-st-wait'], open: ['Open', 'ib-st-open'], resolved: ['Resolved', 'ib-st-done'] };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function token() { var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || ''); return m ? decodeURIComponent(m[1]) : undefined; }
  function chip(s) { return el('span', 'ib-st ' + (STATUS[s] ? STATUS[s][1] : ''), STATUS[s] ? STATUS[s][0] : s); }
  // A known OpenVibe link's card (server/chat/link-cards.js; the same markup the server draws): picture, title, one
  // line and the one move. Every field is data: textContent, and only https addresses become links or pictures.
  function httpsHref(v) {
    try { var u = new URL(String(v)); return u.protocol === 'https:' ? u.href : null; } catch (e) { return null; }
  }
  function linkCard(c) {
    if (!c || typeof c !== 'object' || typeof c.title !== 'string' || !c.title) return null;
    var url = httpsHref(c.url), action = c.action && httpsHref(c.action.href);
    var box = el('div', 'oc-card'); box.dataset.kind = typeof c.kind === 'string' ? c.kind : 'link';
    var img = typeof c.image === 'string' && /^https:\/\/openvibe\.media\/[^\s"'<>]+$/.test(c.image) ? httpsHref(c.image) : null;
    if (img) {
      var pic = el('a', 'oc-card-pic'); pic.href = url || img; pic.target = '_blank'; pic.rel = 'noopener nofollow';
      var picture = el('img'); picture.src = img; picture.alt = ''; picture.loading = 'lazy'; picture.decoding = 'async';
      pic.appendChild(picture); box.appendChild(pic);
    }
    var body = el('div', 'oc-card-body');
    if (url) {
      var title = el('a', 'oc-card-title', c.title); title.href = url; title.target = '_blank'; title.rel = 'noopener nofollow';
      body.appendChild(title);
    } else body.appendChild(el('span', 'oc-card-title', c.title));
    if (typeof c.line === 'string' && c.line) body.appendChild(el('p', 'oc-card-line', c.line));
    if (typeof c.note === 'string' && c.note) body.appendChild(el('p', 'oc-card-note', c.note));
    if (action && c.action && typeof c.action.label === 'string' && c.action.label) {
      var go = el('a', 'oc-card-go', c.action.label); go.href = action; go.target = '_blank'; go.rel = 'noopener nofollow';
      body.appendChild(go);
    }
    box.appendChild(body);
    return box;
  }
  // OpenVibe.Pics direct links in a person's reply, or a signed-in visitor's, show as pictures (only that host, at most four).
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
  function bare(t) { return String(t || '').replace(PICS, '').replace(/[ \t]+$/gm, '').trim(); }
  function plain(t) { return String(t || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]+|^#+\s*|^>\s*/gm, '').replace(/\s+/g, ' ').trim(); }
  function bottom() { window.scrollTo(0, document.documentElement.scrollHeight); }
  function clearTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  // One message, as the kit's turn (server/web/inbox-pages.js inboxTurn).
  function turn(m) {
    if (m.author === 'system') { var d = el('li', 'ovt-divider'); d.appendChild(el('span', null, m.body)); d.dataset.id = String(m.id); return d; }
    var li = el('li', 'ovt-turn');
    if (m.author === 'visitor') {
      var name = m.author_name || 'Visitor';
      var bot = el('div', 'ovt-bot');
      bot.appendChild(el('span', 'ovt-avatar is-who', name.slice(0, 1).toUpperCase())).setAttribute('aria-hidden', 'true');
      var reply = el('div', 'ovt-reply');
      var who = el('p', 'ovt-who'); who.appendChild(el('b', null, name)); reply.appendChild(who);
      var vp = m.account ? picsOf(m.body) : null;   // a signed-in visitor's pictures show, not their links
      var said = vp ? bare(m.body) : m.body;
      if (said) reply.appendChild(el('div', 'ovt-answer ib-text', said));
      if (vp) reply.appendChild(vp);
      var vc = linkCard(m.card); if (vc) reply.appendChild(vc);
      bot.appendChild(reply); li.appendChild(bot);
      li.dataset.author = 'visitor';
    } else {
      var ai = m.author === 'ai';
      var you = el('div', 'ovt-you');
      you.appendChild(el('span', 'ovt-caption', ai ? 'Vibe (AI)' : (m.author_name || 'Agent')));
      var bubble = el('div', 'ovt-bubble');
      if (ai && window.VibeMarkdown) { var mdEl = el('div', 'vb-md'); mdEl.innerHTML = window.VibeMarkdown.render(m.body); bubble.appendChild(mdEl); }
      else {
        var pics = m.author === 'agent' ? picsOf(m.body) : null;
        bubble.appendChild(el('span', 'ib-text', pics ? bare(m.body) : m.body));
        if (pics) bubble.appendChild(pics);
      }
      var ac = linkCard(m.card); if (ac) bubble.appendChild(ac);
      you.appendChild(bubble); li.appendChild(you);
      li.dataset.author = ai ? 'ai' : 'agent';
    }
    li.dataset.id = String(m.id);
    return li;
  }
  function appendToThread(m) {
    if (!thread || thread.querySelector('[data-id="' + m.id + '"]')) return;
    // One's own reply, back over the socket before the POST answered: it is the one already shown.
    if (m.author === 'agent') { var p = thread.querySelector('[data-author="agent"]:not([data-id])'); if (p) { p.dataset.id = String(m.id); latest = Math.max(latest, Number(m.id)); return; } }
    clearTyping();
    var li = turn(m);
    if (window.OVThread) window.OVThread.add(li); else { thread.appendChild(li); bottom(); }
    addTranslate(li);
    latest = Math.max(latest, Number(m.id));
  }

  // The rows: one per conversation, found by data-conv (kit.sidebar's item, server/web/inbox-pages.js conversationsRail).
  function listItem(convId) { return list ? list.querySelector('[data-conv="' + convId + '"]') : null; }
  function setDot(a, kind) {
    var old = a.querySelector('.ovk-sidebar-dot'); if (old) old.remove();
    if (!kind) return;
    var dot = el('i', 'ovk-sidebar-dot' + (kind === true ? '' : ' is-' + kind)); dot.setAttribute('aria-hidden', 'true');
    a.insertBefore(dot, a.querySelector('.ovk-sidebar-s'));
  }
  function setLine(a, preview) {
    var sub = a.querySelector('.ovk-sidebar-s'); if (!sub) return;
    var who = a.getAttribute('data-who') || '';
    sub.textContent = (who ? who + ' · ' : '') + plain(preview).slice(0, 140);
  }
  function setWhen(a, text) {
    var meta = a.querySelector('.ovk-sidebar-m'); if (!meta) return;
    var rate = /^(👍|👎) /.exec(meta.textContent);
    meta.textContent = (rate ? rate[0] : '') + text;
  }
  function toTop(a) { var first = list.querySelector('.ovk-sidebar-item'); if (first && first !== a) list.insertBefore(a, first); }
  function touchList(convId, preview, status) {
    var a = listItem(convId);
    if (!a) return;
    if (preview != null) { setLine(a, preview); setWhen(a, 'now'); }
    if (status) { a.setAttribute('data-status', status); setDot(a, status === 'waiting' ? 'needs' : a.classList.contains('ib-unread') ? true : null); }
    if (String(convId) !== String(cfg.conversation) && preview != null) { a.classList.add('ib-unread'); if (a.getAttribute('data-status') !== 'waiting') setDot(a, true); }
    if (preview != null) toTop(a);
  }
  function addConversation(c) {
    if (!list || listItem(c.id)) return;
    var empty = list.querySelector('.ovk-sidebar-empty'); if (empty) empty.remove();
    var a = el('a', 'ovk-sidebar-item has-sub has-mark ib-unread'); a.href = '/inbox/' + cfg.inbox + '?c=' + c.id + '&f=' + (cfg.filter || 'active');
    a.setAttribute('data-conv', c.id); a.setAttribute('data-who', c.status === 'bot' ? 'Vibe' : ''); a.setAttribute('data-status', c.status);
    var mark = el('span', 'ib-av', String(c.visitor_name || 'V').slice(0, 1).toUpperCase()); mark.setAttribute('aria-hidden', 'true');
    a.appendChild(mark);
    a.appendChild(el('span', 'ovk-sidebar-t', c.visitor_name || 'Visitor'));
    a.appendChild(el('span', 'ovk-sidebar-m', 'now'));
    a.appendChild(el('span', 'ovk-sidebar-s', c.status === 'bot' ? 'Vibe' : 'New'));
    setDot(a, c.status === 'waiting' ? 'needs' : true);
    var first = list.querySelector('.ovk-sidebar-item');
    if (first) list.insertBefore(a, first); else list.appendChild(a);
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
        var row = listItem(m.conversation);
        if (row) { row.setAttribute('data-who', m.assignee == null ? '' : m.assignee === cfg.me ? 'You' : 'Someone'); var sub = row.querySelector('.ovk-sidebar-s'); if (sub) setLine(row, sub.textContent.replace(/^(You|Someone|Vibe|[^·]{1,40}) · /, '')); }
        if (m.conversation === cfg.conversation) { var sel = document.querySelector('.ib-assign select'); if (sel) sel.value = m.assignee == null ? '' : String(m.assignee); }
      } else if (m.type === 'inbox_rating') {
        var item = listItem(m.conversation), meta = item && item.querySelector('.ovk-sidebar-m');
        if (meta) meta.textContent = (m.rating > 0 ? '👍 ' : '👎 ') + meta.textContent.replace(/^(👍|👎) /, '');
      } else if (m.type === 'inbox_call' && m.conversation === cfg.conversation) {
        if (m.state === 'ringing') callOffered(m.by); else callGone();
      } else if (m.type === 'inbox_status') {
        touchList(m.conversation, null, m.status);
        if (m.conversation === cfg.conversation) { var h = document.querySelector('.ib-tags .ib-st'); if (h) h.replaceWith(chip(m.status)); }
      } else if (m.type === 'inbox_typing' && m.conversation === cfg.conversation && thread) {
        clearTyping(); typingEl = el('li', 'ovt-divider ib-typing'); typingEl.appendChild(el('span', null, (m.who || 'Vibe') + ' is writing…'));
        if (window.OVThread) window.OVThread.add(typingEl); else { thread.appendChild(typingEl); bottom(); }
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
    if (!li || li.dataset.author !== 'visitor' || !li.dataset.id || li.querySelector('.ib-tr-btn')) return;
    var body = li.querySelector('.ovt-reply'); if (!body) return;
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
  if (thread) Array.prototype.forEach.call(thread.querySelectorAll('[data-author="visitor"]'), addTranslate);
  var picBtn = document.getElementById('ib-pic');
  var uploadDialog = document.querySelector('[data-ib-upload-dialog]');
  var uploadRoot = document.querySelector('[data-ib-upload]');
  var progressEl = document.querySelector('[data-ib-progress]');
  var uploadMeter = progressEl && window.OVUpload ? window.OVUpload.progress(progressEl) : null;
  function sendInboxPicture(f) {
    if (!f) return;
    var caption = input.value.trim();
    if (progressEl) progressEl.hidden = false;
    if (uploadMeter) uploadMeter.update({ state: 'sending', done: 0, total: f.size });
    new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/chat/inboxes/' + cfg.inbox + '/conversations/' + cfg.conversation + '/picture');
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', f.type);
      xhr.setRequestHeader('X-Caption', encodeURIComponent(caption));
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && uploadMeter) uploadMeter.update({ state: 'sending', done: e.loaded, total: e.total }); };
      xhr.onload = function () {
        var d = null; try { d = JSON.parse(xhr.responseText || 'null'); } catch (_) { d = null; }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, d: d });
      };
      xhr.onerror = function () { reject(new Error('offline')); };
      xhr.send(f);
    }).then(function (x) {
      if (!x.ok) { if (uploadMeter) uploadMeter.update({ state: 'failed', message: (x.d && x.d.error) || 'That picture did not send.' }); window.alert((x.d && x.d.error) || 'That picture did not send.'); return; }
      if (uploadMeter) uploadMeter.update({ state: 'done', done: f.size, total: f.size });
      if (progressEl) setTimeout(function () { progressEl.hidden = true; }, 800);
      input.value = ''; input.dispatchEvent(new Event('input'));
      appendToThread(x.d.message); touchList(cfg.conversation, x.d.message.body, 'open');
    }).catch(function () { if (uploadMeter) uploadMeter.update({ state: 'failed', message: 'You seem to be offline.' }); window.alert('You seem to be offline.'); });
  }
  if (picBtn && input && uploadDialog && uploadRoot && window.OVUpload) {
    window.OVUpload.picker(uploadRoot, { label: 'Choose a picture', accept: uploadRoot.getAttribute('data-accept') || 'image/*', onFile: function (f) { uploadDialog.close(); sendInboxPicture(f); } });
    picBtn.addEventListener('click', function () { uploadDialog.showModal(); });
    var closeUpload = uploadDialog.querySelector('[data-ib-upload-close]');
    if (closeUpload) closeUpload.addEventListener('click', function () { uploadDialog.close(); });
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
    if (saved.length) input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', function () { picked = 0; showPick(); });
    // In the capture phase, so a picked reply wins over ov-thread.js's Enter to send.
    input.addEventListener('keydown', function (e) {
      if (!pick) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + pick._list.length) % pick._list.length; showPick(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); usePick(pick._list[picked]); }
      else if (e.key === 'Escape') closePick();
    }, true);
    // The kit grows the box and sends on Enter (ov-thread.js); an 'input' event keeps its size and Send in step.
    var grow = function () { input.dispatchEvent(new Event('input')); };
    form.addEventListener('submit', function (e) {
      var text = input.value.trim(); if (!text) { e.preventDefault(); return; }
      if (!window.fetch) return;
      e.preventDefault();
      var pending = turn({ id: 0, author: 'agent', author_name: 'You', body: text }); pending.removeAttribute('data-id');
      if (window.OVThread) window.OVThread.add(pending); else { thread.appendChild(pending); bottom(); }
      input.value = ''; grow();
      fetch('/api/chat/inboxes/' + cfg.inbox + '/conversations/' + cfg.conversation + '/messages', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) { pending.remove(); input.value = text; grow(); window.alert((x.d && x.d.error) || 'That did not send.'); return; }
          // The socket may have answered first and given this very turn its id: only another turn with it is a copy.
          var copy = thread.querySelector('[data-id="' + x.d.message.id + '"]');
          if (copy && copy !== pending) pending.remove(); else pending.dataset.id = String(x.d.message.id);
          touchList(cfg.conversation, text, 'open');
        })
        .catch(function () { pending.remove(); input.value = text; grow(); });
    });
  }
  // "Answered by": choosing a person assigns at once.
  var assignSel = document.querySelector('.ib-assign select[data-autosubmit]');
  if (assignSel) assignSel.addEventListener('change', function () { assignSel.form.requestSubmit ? assignSel.form.requestSubmit() : assignSel.form.submit(); });
  connect();

  // A voice call with the visitor (server/inbox/inbox.js startCall, support-call.js): Call starts it and joins; anyone
  // else of the team on this conversation is offered to join; End call ends it for everyone, the visitor included.
  var callBtn = document.getElementById('ib-call'), callBar = document.getElementById('ib-callbar');
  var callText = document.getElementById('ib-call-text'), callJoin = document.getElementById('ib-call-join');
  var callMute = document.getElementById('ib-call-mute'), callEnd = document.getElementById('ib-call-end');
  var call = null;
  function callApi(method) {
    return fetch('/api/chat/inboxes/' + cfg.inbox + '/conversations/' + cfg.conversation + '/call', { method: method, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: {} }; }); });
  }
  function showBar(text) { callBar.hidden = false; callText.textContent = text; if (callBtn) callBtn.hidden = true; }
  function joinCall() {
    if (call) return;
    callJoin.hidden = true; callMute.hidden = false; callMute.textContent = 'Mute'; callMute.setAttribute('aria-pressed', 'false');
    showBar('Joining the call…');
    call = window.OVSupportCall.join({
      channel: 'support-' + cfg.conversation, token: token(),
      onState: function (s, t) { if (s === 'ended' || s === 'error') { call = null; callGone(t); } else if (t) callText.textContent = t; },
      onPeople: function (names) { callText.textContent = names.length ? 'In the call with ' + names.join(', ') + '.' : 'Calling… the visitor sees an invitation in their chat.'; },
      onScreen: showScreen,
    });
  }
  // The visitor's shared screen, above the call bar.
  var screenBox = document.getElementById('ib-screen'), screenVideo = document.getElementById('ib-screen-video'), screenWho = document.getElementById('ib-screen-who');
  function showScreen(stream, name) {
    if (!screenBox) return;
    if (!stream) { screenBox.hidden = true; screenVideo.srcObject = null; return; }
    screenWho.textContent = (name || 'The visitor') + ' is sharing their screen';
    screenVideo.srcObject = stream; screenBox.hidden = false;
  }
  var fullBtn = document.getElementById('ib-screen-full');
  if (fullBtn) fullBtn.addEventListener('click', function () { if (screenVideo.requestFullscreen) screenVideo.requestFullscreen().catch(function () {}); });
  function callOffered(by) { if (call) return; showBar(by ? by + ' started a voice call.' : 'A voice call with this visitor is open.'); callJoin.hidden = false; callMute.hidden = true; }
  function callGone(text) {
    if (call) { var c = call; call = null; c.leave(); }
    showScreen(null);
    if (!callBar) return;
    callBar.hidden = true;
    if (callBtn) callBtn.hidden = false;
    if (text && text !== 'You left the call.' && text !== 'The call ended.') alert(text);
  }
  if (callBtn && callBar && window.OVSupportCall) {
    callBtn.hidden = false;
    if (cfg.call) callOffered(null);
    callBtn.addEventListener('click', function () {
      callBtn.disabled = true;
      callApi('POST').then(function (x) { if (x.ok) joinCall(); else alert((x.d && x.d.error) || 'The call did not start.'); })
        .catch(function () { alert('You seem to be offline.'); }).then(function () { callBtn.disabled = false; });
    });
    callJoin.addEventListener('click', joinCall);
    callMute.addEventListener('click', function () { if (!call) return; call.mute(!call.muted); callMute.textContent = call.muted ? 'Unmute' : 'Mute'; callMute.setAttribute('aria-pressed', call.muted ? 'true' : 'false'); });
    callEnd.addEventListener('click', function () { callApi('DELETE').catch(function () {}); callGone(); });
  }
})();
