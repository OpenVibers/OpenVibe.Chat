(function () {
  'use strict';
  var box = document.querySelector('[data-server-emoji-manager]');
  if (!box) return;
  var url = '/api/chat/servers/' + encodeURIComponent(box.dataset.serverEmojiManager) + '/emojis';
  var status = box.querySelector('[data-emoji-status]');
  function done(response) { return response.json().then(function (body) { if (!response.ok) throw Error(body.error || 'Could not save emoji'); return body; }); }
  box.querySelector('[data-emoji-upload]').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget, file = form.elements.file.files[0];
    if (!file || file.size > 512 * 1024) { status.textContent = 'Choose an image up to 512 KB.'; return; }
    var button = form.querySelector('button'); button.disabled = true; status.textContent = 'Uploading…';
    fetch(url, { method: 'POST', credentials: 'same-origin', body: new FormData(form) }).then(done)
      .then(function () { location.reload(); }).catch(function (error) { status.textContent = error.message; button.disabled = false; });
  });
  box.addEventListener('click', function (event) {
    var button = event.target.closest('[data-emoji-remove]'); if (!button) return;
    button.disabled = true;
    fetch(url + '/' + encodeURIComponent(button.dataset.emojiRemove), { method: 'DELETE', credentials: 'same-origin' }).then(done)
      .then(function () { location.reload(); }).catch(function (error) { status.textContent = error.message; button.disabled = false; });
  });
}());
