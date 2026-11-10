/* Chat's pictures: the shared picker and progress meter, then the form's own endpoint with the file.
   The page loads openvibe-shared/ov-upload.js and ov-upload.css. A room/channel picture, a new server's
   picture: each form names its root with [data-picture-upload]; the request is still multipart to the same
   server route that stores the picture in OpenVibe.Pics. */
(function () {
  'use strict';
  function load(root) {
    if (root.getAttribute('data-ready')) return;
    var form = root.closest('form');
    if (!form || !window.OVUpload) return;
    root.setAttribute('data-ready', '1');
    var status = form.querySelector('[data-picture-status]');
    var progressEl = form.querySelector('[data-picture-progress]');
    var meter = progressEl ? window.OVUpload.progress(progressEl, { onRetry: function () { send(); } }) : null;
    var file = null, busy = false;
    function say(text, bad) { if (status) { status.textContent = text || ''; status.className = 'oc-muted' + (bad ? ' oc-error' : ''); } }
    function pick(f) {
      file = f;
      if (progressEl) progressEl.hidden = true;
      say('Ready to send ' + f.name + '.');
    }
    window.OVUpload.picker(root, { label: 'Choose a picture', accept: root.getAttribute('data-accept') || 'image/*', onFile: pick, onRemove: function () { file = null; say(''); } });
    function send() {
      if (!file || busy) return;
      busy = true;
      var button = form.querySelector('button[type=submit]');
      if (button) button.disabled = true;
      var fd = new FormData(form);
      fd.append('picture', file, file.name);
      if (progressEl) progressEl.hidden = false;
      if (meter) meter.update({ state: 'sending', done: 0, total: file.size });
      say('Sending ' + file.name + '…');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', form.getAttribute('action') || location.pathname);
      xhr.withCredentials = true;
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && meter) meter.update({ state: 'sending', done: e.loaded, total: e.total }); };
      xhr.onload = function () {
        busy = false;
        if (button) button.disabled = false;
        if (xhr.status >= 200 && xhr.status < 400) {
          if (meter) meter.update({ state: 'done', done: file.size, total: file.size });
          say('Sent.');
          location.assign(xhr.responseURL || (form.getAttribute('action') || location.href));
          return;
        }
        var message = 'The picture did not send (' + xhr.status + ').';
        if (meter) meter.update({ state: 'failed', message: message });
        say(message, true);
      };
      xhr.onerror = function () {
        busy = false;
        if (button) button.disabled = false;
        var message = 'The connection dropped. Try again.';
        if (meter) meter.update({ state: 'failed', message: message });
        say(message, true);
      };
      xhr.send(fd);
    }
    form.addEventListener('submit', function (e) {
      if (!file) { e.preventDefault(); say('Choose a picture first.', true); return; }
      e.preventDefault();
      send();
    });
  }
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-picture-upload]'), load);
  }
  wire();
  document.addEventListener('ov:boost:load', wire);
})();
