/* openvibe.chat — the app shell on the page (the plan, 2026-11-09, stage V2): the phone's panels and the swipe
 * between them, the members toggle, and the shared user popout on every name.
 *
 * The page reads and works without this file: the shell is server-rendered, and the panels are links to the same
 * places. This adds the gestures and the popout. */
(function () {
  'use strict';

  var app = document.querySelector('[data-oc-app]');
  if (!app) return;

  // ── The Start sheet opens from any link to it (the rail's +, the side column, the Start card), so it needs no bar
  // of its own while closed (chat-shell.css hides that bar once this runs; without this file the bar stays) ──
  document.documentElement.classList.add('oc-js');
  function openSheet() {
    var sheet = document.getElementById('oc-new-server');
    if (!sheet) return false;
    sheet.open = true;
    var page = sheet.closest('.oc-page');
    if (page) page.scrollTo({ top: Math.max(0, sheet.offsetTop - page.offsetTop - 12) });
    var first = sheet.querySelector('input:not([type=hidden]):not([type=radio]), input[type=radio]:checked, select, textarea');
    if (first) first.focus({ preventScroll: true });
    return true;
  }
  if (location.hash === '#oc-new-server') openSheet();
  window.addEventListener('hashchange', function () { if (location.hash === '#oc-new-server') openSheet(); });
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href$="#oc-new-server"]');
    if (!a || !document.getElementById('oc-new-server')) return;
    e.preventDefault();
    if (location.hash !== '#oc-new-server') history.replaceState(null, '', '#oc-new-server');
    openSheet();
  });

  // ── The panels: the side column on the left, the people on the right, the conversation between them ──
  function panel(name) {
    app.setAttribute('data-oc-panel', name);
    app.classList.toggle('is-members', name === 'members');
    document.querySelectorAll('[data-oc-panel-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-oc-panel-toggle') === name ? 'true' : 'false');
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-oc-panel]');
    if (!b || b === app) return;
    var to = b.getAttribute('data-oc-panel');
    if (!to) return;
    e.preventDefault();
    panel(app.getAttribute('data-oc-panel') === to ? 'main' : to);
  });
  document.querySelectorAll('[data-oc-panel-toggle]').forEach(function (b) {
    b.addEventListener('click', function () { panel(b.getAttribute('data-oc-panel-toggle')); });
  });

  // ── The phone: swipe right from the conversation for the side column, left for the people ──
  if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches && window.PointerEvent) {
    var startX = 0, startY = 0, tracking = false;
    app.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      startX = e.clientX; startY = e.clientY; tracking = true;
    }, { passive: true });
    app.addEventListener('pointerup', function (e) {
      if (!tracking) return;
      tracking = false;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
      var here = app.getAttribute('data-oc-panel');
      if (dx > 0 && here === 'main') panel('side');
      else if (dx > 0 && here === 'members') panel('main');
      else if (dx < 0 && here === 'main') panel('members');
      else if (dx < 0 && here === 'side') panel('main');
    }, { passive: true });
  }

  // ── Copy a link (the invite at the end of the Start sheet) ──
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-oc-copy]');
    if (!b) return;
    e.preventDefault();
    var text = b.getAttribute('data-oc-copy') || '';
    var done = function () { var old = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = old; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { });
    else {
      var input = document.createElement('textarea');
      input.value = text; document.body.appendChild(input); input.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* nothing to copy with */ }
      input.remove();
    }
  });

  // ── The rail: on a computer one label follows the tile under the pointer (the rail scrolls, so a label inside it
  // would be cut off); on a phone the strip fades at the edge that has more, and starts with the open place in view ──
  var isPhone = function () { return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); };
  var railEl = app.querySelector('.oc-rail');
  if (railEl) {
    var tip = null;
    var showTip = function (el) {
      var label = el.querySelector('.oc-rail-label');
      if (!label || isPhone()) return;
      if (!tip) { tip = document.createElement('span'); tip.className = 'oc-rail-tip'; tip.setAttribute('aria-hidden', 'true'); document.body.appendChild(tip); }
      var box = el.getBoundingClientRect();
      tip.textContent = label.textContent;
      tip.style.left = Math.round(box.right + 4) + 'px';
      tip.style.top = Math.round(box.top + box.height / 2) + 'px';
      tip.classList.add('is-on');
    };
    var hideTip = function () { if (tip) tip.classList.remove('is-on'); };
    var placeOf = function (e) { return e.target && e.target.closest ? e.target.closest('.oc-rail-icon') : null; };
    railEl.addEventListener('pointerover', function (e) { var el = placeOf(e); if (el && e.pointerType !== 'touch') showTip(el); });
    railEl.addEventListener('pointerout', function (e) { var el = placeOf(e); if (el && !el.contains(e.relatedTarget)) hideTip(); });
    railEl.addEventListener('focusin', function (e) { var el = placeOf(e); if (el && el.matches(':focus-visible')) showTip(el); });
    railEl.addEventListener('focusout', hideTip);
    railEl.addEventListener('scroll', hideTip, { passive: true });
  }

  // ── A phone's two levels: the list (the rail and the list beside it), then the conversation ──
  var talk = app.querySelector(':scope > .oc-col-main > .oc-dock, :scope > .oc-col-main > .oc-compose');
  var sideCol = app.querySelector(':scope > .oc-side');
  var phone = function () { return window.matchMedia && window.matchMedia('(max-width: 760px)').matches; };
  // The place that is open, pressed again from the list: back into its conversation, with no reload.
  document.addEventListener('click', function (e) {
    var here = e.target.closest && e.target.closest('.oc-rail-icon.is-active');
    if (!here || !phone() || !talk || app.getAttribute('data-oc-panel') !== 'side' || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    panel('main');
  });
  // A page with a list beside it and no conversation of its own (your conversations) opens on the list.
  if (phone() && sideCol && !talk && app.querySelector('.oc-rail-home.is-active') && !/[?&]panel=main\b/.test(location.search)) panel('side');
  // A page head with no way back of its own gets the way to the list.
  var pageHead = app.querySelector(':scope > .oc-col-main > .oc-page-head, :scope > .oc-col-main > .oc-page > .oc-page-head');
  if (pageHead && sideCol && !pageHead.querySelector('.oc-back, .oc-tolist')) {
    var lb = document.createElement('button');
    lb.type = 'button'; lb.className = 'oc-icon-btn oc-tolist'; lb.setAttribute('data-oc-panel', 'side'); lb.setAttribute('aria-label', 'All chats'); lb.title = 'All chats';
    lb.innerHTML = '<svg class="oc-i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.5 5.500 8 12l6.500 6.500" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    pageHead.insertBefore(lb, pageHead.firstChild);
  }

  // ── Messages grouped by who said them: a run from one person within five minutes shows their mark, name and the
  // time once; a line says where the day changes. New and older messages are grouped as they arrive. ──
  var feed = app.querySelector('.oc-feed');
  if (feed && feed.querySelector(':scope > .oc-msg > .oc-name')) {
    var dayOf = function (d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
    var dayName = function (d) {
      var now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      if (dayOf(d) === dayOf(now)) return 'Today';
      if (dayOf(d) === dayOf(y)) return 'Yesterday';
      return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    };
    var grouping = false;
    var group = function () {
      if (grouping) return;
      grouping = true;
      feed.classList.add('is-grouped');
      Array.prototype.forEach.call(feed.querySelectorAll(':scope > .oc-day'), function (n) { n.remove(); });
      var prev = null;
      Array.prototype.forEach.call(feed.querySelectorAll(':scope > .oc-msg'), function (li) {
        var name = li.querySelector(':scope > .oc-name'), where = li.querySelector(':scope > .oc-where'), time = li.querySelector(':scope > .oc-time');
        var who = (name ? name.textContent.trim() : '') + '|' + (where ? where.textContent.trim() : '');
        var at = time && time.dateTime ? new Date(time.dateTime) : null;
        var sameDay = !!(prev && at && prev.at && dayOf(prev.at) === dayOf(at));
        if (at && !sameDay) { var d = document.createElement('li'); d.className = 'oc-day'; d.setAttribute('role', 'separator'); d.textContent = dayName(at); feed.insertBefore(d, li); }
        var cont = !!(prev && sameDay && prev.who === who && name && at - prev.at < 5 * 60000);
        li.classList.toggle('is-cont', cont); li.classList.toggle('is-first', !cont);
        if (!cont && name) {
          // The first letter or digit of the name (a decoration in front of it drew "?"), and the person's picture over it
          // (Network's /avatar/<username> answers for everyone; 11-14, the owner: "the user avatars … don't work").
          var letter = (name.textContent.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
          li.setAttribute('data-initial', letter);
          var handle = (String(name.getAttribute('href') || '').match(/\/@([A-Za-z0-9_]{2,32})(?:$|[/?#])/) || [])[1];
          if (handle && !li.style.getPropertyValue('--av-img')) li.style.setProperty('--av-img', 'url("https://openvibe.network/avatar/' + encodeURIComponent(handle) + '?s=80")');
          var nc = name.style.getPropertyValue('--nc'); if (nc) li.style.setProperty('--nc', nc);
        }
        if (time && at) time.title = at.toLocaleString();
        prev = { who: who, at: at };
      });
      grouping = false;
    };
    group();
    if (window.MutationObserver) new MutationObserver(function (list) {
      if (grouping) return;
      var touched = list.some(function (m) { return Array.prototype.some.call(m.addedNodes, function (n) { return n.nodeType === 1 && n.classList.contains('oc-msg'); }) || Array.prototype.some.call(m.removedNodes, function (n) { return n.nodeType === 1 && n.classList.contains('oc-msg'); }); });
      if (touched) group();
    }).observe(feed, { childList: true });
  }

  // ── A server's sheet: what it is, your rank in it, what you may do with it. It opens when a server is held (a
  // phone) or right-clicked (a computer), from the open server's chip on a phone, and from the three dots on a
  // server's card. The page carries one template (shell.js SERVER_SHEET); the facts are on the element. ──
  var RANK = { owner: 'You own this server', admin: 'You are an admin here', mod: 'You are a moderator here', member: 'You are a member' };
  var sheetAt = 0;
  function lettersOf(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }
  function serverSheet(el) {
    var tpl = document.getElementById('oc-srv-sheet');
    if (!tpl || !tpl.content || !window.HTMLDialogElement || !el.getAttribute('data-oc-server')) return false;
    var open = document.querySelector('dialog.oc-ssheet');
    if (open) open.remove();
    var dlg = tpl.content.firstElementChild.cloneNode(true);
    var part = function (k) { return dlg.querySelector('[data-s="' + k + '"]'); };
    var slug = el.getAttribute('data-oc-server'), name = el.getAttribute('data-oc-name') || slug;
    var role = el.getAttribute('data-oc-role') || '', members = Number(el.getAttribute('data-oc-members')) || 0;
    var official = el.hasAttribute('data-oc-official'), closed = el.hasAttribute('data-oc-private');
    var base = '/s/' + encodeURIComponent(slug);
    var staff = role === 'owner' || role === 'admin';
    var mark = part('mark');
    mark.style.setProperty('--oc-hue', el.getAttribute('data-oc-hue') || '215');
    mark.textContent = lettersOf(name);
    part('name').textContent = name;
    part('official').hidden = !official;
    part('private').hidden = !closed;
    part('sub').textContent = (RANK[role] || 'You are not in this server') + ' · ' + members + (members === 1 ? ' member' : ' members');
    // The sheet carries only what the person may do somewhere (shell.js serverSheet): a part may not be there.
    var show = function (k, on, to) {
      var n = part(k);
      if (!n) return null;
      n.hidden = !on;
      if (on && to) n.setAttribute(n.tagName === 'FORM' ? 'action' : 'href', to);
      return n;
    };
    show('open', !(el.classList.contains('oc-rail-icon') && el.classList.contains('is-active')), base);
    show('invite', staff || (role === 'mod' && !closed), base + '/settings#oc-invites');
    var settings = show('settings', staff || role === 'mod', base + '/settings');
    if (settings && role === 'mod') { settings.querySelector('b').textContent = 'Members and invites'; settings.querySelector('small').textContent = 'Who is in it, and who is banned'; }
    show('leave', !!role && role !== 'owner', base + '/leave');
    var del = show('delete', role === 'owner' && !official);
    if (del) {
      del.querySelector('form').setAttribute('action', base + '/delete');
      part('delete-line').textContent = 'Delete ' + name + ' and all its channels? Their messages go with it, and it cannot be brought back.';
      part('keep').addEventListener('click', function () { del.open = false; });
    }
    part('close').addEventListener('click', function () { dlg.close(); });
    // A tap on the dimmed page closes it; the tap that is still ending the hold that opened it does not.
    dlg.addEventListener('click', function (e) { if (e.target === dlg && Date.now() - sheetAt > 500) dlg.close(); });
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.setAttribute('tabindex', '-1');
    dlg.showModal();
    dlg.focus();   // the sheet itself, not its Close button: nothing in it is picked on the person's behalf
    sheetAt = Date.now();
    return true;
  }
  var serverOf = function (e) { return e.target && e.target.closest ? e.target.closest('[data-oc-server]') : null; };
  document.addEventListener('contextmenu', function (e) {
    var el = serverOf(e);
    if (!el) return;
    if (Date.now() - sheetAt < 600 || serverSheet(el)) e.preventDefault();
  });
  // Where a hold raises no context menu (iOS), the hold itself opens the sheet.
  var holdTimer = 0, holdX = 0, holdY = 0, held = false;
  var dropHold = function () { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };
  document.addEventListener('pointerdown', function (e) {
    held = false;
    var el = e.pointerType === 'touch' ? serverOf(e) : null;
    if (!el) return;
    holdX = e.clientX; holdY = e.clientY;
    dropHold();
    holdTimer = setTimeout(function () { holdTimer = 0; if (Date.now() - sheetAt > 600 && serverSheet(el)) held = true; }, 480);
  }, { passive: true });
  document.addEventListener('pointermove', function (e) { if (holdTimer && (Math.abs(e.clientX - holdX) > 10 || Math.abs(e.clientY - holdY) > 10)) dropHold(); }, { passive: true });
  document.addEventListener('pointerup', dropHold, { passive: true });
  document.addEventListener('pointercancel', dropHold, { passive: true });
  document.addEventListener('click', function (e) {
    if (held) { held = false; e.preventDefault(); e.stopPropagation(); return; }
    var el = e.target && e.target.closest ? e.target.closest('.oc-card-more[data-oc-server], .oc-rail-server.is-active[data-oc-server]') : null;
    if (!el || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (el.classList.contains('oc-rail-server') && !isPhone()) return;   // a computer: the open server's tile is a link like the rest
    if (serverSheet(el)) e.preventDefault();
  }, true);

  // ── The composer: Send is lit while there is something to send; Add opens what the place takes (its pictures) ──
  var composeForm = document.getElementById('oc-compose'), composeInput = document.getElementById('oc-input');
  if (composeForm && composeInput) {
    var syncSend = function () { composeForm.classList.toggle('is-empty', !composeInput.value.trim()); };
    composeInput.addEventListener('input', syncSend);
    syncSend();
    var addButton = composeForm.querySelector('[data-oc-attach]'), addPanel = document.getElementById('oc-add-panel');
    if (addButton && addPanel) {
      addButton.addEventListener('click', function () { addPanel.open = !addPanel.open; });
      addPanel.addEventListener('toggle', function () {
        addButton.setAttribute('aria-expanded', addPanel.open ? 'true' : 'false');
        addButton.setAttribute('aria-label', addPanel.open ? 'Close' : 'Add a picture');
        addButton.title = addPanel.open ? 'Close' : 'Add a picture';
        if (addPanel.open) { var first = addPanel.querySelector('button, input:not([type=hidden])'); if (first) first.focus({ preventScroll: true }); }
      });
    }
  }

  // ── The shared user popout (openvibe-shared/user-card.js): every name and avatar opens it ──
  function token() {
    var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var people = Array.prototype.slice.call(document.querySelectorAll('[data-oc-user]'));
  // A message's author opens the card too: the message carries data-user, live messages included (one listener).
  // 11-14 (the owner: "the user context menu cross-site shared system doesn't work"): Global chat's messages arrive over
  // the socket after this runs, so the listener never waits for them; the card asks Network by username (Chat's own ids
  // are not Network's) and a public card needs no sign-in.
  var hasMessages = !!document.querySelector('.oc-feed, .oc-msg');
  if (!people.length && !hasMessages) return;
  var tok = token();
  if (window.OpenVibeUserCard && window.OpenVibeUserCard.init) window.OpenVibeUserCard.init({ apiBase: 'https://openvibe.network', token: tok || null });
  document.addEventListener('click', function (e) {
    var name = e.target && e.target.closest && e.target.closest('.oc-msg .oc-name');
    if (!name || !window.OpenVibeUserCard || e.ctrlKey || e.metaKey || e.shiftKey) return;   // a modifier opens the profile page
    var handle = (String(name.getAttribute('href') || '').match(/\/@([A-Za-z0-9_]{2,32})(?:$|[/?#])/) || [])[1];
    if (!handle) return;
    e.preventDefault();
    var box = name.getBoundingClientRect();
    window.OpenVibeUserCard.show(handle, box.left + 8, box.bottom + 8);
  });
  if (!tok) return;   // signed out: the members' cards by id need a session

  function openCard(el) {
    if (window.OpenVibeUserCard && window.OpenVibeUserCard.show) {
      var box = el.getBoundingClientRect();
      window.OpenVibeUserCard.show(el.getAttribute('data-oc-user'), box.left + 8, box.bottom + 8);
      return;
    }
    if (window.OpenVibeUserMenu && window.OpenVibeUserMenu.show) {
      var box2 = el.getBoundingClientRect();
      window.OpenVibeUserMenu.show(el.getAttribute('data-oc-user'), box2.left + 8, box2.bottom + 8);
    }
  }
  function wire() {
    if (!window.OpenVibeUserCard) return;
    window.OpenVibeUserCard.init({ apiBase: 'https://openvibe.network', token: tok });
    var phone = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    people.forEach(function (el) {
      var id = el.getAttribute('data-oc-user');
      if (!id) return;
      if (phone) {
        el.addEventListener('click', function (e) { e.preventDefault(); openCard(el); });
      } else {
        window.OpenVibeUserCard.attach(el, id);
        el.addEventListener('click', function (e) {
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); openCard(el); }
        });
      }
    });
    // Chat's own actions in the shared card: Message, Call, Add friend, Mute, Block, Report.
    if (window.OpenVibeUserMenu && window.OpenVibeUserMenu.register) {
      window.OpenVibeUserMenu.register({
        id: 'chat-message', label: 'Message', icon: '💬',
        onSelect: function (user) { window.location.href = '/messages/new?to=' + encodeURIComponent(user.username || ''); },
      });
      window.OpenVibeUserMenu.register({
        id: 'chat-friend', label: 'Add friend', icon: '＋',
        onSelect: function (user) {
          fetch('/api/dm/contacts', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username }),
          }).then(function (r) { if (r.ok) window.location.reload(); });
        },
      });
    }
  }
  if (window.OpenVibeUserCard) wire();
  else {
    var s = document.createElement('script');
    s.src = '/shared/user-card.js';
    s.async = true;
    s.onload = wire;
    s.onerror = function () { /* the card is optional */ };
    document.head.appendChild(s);
  }
})();
