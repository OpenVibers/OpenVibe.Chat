/* A chat room in a frame on any website (server/web/room-embed-pages.js /embed/room/:slug). Anyone reads; the room's
   messages arrive over the chat socket (join_room). To write, a person signs in through a window on openvibe.chat:
   this frame makes a random ticket, opens /embed/signin#t=…, and asks /embed/ticket until the window has bound it
   to their session; the token it gets back is kept in this frame's own storage (partitioned by the site embedding
   it) and sent with join_room. Everything a person wrote is set with textContent; links are made with DOM nodes. */
(function () {
  'use strict';
  var root = document.getElementById('re');
  if (!root) return;
  var slug = root.getAttribute('data-room');
  var KEY = 'ov-embed-token';
  var thread = document.getElementById('re-thread');
  var form = document.getElementById('re-form');
  var input = document.getElementById('re-input');
  var dock = document.getElementById('re-dock');
  var signinBtn = document.getElementById('re-signin');
  var whoEl = document.getElementById('re-who');
  var errEl = root.querySelector('.em-error');
  var token = store(function (s) { return s.getItem(KEY); }) || null;
  var ws = null, delay = 1000, latest = 0, can = {}, role = null, polling = null;

  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toParent(msg) { try { window.parent.postMessage(Object.assign({ ov: 'chat' }, msg), '*'); } catch (e) { /* not framed */ } }
  function bottom() { thread.scrollTop = thread.scrollHeight; }
  function error(text) { errEl.textContent = text || ''; errEl.hidden = !text; }
  function nearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120; }

  // Text with its http(s) links as links, built from nodes.
  function textNodes(parent, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var url = m[0].replace(/[.,!?)]+$/, ''); var a = el('a', null, url); a.href = url; a.target = '_blank'; a.rel = 'noopener nofollow ugc';
      parent.appendChild(a); last = m.index + url.length; re.lastIndex = last;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function render(m) {
    if (!m || thread.querySelector('[data-id="' + m.id + '"]')) return;
    var empty = document.getElementById('re-empty'); if (empty) empty.remove();
    var stick = nearBottom();
    var li = el('li', 're-msg' + (m.ai_member_id != null ? ' re-ai' : '')); li.dataset.id = String(m.id);
    li.appendChild(el('b', null, m.display_name || m.username || 'someone'));
    if (m.ai_member_id != null) li.appendChild(el('span', 're-badge', 'AI'));
    li.appendChild(document.createTextNode(' '));
    var t = el('span', 're-text'); textNodes(t, String(m.message || '')); li.appendChild(t);
    thread.appendChild(li);
    latest = Math.max(latest, Number(m.id) || 0);
    if (stick) bottom();
    if (m.ai_member_id == null) toParent({ type: 'message', author: 'room' });
  }
  // The server's first page: links, and where the newest is.
  Array.prototype.forEach.call(thread.querySelectorAll('.re-msg'), function (li) {
    latest = Math.max(latest, Number(li.dataset.id) || 0);
    var t = li.querySelector('.re-text'); if (t) { var raw = t.textContent; t.textContent = ''; textNodes(t, raw); }
  });

  function dockState() {
    form.hidden = !(token && can.post);
    dock.textContent = '';
    if (!token) { dock.appendChild(signinBtn); signinBtn.disabled = !!polling; signinBtn.textContent = polling ? 'Finish signing in in the window…' : 'Sign in with OpenVibe to chat'; }
    else if (!can.post && !role) { var j = el('button', 're-signin', 'Join this room to chat'); j.type = 'button'; j.addEventListener('click', join); dock.appendChild(j); }
    else if (!can.post) dock.appendChild(el('p', 'em-system', 'You can read this room but not write in it.'));
    whoEl.textContent = '';
    if (token) {
      whoEl.appendChild(document.createTextNode(' · '));
      var out = el('a', null, 'Sign out'); out.href = '#'; out.addEventListener('click', function (e) { e.preventDefault(); signOut(); });
      whoEl.appendChild(out);
    }
  }

  function connect() {
    if (!window.WebSocket) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'join_room', room: slug, token: token || undefined })); catchUp(); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'room_joined' && m.room === slug) { can = m.can || {}; role = m.role || null; dockState(); }
      else if (m.type === 'room_message' && m.room === slug) render(m.message);
      else if (m.type === 'room_error') error(m.message || 'Something went wrong.');
    };
    ws.onclose = function () { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
  }
  function reconnect() { if (ws) { ws.onclose = null; try { ws.close(); } catch (e) { /* closed */ } } connect(); }
  function catchUp() {
    if (!latest) return;
    fetch('/api/chat/rooms/' + encodeURIComponent(slug) + '/messages?after=' + latest, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && d.messages) d.messages.forEach(render); }).catch(function () {});
  }

  // Sign in through a window on openvibe.chat, then collect the token with the ticket.
  function newTicket() {
    var b = new Uint8Array(32); crypto.getRandomValues(b);
    return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  signinBtn.addEventListener('click', function () {
    var ticket = newTicket();
    // The ticket rides in the fragment: the window keeps it in its own storage, and no server or log sees it.
    var w = window.open('/embed/signin#t=' + ticket, 'ovchat-signin', 'width=480,height=680');
    if (!w) { error('Allow pop-ups for this site to sign in, or open the room on OpenVibe.'); return; }
    error('');
    var started = Date.now();
    polling = setInterval(function () {
      if (Date.now() - started > 120000) { clearInterval(polling); polling = null; dockState(); return; }
      fetch('/embed/ticket', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: ticket }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.token) return;
          clearInterval(polling); polling = null;
          token = d.token; store(function (s) { s.setItem(KEY, token); });
          dockState(); reconnect(); input.focus();
        }).catch(function () {});
    }, 1500);
    dockState();
  });
  function signOut() { token = null; can = {}; role = null; store(function (s) { s.removeItem(KEY); }); dockState(); reconnect(); }
  function join() {
    fetch('/api/chat/rooms/' + encodeURIComponent(slug) + '/join', { method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { if (r.status === 401) { signOut(); return; } if (!r.ok) return r.json().then(function (d) { error((d && d.error) || 'That did not work.'); }); reconnect(); })
      .catch(function () { error('You seem to be offline.'); });
  }

  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    error('');
    ws.send(JSON.stringify({ type: 'room_message', message: text }));
    input.value = ''; grow(); bottom();
  });
  var close = root.querySelector('[data-close]');
  if (close) close.addEventListener('click', function () { toParent({ type: 'close' }); });
  window.addEventListener('message', function (e) { if (e.data && e.data.ov === 'chat' && e.data.type === 'visible' && e.data.visible) bottom(); });

  dockState();
  bottom();
  connect();
})();
