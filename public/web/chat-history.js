/* One top-paging controller shared by Global, rooms/channels and DMs. */
(function (root) {
  'use strict';
  root.OvChatHistory = {
    attach: function (feed, state, fetchPage, render, hasMore) {
      if (!feed) return;
      var loading = false, more = hasMore !== false;
      if (state) { state.hidden = more; state.textContent = more ? '' : 'The start of the chat'; }
      function load() {
        if (loading || !more) return;
        var first = feed.querySelector('[data-id]');
        if (!first) return;
        loading = true;
        if (state) { state.hidden = false; state.textContent = 'Loading earlier messages'; }
        var cursor = Number(first.dataset.id), top = first.getBoundingClientRect().top;
        fetchPage(cursor).then(function (page) {
          if (!page || !Array.isArray(page.messages)) {
            if (state) { state.textContent = ''; state.hidden = true; }
            return;
          }
          var anchor = feed.querySelector('[data-id="' + first.dataset.id + '"]');
          // APIs return each page newest first; insert oldest first to retain the feed's chronological display.
          page.messages.slice().reverse().forEach(function (message) {
            if (!message || feed.querySelector('[data-id="' + Number(message.id) + '"]')) return;
            feed.insertBefore(render(message), anchor || (state && state.nextSibling) || feed.firstChild);
          });
          more = !!page.more;
          if (state) {
            state.textContent = more ? '' : 'The start of the chat';
            state.hidden = more;
          }
          if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - top;
        }).catch(function () { if (state) { state.textContent = ''; state.hidden = true; } }).finally(function () { loading = false; });
      }
      feed.addEventListener('scroll', function () { if (feed.scrollTop < 600) load(); });
      feed.scrollTop = feed.scrollHeight;
      return { load: load };
    }
  };
})(window);
