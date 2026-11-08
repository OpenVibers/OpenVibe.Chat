/* Official player adapters for openvibe.party. This file is CommonJS-testable and also exposes the browser API. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PartyProviders = factory();
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function parse(value) {
    try {
      var u = new URL(value), host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
      var m;
      if (host === 'youtu.be' && (m = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname))) return { kind: 'youtube', id: m[1], live: false, url: 'https://www.youtube.com/watch?v=' + m[1] };
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
        m = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname);
        var id = u.pathname === '/watch' ? u.searchParams.get('v') : (m && m[1]);
        if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return { kind: 'youtube', id: id, live: false, url: 'https://www.youtube.com/watch?v=' + id };
      }
      if (host === 'twitch.tv' || host === 'www.twitch.tv') {
        m = /^\/videos\/(\d+)\/?$/.exec(u.pathname);
        if (m) return { kind: 'twitch', id: m[1], live: false, url: 'https://www.twitch.tv/videos/' + m[1] };
        m = /^\/([A-Za-z0-9_]{1,25})\/?$/.exec(u.pathname);
        if (m) return { kind: 'twitch', id: m[1], live: true, url: 'https://www.twitch.tv/' + m[1] };
      }
    } catch (_) { /* invalid URL */ }
    return null;
  }
  function loadScript(src, test, ready) {
    if (test()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      ready(resolve); var script = document.createElement('script'); script.src = src; script.async = true;
      script.onerror = function () { reject(new Error('The player could not be loaded.')); };
      document.head.appendChild(script);
    });
  }
  function youtube(target, media, onState) {
    var player, dead = false, readyResolve, readyReject;
    var ready = new Promise(function (r, j) { readyResolve = r; readyReject = j; });
    var previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () { if (typeof previous === 'function') previous(); create(); };
    function create() {
      if (dead || player || !window.YT || !window.YT.Player) return;
      player = new window.YT.Player(target, { videoId: media.id, host: 'https://www.youtube-nocookie.com', playerVars: { playsinline: 1, origin: location.origin }, events: {
        onReady: function () { readyResolve(); },
        onStateChange: function (e) { onState(e.data === 1 ? 'playing' : e.data === 2 ? 'paused' : e.data === 0 ? 'ended' : e.data === 3 ? 'seek' : 'buffering'); },
        onPlaybackRateChange: function (e) { onState('rate', e.data); },
        onError: function () { onState('refused'); readyReject(new Error('YouTube refused this video.')); }
      }});
    }
    loadScript('https://www.youtube.com/iframe_api', function () { return !!(window.YT && window.YT.Player); }, create).then(create).catch(function (err) { onState('refused'); readyReject(err); });
    return { ready: ready, supportsRate: true, play: function () { player.playVideo(); }, pause: function () { player.pauseVideo(); }, seek: function (s) { player.seekTo(s, true); }, time: function () { return player.getCurrentTime(); }, rate: function (r) { if (player.setPlaybackRate) player.setPlaybackRate(r); }, destroy: function () { dead = true; if (player) player.destroy(); } };
  }
  function twitch(target, media, onState) {
    var player, dead = false, readyResolve, readyReject;
    var ready = new Promise(function (r, j) { readyResolve = r; readyReject = j; });
    var options = { width: '100%', height: '100%', parent: [location.hostname], autoplay: false, muted: false, layout: 'video' };
    options[media.live ? 'channel' : 'video'] = media.id;
    loadScript('https://embed.twitch.tv/embed/v1.js', function () { return !!window.Twitch && !!window.Twitch.Embed; }, function () {}).then(function () {
      if (dead) return;
      var embed = new window.Twitch.Embed(target, options);
      embed.addEventListener(window.Twitch.Embed.VIDEO_READY, function () {
        clearTimeout(timer);
        player = embed.getPlayer();
        readyResolve();
        ['PLAY', 'PAUSE', 'ENDED', 'SEEK', 'PLAYBACK_BLOCKED', 'OFFLINE'].forEach(function (name) {
          var type = window.Twitch.Player && window.Twitch.Player[name];
          if (type) player.addEventListener(type, function () { onState(name === 'PLAY' ? 'playing' : name === 'PAUSE' ? 'paused' : name === 'ENDED' ? 'ended' : name === 'SEEK' ? 'seek' : 'refused'); });
        });
      });
      var timer = setTimeout(function () { if (!player) { onState('refused'); readyReject(new Error('Twitch player did not become ready.')); } }, 15000);
    }).catch(function (err) { onState('refused'); readyReject(err); });
    return { ready: ready, supportsRate: false, play: function () { player.play(); }, pause: function () { player.pause(); }, seek: function (s) { if (!media.live) player.seek(s); }, time: function () { return media.live ? 0 : player.getCurrentTime(); }, live: media.live, destroy: function () { dead = true; } };
  }
  function create(target, url, onState) { var p = parse(url); if (!p) return null; return p.kind === 'youtube' ? youtube(target, p, onState) : twitch(target, p, onState); }
  return { parse: parse, create: create };
}));
