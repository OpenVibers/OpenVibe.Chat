/**
 * OpenVibe.Chat — channel alert sounds (donation / donation-goal-reached).
 *
 * Live's server/monetization/alerts.js used to read the sound file off disk and broadcast it itself
 * as base64 `soundboard-audio`. At the T3 cutover the settings row and the file are Chat's, so Live
 * only says "play the donation|goal alert for channel X" over the bridge (op `playAlertSound`); this
 * module resolves the channel's own channel_moderation_settings row, reads the clip from the shared
 * sounds directory, and broadcasts it to the channel room (every slot + the offline room), gated on
 * the viewer's Chat Sounds toggle exactly as before.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const ctx = require('../live-context');

const MAX_SOUND_BYTES = 3 * 1024 * 1024;

function mimeForExt(ext) {
    switch ((ext || '').toLowerCase()) {
        case '.wav': return 'audio/wav';
        case '.ogg': case '.oga': return 'audio/ogg';
        case '.opus': return 'audio/opus';
        case '.webm': return 'audio/webm';
        case '.m4a': case '.mp4': return 'audio/mp4';
        case '.aac': return 'audio/aac';
        case '.flac': return 'audio/flac';
        default: return 'audio/mpeg';
    }
}

function readSound(diskPath, mimeHint) {
    try {
        if (!diskPath || !fs.existsSync(diskPath)) return null;
        const buf = fs.readFileSync(diskPath);
        if (!buf || !buf.length || buf.length > MAX_SOUND_BYTES) return null;
        return { audio: buf.toString('base64'), mimeType: mimeHint || mimeForExt(path.extname(diskPath)) };
    } catch { return null; }
}

/**
 * Broadcast a streamer's alert sound to their viewers. kind: 'donation' | 'goal'. The sound comes
 * from Chat's own settings row for the channel (goal falls back to the donation sound). No-op when
 * none is configured. → { played: boolean, source } (never throws: a missing sound is not an error).
 */
async function playAlertSound(chatServer, streamerId, streamId, kind) {
    const source = kind === 'goal' ? 'goal-alert' : 'donation-alert';
    try {
        if (!chatServer || !chatServer.broadcastToChannelRoom) return { played: false, source };
        const channel = await ctx.ensureChannelForUser(streamerId);
        const row = channel ? db.getChannelModerationSettingsRow(channel.id) : null;
        if (!row) return { played: false, source };
        let disk, mime;
        if (kind === 'goal') {
            disk = row.goal_sound_url || row.donation_sound_url;
            mime = row.goal_sound_url ? row.goal_sound_mime : row.donation_sound_mime;
        } else {
            disk = row.donation_sound_url;
            mime = row.donation_sound_mime;
        }
        const snd = readSound(disk, mime);
        if (!snd) return { played: false, source };
        chatServer.broadcastToChannelRoom(streamerId, streamId || null, { type: 'soundboard-audio', audio: snd.audio, mimeType: snd.mimeType, source });
        return { played: true, source };
    } catch (err) {
        console.warn(`[Alerts] play ${kind} for ${streamerId}: ${err.message}`);
        return { played: false, source };
    }
}

module.exports = { playAlertSound, mimeForExt };
