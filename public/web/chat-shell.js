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

  // ── The shared user popout (openvibe-shared/user-card.js): every name and avatar opens it ──
  function token() {
    var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var people = Array.prototype.slice.call(document.querySelectorAll('[data-oc-user]'));
  if (!people.length) return;
  var tok = token();
  if (!tok) return;   // signed out: no card to open

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
