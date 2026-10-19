/* openvibe.chat incoming calls: on every page of a signed-in person, a /ws/chat socket waits for the vc-call-invite
   that POST /api/streams/voice-channels/call-user pushes to the callee's sockets (Live's chat sockets get the same
   frame). It shows who is calling with Answer and Decline; Answer tells the caller (call-user/respond) and opens the
   call's page, Decline tells them too, and a ring nobody answers gives up after 30 seconds with "no-answer", as
   Live's client does. Already in a call on this page: "busy". Names are set with textContent. */
(function () {
  'use strict';
  if (!window.WebSocket || !window.fetch) return;
  var RING_MS = 30000;
  var page = (window.__OV_PAGE && window.__OV_PAGE.chat) || {};
  var ring = null;   // { msg, el, timer }

  function sessionToken() {
    var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  if (!sessionToken()) return;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function respond(msg, status) {
    return fetch('/api/streams/voice-channels/call-user/respond', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caller_user_id: Number(msg.fromUserId), channel_id: String(msg.channelId), channel_name: String(msg.channelName || 'Voice Channel'), status: status }),
    }).then(function (r) { return r.ok; }, function () { return false; });
  }
  function dismiss() {
    if (!ring) return;
    clearTimeout(ring.timer);
    if (ring.el) ring.el.remove();
    document.title = ring.title;
    ring = null;
  }
  // The call page's own call: a person in it is busy for another ring.
  function inCall() { return page.view === 'call' && !!document.querySelector('#oc-call-leave:not([hidden])'); }

  function show(msg) {
    if (!msg.fromUserId || !msg.channelId) return;
    if (ring && ring.msg.channelId === msg.channelId) return;
    if (ring || inCall()) { respond(msg, 'busy'); return; }
    var who = msg.fromDisplayName || msg.fromUsername || 'Someone';
    var box = el('div', 'oc-ring');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-live', 'assertive');
    box.setAttribute('aria-label', who + ' is calling you');
    var text = el('p', 'oc-ring-text');
    text.appendChild(el('strong', null, who));
    text.appendChild(document.createTextNode(' is calling you'));
    var actions = el('p', 'oc-ring-actions');
    var answer = el('button', 'oc-ring-answer', 'Answer');
    answer.type = 'button';
    var decline = el('button', 'oc-button--quiet', 'Decline');
    decline.type = 'button';
    actions.appendChild(answer); actions.appendChild(decline);
    box.appendChild(text); box.appendChild(actions);
    document.body.appendChild(box);
    ring = { msg: msg, el: box, title: document.title, timer: setTimeout(function () { var m = ring && ring.msg; dismiss(); if (m) respond(m, 'no-answer'); }, RING_MS) };
    document.title = who + ' is calling · ' + ring.title;
    answer.addEventListener('click', function () {
      var m = ring && ring.msg; if (!m) return;
      answer.disabled = decline.disabled = true;
      respond(m, 'accepted').then(function (ok) {
        dismiss();
        if (ok) location.href = '/call/' + encodeURIComponent(m.channelId);
        else { var gone = el('p', 'oc-ring oc-ring-gone', 'That call has ended.'); gone.setAttribute('role', 'status'); document.body.appendChild(gone); setTimeout(function () { gone.remove(); }, 4000); }
      });
    });
    decline.addEventListener('click', function () { var m = ring && ring.msg; dismiss(); if (m) respond(m, 'declined'); });
    answer.focus();
  }

  var delay = 2000, stopped = false;
  function connect() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 2000; ws.send(JSON.stringify({ type: 'join', token: sessionToken() || undefined })); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'vc-call-invite') show(m);
      else if (m.type === 'auth_revoked') { stopped = true; try { ws.close(); } catch (e) { /* */ } }
    };
    ws.onclose = function () { if (!stopped && sessionToken()) setTimeout(connect, delay = Math.min(delay * 2, 60000)); };
  }
  connect();
})();
