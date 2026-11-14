/* openvibe.chat/vibe, signed in: the network's messenger full-page (openvibe-shared ov-run.js OpenVibeRun.page, 4.250.0;
   plan §AB.47, the owner: "the same conversation system everywhere"). Your agents and conversations on the left, the
   open one on the right; on a phone one at a time. It reads and writes through the Frame's Run API with the person's
   Network token (the navbar's), so a conversation here is the same one in the menu's Vibe on every site.
   It only takes over once ov-run.js has loaded and the navbar has the token: until then, and if either never comes,
   the server-rendered page (public/web/vibe.js) stays and works. ?ask= (Ask Vibe from another site) goes into the box. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || cfg.view !== 'vibe' || cfg.room || !cfg.signedIn) return;
  var app = document.getElementById('vb');
  if (!app) return;
  var STARTERS = [
    ['bell', 'Remind me to stretch every 2 hours'],
    ['search', 'What is new on OpenVibe this week?'],
    ['live', 'Who is live right now?'],
    ['spark', 'Explain a concept I am curious about in plain English'],
  ];
  function loadRun() {
    if (window.OpenVibeRun && window.OpenVibeRun.page) return Promise.resolve(window.OpenVibeRun);
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script'); sc.src = '/shared/ov-run.js'; sc.async = true;
      sc.onload = function () { return window.OpenVibeRun && window.OpenVibeRun.page ? resolve(window.OpenVibeRun) : reject(new Error('ov-run.js has no page')); };
      sc.onerror = function () { reject(new Error('ov-run.js')); };
      document.head.appendChild(sc);
    });
  }
  // The navbar finds the person's token after the page loads (its own session read): wait for it, up to 8 s.
  function tokenSoon() {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function look() {
        var N = window.OpenVibeNavbar; var t = N && typeof N.token === 'function' ? N.token() : null;
        if (t) return resolve(t);
        if (Date.now() - start > 8000) return resolve(null);
        setTimeout(look, 150);
      })();
    });
  }
  var ask = '';
  try { ask = String(new URLSearchParams(location.search).get('ask') || '').slice(0, 1200); } catch (e) { ask = ''; }
  Promise.all([loadRun(), tokenSoon()]).then(function (got) {
    var R = got[0], token = got[1];
    if (!token) return;   // the server-rendered page stays
    var host = document.createElement('div'); host.className = 'vb-messenger';
    app.replaceWith(host);
    document.documentElement.classList.add('vb-has-messenger');
    var page = R.page(host, {
      base: 'https://openvibe.network/api/frame',
      token: function () { var N = window.OpenVibeNavbar; return (N && N.token && N.token()) || token; },
      agent: true, starters: STARTERS,
      actions: { base: 'https://openvibe.network' },
      sibling: function (file) { return '/shared/' + file; },
      onPlace: function (p) {
        // The address follows the open conversation, so a reload or a shared link comes back to it.
        try { if (p && p.ref && /^chat:/.test(p.ref)) history.replaceState(null, '', '/vibe?c=' + encodeURIComponent(String(p.ref).slice(5))); else if (p && p.blank) history.replaceState(null, '', '/vibe'); } catch (e) { /* the address stays */ }
      },
      open: (function () { try { var c = new URLSearchParams(location.search).get('c'); return c && /^[A-Za-z0-9_-]{1,80}$/.test(c) ? 'chat:' + c : null; } catch (e) { return null; } })(),
    });
    if (ask && page.main && page.main.prefill) page.main.prefill(ask);
  }, function () { /* ov-run.js did not load: the server-rendered page stays */ });
})();
