/* openvibe.chat client: the live global feed over /ws/chat and a quicker composer; DMs refresh every few
   seconds. Pages work without this file (server-rendered, forms post); it only adds liveness. User text
   is always set with textContent, never parsed as HTML. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg) return;
  var feed = document.getElementById('oc-feed');
  var form = document.getElementById('oc-compose');
  var input = document.getElementById('oc-input');
  var latest = Number(cfg.latest) || 0;
  var LIVE = 'https://openvibe.live';

  function nearBottom() { return !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120; }
  function toBottom() { if (feed) feed.scrollTop = feed.scrollHeight; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clock(ts) {
    var d = new Date(ts && String(ts).indexOf('T') < 0 ? String(ts).replace(' ', 'T') + 'Z' : ts);
    var t = el('time', 'oc-time', isNaN(d) ? '' : d.toISOString().slice(11, 16));
    if (!isNaN(d)) t.dateTime = d.toISOString();
    return t;
  }
  function textWithLinks(parent, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    text = String(text || '');
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = el('a', null, m[0]); a.href = m[0]; a.rel = 'nofollow ugc noopener'; a.target = '_blank';
      parent.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  // Display only (the server decides who may do what): the same badges the page renders.
  var BADGES = { admin: ['oc-badge oc-badge-staff', 'staff'], global_mod: ['oc-badge oc-badge-mod', 'mod'] };
  function badge(role) { var b = BADGES[role]; return b ? el('span', b[0], b[1]) : null; }
  function removeEmpty() { var e = feed && feed.querySelector('.oc-empty'); if (e) e.remove(); }
  function append(li, id) {
    if (!feed) return;
    if (id && feed.querySelector('[data-id="' + id + '"]')) return;
    var stick = nearBottom();
    removeEmpty();
    feed.appendChild(li);
    while (feed.children.length > 300) feed.removeChild(feed.firstChild);
    if (stick) toBottom();
  }
  function showError(text) {
    var p = document.querySelector('.oc-live-error');
    if (!p) { p = el('p', 'oc-notice oc-error oc-live-error'); p.setAttribute('role', 'alert'); (form || feed).insertAdjacentElement('beforebegin', p); }
    p.textContent = text;
    clearTimeout(showError.t); showError.t = setTimeout(function () { p.remove(); }, 6000);
  }

  // ── Global chat ──
  function globalItem(m) {
    var li = el('li', 'oc-msg'); li.dataset.id = m.id || '';
    li.appendChild(clock(m.timestamp)); li.appendChild(document.createTextNode(' '));
    var handle = m.core_username || (m.user_id ? m.username : null);
    var name = m.display_name || m.username || m.anon_id || 'someone';
    var who;
    if (handle) { who = el('a', 'oc-name', name); who.href = LIVE + '/@' + encodeURIComponent(handle); if (/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '')) who.style.setProperty('--nc', m.profile_color); }
    else who = el('span', 'oc-name oc-anon', name);
    li.appendChild(who);
    var b = badge(m.role); if (b) li.appendChild(b);
    li.appendChild(document.createTextNode(' '));
    var t = el('span', 'oc-text'); textWithLinks(t, m.message); li.appendChild(t);
    return li;
  }
  function catchUp() {
    return fetch('/api/chat/global/history?after_id=' + latest + '&limit=200', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.messages) return;
        d.messages.forEach(function (m) { if ((m.message_type || 'chat') === 'chat' && !m.is_deleted) append(globalItem(m), m.id); });
        if (d.latest_id) latest = Math.max(latest, d.latest_id);
      }).catch(function () {});
  }
  function startGlobal() {
    var live = document.getElementById('oc-live');
    var ws = null, delay = 1000, opened = false;
    function connect() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
      ws.onopen = function () {
        delay = 1000;
        ws.send(JSON.stringify({ type: 'join' }));
        if (live) live.hidden = false;
        if (opened) catchUp();
        opened = true;
      };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'chat' && m.is_global) {
          if (m.id) latest = Math.max(latest, Number(m.id));
          append(globalItem(m), m.id);
        } else if (m.type === 'delete-messages' && Array.isArray(m.ids || m.message_ids)) {
          (m.ids || m.message_ids).forEach(function (id) { var x = feed.querySelector('[data-id="' + id + '"]'); if (x) x.remove(); });
        } else if (m.type === 'error' && m.message) {
          showError(m.message);
        } else if (m.type === 'auth_revoked') {
          showError('You were signed out. Sign in again to keep chatting.');
        }
      };
      ws.onclose = function () {
        if (live) live.hidden = true;
        setTimeout(connect, delay); delay = Math.min(delay * 2, 30000);
      };
    }
    connect();
    if (form && input) {
      form.addEventListener('submit', function (e) {
        var text = input.value.trim();
        if (!text) { e.preventDefault(); return; }
        if (!ws || ws.readyState !== 1) return;           // not connected: the form posts as without JavaScript
        e.preventDefault();
        ws.send(JSON.stringify({ type: 'chat', message: text }));
        input.value = '';
        input.focus();
      });
    }
  }

  // ── A conversation ──
  function dmItem(m) {
    var li = el('li', 'oc-msg' + (m.sender_id === cfg.me ? ' oc-mine' : '')); li.dataset.id = m.id || '';
    li.appendChild(clock(m.created_at)); li.appendChild(document.createTextNode(' '));
    li.appendChild(el('span', 'oc-name', m.display_name || m.username));
    li.appendChild(document.createTextNode(' '));
    var t = el('span', 'oc-text'); textWithLinks(t, m.message); li.appendChild(t);
    return li;
  }
  function startDm() {
    var base = '/api/dm/conversations/' + encodeURIComponent(cfg.conversation);
    function poll() {
      if (document.hidden) return;
      fetch(base + '/messages?after=' + latest + '&limit=100', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.messages || !d.messages.length) return;
          d.messages.forEach(function (m) { latest = Math.max(latest, Number(m.id) || 0); append(dmItem(m), m.id); });
          fetch(base + '/read', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
        }).catch(function () {});
    }
    setInterval(poll, 4000);
    document.addEventListener('visibilitychange', poll);
    if (form && input) {
      form.addEventListener('submit', function (e) {
        var text = input.value.trim();
        if (!text) { e.preventDefault(); return; }
        e.preventDefault();
        var btn = form.querySelector('button'); if (btn) btn.disabled = true;
        fetch(base + '/messages', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok) { showError((x.d && x.d.error) || 'Could not send'); return; }
            if (x.d && x.d.message) { latest = Math.max(latest, Number(x.d.message.id) || 0); append(dmItem(x.d.message), x.d.message.id); }
            input.value = ''; input.focus();
          })
          .catch(function () { form.submit(); })
          .then(function () { if (btn) btn.disabled = false; });
      });
    }
  }

  // ── A room ──
  function roomItem(m) {
    var li = el('li', 'oc-msg'); li.dataset.id = m.id || ''; li.dataset.user = m.user_id || '';
    li.appendChild(clock(m.created_at)); li.appendChild(document.createTextNode(' '));
    var who = el('a', 'oc-name', m.display_name || m.username || 'someone');
    who.href = LIVE + '/@' + encodeURIComponent(m.username || '');
    if (/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '')) who.style.setProperty('--nc', m.profile_color);
    li.appendChild(who);
    var b = badge(m.user_role); if (b) li.appendChild(b);
    li.appendChild(document.createTextNode(' '));
    var t = el('span', 'oc-text'); textWithLinks(t, m.message); li.appendChild(t);
    if (cfg.moderate || (cfg.me && m.user_id === cfg.me)) {
      var f = el('form', 'oc-del'); f.method = 'post'; f.action = '/r/' + encodeURIComponent(cfg.room) + '/delete/' + m.id;
      var x = el('button', null, '×'); x.type = 'submit'; x.title = 'Delete this message'; x.setAttribute('aria-label', 'Delete this message');
      f.appendChild(x); li.appendChild(f);
    }
    return li;
  }
  function startRoom() {
    var live = document.getElementById('oc-live');
    var ws = null, delay = 1000, opened = false;
    var api = '/api/chat/rooms/' + encodeURIComponent(cfg.room);
    function catchUpRoom() {
      return fetch(api + '/messages?after=' + latest + '&limit=200', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.messages) d.messages.forEach(function (m) { latest = Math.max(latest, Number(m.id) || 0); append(roomItem(m), m.id); }); })
        .catch(function () {});
    }
    function connect() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
      ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'join_room', room: cfg.room })); if (opened) catchUpRoom(); opened = true; };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'room_joined') { if (live) live.hidden = false; }
        else if (m.type === 'room_message' && m.room === cfg.room && m.message) {
          latest = Math.max(latest, Number(m.message.id) || 0);
          append(roomItem(m.message), m.message.id);
          if (!document.hidden && cfg.me) fetch(api + '/read', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ last_id: latest }) }).catch(function () {});
        } else if (m.type === 'room_message_deleted' && m.room === cfg.room) {
          var x = feed.querySelector('[data-id="' + m.id + '"]'); if (x) x.remove();
        } else if (m.type === 'room_error' && m.message) {
          showError(m.message);
        } else if (m.type === 'room_left') {
          showError('You can no longer read this room.'); setTimeout(function () { location.href = '/rooms'; }, 1500);
        } else if (m.type === 'auth_revoked') {
          showError('You were signed out. Sign in again to keep chatting.');
        }
      };
      ws.onclose = function () { if (live) live.hidden = true; setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
    }
    connect();
    if (form && input) {
      form.addEventListener('submit', function (e) {
        var text = input.value.trim();
        if (!text) { e.preventDefault(); return; }
        if (!ws || ws.readyState !== 1) return;
        e.preventDefault();
        ws.send(JSON.stringify({ type: 'room_message', message: text }));
        input.value = ''; input.focus();
      });
    }
    if (feed) feed.addEventListener('submit', function (e) {
      var f = e.target; if (!f.classList || !f.classList.contains('oc-del')) return;
      e.preventDefault();
      var li = f.closest('.oc-msg');
      fetch(api + '/messages/' + encodeURIComponent(li.dataset.id), { method: 'DELETE', credentials: 'same-origin' })
        .then(function (r) { if (r.ok) li.remove(); else return r.json().then(function (d) { showError((d && d.error) || 'Could not delete'); }); })
        .catch(function () { f.submit(); });
    });
  }

  if (input) input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
  });
  toBottom();
  if (cfg.view === 'global') startGlobal();
  else if (cfg.view === 'dm') startDm();
  else if (cfg.view === 'room') startRoom();
})();
