/**
 * The user modules Chat owns (openvibe-contracts 0.41.0), one store each (./module-store.js):
 *
 *   preferences  chat.preferences     display (timestamps, compact, font_scale, show_badges, hide_emotes)
 *   tts          chat.tts_defaults    text-to-speech and sounds (send, send_while_live, volume, sounds,
 *                                     sound_volume, sources) — Live's chat panel reads and writes it
 *   dm           chat.dm_settings     new_conversations (everyone | nobody), group_invites, previews —
 *                                     enforced by the DM routes (server/chat/dm-routes.js)
 *   presence     chat.presence_prefs  show_in_user_list — enforced by ChatServer.getUserList()
 */
'use strict';

const { createModuleStore } = require('./module-store');
const preferences = require('./chat-preferences');

const tts = createModuleStore('chat.tts_defaults', { label: 'text-to-speech settings', key: 'settings' });
const dm = createModuleStore('chat.dm_settings', { label: 'message settings', key: 'settings' });
const presence = createModuleStore('chat.presence_prefs', { label: 'presence settings', key: 'settings' });

const all = [preferences, tts, dm, presence];
const byNamespace = new Map(all.map((s) => [s.NAMESPACE, s]));

/**
 * A person's settings in one store for an enforcement check: the record (cached, else from Network), or
 * {} when there is none or Network cannot answer — the defaults, so an outage never locks anyone out.
 */
async function settingsOf(store, subject) {
    if (!subject) return {};
    try { return (await store.get(subject))[store === preferences ? 'preferences' : 'settings'] || {}; } catch { return {}; }
}

module.exports = { preferences, tts, dm, presence, all, byNamespace, settingsOf };
