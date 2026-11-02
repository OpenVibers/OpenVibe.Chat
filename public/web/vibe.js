/* Vibe on openvibe.chat (server/web/vibe-pages.js): makes the app live. The page is the network's conversation UI
   (openvibe-shared/thread, plan L55 C4): ov-thread.js grows the composer, sends on Enter, adds Copy, filters the chats
   and keeps the thread at the bottom; kit-web.js opens the chats on a phone. The page works without either (forms
   post, the server renders every message). Here: a first message starts the chat in place, answers arrive over the
   room socket (/ws/chat join_room, room_message, room_ai_typing, room_ai_delta) and are written in as they come, a
   picture or a text file goes with a message, the modes, Stop, Try again, and a draft typed while signed out survives
   the sign-in. A person's text is always set with textContent; Vibe's answers go through VibeMarkdown
   (public/web/vibe-md.js), which escapes everything first. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || cfg.view !== 'vibe') return;
  var MD = window.VibeMarkdown;
  var DRAFT = 'ov-vibe-draft';
  var app = document.getElementById('vb');
  if (!app) return;
  var box = app.querySelector('[data-ovt]');
  var form = document.getElementById('vb-composer');
  var input = form && form.querySelector('[data-ovt-text]');
  var sendBtn = form && form.querySelector('[data-ovt-send]');
  var stopBtn = form && form.querySelector('[data-ovt-stop]');
  var room = cfg.room || null;
  var latest = Number(cfg.latest) || 0;
  var ws = null, delay = 1000, sending = false, waitTimer = null;
  var fileInput = document.getElementById('vb-file');
  var previewEl = document.getElementById('vb-preview');
  var picture = null;   // { file, url }: a picture waiting to go with the next message
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function token() { var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || ''); return m ? decodeURIComponent(m[1]) : undefined; }
  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  // The browser's IANA zone (America/New_York) with each message: Vibe's prompt then states the person's local date.
  function timezone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; } }
  // The page scrolls as a whole (the kit has no inner scroll box).
  function nearBottom() { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 220; }
  function toBottom() { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }); }
  function kitEnhance(scope) { if (window.OVThread && window.OVThread.enhance) window.OVThread.enhance(scope); }
  // The kit's composer reads its own input event (it grows and wakes Send); a box filled from here sends one too.
  function changed() { if (input) input.dispatchEvent(new Event('input', { bubbles: true })); }

  // ── The composer ──
  if (input) {
    // A picture alone may be sent: Send wakes for it even with no words (the kit wakes it only for words).
    input.addEventListener('input', function () { if (picture && sendBtn) sendBtn.disabled = false; });
    var saved = cfg.signedIn ? store(function (s) { var v = s.getItem(DRAFT); s.removeItem(DRAFT); return v; }) : null;
    if (saved && !input.value) { input.value = saved; changed(); }
    if (!('ontouchstart' in window)) input.focus();
  }
  [].forEach.call(document.querySelectorAll('.vb-chip[data-prompt]'), function (b) {
    b.addEventListener('click', function () { input.value = b.getAttribute('data-prompt'); changed(); if (form.requestSubmit) form.requestSubmit(); else form.submit(); });
  });

  // ── A picture with the message: it goes to OpenVibe.Pics as the person, and Vibe sees it ──
  var PIC_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/;
  function clearPicture() {
    if (picture && picture.url) URL.revokeObjectURL(picture.url);
    picture = null;
    if (previewEl) { previewEl.textContent = ''; previewEl.hidden = true; }
    if (fileInput) fileInput.value = '';
    if (input) input.required = true;
    changed();
  }
  // A text file goes into the message itself, as a fenced block named after it, cut to what still fits in the box.
  var TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml|toml|ini|html|css|m?js|ts|py|go|rs|java|c|h|cpp|rb|php|sh|sql)$/i;
  function readText(file) {
    if (file.size > 2 * 1024 * 1024) { notice('A text file can be up to 2 MB.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
      if (!text) { notice('That file is empty.'); return; }
      var name = String(file.name || 'file').replace(/[\r\n`]/g, '').slice(0, 80);
      var before = input.value.trim();
      var head = (before ? before + '\n\n' : '') + name + ':\n```\n';
      var space = Number(input.getAttribute('maxlength') || 12000) - head.length - 5;
      if (space < 200) { notice('The box is nearly full. Send what is there first.'); return; }
      var cut = text.length > space;
      input.value = head + (cut ? text.slice(0, space - 20) + '\n… (cut to fit)' : text) + '\n```';
      changed(); input.focus();
      if (cut) notice('The file was longer than a message: its first part is in the box.');
    };
    reader.onerror = function () { notice('That file could not be read.'); };
    reader.readAsText(file);
  }
  function choosePicture(file) {
    if (!file) return;
    if (!PIC_TYPES.test(file.type) && (/^text\//.test(file.type) || file.type === 'application/json' || TEXT_EXT.test(file.name || ''))) { readText(file); if (fileInput) fileInput.value = ''; return; }
    if (!PIC_TYPES.test(file.type) || !fileInput || !/image\//.test(fileInput.accept)) { notice('Send a JPEG, PNG, GIF, WebP or AVIF picture, or a text file.'); return; }
    if (file.size > 20 * 1024 * 1024) { notice('A picture can be up to 20 MB.'); return; }
    clearPicture();
    picture = { file: file, url: URL.createObjectURL(file) };
    var fig = el('figure');
    var img = el('img'); img.src = picture.url; img.alt = 'The picture you are sending';
    var rm = el('button', null, '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove the picture');
    rm.addEventListener('click', function () { clearPicture(); input.focus(); });
    fig.appendChild(img); fig.appendChild(rm);
    previewEl.appendChild(fig); previewEl.hidden = false;
    input.required = false;
    if (sendBtn) sendBtn.disabled = false;
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

  // ── The thread (the kit's markup: a turn is the person's message and the answer under it) ──
  function threadEl() {
    var t = app.querySelector('[data-ovt-thread]');
    // The first message: the welcome goes, and the composer docks at the bottom.
    if (box) box.classList.remove('is-start');
    var hello = app.querySelector('.ovt-empty-state'); if (hello) hello.hidden = true;
    return t;
  }
  function have(id) { return id && app.querySelector('[data-me="' + Number(id) + '"],[data-ai="' + Number(id) + '"]'); }
  function lastTurn() { var t = threadEl(); return t && t.lastElementChild; }
  function meTurn(text, id, localPicture) {
    var li = el('li', 'ovt-turn is-new'); if (id) li.setAttribute('data-me', String(id));
    var you = el('div', 'ovt-you');
    var b = el('div', 'ovt-bubble');
    b.appendChild(el('span', 'oc-sr', 'You said:'));
    b.appendChild(document.createTextNode(String(text)));
    if (localPicture) { var img = el('img', 'vb-local'); img.src = localPicture; img.alt = 'Your picture'; b.appendChild(img); }
    you.appendChild(b); li.appendChild(you);
    return li;
  }
  // The answer side of a turn: Vibe's mark, then its reply.
  function botOf(li) {
    var bot = li.querySelector('.ovt-bot');
    if (!bot) {
      bot = el('div', 'ovt-bot');
      var av = el('span', 'ovt-avatar'); av.setAttribute('aria-hidden', 'true');
      bot.appendChild(av); bot.appendChild(el('div', 'ovt-reply'));
      li.appendChild(bot);
    }
    return bot.querySelector('.ovt-reply');
  }
  // Vibe's answer, as the server draws it (answerOf in server/web/vibe-pages.js): Undo is the same plain form.
  function fillAnswer(reply, m) {
    reply.textContent = '';
    reply.appendChild(el('p', 'oc-sr', 'Vibe said:'));
    var ans = el('div', 'ovt-answer'); ans.setAttribute('data-ovt-answer', '');
    if (MD) ans.innerHTML = MD.render(m.message); else ans.textContent = m.message;
    reply.appendChild(ans);
    var res = Array.isArray(m.results) ? m.results : [];
    if (res.length && room) {
      var resBox = el('div', 'vb-res');
      res.slice(0, 4).forEach(function (r, i) {
        if (!r || (r.kind !== 'reminder' && r.kind !== 'timer')) return;
        var set = r.action === 'set';
        var c = el('div', 'vb-res-c' + (set ? '' : ' is-stopped'));
        var t = el('div', 'vb-res-t');
        t.appendChild(el('b', '', (r.kind === 'timer' ? (set ? 'Timer' : 'Timer stopped') : (set ? 'Reminder set' : 'Reminder stopped')) + ':'));
        t.appendChild(document.createTextNode(' ' + String(r.title || '')));
        if (r.when && set) t.appendChild(el('small', '', String(r.when)));
        c.appendChild(t);
        var a = el('div', 'vb-res-a');
        if (set) {
          var f = el('form'); f.method = 'post'; f.action = '/vibe/' + room + '/undo';
          [['message_id', String(m.id)], ['index', String(i)]].forEach(function (kv) { var h = el('input'); h.type = 'hidden'; h.name = kv[0]; h.value = kv[1]; f.appendChild(h); });
          var u = el('button', 'ovt-act', 'Undo'); u.type = 'submit'; f.appendChild(u); a.appendChild(f);
        }
        if (r.url && /^https:\/\//.test(r.url)) { var o = el('a', 'ovt-act', 'Open'); o.href = r.url; a.appendChild(o); }
        if (a.childNodes.length) c.appendChild(a);
        resBox.appendChild(c);
      });
      reply.appendChild(resBox);
    }
    // Copy (ov-thread.js shows it where the clipboard works), and Try again under the newest answer to the person's
    // last message (it moves here from an older one).
    var meta = el('div', 'ovt-meta'); var acts = el('span', 'ovt-acts');
    var copy = el('button', 'ovt-act'); copy.type = 'button'; copy.setAttribute('data-ovt-copy', ''); copy.hidden = true;
    copy.appendChild(el('span', null, 'Copy'));
    acts.appendChild(copy);
    if (room && reply.closest('.ovt-turn').querySelector('.ovt-you')) {
      [].forEach.call(app.querySelectorAll('.vb-retry'), function (f) { f.remove(); });
      var again = el('form', 'vb-retry'); again.method = 'post'; again.action = '/vibe/' + room + '/retry';
      var b = el('button', 'ovt-act', 'Try again'); b.type = 'submit'; again.appendChild(b);
      acts.appendChild(again);
    }
    meta.appendChild(acts); reply.appendChild(meta);
  }
  // "How Vibe did this" under an agent task's answer that arrives while the page is open (the server folds it on load).
  function attachHow(li, id) {
    if (!room) return;
    fetch('/api/chat/vibe/' + encodeURIComponent(room) + '/how', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      renderHow(li, d && d.how && d.how[String(id)]);
    }).catch(function () {});
  }
  // A chat answer that arrives with its steps and sources (message.how: { steps, sources, citations }, server/rooms/how.js).
  function sourceSite(u) {
    try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch (e) { return String(u || ''); }
  }
  function sourceDate(ts) {
    var t = Date.parse(String(ts || ''));
    if (!isFinite(t)) return null;
    try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return null; }
  }
  // The same sources the server folds into the answer: resolved URLs, the site they open, and the result's date.
  function sourceChips(info) {
    var out = [], seen = {};
    function add(url, c) {
      url = String(url || '');
      if (!/^https?:\/\//.test(url) || seen[url] || out.length >= 6) return;
      seen[url] = 1;
      out.push({ url: url, site: sourceSite(url), date: sourceDate(c && (c.published_at || c.retrieved_at)) });
    }
    (info.citations || []).forEach(function (c) { add(c.url, c); });
    (info.sources || []).forEach(function (u) { add(u, null); });
    return out;
  }
  function chipLink(c) {
    var a = el('a', 'vb-source'); a.href = c.url; a.rel = 'nofollow ugc noopener'; a.target = '_blank';
    a.appendChild(el('span', 'vb-source-site', c.site));
    if (c.date) a.appendChild(el('span', 'vb-source-date', c.date));
    return a;
  }
  // The id "How Vibe did this" links to: the answer's one set of chips, never a second copy.
  function sourcesId(li) {
    var id = li && li.getAttribute('data-ai');
    return id ? 'vb-sources-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '') : null;
  }
  function renderSources(li, info) {
    var reply = li.querySelector('.ovt-reply');
    if (!info || !reply || reply.querySelector('.vb-sources')) return;
    var links = sourceChips(info);
    if (!links.length) return;
    var ul = el('ul', 'vb-sources'); ul.setAttribute('aria-label', 'Sources');
    var sid = sourcesId(li); if (sid) ul.id = sid;
    links.forEach(function (c) { var row = el('li'); row.appendChild(chipLink(c)); ul.appendChild(row); });
    var ans = reply.querySelector('.ovt-answer');
    if (ans && ans.nextSibling) reply.insertBefore(ul, ans.nextSibling); else reply.appendChild(ul);
  }
  function stepsOf(raw) {
    var h = null; try { h = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { h = null; }
    return h && h.steps && h.steps.length ? { lines: h.steps, sources: h.sources || [], citations: h.citations || [] } : null;
  }
  function renderHow(li, info) {
    var reply = li.querySelector('.ovt-reply');
    if (!info || !reply || reply.querySelector('.vb-how')) return;
    renderSources(li, info);
    var det = el('details', 'vb-how'); det.appendChild(el('summary', null, 'How Vibe did this'));
    var ul = el('ul');
    (info.lines || []).forEach(function (l) { ul.appendChild(el('li', null, l)); });
    var links = sourceChips(info);
    if (links.length) {
      var src = el('li', 'vb-how-sources');
      var link = el('a', null, 'Sources (' + links.length + ') under this answer');
      var sid = sourcesId(li); if (sid) link.href = '#' + sid;
      src.appendChild(link);
      ul.appendChild(src);
    }
    if (info.actor_url && /^https:\/\/openvibe\.actor\//.test(info.actor_url)) { var li2 = el('li'); var a2 = el('a', null, 'Every step on OpenVibe Agents'); a2.href = info.actor_url; li2.appendChild(a2); ul.appendChild(li2); }
    det.appendChild(ul);
    var meta = reply.querySelector('.ovt-meta');
    if (meta) reply.insertBefore(det, meta); else reply.appendChild(det);
  }

  // ── Vibe writing ──
  // The turn that waits for Vibe: the newest one, open, its live line breathing (nothing spins).
  function waitingTurn() { return app.querySelector('[data-ovt-thread] > .ovt-turn[data-open]'); }
  function setStop(on) { if (stopBtn) stopBtn.hidden = !(on && room); if (sendBtn) sendBtn.hidden = !!(on && room); }
  function clearWait() {
    var w = waitingTurn();
    if (w) {
      w.removeAttribute('data-open');
      var bot = w.querySelector('.ovt-bot');
      if (bot && !bot.querySelector('[data-ovt-answer]:not(.vb-streaming)')) bot.remove();
    }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    setStop(false);
  }
  function giveUpLater() {
    if (waitTimer) clearTimeout(waitTimer);
    // An answer takes up to a minute with tools; after two the live line gives way to a way forward.
    waitTimer = setTimeout(function () { clearWait(); notice('Vibe did not answer this time. Send your message again, or try again in a minute.'); }, 120000);
  }
  function showWait() {
    var li = waitingTurn();
    if (!li) {
      li = lastTurn();
      if (!li || li.querySelector('.ovt-bot')) { li = el('li', 'ovt-turn'); threadEl().appendChild(li); }
      li.setAttribute('data-open', '');
      var reply = botOf(li);
      var work = el('details', 'ovt-work'); work.open = true; work.setAttribute('data-open', '');
      var sum = el('summary'); var line = el('span', 'ovt-w-live', 'Vibe is writing…'); line.setAttribute('data-ovt-live', '');
      sum.appendChild(line); work.appendChild(sum);
      reply.appendChild(work);
    }
    setStop(true);
    giveUpLater();
  }
  // The answer as it is written (room_ai_delta: the whole text so far): the waiting turn shows it, rendered like the
  // finished answer, until that message arrives and takes its place. Screen readers hear the finished one only.
  function streamText(text) {
    showWait();
    var w = waitingTurn(); if (!w) return;
    var stick = nearBottom();
    var reply = botOf(w);
    var ans = reply.querySelector('.vb-streaming');
    if (!ans) { ans = el('div', 'ovt-answer vb-streaming'); ans.setAttribute('aria-hidden', 'true'); reply.appendChild(ans); }
    if (MD) ans.innerHTML = MD.render(String(text || '')); else ans.textContent = String(text || '');
    giveUpLater();
    if (stick) toBottom();
  }
  function notice(text) {
    var old = app.querySelector('.vb-live-notice'); if (old) old.remove();
    var p = el('p', 'oc-notice oc-error vb-live-notice', text); p.setAttribute('role', 'alert');
    var scroll = app.querySelector('.ovt-scroll'); (scroll || app).appendChild(p); toBottom();
  }
  function add(m) {
    if (!m || have(m.id)) return;
    latest = Math.max(latest, Number(m.id) || 0);
    var stick = nearBottom();
    if (m.ai_member_id) {
      // The answer takes the waiting turn's place, or the newest turn that has none yet, or a turn of its own.
      var li = waitingTurn() || lastTurn();
      if (!li || (li.querySelector('.ovt-bot') && !li.hasAttribute('data-open'))) { li = el('li', 'ovt-turn'); threadEl().appendChild(li); }
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
      setStop(false);
      li.removeAttribute('data-open');
      li.setAttribute('data-ai', String(m.id));
      fillAnswer(botOf(li), m);
      li.classList.add('is-fresh');
      kitEnhance(li);
      refreshRail();
      if (/^✅ Done:/.test(String(m.message || ''))) attachHow(li, m.id);
      else if (m.how) renderHow(li, stepsOf(m.how));
    } else {
      // The line sent from here already shows (without an id until the server answered): give it its id.
      var pending = app.querySelector('[data-ovt-thread] > .ovt-turn:not([data-me]) > .ovt-you');
      if (pending && Number(m.user_id) === Number(cfg.me)) pending.parentNode.setAttribute('data-me', String(m.id));
      else threadEl().appendChild(meTurn(m.message, m.id));
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
  function removeMessage(id) {
    var li = have(id); if (!li) return;
    if (li.getAttribute('data-me') === String(Number(id))) li.remove();
    else { var bot = li.querySelector('.ovt-bot'); if (bot) bot.remove(); li.removeAttribute('data-ai'); if (!li.querySelector('.ovt-you')) li.remove(); }
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
      else if (m.type === 'room_ai_delta' && m.room === room) streamText(m.text);
      else if (m.type === 'room_message_deleted' && m.room === room) removeMessage(m.id);
      else if (m.type === 'auth_revoked') notice('You were signed out. Sign in again to keep chatting.');
    };
    ws.onclose = function () { ws = null; if (room) { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); } };
  }

  // ── The chats (the network's sidebar, kit.sidebar): rebuilt from data with text nodes after each answer ──
  function refreshRail() {
    fetch('/api/chat/vibe?limit=100', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var allow = document.getElementById('vb-allow');
      if (allow && d.allowance && !allow.hasAttribute('data-own')) allow.textContent = Math.max(0, d.allowance.per_day - d.allowance.used_today) + ' of ' + d.allowance.per_day + ' answers left today';
      var secs = app.querySelector('#vb-rail .ovk-sidebar-secs'); if (!secs || !d.chats) return;
      if (new URLSearchParams(location.search).get('q')) return;   // search results stay until the search is left
      var start = new Date(); start.setUTCHours(0, 0, 0, 0);
      var groups = [{ label: 'Today', chats: [] }, { label: 'Earlier', chats: [] }];
      d.chats.forEach(function (c) { var at = Date.parse(String(c.last_message_at).indexOf('T') < 0 ? String(c.last_message_at).replace(' ', 'T') + 'Z' : c.last_message_at); (at >= start.getTime() ? groups[0] : groups[1]).chats.push(c); });
      secs.textContent = '';
      groups.forEach(function (g) {
        if (!g.chats.length) return;
        var sec = el('section', 'ovk-sidebar-sec');
        sec.appendChild(el('h2', 'ovk-sidebar-h', g.label));
        g.chats.forEach(function (c) {
          var a = el('a', 'ovk-sidebar-item' + (c.slug === room ? ' is-here' : '')); a.href = '/vibe/' + c.slug;
          if (c.slug === room) a.setAttribute('aria-current', 'page');
          a.appendChild(el('span', 'ovk-sidebar-t', c.name));
          sec.appendChild(a);
        });
        secs.appendChild(sec);
      });
    }).catch(function () {});
  }
  // The search's words come back into the box from the address (the page never repeats them).
  var q = app.querySelector('#vb-rail .ovk-sidebar-find input');
  var searched = null;
  try { searched = new URLSearchParams(location.search).get('q'); } catch (e) { searched = null; }
  if (q && searched) q.value = searched.slice(0, 80);
  // Forms that undo something (Memory's "Forget everything") ask first.
  [].forEach.call(app.querySelectorAll('form[data-vb-confirm]'), function (f) { f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-vb-confirm'))) e.preventDefault(); }); });
  var del = app.querySelector('[data-vb-delete]');
  if (del) del.addEventListener('submit', function (e) { if (!window.confirm('Delete this chat? Its messages go too.')) e.preventDefault(); });

  // ── Modes: the box says what the chosen one will do ──
  if (form) [].forEach.call(form.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', function () { if (r.checked && input && r.getAttribute('data-placeholder') && !form.dataset.signin) input.placeholder = r.getAttribute('data-placeholder'); input.focus(); });
  });

  // ── Stop: what Vibe wrote so far stays as its answer (POST /api/chat/vibe/:slug/stop) ──
  if (stopBtn) stopBtn.addEventListener('click', function (e) {
    e.preventDefault();
    if (!room) return;
    stopBtn.disabled = true;
    fetch('/api/chat/vibe/' + encodeURIComponent(room) + '/stop', { method: 'POST', credentials: 'same-origin' })
      .catch(function () {}).then(function () { stopBtn.disabled = false; });
  });

  // ── Sending ──
  if (form) form.addEventListener('submit', function (e) {
    if (e.submitter && e.submitter === stopBtn) { e.preventDefault(); return; }
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
    var old = app.querySelector('.vb-live-notice'); if (old) old.remove();
    var sendingPicture = picture;
    var mine = meTurn(text, null, sendingPicture && sendingPicture.url);
    threadEl().appendChild(mine);
    showWait(); toBottom();
    input.value = ''; picture = null; if (previewEl) { previewEl.textContent = ''; previewEl.hidden = true; } if (fileInput) fileInput.value = ''; input.required = true; changed();
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
      init = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, timezone: timezone() }) };
    }
    function putBack(msg) { mine.remove(); clearWait(); input.value = text; if (sendingPicture) choosePicture(sendingPicture.file); changed(); notice(msg); }
    fetch(url, init)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: null }; }); })
      .then(function (x) {
        if (!x.ok) { putBack((x.d && x.d.error) || 'That did not send. Try again.'); return; }
        if (x.d.message && x.d.message.id) { mine.setAttribute('data-me', String(x.d.message.id)); latest = Math.max(latest, Number(x.d.message.id)); }
        if (!room && x.d.room) {
          room = x.d.room.slug;
          history.replaceState(null, '', '/vibe/' + room);
          var titleEl = app.querySelector('.ovt-title'); if (titleEl) titleEl.textContent = x.d.room.name;
          document.title = x.d.room.name + ' · Vibe · OpenVibe.Chat';
          form.action = '/vibe/' + room;
          setStop(true);
          refreshRail();
          connect();
        }
      })
      .catch(function () { putBack('You seem to be offline. Your message is back in the box.'); })
      .then(function () { sending = false; });
  });

  // Try again: Vibe's last answer goes and a new one is written (POST /api/chat/vibe/:slug/retry).
  app.addEventListener('submit', function (e) {
    var f = e.target.closest('.vb-retry'); if (!f || !room) return;
    e.preventDefault();
    var li = f.closest('.ovt-turn');
    fetch('/api/chat/vibe/' + encodeURIComponent(room) + '/retry', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: null }; }); })
      .then(function (x) {
        if (!x.ok) { notice((x.d && x.d.error) || 'That did not work. Try again in a minute.'); return; }
        if (li) { var bot = li.querySelector('.ovt-bot'); if (bot) bot.remove(); li.removeAttribute('data-ai'); }
        showWait(); toBottom();
      })
      .catch(function () { notice('You seem to be offline.'); });
  });
  if (cfg.waiting) showWait();
  connect();
  window.addEventListener('pagehide', function () { var w = ws; room = null; if (w) w.close(); });
})();
