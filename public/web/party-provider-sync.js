(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PartyProviderSync = factory();
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function expected(state, now) {
    var position = Math.max(0, Number(state.position_ms) || 0) / 1000;
    if (!state.paused) position += Math.max(0, now - Number(state.at_ms || now)) / 1000 * (Number(state.rate) || 1);
    return position;
  }
  function follow(player, state, now, limit) {
    if (!player || !state) return 0;
    if (player.live) {
      if (state.paused) player.pause(); else player.play();
      return 0;
    }
    var target = expected(state, now == null ? Date.now() : now);
    var drift = (Number(player.time()) || 0) - target;
    if (Math.abs(drift) > (limit == null ? 1 : limit)) player.seek(target);
    else if (player.supportsRate && player.rate) player.rate(Math.max(0.95, Math.min(1.05, (Number(state.rate) || 1) - drift * 0.03)));
    else if (player.rate) player.rate(Number(state.rate) || 1);
    if (state.paused) player.pause(); else player.play();
    return drift;
  }
  return { expected: expected, follow: follow };
}));
