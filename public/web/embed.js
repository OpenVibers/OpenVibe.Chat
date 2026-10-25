/* The chat panel (server/web/inbox-pages.js /embed/inbox/:id) a website opens with openvibe.chat/widget.js. The visitor
   is known by a token kept in this frame's own storage (partitioned by the site embedding it); their conversation comes
   from /api/chat/widget/inbox/:id and lives over the chat socket (inbox_watch). Text the visitor or an agent wrote is
   set with textContent; Vibe's answers go through VibeMarkdown (vibe-md.js), which escapes everything first. */
(function () {
  'use strict';
  var root = document.getElementById('em');
  if (!root) return;
  var inbox = root.getAttribute('data-inbox');
  var api = '/api/chat/widget/inbox/' + inbox;
  var KEY = 'ov-inbox-' + inbox;
  var thread = document.getElementById('em-thread');
  var form = document.getElementById('em-form');
  var input = form.querySelector('textarea');
  var sendBtn = form.querySelector('button');
  var personBtn = document.getElementById('em-person');
  var stateEl = document.getElementById('em-state');
  var page = new URLSearchParams(location.search).get('page') || '';
  var token = null, conv = null, latest = 0, ws = null, delay = 1000, aiOn = root.getAttribute('data-ai') === '1', typingEl = null;
  var people = root.getAttribute('data-people') !== '0', rateEl = null;

  // A person's reply may hold OpenVibe.Pics pictures (sent from the inbox): shown inline, only that host, at most four.
  var picsBase = root.getAttribute('data-pics') || 'https://openvibe.pics';
  var PICS = new RegExp(picsBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/i/([2-9a-km-zA-HJ-NP-Z]{8})\\.(?:jpg|png|gif|webp|avif)(?![\\w/.-])', 'g');
  function picsOf(text) {
    var box = null, m, n = 0; PICS.lastIndex = 0;
    while ((m = PICS.exec(String(text || ''))) && n < 4) {
      if (!box) box = el('div', 'em-pics');
      var a = el('a', 'em-pic'); a.href = picsBase + '/i/' + m[1]; a.target = '_blank'; a.rel = 'noopener';
      var img = el('img'); img.src = picsBase + '/i/' + m[1] + '/thumb.webp'; img.alt = 'A picture'; img.loading = 'lazy';
      a.appendChild(img); box.appendChild(a); n++;
    }
    return box;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  function toParent(msg) { try { window.parent.postMessage(Object.assign({ ov: 'chat' }, msg), '*'); } catch (e) { /* not embedded */ } }
  function bottom() { thread.scrollTop = thread.scrollHeight; }
  var STATE = {
    bot: people ? 'Vibe answers right away. Ask for a person any time.' : 'Vibe, the assistant, answers right away.',
    waiting: 'Waiting for a person. You can leave; this conversation stays here.',
    open: 'A person is here.',
    resolved: 'Resolved. Write again any time.',
  };
  function setStatus(s) {
    if (conv) conv.status = s;
    stateEl.textContent = STATE[s] || stateEl.textContent;
    personBtn.hidden = !(aiOn && people && conv && s === 'bot');
    if (s === 'resolved') askRating(); else if (rateEl) { rateEl.remove(); rateEl = null; }
  }
  // A resolved conversation asks how it went: good or bad, then a line if they like.
  function askRating() {
    if (rateEl || !conv || conv.rating) return;
    rateEl = el('li', 'em-rate');
    rateEl.appendChild(el('span', null, 'How was this?'));
    [[1, '👍', 'Good'], [-1, '👎', 'Not good']].forEach(function (r) {
      var b = el('button', null, r[1]); b.type = 'button'; b.setAttribute('aria-label', r[2]);
      b.addEventListener('click', function () { sendRating(r[0]); });
      rateEl.appendChild(b);
    });
    thread.appendChild(rateEl); bottom();
  }
  function sendRating(value, comment) {
    post('/rating', { rating: value, comment: comment || '', conversation: conv.id }).then(function (x) {
      if (!x.ok) { errorLine((x.d && x.d.error) || 'That did not send.'); return; }
      conv.rating = value;
      if (comment != null) { rateEl.textContent = 'Thanks!'; return; }
      rateEl.textContent = '';
      var f = el('form', 'em-rate-more'); var i = el('input'); i.maxLength = 500; i.placeholder = 'Thanks! Anything to add?'; i.setAttribute('aria-label', 'Anything to add');
      var s2 = el('button', null, 'Send'); s2.type = 'submit'; f.appendChild(i); f.appendChild(s2); rateEl.appendChild(f); i.focus();
      f.addEventListener('submit', function (e) { e.preventDefault(); if (i.value.trim()) sendRating(value, i.value.trim()); else rateEl.textContent = 'Thanks!'; });
    }).catch(function () { errorLine('You seem to be offline.'); });
  }
  function clearTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }
  function showTyping(who) {
    clearTyping();
    typingEl = el('li', 'em-msg em-them em-typing');
    typingEl.appendChild(el('small', null, who || 'Vibe'));
    var b = el('div', 'em-bubble'); var d = el('span', 'em-dots'); d.setAttribute('aria-label', 'writing');
    d.appendChild(el('i')); d.appendChild(el('i')); d.appendChild(el('i')); b.appendChild(d); typingEl.appendChild(b);
    thread.appendChild(typingEl); bottom();
    setTimeout(clearTyping, 60000);
  }
  function render(m) {
    if (m.id && thread.querySelector('[data-id="' + m.id + '"]')) return;
    // The visitor's own line, back over the socket before the POST answered: it is the one already shown.
    if (m.author === 'visitor') { var waiting = thread.querySelector('.em-me:not([data-id])'); if (waiting) { waiting.dataset.id = String(m.id); latest = Math.max(latest, Number(m.id)); return; } }
    if (m.id) latest = Math.max(latest, Number(m.id));
    var li;
    if (m.author === 'system') { li = el('li', 'em-system', m.body); }
    else {
      var mine = m.author === 'visitor';
      li = el('li', 'em-msg ' + (mine ? 'em-me' : 'em-them'));
      if (!mine) li.appendChild(el('small', null, m.author === 'ai' ? 'Vibe' : (m.author_name || 'Support')));
      var b = el('div', 'em-bubble');
      if (m.author === 'ai' && window.VibeMarkdown) b.innerHTML = window.VibeMarkdown.render(m.body); else b.textContent = m.body;
      li.appendChild(b);
      if (m.author === 'agent') { var pics = picsOf(m.body); if (pics) li.appendChild(pics); }
      if (!mine) { clearTyping(); toParent({ type: 'message', author: m.author }); }
    }
    if (m.id) li.dataset.id = String(m.id);
    thread.appendChild(li); bottom();
  }
  function errorLine(text) {
    var p = root.querySelector('.em-error'); if (!p) { p = el('p', 'em-error'); p.setAttribute('role', 'alert'); form.parentNode.insertBefore(p, form); }
    p.textContent = text || ''; p.hidden = !text;
  }

  function watch() {
    if (!conv || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'inbox_watch', inbox: inbox, conversation: conv.id, visitor_token: token }));
  }
  function connect() {
    if (!window.WebSocket) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 1000; watch(); catchUp(); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!conv || m.conversation !== conv.id) return;
      if (m.type === 'inbox_message') render(m.message);
      else if (m.type === 'inbox_status') setStatus(m.status);
      else if (m.type === 'inbox_typing') showTyping(m.who);
    };
    ws.onclose = function () { setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
  }
  function catchUp() {
    if (!token) return;
    fetch(api + '/messages?after=' + latest, { headers: headers({ 'X-Visitor-Token': token }) }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.messages) d.messages.forEach(render); if (d && d.conversation) setStatus(d.conversation.status); }).catch(function () {});
  }

  // A visitor may sign in to OpenVibe here (the same ticket window as a room on a site): their conversations are theirs,
  // in their openvibe.chat Messages and on every device. The token stays in this frame's own storage.
  var ACCT = 'ov-embed-token', acct = store(function (s) { return s.getItem(ACCT); }) || null, acctName = null, polling = null;
  function headers(extra) { var hd = Object.assign({ 'Content-Type': 'application/json' }, extra || {}); if (acct) hd.Authorization = 'Bearer ' + acct; return hd; }
  function post(path, body) {
    return fetch(api + path, { method: 'POST', headers: headers(), body: JSON.stringify(Object.assign({ token: token, user: identity || undefined }, body || {})) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: {} }; }); });
  }

  // A site that knows its visitor passes a signed identity (widget.js data-user-*, OpenVibeChat.identify()); with ?id=1
  // the frame waits for it (three seconds at most) before its first visit, and a later one starts the visit again: a
  // verified person's token is their own, the same on every device, so their conversation follows them.
  var identity = null, started = false, wantId = new URLSearchParams(location.search).get('id') === '1';
  function begin() {
    started = true;
    var before = token;
    post('/visit', { token: store(function (s) { return s.getItem(KEY); }) }).then(function (x) {
      if (!x.ok) { errorLine((x.d && x.d.error) || 'This chat is not available right now.'); return; }
      token = x.d.token; store(function (s) { s.setItem(KEY, token); });
      aiOn = !!(x.d.inbox && x.d.inbox.ai);
      people = !(x.d.inbox && x.d.inbox.people === false);
      if (x.d.inbox && x.d.inbox.color) toParent({ type: 'color', color: x.d.inbox.color });
      if (before && before !== token) Array.prototype.forEach.call(thread.querySelectorAll('[data-id], .em-rate'), function (n) { n.remove(); });
      if (acct && !x.d.account) { acct = null; store(function (s) { s.removeItem(ACCT); }); }   // a sign-in that expired
      acctName = x.d.account ? x.d.account.name : null; accountLine();
      conv = x.d.conversation;
      (x.d.messages || []).forEach(render);
      if (conv) setStatus(conv.status);
      if (!ws) connect(); else watch();
    }).catch(function () { errorLine('You seem to be offline.'); });
  }
  var acctEl = document.getElementById('em-account');
  function newTicket() { var b = new Uint8Array(32); crypto.getRandomValues(b); return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function accountLine() {
    if (!acctEl) return;
    acctEl.textContent = ' · ';
    var a = el('a', null, acctName ? 'Signed in as ' + acctName + ' · Sign out' : polling ? 'Finish signing in in the window…' : 'Keep this conversation: sign in');
    a.href = '#';
    a.addEventListener('click', function (e) { e.preventDefault(); if (acctName) signOut(); else if (!polling) signIn(); });
    acctEl.appendChild(a);
  }
  function signIn() {
    var ticket = newTicket();
    var w = window.open('/embed/signin#t=' + ticket, 'ovchat-signin', 'width=480,height=680');
    if (!w) { errorLine('Allow pop-ups for this site to sign in.'); return; }
    var started = Date.now();
    polling = setInterval(function () {
      if (Date.now() - started > 120000) { clearInterval(polling); polling = null; accountLine(); return; }
      fetch('/embed/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: ticket }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.token) return;
          clearInterval(polling); polling = null;
          acct = d.token; store(function (s) { s.setItem(ACCT, acct); });
          begin();
        }).catch(function () {});
    }, 1500);
    accountLine();
  }
  function signOut() { acct = null; acctName = null; store(function (s) { s.removeItem(ACCT); s.removeItem(KEY); }); token = null; begin(); }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.ov !== 'chat' || e.data.type !== 'identify') return;
    var u = e.data.user;
    identity = u && typeof u === 'object' && u.id && u.hash ? { id: String(u.id), name: u.name ? String(u.name) : undefined, email: u.email ? String(u.email) : undefined, hash: String(u.hash) } : null;
    if (started || wantId) begin();
  });
  if (wantId) setTimeout(function () { if (!started) begin(); }, 3000); else begin();

  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); } });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || !token || sendBtn.disabled) return;
    sendBtn.disabled = true; errorLine('');
    var pending = el('li', 'em-msg em-me'); var b = el('div', 'em-bubble', text); pending.appendChild(b); thread.appendChild(pending); bottom();
    input.value = ''; grow();
    post('/messages', { message: text, page_url: page }).then(function (x) {
      if (!x.ok) { pending.remove(); input.value = text; errorLine((x.d && x.d.error) || 'That did not send. Try again.'); return; }
      pending.dataset.id = String(x.d.message.id); latest = Math.max(latest, Number(x.d.message.id));
      var fresh = !conv || conv.id !== x.d.conversation.id;
      conv = x.d.conversation; setStatus(conv.status);
      if (fresh) watch();
      if (conv.status === 'bot') showTyping('Vibe');
    }).catch(function () { pending.remove(); input.value = text; errorLine('You seem to be offline. Your message is back in the box.'); })
      .then(function () { sendBtn.disabled = false; input.focus(); });
  });
  personBtn.addEventListener('click', function () {
    personBtn.disabled = true;
    post('/handoff').then(function (x) { if (x.ok && x.d.conversation) { setStatus(x.d.conversation.status); catchUp(); } else errorLine((x.d && x.d.error) || 'Try again in a moment.'); })
      .then(function () { personBtn.disabled = false; });
  });
  var close = root.querySelector('[data-close]');
  if (close) close.addEventListener('click', function () { toParent({ type: 'close' }); });
  window.addEventListener('message', function (e) { if (e.data && e.data.ov === 'chat' && e.data.type === 'visible' && e.data.visible) { input.focus(); bottom(); } });
})();
