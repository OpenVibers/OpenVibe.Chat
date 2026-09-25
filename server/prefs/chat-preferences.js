/**
 * A person's chat preferences: the OpenVibe.Network user module `chat.preferences`
 * (openvibe-contracts manifests/namespaces/chat.preferences.json, schema v1: timestamps, compact,
 * font_scale, show_badges, hide_emotes). Chat owns the namespace since the Wave 6 cutover. The store
 * (get, update, handleEvent, invalidate) is ./module-store.js; the other chat.* modules are ./stores.js.
 */
'use strict';

const { PrefsError, enabled, createModuleStore, _configure } = require('./module-store');

const store = createModuleStore('chat.preferences', { label: 'preferences', key: 'preferences' });

module.exports = { ...store, PrefsError, enabled, _configure };
