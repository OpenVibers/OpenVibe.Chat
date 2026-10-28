/* openvibe.chat client: the live global feed over /ws/chat and a quicker composer; DMs and the inbox
   refresh every few seconds. Pages work without this file (server-rendered, forms post); it only adds
   liveness. User text is always set with textContent, never parsed as HTML. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg) return;
  // With this file running, a message's delete button waits for a tap on the message on a touch screen (chat.css).
  if (document.documentElement && document.documentElement.classList) document.documentElement.classList.add('oc-js');
  // The icons the server draws (server/web/icons.js), for controls made here: constant markup, never user text.
  var TRASH = '<svg class="oc-i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  var feed = document.getElementById('oc-feed');
  var form = document.getElementById('oc-compose');
  var input = document.getElementById('oc-input');
  var latest = Number(cfg.latest) || 0;
  var LIVE = 'https://openvibe.live';

  // The session token (the ov_token cookie is JS-readable), presented in each socket's first message.
  function sessionToken() {
    var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  function nearBottom() { return !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120; }
  function toBottom() { if (feed) feed.scrollTop = feed.scrollHeight; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clock(ts) {
    var d = new Date(ts && String(ts).indexOf('T') < 0 ? String(ts).replace(' ', 'T') + 'Z' : ts);
    var t = el('time', 'oc-time', isNaN(d) ? '' : d.toISOString().slice(11, 16));
    if (!isNaN(d)) t.dateTime = d.toISOString();
    return t;
  }
  // ||Spoilers||: each hidden part goes in a span.oc-spoiler (pages.js renders the same), shown once selected.
  function textWithLinks(parent, text) {
    var raw = String(text || ''), sre = /\|\|([\s\S]+?)\|\|/g, last = 0, m;
    while ((m = sre.exec(raw))) {
      if (!m[1].trim()) continue;
      linksIn(parent, raw.slice(last, m.index));
      var s = el('span', 'oc-spoiler'); s.tabIndex = 0; s.setAttribute('role', 'button'); s.setAttribute('aria-label', 'Spoiler, select to show');
      linksIn(s, m[1]); parent.appendChild(s);
      last = m.index + m[0].length;
    }
    linksIn(parent, raw.slice(last));
  }
  function reveal(e) {
    var s = e.target && e.target.closest ? e.target.closest('.oc-spoiler:not(.revealed)') : null;
    if (!s || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); e.stopPropagation();
    s.classList.add('revealed'); s.removeAttribute('role'); s.removeAttribute('aria-label');
  }
  document.addEventListener('click', reveal, true);
  document.addEventListener('keydown', reveal, true);
  function linksIn(parent, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
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

  // A name with the effect its person wears (m.nameFX from Live's decor; openvibe-shared items.css draws it).
  // Their hat (m.hatFX) goes just before the name, outside the effect so a gradient cannot hide it.
  function wearing(m, text) {
    var frag = document.createDocumentFragment();
    var bf = m && m.badgeFX;
    if (bf && /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(bf.mediaId || ''))) {
      var img = document.createElement('img');
      img.className = 'ov-badge'; img.src = 'https://openvibe.media/o/' + bf.mediaId; img.alt = ''; img.width = 16; img.height = 16;
      img.setAttribute('loading', 'lazy'); img.setAttribute('aria-hidden', 'true');
      frag.appendChild(img);
    }
    var h = m && m.hatFX;
    var glyph = h && typeof h.hatChar === 'string' ? h.hatChar.slice(0, 8) : '';
    if (glyph) {
      var hat = el('span', 'ov-hat' + (['float', 'pulse', 'warp'].indexOf(h.animated) >= 0 ? ' ov-hat-' + h.animated : ''), glyph);
      hat.setAttribute('aria-hidden', 'true');
      frag.appendChild(hat);
    }
    var cls = m && m.nameFX && /^name-fx-[a-z]{2,24}$/.test(String(m.nameFX.cssClass || '')) ? m.nameFX.cssClass : null;
    frag.appendChild(cls ? el('span', 'ov-fx ' + cls, text) : document.createTextNode(text));
    return frag;
  }

  // ── Global chat ──
  function globalItem(m) {
    var li = el('li', 'oc-msg'); li.dataset.id = m.id || '';
    li.appendChild(clock(m.timestamp)); li.appendChild(document.createTextNode(' '));
    var handle = m.core_username || (m.user_id ? m.username : null);
    var name = m.display_name || m.username || m.anon_id || 'someone';
    var who;
    if (handle) { who = el('a', 'oc-name'); who.appendChild(wearing(m, name)); who.href = LIVE + '/@' + encodeURIComponent(handle); if (/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '')) who.style.setProperty('--nc', m.profile_color); }
    else who = el('span', 'oc-name oc-anon', name);
    li.appendChild(who);
    var b = badge(m.role); if (b) li.appendChild(b);
    li.appendChild(document.createTextNode(' '));
    var t = el('span', 'oc-text'); textWithLinks(t, m.message); li.appendChild(t);
    return li;
  }
  function removeIds(ids) {
    if (!feed || !Array.isArray(ids)) return;
    ids.forEach(function (id) { var x = feed.querySelector('[data-id="' + Number(id) + '"]'); if (x) x.remove(); });
  }
  // After a reconnect: what was written meanwhile, and what was deleted meanwhile (deleted_ids).
  function catchUp() {
    return fetch('/api/chat/global/history?after_id=' + latest + '&limit=200', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.messages) return;
        removeIds(d.deleted_ids);
        d.messages.forEach(function (m) { if ((m.message_type || 'chat') === 'chat' && !m.is_deleted) append(globalItem(m), m.id); });
        if (d.latest_id) latest = Math.max(latest, d.latest_id);
      }).catch(function () {});
  }
  function startGlobal() {
    var live = document.getElementById('oc-live');
    var ws = null, delay = 1000, opened = false;
    // A workspace room's queue (server/web/workspace-pages.js): its panel reloads when the socket says it changed.
    var queueBox = document.getElementById('oc-queue'), queueTimer = null;
    function refreshQueue() {
      if (!queueBox || queueTimer) return;
      queueTimer = setTimeout(function () {
        queueTimer = null;
        if (queueBox.querySelector('form :focus, details[open] input:not(:placeholder-shown), details[open] textarea:not(:placeholder-shown)')) return;
        fetch(queueBox.getAttribute('data-queue'), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.text() : null; })
          .then(function (html) { if (html) queueBox.innerHTML = html; })
          .catch(function () {});
      }, 400);
    }
    function connect() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
      ws.onopen = function () {
        delay = 1000;
        ws.send(JSON.stringify({ type: 'join', token: sessionToken() }));
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
          removeIds(m.ids || m.message_ids);
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
    var ai = m.ai_member_id != null;
    var li = el('li', 'oc-msg' + (ai ? ' oc-msg-ai' : '')); li.dataset.id = m.id || ''; li.dataset.user = m.user_id || '';
    li.appendChild(clock(m.created_at)); li.appendChild(document.createTextNode(' '));
    if (ai) {
      // An AI member of the room: its name and an AI badge, never a profile link.
      li.appendChild(el('span', 'oc-name oc-ai-name', m.display_name || 'AI'));
      li.appendChild(document.createTextNode(' '));
      var ab = el('span', 'oc-badge oc-ai', 'AI'); ab.title = 'An AI member of this room'; li.appendChild(ab);
      clearThinking();
    } else {
      var who = el('a', 'oc-name'); who.appendChild(wearing(m, m.display_name || m.username || 'someone'));
      who.href = LIVE + '/@' + encodeURIComponent(m.username || '');
      if (/^#[0-9a-f]{3,8}$/i.test(m.profile_color || '')) who.style.setProperty('--nc', m.profile_color);
      li.appendChild(who);
      var b = badge(m.user_role); if (b) li.appendChild(b);
    }
    li.appendChild(document.createTextNode(' '));
    // An AI member writes Markdown: rendered by VibeMarkdown, which escapes every character first (as the server does).
    var t;
    if (ai && window.VibeMarkdown) { t = el('div', 'oc-text vb-md'); t.innerHTML = window.VibeMarkdown.render(m.message); }
    else { t = el('span', 'oc-text'); textWithLinks(t, m.message); }
    li.appendChild(t);
    if (!ai && cfg.pics) { var pw = pictureThumbs(m.message); if (pw) li.appendChild(pw); }
    if (cfg.moderate || (cfg.me && !ai && m.user_id === cfg.me)) {
      var f = el('form', 'oc-del'); f.method = 'post'; f.action = '/r/' + encodeURIComponent(cfg.room) + '/delete/' + m.id;
      var x = el('button'); x.type = 'submit'; x.title = 'Delete this message'; x.setAttribute('aria-label', 'Delete this message'); x.innerHTML = TRASH;
      f.appendChild(x); li.appendChild(f);
    }
    return li;
  }
  // OpenVibe.Pics pictures a message links (server/rooms/pictures.js): thumbnails linked to the picture's page.
  function pictureThumbs(text) {
    var base = String(cfg.pics).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(base + '/i/([2-9a-km-zA-HJ-NP-Z]{8})\\.(jpg|png|gif|webp|avif)(?![\\w/.-])', 'g');
    var seen = {}, wrap = null, m, n = 0;
    while ((m = re.exec(String(text || ''))) && n < 4) {
      if (seen[m[1]]) continue;
      seen[m[1]] = true; n++;
      if (!wrap) wrap = el('span', 'oc-pics');
      var a = el('a', 'oc-pic'); a.href = cfg.pics + '/i/' + m[1]; a.target = '_blank'; a.rel = 'noopener';
      var img = document.createElement('img'); img.src = cfg.pics + '/i/' + m[1] + '/thumb.webp'; img.alt = 'A picture on OpenVibe.Pics'; img.loading = 'lazy'; img.decoding = 'async';
      a.appendChild(img); wrap.appendChild(a);
    }
    return wrap;
  }
  // The "Add a picture" form sends the file to the API; the message then arrives over the socket like any other.
  function startPictureForm() {
    var f = document.querySelector ? document.querySelector('.oc-pic-form') : null;
    if (!f || !window.fetch) return;
    f.addEventListener('submit', function (e) {
      var file = f.picture && f.picture.files && f.picture.files[0];
      if (!file) return;
      e.preventDefault();
      var btn = f.querySelector('button'); if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
      fetch('/api/chat/rooms/' + encodeURIComponent(f.getAttribute('data-room')) + '/pictures', {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Caption': encodeURIComponent((f.caption && f.caption.value) || '') },
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: null }; }); })
        .then(function (x) {
          if (!x.ok) { showError((x.d && x.d.error) || 'The picture did not go. Try again.'); return; }
          f.reset(); var det = f.closest ? f.closest('details') : null; if (det) det.open = false;
        })
        .catch(function () { f.submit(); })
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Send picture'; } });
    });
  }
  // "Pantry is writing…" while a room's AI member answers (room_ai_typing), until its message arrives or 40 s pass.
  var thinking = null, thinkingTimer = null;
  function clearThinking() { if (thinking) { thinking.remove(); thinking = null; } if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; } }
  function showThinking(name) {
    clearThinking();
    thinking = el('li', 'oc-msg oc-msg-ai oc-thinking', (name || 'The AI member') + ' is writing\u2026');
    thinking.setAttribute('aria-live', 'polite');
    feed.appendChild(thinking);
    thinkingTimer = setTimeout(clearThinking, 40000);
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
      ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'join_room', room: cfg.room, token: sessionToken() })); if (opened) catchUpRoom(); opened = true; };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'room_joined') { if (live) live.hidden = false; }
        else if (m.type === 'room_message' && m.room === cfg.room && m.message) {
          latest = Math.max(latest, Number(m.message.id) || 0);
          append(roomItem(m.message), m.message.id);
          if (!document.hidden && cfg.me) fetch(api + '/read', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ last_id: latest }) }).catch(function () {});
        } else if (m.type === 'room_task' && m.room === cfg.room) {
          refreshQueue();
        } else if (m.type === 'room_ai_typing' && m.room === cfg.room) {
          showThinking(m.name);
        } else if (m.type === 'room_message_deleted' && m.room === cfg.room) {
          var x = feed.querySelector('[data-id="' + m.id + '"]'); if (x) x.remove();
        } else if (m.type === 'room_error' && m.message) {
          showError(m.message);
        } else if (m.type === 'room_left') {
          showError('You can no longer read this room.'); setTimeout(function () { location.href = cfg.back || '/rooms'; }, 1500);
        } else if (m.type === 'room_access' && m.room === cfg.room && m.can) {
          // Your role changed (a moderator made you a member, a speaker, a viewer…): the page shows what you may do now.
          if (!!m.can.post !== !!cfg.post || (m.role || null) !== (cfg.role || null)) { showError('Your role in this room changed.'); setTimeout(function () { location.reload(); }, 1200); }
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

  // ── The inbox: conversations and unread counts, refreshed while the page is open ──
  function convItem(c, me) {
    var li = el('li', 'oc-conv' + (c.unread_count ? ' oc-unread' : ''));
    var a = el('a'); a.href = '/messages/' + encodeURIComponent(c.id);
    var others = (c.participants || []).filter(function (p) { return p.id !== me; });
    a.appendChild(el('strong', null, c.name || others.map(function (p) { return p.display_name || p.username; }).join(', ') || 'Just you'));
    if (c.unread_count) { a.appendChild(document.createTextNode(' ')); a.appendChild(el('span', 'oc-badge', c.unread_count + ' new')); }
    a.appendChild(el('span', 'oc-muted oc-last', c.last_message ? String(c.last_message).slice(0, 120) : 'No messages yet'));
    li.appendChild(a);
    if (c.last_message_at) {
      var d = new Date(String(c.last_message_at).indexOf('T') < 0 ? String(c.last_message_at).replace(' ', 'T') + 'Z' : c.last_message_at);
      if (!isNaN(d)) { var t = el('time', 'oc-time', d.toISOString().slice(0, 10)); t.dateTime = d.toISOString(); li.appendChild(t); }
    }
    return li;
  }
  function startInbox() {
    var list = document.getElementById('oc-convs');
    var status = document.getElementById('oc-inbox-status');
    var me = Number(cfg.me) || null;
    function poll() {
      if (document.hidden || !list) return;
      fetch('/api/dm/conversations', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !Array.isArray(d.conversations)) return;
          var unread = 0;
          list.textContent = '';
          d.conversations.forEach(function (c) { unread += Number(c.unread_count) || 0; list.appendChild(convItem(c, me)); });
          if (!d.conversations.length) list.appendChild(el('li', 'oc-muted', 'No conversations yet.'));
          if (status) status.textContent = unread ? unread + ' unread' : 'All caught up';
        }).catch(function () {});
    }
    setInterval(poll, 15000);
    document.addEventListener('visibilitychange', poll);
  }

  if (input) input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
  });
  // A server's channel list folds away on a phone: the channel's own header says where you are.
  var chans = document.querySelector ? document.querySelector('.oc-srv-channels') : null;
  if (chans && window.matchMedia && window.matchMedia('(max-width: 760px)').matches) chans.open = false;
  // A tap on a message (not on its links or buttons) shows its delete button on a touch screen; another hides it.
  if (feed) feed.addEventListener('click', function (e) {
    if (!e.target.closest || e.target.closest('a, button, input, summary, .oc-spoiler')) return;
    var li = e.target.closest('.oc-msg');
    if (!li || !li.querySelector('.oc-del')) return;
    var on = !li.classList.contains('oc-sel');
    Array.prototype.forEach.call(feed.querySelectorAll('.oc-sel'), function (x) { x.classList.remove('oc-sel'); });
    if (on) li.classList.add('oc-sel');
  });
  // Copy buttons (a task's result): shown only where the clipboard works.
  if (navigator.clipboard && document.querySelectorAll) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-oc-copy]'), function (b) {
      var target = document.querySelector(b.getAttribute('data-oc-copy'));
      if (!target) return;
      b.hidden = false;
      b.addEventListener('click', function () {
        navigator.clipboard.writeText(target.innerText || target.textContent || '').then(function () {
          b.classList.add('is-done'); b.setAttribute('aria-label', 'Copied'); b.title = 'Copied';
          setTimeout(function () { b.classList.remove('is-done'); b.setAttribute('aria-label', 'Copy the result'); b.title = 'Copy'; }, 1800);
        }, function () {});
      });
    });
  }
  toBottom();
  if (cfg.view === 'global') startGlobal();
  else if (cfg.view === 'dm') startDm();
  else if (cfg.view === 'room') { startRoom(); startPictureForm(); }
  else if (cfg.view === 'inbox') startInbox();
})();
