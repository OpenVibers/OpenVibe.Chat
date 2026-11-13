/* A chat.embed@1 agent-run card follows its owner-authorized AG-UI stream through Network. */
(function (root) {
  'use strict';
  function token() {
    var m = /(?:^|;\s*)ov_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var loading = null;
  function shared() {
    if (root.OpenVibeAgentSession) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var script = document.createElement('script'); script.src = '/shared/agent-session.js'; script.async = true;
      script.onload = function () { resolve(!!root.OpenVibeAgentSession); };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
    });
    return loading;
  }
  function mountAll(from) {
    Array.prototype.forEach.call((from || document).querySelectorAll('.oc-agent-run:not([data-mounted])'), function (host) {
      host.dataset.mounted = '1';
      var bearer = token(), runUrl = host.dataset.ovRunUrl, eventsUrl = host.dataset.ovEventsUrl;
      if (!bearer || !/^https:\/\/openvibe\.network\/api\/frame\/(?:codes-runs|agent-runs\/actor)\/tsk_[0-9A-HJKMNP-TV-Z]{26}(?:~[1-9][0-9]*)?$/.test(runUrl || '') || eventsUrl !== runUrl + '/events') return;
      shared().then(function (ready) {
        if (!ready || !host.isConnected) return;
        return fetch(runUrl, { credentials: 'omit', headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (run) {
          if (!run || !host.isConnected) return;
          var href = host.querySelector('a') && host.querySelector('a').href;
          var view = root.OpenVibeAgentSession.mount(host, { mode: 'card', href: href, title: run.title || host.dataset.ovRunTitle, status: run.status || 'running' });
          var last = 0;
          function follow() {
            if (!host.isConnected) { view.destroy(); return; }
            return fetch(eventsUrl, { credentials: 'omit', headers: { Authorization: 'Bearer ' + bearer, Accept: 'text/event-stream', 'Last-Event-ID': String(last) } }).then(function (r) {
              if (!r.ok || !r.body) return;
              var reader = r.body.getReader(), decoder = new TextDecoder(), buffer = '', done = false;
              function read() { if (!host.isConnected) { reader.cancel(); view.destroy(); return Promise.resolve(); } return reader.read().then(function (part) {
                if (part.done) return;
                if (!host.isConnected) { reader.cancel(); view.destroy(); return; }
                buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n');
                var cut;
                while ((cut = buffer.indexOf('\n\n')) !== -1) {
                  var frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
                  var id = /^id: *(\d+)$/m.exec(frame);
                  var data = frame.split('\n').filter(function (line) { return line.indexOf('data:') === 0; }).map(function (line) { return line.slice(5).trimStart(); }).join('\n');
                  if (id) last = Number(id[1]);
                  if (data) try { var event = JSON.parse(data); view.push(event); if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') done = true; } catch (err) { /* one malformed event is skipped */ }
                }
                return read();
              }); }
              return read().then(function () { if (!done && host.isConnected && /running|queued|placed/.test(run.status || '')) setTimeout(follow, 1500); });
            }).catch(function () {
              if (host.isConnected && /running|queued|placed/.test(run.status || '')) setTimeout(follow, 1500);
            });
          }
          follow();
        });
      }).catch(function () { /* the link remains available */ });
    });
  }
  root.OpenVibeAgentRunCards = { mountAll: mountAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mountAll(document); });
  else mountAll(document);
})(window);
