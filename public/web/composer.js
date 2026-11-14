/* The Chat composer on the shared one (openvibe-shared 4.217.0, OpenVibeComposer.mount, preset chat): the room,
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
    // 4.247.0 (plan §Z.9): a room's box sends the files it takes to Media's composer attachments as they are
    // picked (any video, picture, sound, PDF or text, at Media's limits) and puts their ids on the form. The
    // room's own server checks them with Media and keeps them with the message. A box that says nothing keeps
    // the plain upload.
    var media = form.hasAttribute('data-ovc-media');
    var c = window.OpenVibeComposer.mount(document.createElement('div'), {
      preset: 'chat', name: ta.name || 'message', maxLength: Number(ta.getAttribute('maxlength')) || 4000,
      placeholder: ta.placeholder || 'Write a message', label: ta.getAttribute('aria-label') || form.getAttribute('aria-label') || 'Message',
      tools: ['emoji'], media: !!media, maxFiles: media ? 4 : undefined,
    });
    if (!c) return;
    c.text.id = ta.id || 'oc-input';
    // The mounted form IS the box (not its children in the old one): api.edit() and its submit capture belong to
    // this form, so Enter saves an edit before the room's send handler hears it.
    c.form.id = form.id || 'oc-compose';
    c.form.className = 'oc-compose ovt-composer ovc-v2';
    c.form.dataset.preset = 'chat';
    c.form.dataset.ovcCompose = '';
    c.form.setAttribute('action', form.getAttribute('action') || '');
    c.form.setAttribute('method', form.getAttribute('method') || 'post');
    Array.prototype.forEach.call(form.querySelectorAll('input[type="hidden"]'), function (h) { c.form.appendChild(h.cloneNode(true)); });
    if (add) { var tools = c.form.querySelector('.ovt-c-tools'); if (tools) tools.insertBefore(add, tools.firstChild); }
    c.form.__ovcComposer = c;
    if (form.parentNode) form.parentNode.replaceChild(c.form, form);
  }
  window.OVChatComposer = { scan: scan, upgrade: upgrade };
})();
