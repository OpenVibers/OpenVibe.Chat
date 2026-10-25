/* Vibe on openvibe.chat (server/web/vibe-pages.js): makes the app live. The page works without this file (forms post,
   the server renders every message); here a first message starts the chat in place, answers arrive over the room
   socket (/ws/chat join_room, room_message, room_ai_typing), the composer grows with its text and sends on Enter, the
   rail slides in on phones, and a draft typed while signed out survives the sign-in. A person's text is always set
   with textContent; Vibe's answers go through VibeMarkdown (public/web/vibe-md.js), which escapes everything first. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || cfg.view !== 'vibe') return;
  var MD = window.VibeMarkdown;
  var DRAFT = 'ov-vibe-draft';
  var app = document.getElementById('vb');
  var scroll = document.getElementById('vb-scroll');
  var form = document.getElementById('vb-composer');
  var input = document.getElementById('vb-input');
  var titleEl = document.getElementById('vb-title');
  var room = cfg.room || null;
  var latest = Number(cfg.latest) || 0;
  var ws = null, delay = 1000, sending = false, waitTimer = null;
  var fileInput = document.getElementById('vb-file');
  var previewEl = document.getElementById('vb-preview');
  var picture = null;   // { file, url }: a picture waiting to go with the next message

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function token() { var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || ''); return m ? decodeURIComponent(m[1]) : undefined; }
  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  function nearBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160; }
  function toBottom() { scroll.scrollTop = scroll.scrollHeight; }
  function markSvg() {
    var s = el('span', 'vb-mark'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 5l7 14 7-14"/></svg>';
    return s;
  }

  // ── The composer ──
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; form.classList.toggle('is-empty', !input.value.trim() && !picture); }
  if (input) {
    input.addEventListener('input', grow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.submit(); }
    });
    var saved = cfg.signedIn ? store(function (s) { var v = s.getItem(DRAFT); s.removeItem(DRAFT); return v; }) : null;
    if (saved && !input.value) input.value = saved;
    grow();
    if (!('ontouchstart' in window)) input.focus();
  }
  document.querySelectorAll('.vb-chip[data-prompt]').forEach(function (b) {
    b.addEventListener('click', function () { input.value = b.getAttribute('data-prompt'); grow(); form.requestSubmit ? form.requestSubmit() : form.submit(); });
  });

  // ── A picture with the message: it goes to OpenVibe.Pics as the person, and Vibe sees it ──
  var PIC_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/;
  function clearPicture() {
    if (picture && picture.url) URL.revokeObjectURL(picture.url);
    picture = null;
    if (previewEl) { previewEl.textContent = ''; previewEl.hidden = true; }
    if (fileInput) fileInput.value = '';
    if (input) input.required = true;
  }
  function choosePicture(file) {
    if (!file) return;
    if (!PIC_TYPES.test(file.type)) { notice('Send a JPEG, PNG, GIF, WebP or AVIF picture.'); return; }
    if (file.size > 20 * 1024 * 1024) { notice('A picture can be up to 20 MB.'); return; }
    clearPicture();
    picture = { file: file, url: URL.createObjectURL(file) };
    var fig = el('figure');
    var img = el('img'); img.src = picture.url; img.alt = 'The picture you are sending';
    var rm = el('button', null, '\u00d7'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove the picture');
    rm.addEventListener('click', function () { clearPicture(); input.focus(); });
    fig.appendChild(img); fig.appendChild(rm);
    previewEl.appendChild(fig); previewEl.hidden = false;
    input.required = false;
    form.classList.remove('is-empty');
    input.focus();
  }
  var attachBtn = app.querySelector('[data-vb-attach]');
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { choosePicture(fileInput.files && fileInput.files[0]); });
    // A picture pasted into the composer goes the same way.
    input.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.files) || [];
      if (items.length && PIC_TYPES.test(items[0].type)) { e.preventDefault(); choosePicture(items[0]); }
    });
  }

  // ── The thread ──
  function thread() {
    var t = document.getElementById('vb-thread');
    if (t) return t;
    var hello = scroll.querySelector('.vb-hello'); if (hello) hello.remove();
    app.classList.remove('vb-empty');
    t = el('ol', 'vb-thread'); t.id = 'vb-thread';
    scroll.appendChild(t);
    return t;
  }
  function have(id) { return id && document.querySelector('.vb-turn[data-id="' + Number(id) + '"]'); }
  function meTurn(text, id, localPicture) {
    var li = el('li', 'vb-turn vb-me'); if (id) li.dataset.id = String(id);
    var b = el('div', 'vb-bubble'); b.appendChild(el('p', 'oc-sr', 'You said:'));
    String(text).split('\n').forEach(function (line, i) { if (i) b.appendChild(document.createElement('br')); b.appendChild(document.createTextNode(line)); });
    if (localPicture) { var img = el('img', 'vb-local'); img.src = localPicture; img.alt = 'Your picture'; b.appendChild(img); }
    li.appendChild(b);
    return li;
  }
  function aiTurn(m) {
    var li = el('li', 'vb-turn vb-ai'); li.dataset.id = String(m.id);
    li.appendChild(markSvg());
    var body = el('div', 'vb-body'); body.appendChild(el('p', 'oc-sr', 'Vibe said:'));
    var md = el('div', 'vb-md'); md.innerHTML = MD ? MD.render(m.message) : '';
    if (!MD) md.textContent = m.message;
    body.appendChild(md); li.appendChild(body);
    return li;
  }
  // "How Vibe did this" under an agent task's answer that arrives while the page is open (the server folds it on load).
  function attachHow(li, id) {
    if (!room) return;
    fetch('/api/chat/vibe/' + encodeURIComponent(room) + '/how', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var info = d && d.how && d.how[String(id)];
      var body = li.querySelector('.vb-body');
      if (!info || !body || body.querySelector('.vb-how')) return;
      var det = el('details', 'vb-how'); det.appendChild(el('summary', null, 'How Vibe did this'));
      var ul = el('ul');
      (info.lines || []).forEach(function (l) { ul.appendChild(el('li', null, l)); });
      if (info.sources && info.sources.length) {
        var src = el('li', null, 'Sources: ');
        info.sources.forEach(function (u, i) {
          if (!/^https?:\/\//.test(u)) return;
          if (i) src.appendChild(document.createTextNode(', '));
          var a = el('a', null, u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]); a.href = u; a.rel = 'nofollow ugc noopener'; a.target = '_blank';
          src.appendChild(a);
        });
        ul.appendChild(src);
      }
      if (info.actor_url && /^https:\/\/openvibe\.actor\//.test(info.actor_url)) { var li2 = el('li'); var a2 = el('a', null, 'Every step on OpenVibe Agents'); a2.href = info.actor_url; li2.appendChild(a2); ul.appendChild(li2); }
      det.appendChild(ul); body.appendChild(det);
    }).catch(function () {});
  }
  function clearWait() { var w = document.getElementById('vb-wait'); if (w) w.remove(); if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; } }
  function showWait() {
    if (document.getElementById('vb-wait')) return;
    var li = el('li', 'vb-turn vb-ai vb-wait'); li.id = 'vb-wait';
    li.appendChild(markSvg());
    var body = el('div', 'vb-body'); var dots = el('span', 'vb-dots'); dots.setAttribute('aria-label', 'Vibe is writing');
    dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    body.appendChild(dots); li.appendChild(body);
    thread().appendChild(li);
    // An answer takes up to a minute with tools; after two the dots give way to a way forward.
    waitTimer = setTimeout(function () { clearWait(); notice('Vibe did not answer this time. Send your message again, or try again in a minute.'); }, 120000);
  }
  function notice(text) {
    var old = scroll.querySelector('.vb-live-notice'); if (old) old.remove();
    var p = el('p', 'oc-notice oc-error vb-live-notice', text); p.setAttribute('role', 'alert');
    scroll.appendChild(p); toBottom();
  }
  function add(m) {
    if (!m || have(m.id)) return;
    latest = Math.max(latest, Number(m.id) || 0);
    var stick = nearBottom();
    if (m.ai_member_id) {
      clearWait(); var turnEl = aiTurn(m); thread().appendChild(turnEl); refreshRail();
      if (/^✅ Done:/.test(String(m.message || ''))) attachHow(turnEl, m.id);
    }
    else {
      // The line sent from here already shows (without an id until the server answered): give it its id.
      var pending = document.querySelector('.vb-turn.vb-me:not([data-id])');
      if (pending && Number(m.user_id) === Number(cfg.me)) pending.dataset.id = String(m.id);
      else thread().appendChild(meTurn(m.message, m.id));
    }
    if (stick) toBottom();
  }

  // ── Live ──
  function catchUp() {
    if (!room) return Promise.resolve();
    return fetch('/api/chat/rooms/' + encodeURIComponent(room) + '/messages?after=' + latest + '&limit=200', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.messages) d.messages.forEach(add); })
      .catch(function () {});
  }
  function connect() {
    if (!room || !window.WebSocket) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'join_room', room: room, token: token() })); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'room_joined') catchUp();
      else if (m.type === 'room_message' && m.room === room) add(m.message);
      else if (m.type === 'room_ai_typing' && m.room === room) { showWait(); if (nearBottom()) toBottom(); }
      else if (m.type === 'room_message_deleted' && m.room === room) { var x = have(m.id); if (x) x.remove(); }
      else if (m.type === 'auth_revoked') notice('You were signed out. Sign in again to keep chatting.');
    };
    ws.onclose = function () { ws = null; if (room) { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); } };
  }

  // ── The rail ──
  function refreshRail() {
    fetch('/api/chat/vibe?limit=100', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var allow = document.getElementById('vb-allow');
      if (allow && d.allowance) allow.textContent = Math.max(0, d.allowance.per_day - d.allowance.used_today) + ' of ' + d.allowance.per_day + ' answers left today';
      var list = document.querySelector('.vb-rail-list'); if (!list || !d.chats) return;
      // Rebuilt from data with text nodes (the server's grouping, kept simple here: Today and Earlier).
      var start = new Date(); start.setUTCHours(0, 0, 0, 0);
      list.textContent = '';
      var groups = [{ label: 'Today', chats: [] }, { label: 'Earlier', chats: [] }];
      d.chats.forEach(function (c) { var at = Date.parse(String(c.last_message_at).indexOf('T') < 0 ? String(c.last_message_at).replace(' ', 'T') + 'Z' : c.last_message_at); (at >= start.getTime() ? groups[0] : groups[1]).chats.push(c); });
      groups.forEach(function (g) {
        if (!g.chats.length) return;
        list.appendChild(el('p', 'vb-group', g.label));
        var ul = el('ul', 'vb-chats');
        g.chats.forEach(function (c) {
          var li = el('li'); var a = el('a', 'vb-chat', c.name); a.href = '/vibe/' + c.slug;
          if (c.slug === room) a.setAttribute('aria-current', 'page');
          li.appendChild(a); ul.appendChild(li);
        });
        list.appendChild(ul);
      });
    }).catch(function () {});
  }
  function setRail(open) {
    app.classList.toggle('is-open', open);
    var scrim = app.querySelector('.vb-scrim'); if (scrim) scrim.hidden = !open;
    var btn = app.querySelector('[data-vb-open]'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  app.addEventListener('click', function (e) {
    if (e.target.closest('[data-vb-open]')) setRail(true);
    else if (e.target.closest('[data-vb-close]')) setRail(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && app.classList.contains('is-open')) setRail(false); });
  // ── Search chats: typing narrows the listed chats by name at once; Enter searches inside them too (?q=) ──
  var q = document.getElementById('vb-q');
  var searched = null;
  try { searched = new URLSearchParams(location.search).get('q'); } catch (e) { searched = null; }
  if (q && searched) q.value = searched.slice(0, 80);   // the page never repeats it (server/web/vibe-pages.js)
  if (q && !searched) q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase();
    var list = document.querySelector('.vb-rail-list'); if (!list) return;
    [].forEach.call(list.querySelectorAll('.vb-chats'), function (ul) {
      var shown = 0;
      [].forEach.call(ul.children, function (li) { var hit = !v || li.textContent.toLowerCase().indexOf(v) >= 0; li.hidden = !hit; if (hit) shown++; });
      ul.hidden = !shown;
      var head = ul.previousElementSibling; if (head && head.classList.contains('vb-group')) head.hidden = !shown;
    });
  });
  // Forms that undo something (Memory's "Forget everything") ask first.
  [].forEach.call(app.querySelectorAll('form[data-vb-confirm]'), function (f) { f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-vb-confirm'))) e.preventDefault(); }); });
  var del = app.querySelector('[data-vb-delete]');
  if (del) del.addEventListener('submit', function (e) { if (!window.confirm('Delete this chat? Its messages go too.')) e.preventDefault(); });

  // ── Modes: the box says what the chosen one will do ──
  if (form) [].forEach.call(form.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', function () { if (r.checked && input && r.getAttribute('data-placeholder') && !form.dataset.signin) input.placeholder = r.getAttribute('data-placeholder'); input.focus(); });
  });

  // ── Sending ──
  if (form) form.addEventListener('submit', function (e) {
    var text = input.value.trim();
    if (!text && !picture) { e.preventDefault(); return; }
    if (form.dataset.signin) {
      // Signed out: the draft waits in this browser while they sign in, and comes back in the composer.
      e.preventDefault();
      store(function (s) { s.setItem(DRAFT, text); });
      location.href = '/auth/login?next=' + encodeURIComponent(location.pathname);
      return;
    }
    if (!window.fetch || sending) return;
    e.preventDefault();
    sending = true;
    var old = scroll.querySelector('.vb-live-notice'); if (old) old.remove();
    var sendingPicture = picture;
    var mine = meTurn(text, null, sendingPicture && sendingPicture.url);
    thread().appendChild(mine);
    showWait(); toBottom();
    input.value = ''; picture = null; if (previewEl) { previewEl.textContent = ''; previewEl.hidden = true; } if (fileInput) fileInput.value = ''; input.required = true; grow();
    var url, init;
    var modeEl = form.querySelector('input[name="mode"]:checked'), mode = modeEl ? modeEl.value : 'chat';
    if (mode !== 'chat' && !sendingPicture) {
      // Research, Agent or Code: an agent task of this chat; Vibe says it is on it, and the result comes back here.
      url = room ? '/api/chat/vibe/' + encodeURIComponent(room) + '/ask' : '/api/chat/vibe';
      init = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, mode: mode }) };
    } else if (sendingPicture) {
      // The picture is the body; the question rides in X-Caption. A new chat starts with it (/api/chat/vibe/picture).
      url = room ? '/api/chat/rooms/' + encodeURIComponent(room) + '/pictures' : '/api/chat/vibe/picture';
      init = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': sendingPicture.file.type, 'X-Caption': encodeURIComponent(text) }, body: sendingPicture.file };
    } else {
      url = room ? '/api/chat/rooms/' + encodeURIComponent(room) + '/messages' : '/api/chat/vibe';
      init = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) };
    }
    fetch(url, init)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: null }; }); })
      .then(function (x) {
        if (!x.ok) { mine.remove(); clearWait(); input.value = text; if (sendingPicture) choosePicture(sendingPicture.file); grow(); notice((x.d && x.d.error) || 'That did not send. Try again.'); return; }
        if (x.d.message && x.d.message.id) { mine.dataset.id = String(x.d.message.id); latest = Math.max(latest, Number(x.d.message.id)); }
        if (!room && x.d.room) {
          room = x.d.room.slug;
          history.replaceState(null, '', '/vibe/' + room);
          if (titleEl) titleEl.textContent = x.d.room.name;
          document.title = x.d.room.name + ' · Vibe · OpenVibe.Chat';
          form.action = '/vibe/' + room;
          refreshRail();
          connect();
        }
      })
      .catch(function () { mine.remove(); clearWait(); input.value = text; if (sendingPicture) choosePicture(sendingPicture.file); grow(); notice('You seem to be offline. Your message is back in the box.'); })
      .then(function () { sending = false; });
  });

  if (cfg.waiting) showWait();
  connect();
  if (!cfg.memory) toBottom();   // the Memory page reads from the top
  window.addEventListener('pagehide', function () { var w = ws; room = null; if (w) w.close(); });
})();
