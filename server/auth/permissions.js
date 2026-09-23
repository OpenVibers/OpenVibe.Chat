/**
 * OpenVibe.Chat — capability & scope permission checks used by chat.
 *
 * Moved from OpenVibe.Live server/auth/permissions.js (the chat subset, rules unchanged).
 * Roles come with the user from Live; streams, channels and channel moderators are Live data
 * read through live-context (warm caches, no network call per check).
 *
 * Roles answer "who are you globally?"   user, streamer, global_mod, admin
 * Scope answers "where do you have power?" channel_moderators (per channel)
 */
'use strict';

const ctx = require('../live-context');

// ── Role hierarchy (higher = more power) ─────────────────────
const ROLE_RANK = {
    user: 0,
    streamer: 1,
    global_mod: 2,
    admin: 3,
};

function roleRank(role) {
    return ROLE_RANK[role] ?? 0;
}

// ── Core role checks ─────────────────────────────────────────

function isAdmin(user) {
    return user?.role === 'admin';
}

/**
 * Owner = an admin with Live's local is_owner flag. Owners are the ONLY users who may view or
 * change API keys (TTS credentials here).
 */
function isOwner(user) {
    return !!(user && user.is_owner && (user.role === 'admin' || roleRank(user.role) >= ROLE_RANK.admin));
}

function isGlobalMod(user) {
    return user?.role === 'global_mod';
}

function isGlobalModOrAbove(user) {
    return roleRank(user?.role) >= ROLE_RANK.global_mod;
}

const isStaff = isGlobalModOrAbove;

function isStreamer(user) {
    return roleRank(user?.role) >= ROLE_RANK.streamer;
}

// ── Channel mod checks ──────────────────────────────────────

/**
 * Is this user a channel moderator for the given channel?
 */
function isChannelMod(user, channelId) {
    if (!user?.id || !channelId) return false;
    return !!ctx.isChannelModerator(user.id, channelId);
}

/**
 * Is this user the owner of the given channel?
 */
function isChannelOwner(user, channelId) {
    if (!user?.id || !channelId) return false;
    const channel = ctx.getChannelById(channelId);
    return channel?.user_id === user.id;
}

/**
 * Does a stream belong to this user?
 */
function isStreamOwner(user, streamId) {
    if (!user?.id || !streamId) return false;
    const stream = ctx.getStreamById(streamId);
    return stream?.user_id === user.id;
}

/**
 * Get the channel_id for a given stream.
 */
function getChannelIdForStream(streamId) {
    if (!streamId) return null;
    const stream = ctx.getStreamById(streamId);
    return stream?.channel_id || null;
}

// ── Capability checks ────────────────────────────────────────

/**
 * Can this user moderate a specific channel's chat?
 *
 * True for: admin, global_mod, channel owner, channel mod
 */
function canModerateChannel(user, channelId) {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    if (isChannelOwner(user, channelId)) return true;
    return isChannelMod(user, channelId);
}

/**
 * Can this user moderate a specific stream's chat?
 *
 * Resolves stream → channel, then checks channel moderation.
 */
function canModerateStream(user, streamId) {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    if (isStreamOwner(user, streamId)) return true;
    const channelId = getChannelIdForStream(streamId);
    if (channelId && isChannelMod(user, channelId)) return true;
    return false;
}

/**
 * Can this user view chat logs?
 */
function canViewChatLogs(user, scope = 'own') {
    if (!user) return false;
    if (isGlobalModOrAbove(user)) return true;
    return scope === 'own';
}

/**
 * Can this user view another user's chat logs?
 */
function canViewOtherUserLogs(user) {
    return isGlobalModOrAbove(user);
}

module.exports = {
    ROLE_RANK,
    roleRank,
    isAdmin,
    isOwner,
    isGlobalMod,
    isGlobalModOrAbove,
    isStaff,
    isStreamer,
    isChannelMod,
    isChannelOwner,
    isStreamOwner,
    getChannelIdForStream,
    canModerateChannel,
    canModerateStream,
    canViewChatLogs,
    canViewOtherUserLogs,
};
