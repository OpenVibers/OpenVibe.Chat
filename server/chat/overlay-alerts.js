'use strict';
/**
 * overlay-alerts.js — the overlay alert feed: the typed frame a streamer's OBS overlay reads to show
 * "X followed", "X tipped 5 Vibes: message", "X subscribed", "X raided with 12 viewers" and "Goal
 * reached" as they happen (Live sends it; see OpenVibe.Live server/overlay/overlay-alerts.js).
 *
 *   { type: 'overlay-alert', kind, id, at, who: { name, avatar }|null, amount: { value, unit }|null, text }
 *
 * The frame goes to the channel's own room (the same room the chat overlay and the OBS browser source
 * read). It is never a chat message: nothing is persisted, nothing is mirrored into global chat, and
 * nothing here is answered to the sender.
 *
 * The text a tipper wrote passes the moderation a chat line passes:
 *   - the blocked-word filter (server/chat/word-filter.js) censors it, as chat does;
 *   - the channel's own filters (its slur filter: terms, regexes and the built-in list) decide whether
 *     the text is shown at all — a hit means the text is dropped and only the moment itself is shown.
 * The words are plain text: they are never markup, and the overlay renders them as text.
 */
const wordFilter = require('./word-filter');
const moderation = require('./moderation-utils');
const ctx = require('../live-context');

const TEXT_MAX = 200;

/**
 * The channel's own filters, as chat's own message path reads them (chat-server.js _chatRulesBlock):
 * the slur filter's configured terms, its configured regexes and the built-in list. Off unless the
 * channel turned it on.
 */
async function hitsChannelFilters(text, channelUserId) {
    try {
        const channel = await ctx.getChannelByUserId(channelUserId);
        if (!channel) return false;
        const settings = await ctx.getChannelModerationSettings(channel.id);
        if (!settings || !settings.slur_filter_enabled) return false;
        const terms = moderation.parseSlurFilterTerms(settings.slur_filter_terms);
        const regexes = moderation.parseRegexLines(settings.slur_filter_regexes);
        let disabled = [];
        try { disabled = JSON.parse(settings.slur_filter_disabled_categories || '[]') || []; } catch { disabled = []; }
        const hitCore = settings.slur_filter_use_builtin !== 0 && moderation.containsCoreSlur(text, disabled);
        const hitTerms = terms.length > 0 && moderation.containsConfiguredSlur(text, terms);
        const hitRegex = regexes.length > 0 && moderation.containsRegexSlur(text, regexes);
        return !!(hitCore || hitTerms || hitRegex);
    } catch (e) {
        console.warn('[OverlayAlerts] channel filters not read:', e.message);
        return false;
    }
}

/**
 * The text as it may be shown: censored by the blocked-word filter, and dropped when the channel's own
 * filters hit it. Plain text, at most 200 characters.
 */
async function moderateText(text, channelUserId) {
    if (text == null) return null;
    let out = String(text);
    const filtered = wordFilter.check(out);
    if (!filtered.safe) out = filtered.filtered;
    if (await hitsChannelFilters(out, channelUserId)) return null;
    return out.length > TEXT_MAX ? out.slice(0, TEXT_MAX) : out;
}

/**
 * Deliver one moment to the channel's room. The frame keeps its shape; only the text is moderated.
 * `channelUserId` is the room (the channel owner).
 */
async function deliver(chatServer, frame, channelUserId) {
    const text = await moderateText(frame.text, channelUserId);
    const out = { ...frame, text: text == null ? null : text };
    await chatServer.broadcastToChannelRoom(channelUserId, null, out);
    return out;
}

module.exports = { deliver, moderateText, hitsChannelFilters, TEXT_MAX };
