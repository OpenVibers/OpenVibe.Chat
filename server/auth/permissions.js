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
const { staff } = require('openvibe-contracts');

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
    if (can(user, 'staff.moderation.chat')) return true;
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
    if (can(user, 'staff.moderation.chat')) return true;
    if (isStreamOwner(user, streamId)) return true;
    const channelId = getChannelIdForStream(streamId);
    if (channelId && isChannelMod(user, channelId)) return true;
    return false;
}

/**
 * Can this user moderate a call on a specific stream?
 * Same rules as chat moderation.
 */
function canModerateCall(user, streamId) {
    return canModerateStream(user, streamId);
}

/**
 * Can this user view chat logs?
 */
function canViewChatLogs(user, scope = 'own') {
    if (!user) return false;
    if (can(user, 'staff.moderation.logs')) return true;
    return scope === 'own';
}

/**
 * Can this user view another user's chat logs?
 */
function canViewOtherUserLogs(user) {
    return can(user, 'staff.moderation.logs');
}

// ── Staff capabilities (openvibe-contracts manifests/policy/staff-roles.json, ADR-022) ──────
// Every staff gate asks can(user, 'staff.<area>.<action>'); issued staff_caps claims win when present.
function staffClaims(user) {
    if (!user) return null;
    const c = { role: user.role, is_owner: isOwner(user) };
    if (Array.isArray(user.staff_caps)) c.staff_caps = user.staff_caps;
    return c;
}
function can(user, capability) {
    return !!user && staff.can(staffClaims(user), capability);
}

module.exports = {
    can,
    staffClaims,
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
    canModerateCall,
    canViewChatLogs,
    canViewOtherUserLogs,
};
