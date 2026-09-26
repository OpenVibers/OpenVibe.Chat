/* openvibe.chat call rooms: the room's voice call in the page. Audio only, peer to peer (a full mesh, as
   Live's call client), signalled over /ws/call?channelId=room-<slug> with the protocol of
   server/calls/call-server.js: the newcomer offers to everyone already in, the others answer. The room's
   roles decide who talks (the server force-mutes listeners; this client never sends a microphone it may
   not use). Names are set with textContent. The room's chat works without this file. */
(function () {
  'use strict';
  var cfg = (window.__OV_PAGE && window.__OV_PAGE.chat) || null;
  if (!cfg || !cfg.call || !cfg.call.join || !window.RTCPeerConnection || !window.WebSocket) return;
  var $ = function (id) { return document.getElementById(id); };
  var joinBtn = $('oc-call-join'), muteBtn = $('oc-call-mute'), leaveBtn = $('oc-call-leave');
  var statusEl = $('oc-call-status'), peopleEl = $('oc-call-people'), countEl = $('oc-call-count'), howEl = $('oc-call-how');
  if (!joinBtn) return;

  var canTalk = !!cfg.call.talk;
  var ws = null, myPeerId = null, localStream = null, muted = false, forceMuted = !canTalk, joined = false, connecting = false;
  var attempt = 0;   // each join; a teardown makes an attempt still starting stale
  var iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  var peers = new Map();      // peerId → { pc, audio, pending: [candidates] }
  var people = new Map();     // peerId → participant info from the server

  function status(text) { if (statusEl) statusEl.textContent = text || ''; }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function render() {
    if (!peopleEl) return;
    peopleEl.textContent = '';
    if (!people.size) { peopleEl.appendChild(el('li', 'oc-muted', 'Nobody is in the call yet.')); }
    people.forEach(function (p, id) {
      var li = el('li', null, (p.displayName || p.username || p.anonId || 'Guest') + (id === myPeerId ? ' (you)' : ''));
      var state = p.canTalk === false || p.forceMuted ? 'listening' : p.muted ? 'muted' : '';
      if (state) { li.appendChild(document.createTextNode(' ')); li.appendChild(el('span', 'oc-muted', '(' + state + ')')); }
      peopleEl.appendChild(li);
    });
    if (countEl) countEl.textContent = people.size ? '· ' + people.size + ' in' : '';
  }
  function setButtons() {
    joinBtn.hidden = joined;
    joinBtn.disabled = connecting;
    leaveBtn.hidden = !joined;
    muteBtn.hidden = !joined || !localStream;
    muteBtn.disabled = forceMuted;
    muteBtn.textContent = muted || forceMuted ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', muted || forceMuted ? 'true' : 'false');
  }
  function applyMute() {
    if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !(muted || forceMuted); });
    setButtons();
  }

  function closePeer(id) {
    var p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch (e) { /* */ }
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    peers.delete(id);
  }
  function createPeer(id, initiator) {
    closePeer(id);
    var pc = new RTCPeerConnection({ iceServers: iceServers });
    var p = { pc: pc, audio: null, pending: [] };
    peers.set(id, p);
    if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = function (e) { if (e.candidate) send({ type: 'ice-candidate', targetPeerId: id, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.ontrack = function (e) {
      if (!p.audio) { p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.hidden = true; document.body.appendChild(p.audio); }
      p.audio.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
    };
    pc.onconnectionstatechange = function () { if (pc.connectionState === 'failed') status('The connection to someone in the call failed. Leave and join again to retry.'); };
    if (initiator) {
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
        .then(function () { send({ type: 'offer', targetPeerId: id, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); })
        .catch(function () { status('Could not start the call with someone.'); });
    }
    return p;
  }
  function flush(p) { var c; while ((c = p.pending.shift())) p.pc.addIceCandidate(c).catch(function () {}); }

  function onMessage(m) {
    switch (m.type) {
      case 'welcome':
        myPeerId = m.peerId; joined = true; connecting = false;
        people.clear();
        (m.participants || []).forEach(function (p) { people.set(p.peerId, p); });
        if (typeof m.canTalk === 'boolean' && m.canTalk !== canTalk) { rejoin(m.canTalk); return; }
        (m.participants || []).forEach(function (p) { if (p.peerId !== myPeerId) createPeer(p.peerId, true); });
        status(canTalk ? 'You are in the call.' : 'You are listening.');
        render(); applyMute();
        break;
      case 'peer-joined':
        people.set(m.peerId, m); createPeer(m.peerId, false); render();
        break;
      case 'peer-left':
        people.delete(m.peerId); closePeer(m.peerId); render();
        break;
      case 'peer-updated':
        people.set(m.peerId, Object.assign(people.get(m.peerId) || {}, m)); render();
        break;
      case 'peer-muted': case 'peer-force-muted': {
        var who = people.get(m.peerId);
        if (who) { if (m.type === 'peer-muted') who.muted = !!m.muted; else who.forceMuted = !!m.forceMuted; render(); }
        break;
      }
      case 'offer': {
        var p = peers.get(m.fromPeerId) || createPeer(m.fromPeerId, false);
        p.pc.setRemoteDescription(m.sdp)
          .then(function () { flush(p); return p.pc.createAnswer(); })
          .then(function (a) { return p.pc.setLocalDescription(a); })
          .then(function () { send({ type: 'answer', targetPeerId: m.fromPeerId, sdp: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } }); })
          .catch(function () { status('Could not connect to someone in the call.'); });
        break;
      }
      case 'answer': {
        var q = peers.get(m.fromPeerId);
        if (q) q.pc.setRemoteDescription(m.sdp).then(function () { flush(q); }).catch(function () {});
        break;
      }
      case 'ice-candidate': {
        var r = peers.get(m.fromPeerId);
        if (!r || !m.candidate) break;
        if (r.pc.remoteDescription) r.pc.addIceCandidate(m.candidate).catch(function () {});
        else r.pending.push(m.candidate);
        break;
      }
      case 'force-muted':
        forceMuted = !!m.forceMuted; applyMute();
        break;
      case 'room-role':
        // A moderator changed your role: a new speaker needs the microphone, a new listener gives it up.
        if (typeof m.canTalk === 'boolean' && m.canTalk !== canTalk) rejoin(m.canTalk);
        break;
      case 'kicked': teardown('You were removed from the call.'); break;
      case 'banned': teardown('You were banned from this call.'); break;
      case 'call-ended': teardown('The call ended.'); break;
      case 'replaced': teardown('You joined this call from another tab.'); break;
      case 'error': teardown(m.message || 'The call is not available.'); break;
      default: break;
    }
  }

  function teardown(text) {
    attempt++;
    connecting = false;
    peers.forEach(function (p, id) { closePeer(id); });
    people.clear();
    if (ws) { try { ws.close(); } catch (e) { /* */ } ws = null; }
    if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
    joined = false; myPeerId = null;
    render(); setButtons();
    if (text != null) status(text);
  }
  function rejoin(talk) {
    canTalk = talk; forceMuted = !talk;
    if (howEl) howEl.textContent = talk ? 'You can talk in this call.' : 'You are listening. The owner or a moderator can make you a speaker.';
    teardown(talk ? 'You can talk now. Joining with your microphone…' : 'You are a listener now. Rejoining…');
    join();
  }

  function join() {
    var mine = ++attempt;
    connecting = true; setButtons();
    status('Joining…');
    var ice = fetch('/api/chat/ice-servers', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && Array.isArray(d.iceServers) && d.iceServers.length) iceServers = d.iceServers; })
      .catch(function () { /* STUN only */ });
    var mic = canTalk && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        .then(function (s) { if (mine === attempt) localStream = s; else s.getTracks().forEach(function (t) { t.stop(); }); }, function () { status('No microphone: you will listen until you allow it and join again.'); })
      : Promise.resolve();
    Promise.all([ice, mic]).then(function () {
      if (mine !== attempt) return;
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/call?channelId=' + encodeURIComponent(cfg.call.channel));
      ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
      var sock = ws;
      ws.onclose = function () { if (sock === ws && mine === attempt) teardown(joined ? 'The call was disconnected. Join again to reconnect.' : 'Could not reach the call.'); };
    });
  }

  joinBtn.hidden = false;
  joinBtn.addEventListener('click', join);
  leaveBtn.addEventListener('click', function () { teardown('You left the call.'); });
  muteBtn.addEventListener('click', function () {
    if (forceMuted) return;
    muted = !muted; applyMute();
    send({ type: 'mute', muted: muted });
  });
  window.addEventListener('pagehide', function () { if (joined) teardown(null); });
})();
