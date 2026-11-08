/* openvibe.party: watch together (plan R1, Party watch v1; Opus's design). The page shell (server/web) gives
   <main data-party> with five empty regions and the party's view as JSON in #party-data. This script builds:

   - the stage: Shared's player (<video data-ov-player>) kept on the room's timeline by Shared's ov-sync over Chat's
     room socket (common.sync-clock@1), with honest states over it: waiting for the host, catching up (only past a
     second of drift), reconnecting;
   - the remote pill under it (common.control-lease@1): who has it and the one move that makes sense for you (Ask for
     it, Pass it, Take it, and Take it back for the room's owner, which always wins);
   - the people: faces, the one with the remote marked, the away ones dimmed while their seat waits;
   - the room's chat, with reactions that also float over the stage;
   - Invite: Shared's share sheet (the link and a QR code).

   Everything a person wrote is set with textContent; links are built from nodes. No tabs: on a phone the stage, a row
   of faces and the chat stack in one column. */
(function () {
  'use strict';
  var root = document.querySelector('main[data-party]');
  var dataEl = document.getElementById('party-data');
  if (!root || !dataEl) return;
  var data;
  try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
  // The shell (server/web/party-pages.js) sends { party: view }: the slug is its id, the host its subject.
  if (data && data.party) {
    var v = data.party;
    data = {
      slug: v.id, title: v.title, media: v.media, source_url: v.source_url, member: v.member,
      host: { subject: v.host, name: v.host_name || null },
      members: (v.members || []).map(function (m) { return { subject: m.subject, name: m.name }; }),
      // The shell's join_url never carries the key (the secret is not echoed into a page): only a URL that has one
      // is an invitation; otherwise the key kept from the link the person came by makes it (inviteUrl).
      clock: v.clock || null, lease: v.lease || null, invite_url: v.join_url && /[?&]k=/.test(v.join_url) ? v.join_url : null,
    };
  }

  var slug = root.getAttribute('data-party') || data.slug;
  var region = function (name) { return root.querySelector('[data-party-' + name + ']'); };
  var stage = region('stage'), people = region('people'), chat = region('chat'), remote = region('remote'), invite = region('invite');
  var REACTIONS = ['😂', '😮', '🔥', '❤️', '👏'];
  var DRIFT_SHOWN_MS = 1000;
  var self = data.self || null;                     // { subject, name } for a signed-in member
  var owner = data.host ? data.host.subject : null; // the room's owner: Take it back always works for them
  var names = {};
  (data.members || []).forEach(function (m) { if (m && m.subject) names[m.subject] = m.name || 'Someone'; });
  if (data.host && data.host.subject) names[data.host.subject] = data.host.name || names[data.host.subject] || 'The host';
  if (self && self.subject) names[self.subject] = self.name || names[self.subject] || 'You';
  var lease = data.lease || null, clock = data.clock || null, asked = null, everPlayed = !!(clock && (!clock.paused || clock.position_ms > 0));
  var away = {};                                    // subject -> when they left (their seat waits a minute)
  var ws = null, sync = null, delay = 1000, latest = 0, joined = false;

  // ── small helpers ────────────────────────────────────────────────────────────
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nameOf(subject) { return subject === (self && self.subject) ? 'You' : (names[subject] || 'Someone'); }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
  // FNV-1a over the whole subject, so two subjects that differ in one letter still get far-apart colours.
  function hue(s) { var h = 2166136261; s = String(s || ''); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return (h % 12) * 30; }
  function realName(subject) { return names[subject] || 'Someone'; }
  function send(frame) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(frame)); return true; } catch (e) { /* closed */ } } return false; }
  function token() {
    if (data.token) return data.token;
    var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  // The invite link carries the party's key. The server shows the key once (when the party is made); a member who
  // came by the link keeps it here, so they can invite others too.
  function inviteUrl() {
    var KEY = 'ov-party-key:' + slug, k = null;
    try { k = new URLSearchParams(location.search).get('k'); } catch (e) { /* old browser */ }
    try { if (k) localStorage.setItem(KEY, k); else k = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    return data.invite_url || ('https://openvibe.party/p/' + encodeURIComponent(slug) + (k ? '?k=' + encodeURIComponent(k) : ''));
  }

  // ── a guest: the link's holder who has not signed in ─────────────────────────
  // A party is a private room: its socket and its chat need a person. A guest sees the picture and one move, Sign in to
  // join, which comes straight back to this link (its key included). Nothing that would only fail is drawn: no remote,
  // no reactions, no composer, no count of who is watching, no socket (it answered "No such room").
  var guest = !token();
  var joinHref = '/auth/login?next=' + encodeURIComponent(location.pathname + location.search);
  function joinLink(cls, text) { var a = el('a', cls, text); a.href = joinHref; return a; }
  if (guest) root.classList.add('is-guest');

  // ── the stage ────────────────────────────────────────────────────────────────
  var src = typeof (clock && clock.media) === 'string' ? clock.media : (typeof data.media === 'string' ? data.media : null);
  var providerInfo = src && window.PartyProviders ? window.PartyProviders.parse(src) : null;
  var video = providerInfo ? null : el('video');
  var providerTarget = providerInfo ? el('div', 'pt-provider') : null;
  var provider = null, providerApplying = false, providerFailure = false;
  if (video) {
    video.setAttribute('data-ov-player', '');
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.controls = !guest;   // a guest's player would not follow the party: the invitation stands over it
    if (src) video.src = src;
  }
  var frame = el('div', 'pt-frame');
  if (video) frame.appendChild(video); else if (providerTarget) frame.appendChild(providerTarget);
  var veil = el('div', 'pt-veil');          // waiting / reconnecting, over the picture
  veil.setAttribute('role', 'status');
  var drift = el('span', 'pt-drift', 'Catching up…');
  drift.hidden = true;
  var floats = el('div', 'pt-floats');      // reactions rising over the picture
  floats.setAttribute('aria-hidden', 'true');
  frame.appendChild(veil); frame.appendChild(drift); frame.appendChild(floats);
  var refusal = el('p', 'pt-provider-refusal'); refusal.hidden = true;
  if (providerInfo) {
    refusal.appendChild(el('span', '', 'This player could not play the link.'));
    refusal.appendChild(document.createTextNode(' '));
    var external = el('a', '', 'Open on ' + (providerInfo.kind === 'youtube' ? 'YouTube' : 'Twitch'));
    external.href = providerInfo.url; external.target = '_blank'; external.rel = 'noopener';
    refusal.appendChild(external);
  }
  // The shell's own header (the title and who started it) leads; without one, the page writes its own.
  var shellHead = root.querySelector('.oc-party-head');
  var head = shellHead || el('div', 'pt-head');
  if (shellHead) head.classList.add('pt-head');
  else head.appendChild(el('h1', 'pt-title', data.title || 'Watch party'));
  if (data.source_url) {
    var from = el('a', 'pt-from', 'Open on its page ↗');
    from.href = data.source_url; from.target = '_blank'; from.rel = 'noopener';
    // Beside "Started by …" when the shell has that line; otherwise in the header.
    var by = shellHead && shellHead.querySelector('p');
    if (by) { by.appendChild(document.createTextNode(' · ')); by.appendChild(from); } else head.appendChild(from);
  }
  var bar = el('div', 'pt-bar');            // the remote pill and the reactions, under the picture
  // Invite sits right after the title, on its line.
  if (invite) { var h1 = head.querySelector('h1'); if (h1 && h1.nextSibling) head.insertBefore(invite, h1.nextSibling); else head.appendChild(invite); }
  stage.appendChild(head);
  stage.appendChild(frame);
  if (providerInfo) stage.appendChild(refusal);
  if (!guest) stage.appendChild(bar);
  if (remote && !guest) bar.appendChild(remote);
  var react = el('div', 'pt-react');
  react.setAttribute('aria-label', 'React');
  REACTIONS.forEach(function (r) {
    var b = el('button', 'pt-react-btn', r);
    b.type = 'button';
    b.setAttribute('aria-label', 'React ' + r);
    // It rises when the room's echo arrives, for everyone at once, the sender too.
    b.addEventListener('click', function () { send({ type: 'room_message', message: r }); });
    react.appendChild(b);
  });
  bar.appendChild(react);

  function rise(emoji) {
    var f = el('span', 'pt-float', emoji);
    f.style.left = (12 + Math.random() * 70) + '%';
    floats.appendChild(f);
    setTimeout(function () { f.remove(); }, 2600);
  }
  function holder() { return lease && lease.holder ? lease.holder : { kind: 'nobody', subject: null }; }
  function iHold() { var h = holder(); return !!(self && h.kind === 'person' && h.subject === self.subject); }
  function paintVeil() {
    if (guest) {
      veil.textContent = '';
      var host = data.host && data.host.name ? data.host.name : null;
      veil.appendChild(el('span', 'pt-veil-line', host ? host + ' invited you to watch together' : 'You are invited to watch together'));
      veil.appendChild(joinLink('pt-join', 'Sign in to join'));
      veil.hidden = false;
      frame.classList.add('is-waiting', 'is-guest');
      return;
    }
    var text = '';
    if (!ws || ws.readyState !== 1) text = joined ? 'Reconnecting…' : 'Joining the party…';
    else if (providerFailure) text = '';
    else if (!src) text = 'This party has nothing to play yet.';
    else if (!everPlayed && clock && clock.paused) text = iHold() ? 'Press play when everyone is here.' : 'Waiting for ' + (holder().kind === 'person' ? nameOf(holder().subject) : 'the host') + ' to press play';
    veil.textContent = text;
    veil.hidden = !text;
    frame.classList.toggle('is-waiting', !!text);
  }

  function providerClock(state, userAction) {
    if (!provider || !state || !providerReady) return;
    providerApplying = true;
    try { window.PartyProviderSync.follow(provider, state, Date.now(), DRIFT_SHOWN_MS / 1000); } catch (e) { /* a provider may reject autoplay */ }
    setTimeout(function () { providerApplying = false; }, 150);
    if (userAction && iHold()) {
      var pos = provider.live ? 0 : Math.max(0, Math.round((Number(provider.time()) || 0) * 1000));
      send({ type: 'sync', media: src, position_ms: pos, rate: Number(state.rate) || 1, paused: !!state.paused });
    }
  }
  var providerReady = false;
  if (providerInfo && providerTarget && window.PartyProviders) {
    provider = window.PartyProviders.create(providerTarget, src, function (event, value) {
      if (event === 'refused') {
        providerFailure = true; refusal.hidden = false; paintVeil(); return;
      }
      if (event === 'playing' || event === 'paused') {
        if (providerApplying) return;
        everPlayed = everPlayed || event === 'playing';
        var state = { paused: event === 'paused', rate: clock && clock.rate || 1, position_ms: Math.round((Number(provider.time()) || 0) * 1000), at_ms: Date.now() };
        if (!clock || !!clock.paused !== state.paused) providerClock(state, true);
        paintVeil();
      } else if (event === 'seek' && !providerApplying && iHold()) {
        send({ type: 'sync', media: src, position_ms: provider.live ? 0 : Math.round((Number(provider.time()) || 0) * 1000), rate: Number(clock && clock.rate) || 1, paused: !!(clock && clock.paused) });
      } else if (event === 'rate' && !providerApplying && iHold()) {
        send({ type: 'sync', media: src, position_ms: Math.round((Number(provider.time()) || 0) * 1000), rate: Number(value) || 1, paused: !!(clock && clock.paused) });
      }
    });
    if (!provider) { providerFailure = true; refusal.hidden = false; }
    else provider.ready.then(function () {
      providerReady = true; if (clock) providerClock(clock, false);
      if (provider.live && iHold()) send({ type: 'sync', media: src, position_ms: 0, rate: 1, paused: !!(clock && clock.paused) });
    }).catch(function () { providerFailure = true; refusal.hidden = false; paintVeil(); });
  }

  // ── the remote ───────────────────────────────────────────────────────────────
  function pill(text, moves) {
    remote.textContent = '';
    var p = el('div', 'pt-remote');
    var icon = el('span', 'pt-remote-ic');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="8" r="1.6"/><path d="M10 13h4M10 16.5h4"/></svg>';
    p.appendChild(icon);
    p.appendChild(el('span', 'pt-remote-text', text));
    (moves || []).forEach(function (m) {
      var b = el('button', 'pt-remote-btn' + (m.quiet ? ' is-quiet' : ''), m.label);
      b.type = 'button';
      b.addEventListener('click', m.run);
      p.appendChild(b);
    });
    remote.appendChild(p);
  }
  function passMenu() {
    var here = (lease && lease.watchers || []).filter(function (s) { return !self || s !== self.subject; });
    remote.textContent = '';
    var p = el('div', 'pt-remote is-menu');
    p.appendChild(el('span', 'pt-remote-text', here.length ? 'Pass the remote to' : 'Nobody else is here yet'));
    here.forEach(function (s) {
      var b = el('button', 'pt-remote-btn is-quiet', nameOf(s));
      b.type = 'button';
      b.addEventListener('click', function () { send({ type: 'lease.grant', to: { kind: 'person', subject: s } }); });
      p.appendChild(b);
    });
    var back = el('button', 'pt-remote-btn is-quiet', 'Cancel');
    back.type = 'button';
    back.addEventListener('click', paintRemote);
    p.appendChild(back);
    remote.appendChild(p);
  }
  function paintRemote() {
    if (!remote || guest) return;
    var h = holder(), mine = iHold(), isOwner = !!(self && self.subject === owner);
    var takeBack = { label: 'Take it back', run: function () { send({ type: 'lease.take' }); } };
    if (!self) return pill(h.kind === 'person' ? nameOf(h.subject) + ' has the remote' : 'Sign in to share the remote', []);
    if (mine) {
      var moves = [{ label: 'Pass it', run: passMenu }, { label: 'Let go', quiet: true, run: function () { send({ type: 'lease.release' }); } }];
      if (asked && asked !== self.subject) {
        moves.unshift({ label: 'Pass to ' + nameOf(asked), run: function () { send({ type: 'lease.grant', to: { kind: 'person', subject: asked } }); asked = null; } });
        return pill(nameOf(asked) + ' asks for the remote', moves);
      }
      return pill('You have the remote', moves);
    }
    if (h.kind === 'nobody') return pill('Nobody has the remote', [{ label: 'Take it', run: function () { send({ type: 'lease.request' }); } }]);
    if (h.kind === 'ai') return pill((names[h.subject] || 'Vibe') + ' has the remote', isOwner ? [takeBack] : []);
    var label = nameOf(h.subject) + ' has the remote' + (away[h.subject] ? ' (away a moment)' : '');
    var ask = { label: asked === self.subject ? 'Asked' : 'Ask for it', quiet: asked === self.subject, run: function () { if (send({ type: 'lease.request' })) { asked = self.subject; paintRemote(); } } };
    return pill(label, isOwner ? [ask, takeBack] : [ask]);
  }

  // ── the people ───────────────────────────────────────────────────────────────
  function paintPeople() {
    if (!people) return;
    people.textContent = '';
    if (guest) {
      people.appendChild(el('h2', 'pt-h', 'Watching'));
      people.appendChild(el('p', 'pt-guest-note', 'Sign in to see who is here.'));
      return;
    }
    var watching = (lease && lease.watchers) || [];
    var all = Object.keys(names);
    watching.forEach(function (s) { if (all.indexOf(s) < 0) all.push(s); });
    // Here first, then the ones whose seat waits, then the members who are not here.
    var rank = function (s) { return watching.indexOf(s) >= 0 ? 0 : away[s] ? 1 : 2; };
    all.sort(function (a, b) { return rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)); });
    var h = people.appendChild(el('h2', 'pt-h', watching.length === 1 ? '1 watching' : watching.length + ' watching'));
    h.id = 'pt-people-h';
    var list = el('ul', 'pt-faces');
    list.setAttribute('aria-labelledby', 'pt-people-h');
    all.forEach(function (s) {
      var here = watching.indexOf(s) >= 0, li = el('li', 'pt-face' + (here ? '' : ' is-away'));
      var dot = el('span', 'pt-avatar', initials(realName(s)));
      dot.style.setProperty('--h', String(hue(s)));
      li.appendChild(dot);
      li.appendChild(el('span', 'pt-face-name', nameOf(s)));
      var hd = holder();
      if (hd.kind === 'person' && hd.subject === s) { li.classList.add('has-remote'); li.appendChild(el('span', 'pt-face-tag', 'Remote')); }
      else if (!here && away[s]) li.appendChild(el('span', 'pt-face-tag is-quiet', 'Back soon'));
      if (s === owner) li.title = nameOf(s) + ' made this party';
      list.appendChild(li);
    });
    people.appendChild(list);
  }

  // ── the chat ─────────────────────────────────────────────────────────────────
  var thread = el('ol', 'pt-thread');
  thread.setAttribute('aria-live', 'polite');
  var empty = el('li', 'pt-empty', 'Say hello. Everyone here sees it.');
  thread.appendChild(empty);
  var form = el('form', 'pt-say');
  var input = el('input', 'pt-say-input');
  input.type = 'text'; input.maxLength = 500; input.placeholder = 'Message the party'; input.setAttribute('aria-label', 'Message the party'); input.autocomplete = 'off';
  var go = el('button', 'pt-say-btn', 'Send');
  go.type = 'submit';
  form.appendChild(input); form.appendChild(go);
  if (chat && guest) {
    chat.appendChild(el('h2', 'pt-h', 'Chat'));
    var note = el('p', 'pt-guest-note', 'The chat is for the people in the party. ');
    note.appendChild(joinLink(null, 'Sign in to join'));
    chat.appendChild(note);
  } else if (chat) {
    chat.appendChild(el('h2', 'pt-h', 'Chat'));
    chat.appendChild(thread);
    chat.appendChild(form);
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    if (send({ type: 'room_message', message: text })) input.value = '';
  });
  function textNodes(parent, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var url = m[0].replace(/[.,!?)]+$/, ''), a = el('a', null, url);
      a.href = url; a.target = '_blank'; a.rel = 'noopener nofollow ugc';
      parent.appendChild(a); last = m.index + url.length; re.lastIndex = last;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  var ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|️|‍){1,8}$/u;
  function render(m, live) {
    if (!m || m.id == null || thread.querySelector('[data-id="' + m.id + '"]')) return;
    if (empty.parentNode) empty.remove();
    var stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    var text = String(m.message || '');
    var li = el('li', 'pt-msg' + (ONLY_EMOJI.test(text) ? ' is-react' : ''));
    li.dataset.id = String(m.id);
    li.appendChild(el('b', 'pt-msg-who', m.display_name || m.username || 'Someone'));
    var t = el('span', 'pt-msg-text');
    textNodes(t, text);
    li.appendChild(t);
    thread.appendChild(li);
    latest = Math.max(latest, Number(m.id) || 0);
    if (stick) thread.scrollTop = thread.scrollHeight;
    if (live && ONLY_EMOJI.test(text)) rise(text);
  }
  function catchUp() {
    var headers = {};
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    fetch('/api/chat/rooms/' + encodeURIComponent(slug) + '/messages' + (latest ? '?after=' + latest : ''), { headers: headers, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.messages) d.messages.forEach(function (m) { render(m, false); }); })
      .catch(function () { /* offline: the socket brings what comes next */ });
  }

  // ── the socket ───────────────────────────────────────────────────────────────
  function connect() {
    if (guest) { paintVeil(); return; }
    if (!window.WebSocket) { paintVeil(); return; }
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
    ws.onopen = function () { delay = 1000; send({ type: 'join_room', room: slug, token: token() }); paintVeil(); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.room && m.room !== slug) return;
      if (m.type === 'room_joined') {
        joined = true;
        if (m.subject && !self) self = { subject: m.subject, name: names[m.subject] || 'You' };
        if (!sync && window.OVSync && video) sync = window.OVSync.attach(video, { room: slug, socket: ws, self: self && self.subject });
        catchUp();
      } else if (m.type === 'sync' && m.state) {
        clock = m.state;
        if (!clock.paused || clock.position_ms > 0) everPlayed = true;
        if (!src && typeof clock.media === 'string' && video) { src = clock.media; video.src = src; }
        if (provider) providerClock(clock, false);
      } else if (m.type === 'lease' && m.state) {
        var before = lease && lease.watchers ? lease.watchers : [];
        lease = m.state;
        before.forEach(function (s) { if ((lease.watchers || []).indexOf(s) < 0) away[s] = Date.now(); });
        (lease.watchers || []).forEach(function (s) { delete away[s]; });
        if (iHold() || holder().kind !== 'person' || (asked && holder().subject === asked)) asked = null;
      } else if (m.type === 'lease.request' && m.request && m.request.requester) {
        if (iHold()) asked = m.request.requester.subject;
      } else if (m.type === 'room_message' && m.message) {
        render(m.message, true);
      } else if (m.type === 'lease_error' || m.type === 'sync_error' || m.type === 'room_error') {
        flash(m.message || 'That did not work.');
      }
      paintVeil(); paintRemote(); paintPeople();
    };
    ws.onclose = function () {
      if (sync && sync.destroy) { try { sync.destroy(); } catch (e) { /* gone */ } }
      sync = null;
      paintVeil();
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    };
  }
  var flashEl = el('p', 'pt-flash');
  flashEl.setAttribute('role', 'alert');
  flashEl.hidden = true;
  stage.appendChild(flashEl);
  var flashTimer = null;
  function flash(text) { flashEl.textContent = text; flashEl.hidden = false; clearTimeout(flashTimer); flashTimer = setTimeout(function () { flashEl.hidden = true; }, 4000); }

  // Catching up shows only past a second of drift, and only while the room plays.
  setInterval(function () {
    var d = sync && sync.drift ? Math.abs(Number(sync.drift()) || 0) : 0;
    if (provider && clock && !clock.paused && providerReady && !provider.live) {
      var expected = window.PartyProviderSync.expected(clock, Date.now());
      d = Math.abs((Number(provider.time()) || 0) - expected) * 1000;
      if (d > DRIFT_SHOWN_MS) providerClock(clock, false);
    }
    drift.hidden = !(clock && !clock.paused && d > DRIFT_SHOWN_MS);
    // A seat waits a minute; after it, the person is simply not here.
    var now = Date.now(), changed = false;
    Object.keys(away).forEach(function (s) { if (now - away[s] > 60000) { delete away[s]; changed = true; } });
    if (changed) { paintPeople(); paintRemote(); }
  }, 500);
  if (video) video.addEventListener('play', function () { everPlayed = true; paintVeil(); });

  // ── invite ───────────────────────────────────────────────────────────────────
  if (invite && !guest) {
    var ib = el('button', 'pt-invite', 'Invite');
    ib.type = 'button';
    ib.addEventListener('click', function () {
      var url = inviteUrl();
      var open = function () { window.OVShare.open({ url: url, title: data.title || 'Watch with me', kind: 'party', id: slug }); };
      if (window.OVShare) return open();
      var s = document.createElement('script');
      s.src = '/shared/ov-share.js';
      s.onload = function () { if (window.OVShare) open(); };
      s.onerror = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { flash('Invite link copied'); }, function () { flash(url); });
        else flash(url);
      };
      document.head.appendChild(s);
    });
    invite.appendChild(ib);
  }

  paintVeil(); paintRemote(); paintPeople();
  connect();
})();
