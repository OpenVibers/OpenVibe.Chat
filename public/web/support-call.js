/* A support call (server/calls/call-server.js, channel support-<conversation>): a voice call between an inbox's people
   and its visitor, peer to peer (a full mesh, at most four), signalled over /ws/call with the protocol call.js speaks.
   The visitor's panel (embed.js) joins with the visitor token, the inbox page (inbox.js) with the person's session.

     var call = OVSupportCall.join({ channel: 'support-cnv_…', visitorToken: '…' | token: '…',
                                     onState: function (state, text) {},      // joining | in | ended | error
                                     onPeople: function (names) {},
                                     onScreen: function (stream | null, name) {} });   // someone's shared screen
     call.mute(true); call.share(); call.stopSharing(); call.leave();

   Voice, and a shared screen: the visitor may share theirs (the browser's own picker decides what), shown to the team;
   the microphone is asked for when joining (no microphone: you listen). The screen rides the same peer connections
   (renegotiated); camera-off false/true tells the others it started or stopped. */
(function () {
  'use strict';
  if (!window.RTCPeerConnection || !window.WebSocket) return;

  function join(opts) {
    var ws = null, localStream = null, myPeerId = null, ended = false, muted = false, screen = null;
    var iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    var peers = new Map(), people = new Map();
    var state = function (s, text) { if (opts.onState) opts.onState(s, text || ''); };
    var send = function (o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    var names = function () {
      if (!opts.onPeople) return;
      var list = []; people.forEach(function (p, id) { if (id !== myPeerId) list.push(p.displayName || p.username || 'Someone'); });
      opts.onPeople(list);
    };

    function closePeer(id) {
      var p = peers.get(id); if (!p) return;
      try { p.pc.close(); } catch (e) { /* */ }
      if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
      peers.delete(id);
    }
    function peer(id, initiator) {
      closePeer(id);
      var pc = new RTCPeerConnection({ iceServers: iceServers });
      var p = { pc: pc, audio: null, pending: [] };
      peers.set(id, p);
      if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
      else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });
      if (screen) p.screenSender = pc.addTrack(screen.getVideoTracks()[0], screen);
      pc.onicecandidate = function (e) { if (e.candidate) send({ type: 'ice-candidate', targetPeerId: id, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
      pc.ontrack = function (e) {
        if (e.track.kind === 'video') {
          var who = people.get(id);
          if (opts.onScreen) opts.onScreen(new MediaStream([e.track]), (who && (who.displayName || who.username)) || 'Someone');
          e.track.addEventListener('ended', function () { if (opts.onScreen) opts.onScreen(null); });
          return;
        }
        if (!p.audio) { p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.hidden = true; document.body.appendChild(p.audio); }
        p.audio.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      };
      if (initiator) offer(id, p);
      return p;
    }
    function offer(id, p) {
      p.pc.createOffer().then(function (o) { return p.pc.setLocalDescription(o); })
        .then(function () { send({ type: 'offer', targetPeerId: id, sdp: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } }); })
        .catch(function () { state('error', 'Could not start the call.'); });
    }
    function flush(p) { var c; while ((c = p.pending.shift())) p.pc.addIceCandidate(c).catch(function () {}); }

    function onMessage(m) {
      switch (m.type) {
        case 'welcome':
          myPeerId = m.peerId;
          (m.participants || []).forEach(function (x) { people.set(x.peerId, x); if (x.peerId !== myPeerId) peer(x.peerId, true); });
          state('in', localStream ? '' : 'No microphone: you can listen.'); names();
          break;
        case 'peer-joined': people.set(m.peerId, m); peer(m.peerId, false); names(); break;
        case 'peer-left': people.delete(m.peerId); closePeer(m.peerId); names(); if (opts.onScreen) opts.onScreen(null); break;
        case 'peer-camera': if (m.cameraOff && opts.onScreen) opts.onScreen(null); break;
        case 'offer': {
          var p = peers.get(m.fromPeerId) || peer(m.fromPeerId, false);
          p.pc.setRemoteDescription(m.sdp).then(function () { flush(p); return p.pc.createAnswer(); })
            .then(function (a) { return p.pc.setLocalDescription(a); })
            .then(function () { send({ type: 'answer', targetPeerId: m.fromPeerId, sdp: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } }); })
            .catch(function () { state('error', 'Could not connect the call.'); });
          break;
        }
        case 'answer': { var q = peers.get(m.fromPeerId); if (q) q.pc.setRemoteDescription(m.sdp).then(function () { flush(q); }).catch(function () {}); break; }
        case 'ice-candidate': {
          var r = peers.get(m.fromPeerId); if (!r || !m.candidate) break;
          if (r.pc.remoteDescription) r.pc.addIceCandidate(m.candidate).catch(function () {}); else r.pending.push(m.candidate);
          break;
        }
        case 'call-ended': case 'kicked': stop('ended', 'The call ended.'); break;
        case 'error': stop('error', m.message || 'The call is not available.'); break;
        default: break;
      }
    }

    function stopSharing() {
      if (!screen) return;
      screen.getTracks().forEach(function (t) { t.stop(); });
      screen = null;
      peers.forEach(function (p, id) { if (p.screenSender) { try { p.pc.removeTrack(p.screenSender); } catch (e) { /* */ } p.screenSender = null; offer(id, p); } });
      send({ type: 'camera-off', cameraOff: true });
      if (opts.onSharing) opts.onSharing(false);
    }
    function share() {
      if (screen || ended || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return Promise.resolve(false);
      return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false }).then(function (s) {
        if (ended) { s.getTracks().forEach(function (t) { t.stop(); }); return false; }
        screen = s;
        var track = s.getVideoTracks()[0];
        track.addEventListener('ended', stopSharing);   // the browser's own "Stop sharing"
        peers.forEach(function (p, id) { p.screenSender = p.pc.addTrack(track, s); offer(id, p); });
        send({ type: 'camera-off', cameraOff: false });
        if (opts.onSharing) opts.onSharing(true);
        return true;
      }, function () { return false; });
    }

    function stop(s, text) {
      if (ended) return;
      if (screen) { screen.getTracks().forEach(function (t) { t.stop(); }); screen = null; }
      ended = true;
      peers.forEach(function (p, id) { closePeer(id); });
      people.clear();
      if (ws) { try { ws.close(); } catch (e) { /* */ } ws = null; }
      if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
      state(s, text);
    }

    state('joining', 'Joining the call…');
    var ice = fetch('/api/chat/ice-servers', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && Array.isArray(d.iceServers) && d.iceServers.length) iceServers = d.iceServers; }).catch(function () {});
    var mic = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }).then(function (s) { if (ended) s.getTracks().forEach(function (t) { t.stop(); }); else localStream = s; }, function () {})
      : Promise.resolve();
    Promise.all([ice, mic]).then(function () {
      if (ended) return;
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/call?channelId=' + encodeURIComponent(opts.channel));
      ws.onopen = function () {
        if (opts.visitorToken) send({ type: 'support-visitor', token: opts.visitorToken });
        else if (opts.token) send({ type: 'auth-update', token: opts.token });
      };
      ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
      ws.onclose = function () { stop('ended', myPeerId ? 'The call ended.' : 'Could not reach the call.'); };
    });

    return {
      mute: function (on) { muted = !!on; if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; }); send({ type: 'mute', muted: muted }); },
      leave: function () { stop('ended', 'You left the call.'); },
      share: share,
      stopSharing: stopSharing,
      get sharing() { return !!screen; },
      get muted() { return muted; },
    };
  }

  window.OVSupportCall = { join: join };
})();
