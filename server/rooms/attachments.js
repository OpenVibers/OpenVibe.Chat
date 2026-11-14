'use strict';
/**
 * The files a room message carries from OpenVibe.Media's composer attachments (composer.attachment@1).
 *
 * A person picks a file in the room's box; Shared's composer sends it to Media as it is picked and puts
 * the id (att_…) on the form. The message names that id, Chat asks Media (with its own service token,
 * naming the sender) whether the file exists, is the sender's and may be carried, keeps it with the
 * message, and stores what Media answered: the kind, the type, the poster, the playback (url, mime,
 * ready), the length and the size. A video whose web copy Media is still making is asked again on a read
 * (freshen), so it plays as soon as the copy is there.
 *
 * The bytes live in Media, never in Chat: the row here is what a reader needs to draw the file.
 */
const db = require('../db/database');

/** Media's composer attachment id. */
const ATTACHMENT_ID = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The kinds a message may carry: a picture, a video, a sound, or a file (a PDF or a text). */
const KINDS = new Set(['image', 'video', 'audio', 'file']);
/** At most four files on one message. */
const MAX_ATTACHMENTS = 4;
const NAME_MAX = 255;
/** Media serves the bytes under /a/: a picture, a video's copy, a sound. Nothing else is ever drawn. */
const MEDIA_HOST = 'openvibe.media';

/**
 * The kind a message may carry. A picture, a video and a sound are fine; a file only when it is a PDF
 * or text. Everything else (code, an executable, a binary nobody can read) is refused.
 */
function allowedKind(kind, mime) {
    const k = String(kind || '').trim();
    if (KINDS.has(k)) {
        if (k !== 'file') return k;
        const m = String(mime || '').split(';')[0].trim().toLowerCase();
        return m === 'application/pdf' || m.startsWith('text/') ? 'file' : null;
    }
    return null;
}

/**
 * The composer attachment a message names: { media_attachment_id: 'att_…' }. Throws a 400 when the id
 * is not one, so a message never carries something Chat cannot ask Media about.
 */
function composerReference(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const id = String(value.media_attachment_id || '').trim();
    if (!ATTACHMENT_ID.test(id)) {
        const err = new Error('Each Media attachment must be named by its media_attachment_id');
        err.status = 400; err.code = 'rooms.attachment_invalid'; throw err;
    }
    return { media_attachment_id: id };
}

/**
 * The ids a body carries: Shared's composer puts one plain att_ id per file on the form (the field
 * repeated), and a service may send a JSON list of { media_attachment_id }. Both are read here.
 */
function namedAttachments(raw) {
    if (raw == null || raw === '') return [];
    let value = raw;
    if (typeof value === 'string' && ATTACHMENT_ID.test(value.trim())) value = [value];
    else if (typeof value === 'string') {
        try { value = JSON.parse(value); }
        catch { const err = new Error('That attachment list is not valid'); err.status = 400; err.code = 'rooms.attachment_invalid'; throw err; }
    }
    if (!Array.isArray(value)) value = [value];
    const out = [];
    for (let item of value) {
        if (typeof item === 'string') {
            const t = item.trim();
            if (ATTACHMENT_ID.test(t)) { out.push({ media_attachment_id: t }); continue; }
            try { item = JSON.parse(t); }
            catch { const err = new Error('That attachment list is not valid'); err.status = 400; err.code = 'rooms.attachment_invalid'; throw err; }
            for (const x of (Array.isArray(item) ? item : [item])) if (x && typeof x === 'object' && x.media_attachment_id) out.push(x);
            continue;
        }
        if (item && typeof item === 'object' && item.media_attachment_id) out.push(item);
    }
    return out;
}

/**
 * An address a reader may be sent to: https on openvibe.media, under /a/ (the bytes Media serves).
 * Anything else — another host, another scheme, another path — is no address at all.
 */
function mediaUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
        if (u.hostname.toLowerCase() !== MEDIA_HOST) return null;
        if (!u.pathname.startsWith('/a/')) return null;
        return u.href;
    } catch { return null; }
}

/**
 * What a message's attachment looks like to everyone who may read the message: the kind and what plays
 * it, so the room can draw a player for a video, a picture, a sound bar or a file link.
 */
function publicReference(row) {
    if (!row) return null;
    const url = mediaUrl(row.url);
    if (!url) return null;
    const poster = mediaUrl(row.poster);
    const out = {
        id: row.attachment_id,
        name: row.name || 'file',
        media_type: row.mime || 'application/octet-stream',
        size: Number(row.size_bytes) || 0,
        kind: row.kind || 'file',
        url,
        poster: poster || null,
        playback: null,
        duration_s: row.duration_s != null ? Number(row.duration_s) : null,
        width: row.width != null ? Number(row.width) : null,
        height: row.height != null ? Number(row.height) : null,
    };
    const pb = mediaUrl(row.playback_url);
    if (pb) out.playback = { url: pb, mime: row.playback_mime || out.media_type, ready: !!row.playback_ready };
    return out;
}

/** The row a kept attachment is stored as. */
function rowFor(messageId, item, position) {
    const att = item.attachment || item;
    const playback = att.playback || null;
    return {
        message_id: Number(messageId) || 0,
        attachment_id: String(att.id || att.media_attachment_id || ''),
        position: Number(position) || 0,
        owner_subject: String(att.owner_subject || ''),
        name: String(att.name || 'file').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NAME_MAX) || 'file',
        mime: String(att.mime || 'application/octet-stream').split(';')[0].trim().slice(0, NAME_MAX) || 'application/octet-stream',
        size_bytes: Math.max(0, Math.floor(Number(att.size) || 0)),
        kind: String(att.kind || 'file'),
        url: mediaUrl(att.url),
        poster: mediaUrl(att.poster),
        playback_url: playback ? mediaUrl(playback.url) : null,
        playback_mime: playback && playback.mime ? String(playback.mime) : null,
        playback_ready: playback && playback.ready ? 1 : 0,
        duration_s: att.duration_s != null ? Number(att.duration_s) : null,
        width: att.width != null ? Number(att.width) : null,
        height: att.height != null ? Number(att.height) : null,
    };
}

/** Store the attachments of one message (the rows a reader draws them from). */
async function createRows(messageId, items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
        const row = rowFor(messageId, items[i], i);
        if (!row.attachment_id || !row.url) continue;
        await db.run(
            'INSERT INTO room_message_attachments (message_id, attachment_id, position, owner_subject, name, mime, size_bytes, kind, url, poster, playback_url, playback_mime, playback_ready, duration_s, width, height)'
            + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [row.message_id, row.attachment_id, row.position, row.owner_subject, row.name, row.mime, row.size_bytes, row.kind,
                row.url, row.poster, row.playback_url, row.playback_mime, row.playback_ready, row.duration_s, row.width, row.height]);
        out.push(row);
    }
    return out;
}

/** The stored attachments of these messages, by message id. */
async function rowsFor(messageIds) {
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).map((n) => Number(n) || 0).filter(Boolean);
    if (!ids.length) return new Map();
    const rows = await db.all(
        'SELECT * FROM room_message_attachments WHERE message_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY message_id, position, attachment_id',
        ids);
    const out = new Map();
    for (const row of rows) {
        const list = out.get(Number(row.message_id)) || [];
        list.push(row);
        out.set(Number(row.message_id), list);
    }
    return out;
}

/** The stored attachments of one message. */
async function rowsOf(messageId) {
    return await db.all('SELECT * FROM room_message_attachments WHERE message_id = ? ORDER BY position, attachment_id', [Number(messageId) || 0]);
}

/** Forget the stored attachments of a message (the message is gone, or the row is replaced). */
async function dropRows(messageId) {
    await db.run('DELETE FROM room_message_attachments WHERE message_id = ?', [Number(messageId) || 0]);
}

module.exports = { ATTACHMENT_ID, KINDS, MAX_ATTACHMENTS, allowedKind, composerReference, namedAttachments, mediaUrl, publicReference, createRows, rowsFor, rowsOf, dropRows };
