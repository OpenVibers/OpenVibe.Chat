/* global window, document */
/**
 * The "What happened" section on openvibe.chat/activity is the Network's own notification list: the same list the
 * menu's Alerts show, drawn by the shared notification UI (openvibe-shared/notification-ui.js). Chat's own rows stay
 * in the page until this list is really there: without JavaScript, or without a token (a person who is not signed in
 * to the Network), the page keeps what it had.
 */
(function () {
    'use strict';
    var API_BASE = 'https://openvibe.network';
    var host = document.getElementById('oc-notif-list');
    if (!host) return;
    var rows = document.getElementById('oc-act-what-rows');
    var tries = 0;

    /** The person's own token, as the navbar has it (it resolves the person a moment after the page). */
    function navToken() {
        try {
            var nav = window.OpenVibeNavbar;
            return nav && typeof nav.token === 'function' ? nav.token() : null;
        } catch (e) { return null; }
    }

    /** The shared notification UI, loaded when the navbar has not loaded it. */
    function ensureScript() {
        if (window.OpenVibeNotifications) return;
        var existing = document.getElementById('ov-notify-loader');
        if (existing) {
            if (!existing.__ovWait) {
                existing.__ovWait = true;
                existing.addEventListener('load', function () { setTimeout(mount, 0); });
            }
            return;
        }
        var sc = document.createElement('script');
        sc.id = 'ov-notify-loader';
        sc.src = '/shared/notification-ui.js';
        sc.async = true;
        sc.onload = function () { setTimeout(mount, 0); };
        document.head.appendChild(sc);
    }

    /** The Network's list in this section. → true when it is there. */
    function mount() {
        var N = window.OpenVibeNotifications;
        var token = navToken();
        if (!N || !token) return false;      // no JavaScript or no token: Chat's own rows stay
        try {
            N.init({ token: token, apiBase: API_BASE });
            N.renderMenuNotifications(host);
            host.hidden = false;
            if (rows) rows.hidden = true;
            return true;
        } catch (e) { return false; }
    }

    function tick() {
        if (mount()) return;
        ensureScript();
        // The navbar resolves the person a moment after the page: wait for the token, then give up and keep the rows.
        if (++tries < 40) setTimeout(tick, 100);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
})();
