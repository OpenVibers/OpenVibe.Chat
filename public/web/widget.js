/* OpenVibe Chat on any website (docs/platform.md): one tag, served at https://openvibe.chat/widget.js.
 *   <script src="https://openvibe.chat/widget.js" data-inbox="inb_…" async></script>      a support inbox
 *   <script src="https://openvibe.chat/widget.js" data-room="<slug>" async></script>       a public chat room
 *   data-position="left" puts the bubble on the left; data-color="#ff7a1a" colours it before the inbox's own colour loads;
 *   data-open="1" opens the panel at once. data-target="#chat" (a room) puts the room in that element instead of a
 *   bubble, data-height="480" tall. A site that knows its visitor (an inbox with verified visitors) adds data-user-id,
 *   data-user-name, data-user-email and data-user-hash (HMAC-SHA256 of the id with the inbox's identity secret, made on
 *   the site's server), or calls OpenVibeChat.identify({ id, name, email, hash }) once they sign in.
 * It draws a bubble in a shadow root (the site's CSS cannot reach it, it cannot reach the site's) and, on the first open,
 * an iframe of openvibe.chat/embed/inbox/<id>: the conversation lives there, on openvibe.chat's own origin, so the site
 * never sees the visitor's token and openvibe.chat never sees the site's cookies. The page may drive it:
 *   window.OpenVibeChat.open() / .close() / .toggle()
 * and it says what happens on `window` as 'openvibechat:open', ':close' and ':message'. */
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me || window.OpenVibeChat) return;
  var inbox = me.getAttribute('data-inbox') || '';
  var room = String(me.getAttribute('data-room') || '').toLowerCase();
  var isRoom = !inbox && /^[a-z0-9][a-z0-9-]{1,48}$/.test(room);
  if (!isRoom && !/^inb_[0-9A-HJKMNP-TV-Z]{26}$/.test(inbox)) { console.warn('OpenVibe Chat: data-inbox is not an inbox id (or data-room a room)'); return; }
  var base = new URL(me.src).origin;
  // A room in an element of the page: just the frame, no bubble.
  var target = isRoom && me.getAttribute('data-target');
  if (target) {
    var mountInline = function () {
      var box = document.querySelector(target);
      if (!box) { console.warn('OpenVibe Chat: no element matches ' + target); return; }
      var f = document.createElement('iframe');
      f.title = 'Chat'; f.loading = 'lazy'; f.allow = 'clipboard-write';
      f.src = base + '/embed/room/' + encodeURIComponent(room);
      f.style.cssText = 'display:block;width:100%;height:' + Math.min(1200, Math.max(240, parseInt(me.getAttribute('data-height'), 10) || 480)) + 'px;border:0;border-radius:14px;color-scheme:normal';
      box.appendChild(f);
    };
    window.OpenVibeChat = { open: function () {}, close: function () {}, toggle: function () {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountInline); else mountInline();
    return;
  }
  var left = me.getAttribute('data-position') === 'left';
  var color = /^#[0-9a-fA-F]{6}$/.test(me.getAttribute('data-color') || '') ? me.getAttribute('data-color') : '#3b82f6';

  var host = document.createElement('div');
  host.setAttribute('data-openvibe-chat', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var side = left ? 'left' : 'right';
  root.innerHTML = '<style>' +
    ':host{all:initial}' +
    '.b{position:fixed;' + side + ':20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;' +
    'background:var(--c);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.28);display:grid;place-items:center;transition:transform .15s}' +
    '.b:hover{transform:scale(1.05)}.b:focus-visible{outline:3px solid var(--c);outline-offset:3px}' +
    '.b svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.d{position:absolute;top:2px;right:2px;width:13px;height:13px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:none}' +
    '.d.on{display:block}.b .x,.b.on .m{display:none}.b.on .x{display:block}' +
    '.p{position:fixed;' + side + ':20px;bottom:88px;z-index:2147483000;width:380px;height:min(640px,calc(100vh - 110px));border-radius:18px;overflow:hidden;display:flex;flex-direction:column;' +
    'box-shadow:0 24px 70px rgba(0,0,0,.35);background:#0a0f1c;opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .16s,transform .2s}' +
    '.p.on{opacity:1;transform:none;pointer-events:auto}.p iframe{width:100%;height:100%;flex:1;min-height:0;border:0;display:block}' +
    '.h{display:none;align-items:center;justify-content:space-between;padding:8px 14px;background:#121a2b;color:#fff;font:600 14px system-ui}.h button{min-width:44px;min-height:44px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}' +
    '@media (max-width:520px){.p{left:0;right:0;bottom:0;top:0;width:auto;height:auto;border-radius:0}.p.on~.b{display:none}.h{display:flex;touch-action:none}}' +
    '</style>' +
    '<div class="p" role="dialog" aria-label="Chat"><div class="h"><span>Chat</span><button type="button" aria-label="Close chat">Close</button></div></div>' +
    '<button class="b" type="button" aria-label="Open the chat" aria-expanded="false"><span class="d"></span>' +
    '<svg class="m" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4Z"/></svg>' +
    '<svg class="x" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>';
  var bubble = root.querySelector('.b'), panel = root.querySelector('.p'), dot = root.querySelector('.d');
  host.style.setProperty('--c', color);   // custom properties cross into the shadow root (all:initial leaves them)
  var frame = null, open = false, savedScroll = null;
  function phone() { return window.innerWidth <= 520; }
  function lockPage() {
    if (savedScroll) return;
    var html = document.documentElement, body = document.body, y = window.scrollY;
    var gap = Math.max(0, window.innerWidth - html.clientWidth);
    savedScroll = { y: y, overflow: html.style.overflow, padding: html.style.paddingRight,
      position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width };
    if (gap) html.style.paddingRight = ((parseFloat(getComputedStyle(html).paddingRight) || 0) + gap) + 'px';
    html.style.overflow = 'hidden';
    body.style.position = 'fixed'; body.style.top = '-' + y + 'px';
    body.style.left = '0'; body.style.right = '0'; body.style.width = '100%';
  }
  function unlockPage() {
    if (!savedScroll) return;
    var s = savedScroll, html = document.documentElement, body = document.body; savedScroll = null;
    html.style.overflow = s.overflow; html.style.paddingRight = s.padding;
    body.style.position = s.position; body.style.top = s.top;
    body.style.left = s.left; body.style.right = s.right; body.style.width = s.width;
    window.scrollTo(0, s.y);
  }
  var identity = null;
  function identityOf(u) { return u && u.id && u.hash ? { id: String(u.id), name: u.name || undefined, email: u.email || undefined, hash: String(u.hash) } : null; }
  if (!isRoom) identity = identityOf({ id: me.getAttribute('data-user-id'), name: me.getAttribute('data-user-name'), email: me.getAttribute('data-user-email'), hash: me.getAttribute('data-user-hash') });
  function sendIdentity() { if (identity && frame && frame.contentWindow) frame.contentWindow.postMessage({ ov: 'chat', type: 'identify', user: identity }, base); }

  function emit(name, detail) { try { window.dispatchEvent(new CustomEvent('openvibechat:' + name, { detail: detail })); } catch (e) { /* old browsers */ } }
  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.title = 'Chat';
    frame.allow = 'clipboard-write; microphone; autoplay';   // a voice call the team starts (the browser still asks)
    frame.src = isRoom ? base + '/embed/room/' + encodeURIComponent(room) + '?bubble=1'
      : base + '/embed/inbox/' + inbox + '?page=' + encodeURIComponent(location.href.slice(0, 500)) + (identity ? '&id=1' : '');
    frame.addEventListener('load', sendIdentity);
    panel.appendChild(frame);
  }
  function setOpen(v) {
    var wasOpen = open;
    open = !!v;
    if (open) { ensureFrame(); dot.classList.remove('on'); }
    if (open && phone()) lockPage(); else unlockPage();
    panel.classList.toggle('on', open);
    if (open && phone()) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
    if (open && phone() && !wasOpen) panel.querySelector('.h button').focus({ preventScroll: true });
    bubble.classList.toggle('on', open);
    bubble.setAttribute('aria-expanded', open ? 'true' : 'false');
    bubble.setAttribute('aria-label', open ? 'Close the chat' : 'Open the chat');
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ ov: 'chat', type: 'visible', visible: open }, base);
    if (wasOpen && !open) bubble.focus({ preventScroll: true });
    emit(open ? 'open' : 'close');
  }
  bubble.addEventListener('click', function () { setOpen(!open); });
  var header = panel.querySelector('.h'), drag = null;
  header.querySelector('button').addEventListener('click', function () { setOpen(false); });
  header.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch' || e.target.closest('button')) return;
    drag = { id: e.pointerId, y: e.clientY };
    try { header.setPointerCapture(e.pointerId); } catch (err) { /* interrupted gesture */ }
  });
  header.addEventListener('pointermove', function (e) {
    if (drag && drag.id === e.pointerId) panel.style.translate = '0 ' + Math.max(0, e.clientY - drag.y) + 'px';
  });
  function endDrag(e) {
    if (!drag || drag.id !== e.pointerId) return;
    var dy = e.clientY - drag.y; drag = null; panel.style.translate = '';
    if (dy > 90) setOpen(false);
  }
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  document.addEventListener('pointerdown', function (e) {
    if (!open || phone()) return;
    if (e.composedPath && e.composedPath().indexOf(host) !== -1) return;
    setOpen(false);
  }, true);
  window.addEventListener('resize', function () { if (open) { if (phone()) lockPage(); else unlockPage(); } });
  window.addEventListener('message', function (e) {
    if (e.origin !== base || !e.data || e.data.ov !== 'chat') return;
    if (e.data.type === 'close') setOpen(false);
    else if (e.data.type === 'color' && /^#[0-9a-fA-F]{6}$/.test(e.data.color || '')) host.style.setProperty('--c', e.data.color);
    else if (e.data.type === 'message') { if (!open) dot.classList.add('on'); emit('message', { author: e.data.author }); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) setOpen(false); });

  window.OpenVibeChat = {
    open: function () { setOpen(true); }, close: function () { setOpen(false); }, toggle: function () { setOpen(!open); },
    identify: function (u) { identity = identityOf(u); sendIdentity(); },
  };
  function mount() { document.body.appendChild(host); if (me.getAttribute('data-open') === '1') setOpen(true); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
