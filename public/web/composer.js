/* The Chat composer on the shared one (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset chat): the room,
   conversation and global message boxes keep their form (action, socket submit, no-JS post) and become the shared
   box with its tools and Send. Add stays beside them where the place takes pictures. Without ov-composer.js the
   server's form is untouched. */
(function () {
  'use strict';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true }); else scan();
  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-ovc-compose]'), upgrade);
  }
  function upgrade(form) {
    if (!form || form.__ovcComposer || !window.OpenVibeComposer || !window.OpenVibeComposer.mount) return;
    var ta = form.querySelector('textarea');
    if (!ta) return;
    var add = form.querySelector('[data-oc-attach]');
    var c = window.OpenVibeComposer.mount(document.createElement('div'), {
      preset: 'chat', name: ta.name || 'message', maxLength: Number(ta.getAttribute('maxlength')) || 4000,
      placeholder: ta.placeholder || 'Write a message', label: ta.getAttribute('aria-label') || form.getAttribute('aria-label') || 'Message',
      tools: ['emoji'],
    });
    if (!c) return;
    c.text.id = ta.id || 'oc-input';
    form.textContent = '';
    while (c.form.firstChild) form.appendChild(c.form.firstChild);
    form.classList.add('ovt-composer', 'ovc-v2');
    form.dataset.preset = 'chat';
    if (add) { var tools = form.querySelector('.ovt-c-tools'); if (tools) tools.insertBefore(add, tools.firstChild); }
    form.__ovcComposer = c;
  }
  window.OVChatComposer = { scan: scan, upgrade: upgrade };
})();
