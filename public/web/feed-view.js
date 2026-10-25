/* A feed's card (server/feeds/feeds.js): what someone is building, live. Mounted on every <div class="fv"
   data-feed="fed_…"> of the page: a room on openvibe.chat, the embed /embed/feed/:id that any site (OpenVibe.Live's
   channel chat among them) frames. It reads /api/chat/feeds/:id and follows the chat socket (feed_watch). Events are
   grouped into turns: a prompt, the steps taken (tools used, files changed), the answer; the newest turn is open, older
   ones fold to their prompt. Everything is set with textContent. In a frame it tells the parent its height. */
(function () {
  'use strict';
  var ICON = { prompt: '›', response: '✓', thinking: '…', 'tool.call': '⚙', 'file.change': '✎', 'file.save': '✎', 'session.status': '•' };
  var LIVE_MS = 3 * 60 * 1000;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }
  function ago(iso) {
    var t = Date.parse(iso || ''); if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? 'now' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd';
  }

  function turnsOf(events) {
    var turns = [], cur = null;
    events.forEach(function (e) {
      if (e.eventType === 'prompt' || !cur) { cur = { prompt: e.eventType === 'prompt' ? e : null, steps: [], answer: null, at: e.occurredAt }; turns.push(cur); if (e.eventType === 'prompt') return; }
      if (e.eventType === 'response') { cur.answer = e; cur.at = e.occurredAt; return; }
      cur.steps.push(e); cur.at = e.occurredAt;
    });
    return turns;
  }

  function mount(box) {
    var id = box.getAttribute('data-feed');
    if (!/^fed_[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '') || box.dataset.mounted) return;
    box.dataset.mounted = '1';
    var events = [], seen = {}, feed = null, publisher = null, ws = null, delay = 1000;
    var KEY = 'ov-feed-folded-' + id;
    var folded = store(function (s) { return s.getItem(KEY); }) === '1';

    var head = el('button', 'fv-head'); head.type = 'button';
    var dot = el('span', 'fv-dot'); var title = el('b', 'fv-title', 'Vibe coding'); var who = el('span', 'fv-who'); var when = el('time', 'fv-when');
    var chev = el('span', 'fv-chev', '▾'); chev.setAttribute('aria-hidden', 'true');
    head.appendChild(dot); head.appendChild(title); head.appendChild(who); head.appendChild(when); head.appendChild(chev);
    var body = el('div', 'fv-body'); var list = el('ol', 'fv-turns'); body.appendChild(list);
    var empty = el('p', 'fv-empty', 'Nothing yet. Steps show here as they happen.');
    body.appendChild(empty);
    box.textContent = ''; box.appendChild(head); box.appendChild(body);
    box.classList.add('fv-on');

    function setFolded(v) {
      folded = v; box.classList.toggle('fv-folded', v); head.setAttribute('aria-expanded', v ? 'false' : 'true');
      store(function (s) { s.setItem(KEY, v ? '1' : '0'); }); tellHeight();
    }
    head.addEventListener('click', function () { setFolded(!folded); });

    function tellHeight() {
      if (window.parent === window) return;
      try { window.parent.postMessage({ ov: 'chat', type: 'feed-height', feed: id, height: Math.ceil(box.getBoundingClientRect().height) }, '*'); } catch (e) { /* not framed */ }
    }
    function stepLine(e) {
      var li = el('li', 'fv-step fv-' + e.eventType.replace('.', '-'));
      li.appendChild(el('span', 'fv-ic', ICON[e.eventType] || '•'));
      var t = el('span', 'fv-txt', e.summary || (e.tool && e.tool.name) || '');
      li.appendChild(t);
      var arg = e.tool && e.tool.argumentsPreview;
      if (arg) li.appendChild(el('code', 'fv-arg', arg));
      return li;
    }
    function render() {
      var live = feed && feed.last_event_at && Date.now() - Date.parse(feed.last_event_at) < LIVE_MS;
      box.classList.toggle('fv-live', !!live);
      dot.title = live ? 'Live' : 'Quiet';
      title.textContent = (feed && feed.title) || 'Vibe coding';
      who.textContent = publisher && publisher.integrationLabel && publisher.integrationLabel !== 'Custom publisher' ? publisher.integrationLabel : '';
      when.textContent = feed ? ago(feed.last_event_at) : '';
      list.textContent = '';
      var turns = turnsOf(events);
      empty.hidden = turns.length > 0;
      turns.forEach(function (turn, i) {
        var last = i === turns.length - 1;
        var li = el('li', 'fv-turn' + (last ? ' fv-cur' : ''));
        if (turn.prompt) { var p = el('p', 'fv-prompt'); p.appendChild(el('span', 'fv-ic', ICON.prompt)); p.appendChild(el('span', 'fv-txt', turn.prompt.summary)); li.appendChild(p); }
        if (last || !turn.prompt) {
          var steps = el('ol', 'fv-steps');
          var shown = turn.steps.slice(-6);
          if (turn.steps.length > shown.length) steps.appendChild(el('li', 'fv-more', (turn.steps.length - shown.length) + ' earlier steps'));
          shown.forEach(function (e) { steps.appendChild(stepLine(e)); });
          if (shown.length) li.appendChild(steps);
        } else if (turn.steps.length) {
          li.appendChild(el('p', 'fv-count', turn.steps.length + (turn.steps.length === 1 ? ' step' : ' steps')));
        }
        if (turn.answer && (last || !turn.prompt)) { var a = el('p', 'fv-answer'); a.appendChild(el('span', 'fv-ic', ICON.response)); a.appendChild(el('span', 'fv-txt', turn.answer.summary)); li.appendChild(a); }
        else if (last && !turn.answer && live && turn.prompt) li.appendChild(el('p', 'fv-working', 'Working…'));
        list.appendChild(li);
      });
      body.scrollTop = body.scrollHeight;
      tellHeight();
    }
    function add(e) {
      if (!e || !e.eventId || seen[e.eventId]) return;
      seen[e.eventId] = 1; events.push(e);
      if (events.length > 120) { events.splice(0, events.length - 120); }
      if (feed) feed.last_event_at = new Date().toISOString();
      render();
    }
    function connect() {
      if (!window.WebSocket) return;
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
      ws.onopen = function () { delay = 1000; ws.send(JSON.stringify({ type: 'feed_watch', feed: id })); };
      ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.type === 'feed_event' && m.feed === id) { if (m.publisher) publisher = m.publisher; add(m.event); } };
      ws.onclose = function () { setTimeout(function () { load(); connect(); }, delay); delay = Math.min(delay * 2, 30000); };
    }
    function load() {
      return fetch('/api/chat/feeds/' + id + '?limit=40', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) { box.classList.add('fv-gone'); return; }
        feed = d.feed; publisher = d.publisher;
        (d.events || []).forEach(function (e) { if (!seen[e.eventId]) { seen[e.eventId] = 1; events.push(e); } });
        render();
      }).catch(function () {});
    }
    setFolded(folded);
    load().then(connect);
    setInterval(function () { if (feed) { when.textContent = ago(feed.last_event_at); box.classList.toggle('fv-live', Date.now() - Date.parse(feed.last_event_at || 0) < LIVE_MS); } }, 30000);
  }
  function all() { Array.prototype.forEach.call(document.querySelectorAll('.fv[data-feed]'), mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
  window.OpenVibeFeed = { mount: mount };
})();
