(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
  var box = document.querySelector('[data-server-emoji-manager]');
  if (!box) return;
  var url = '/api/chat/servers/' + encodeURIComponent(box.dataset.serverEmojiManager) + '/emojis';
  var status = box.querySelector('[data-emoji-status]');
  var file = null;
  if (window.OVUpload) window.OVUpload.picker(box.querySelector('[data-emoji-picker]'), {
    accept: 'image/png,image/jpeg,image/gif,image/webp', label: 'Choose an emoji image',
    onFile: function (selected) { file = selected; }, onRemove: function (removed) { if (file === removed) file = null; }
  });
  function done(response) { return response.json().then(function (body) { if (!response.ok) throw Error(body.error || 'Could not save emoji'); return body; }); }
  box.querySelector('[data-emoji-upload]').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    if (!file || file.size > 512 * 1024) { status.textContent = 'Choose an image up to 512 KB.'; return; }
    var button = form.querySelector('button'); button.disabled = true; status.textContent = 'Uploading…';
    var data = new FormData(form); data.append('file', file);
    fetch(url, { method: 'POST', credentials: 'same-origin', body: data }).then(done)
      .then(function () { location.reload(); }).catch(function (error) { status.textContent = error.message; button.disabled = false; });
  });
  box.addEventListener('click', function (event) {
    var button = event.target.closest('[data-emoji-remove]'); if (!button) return;
    button.disabled = true;
    fetch(url + '/' + encodeURIComponent(button.dataset.emojiRemove), { method: 'DELETE', credentials: 'same-origin' }).then(done)
      .then(function () { location.reload(); }).catch(function (error) { status.textContent = error.message; button.disabled = false; });
  });
  });
}());
