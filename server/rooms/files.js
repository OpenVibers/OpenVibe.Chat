'use strict';
/**
 * Files on a chat message (ai.file@1 references): the Vibe composer's tray uploads a person's file to
 * Media (server/media/client.js) and sends the reference with the message; server/rooms/rooms.js stores
 * the references on the row, and Vibe's turn (server/rooms/ai-members.js) hands them to OpenVibe.AI,
 * which reads them for the model. The bytes never live in Chat's database.
 *
 * A reference is the contract shape: id, name, media_type, size, storage {provider:'media', key},
 * access {readers}, read {method, reason?}, role 'input'. Only a Media object id (med_…) is accepted,
 * at most MAX_FILES a message; the file's size and type are Media's own, checked again by AI.
 */
const MAX_FILES = 10;
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_MAX = 255;

/** A stored file reference as the message keeps it (bytes are not part of it). */
function cleanOne(file, index, reader = null) {
    const { RoomError } = require('./rooms');   // required here: rooms.js requires this module at load
    const raw = file && typeof file === 'object' ? file : {};
    const id = String(raw.id || (raw.storage && raw.storage.key) || '');
    if (!MEDIA_ID.test(id)) throw new RoomError(422, 'rooms.file_invalid', `File ${index + 1} must be a stored Media object`);
    const name = String(raw.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NAME_MAX) || 'file';
    const mediaType = String(raw.media_type || raw.type || 'application/octet-stream').split(';')[0].trim().slice(0, NAME_MAX) || 'application/octet-stream';
    const size = Math.max(0, Math.floor(Number(raw.size) || 0));
    const readers = Array.isArray(raw.access && raw.access.readers) && raw.access.readers.length
        ? raw.access.readers.map((r) => String(r).slice(0, 200)).slice(0, 50)
        : [reader].filter(Boolean);
    return {
        id,
        name,
        media_type: mediaType,
        size,
        storage: { provider: 'media', key: id },
        ...(readers.length ? { access: { readers } } : {}),
        read: { method: 'not_readable', reason: 'Attached; AI has not read it yet.' },
        role: 'input',
    };
}

/** The files a message may carry (at most MAX_FILES), or [] when it has none. */
function cleanFiles(files, reader = null) {
    if (!Array.isArray(files) || !files.length) return [];
    if (files.length > MAX_FILES) {
        const { RoomError } = require('./rooms');
        throw new RoomError(413, 'rooms.files_too_many', `At most ${MAX_FILES} files can go with a message`);
    }
    return files.map((f, i) => cleanOne(f, i, reader));
}

/** The message API calls these attachments; the AI pipeline keeps its historical `files` name. */
function attachmentsFromBody(body) {
    if (!body || typeof body !== 'object') return [];
    return Array.isArray(body.attachments) ? body.attachments : (Array.isArray(body.files) ? body.files : []);
}

/** The files stored on a message row (jsonb comes back as an array; a text column is tolerated too). */
function filesOf(message) {
    if (!message) return [];
    let files = message.files;
    if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = []; } }
    return Array.isArray(files) ? files : [];
}

module.exports = { cleanFiles, filesOf, attachmentsFromBody, MAX_FILES };
