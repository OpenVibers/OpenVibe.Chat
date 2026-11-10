/**
 * OpenVibe.Chat → OpenVibe.Media (object API v2, namespace `chat`).
 *
 * Chat's OWN service token (client `chat`, capability media.object.upload to store an emote's
 * image and media.object.delete to remove it) through openvibe-sdk/media's createObjectsClient.
 * An uploaded object is public, and its public openvibe.media URL is what an emote row stores as
 * media_url (Live's asset-sync did the same onto the shared rows before the T3 takeover).
 */
'use strict';

const config = require('../config');

const APP = 'chat';

let _objects = null;

function objects() {
    if (_objects) return _objects;
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const { createObjectsClient } = require('openvibe-sdk/media');
    const tokenClient = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.media',
        scope: config.media.scope,
    });
    _objects = createObjectsClient({ app: APP, baseUrl: config.media.baseUrl, tokenClient });
    return _objects;
}

/** The absolute public URL of an uploaded object (Media returns public_url; url is the fallback). */
function publicUrl(obj) {
    if (!obj) return null;
    if (obj.public_url) return obj.public_url;
    if (obj.url) return /^https?:\/\//i.test(obj.url) ? obj.url : `${config.media.publicOrigin}${String(obj.url).startsWith('/') ? '' : '/'}${obj.url}`;
    return null;
}

/**
 * A person's file for a Vibe turn: an UNLISTED Media object owned by them. Unlisted means not in any
 * listing, but served by its unguessable Media id, which is what OpenVibe.AI reads a turn's file by
 * reference (a private object would need a signed URL AI cannot mint). → ai.file@1 metadata only.
 */
async function uploadFile(buffer, { filename, mimeType, subject } = {}) {
    if (!subject) throw new Error('uploadFile: subject (the person who owns the file) is required');
    const obj = await objects().upload(buffer, { kind: 'file', visibility: 'unlisted', mimeType: mimeType || 'application/octet-stream', filename, subject });
    return {
        id: obj.id,
        name: obj.filename || filename || 'file',
        media_type: obj.mime_type || mimeType || 'application/octet-stream',
        size: Number(obj.size_bytes) || buffer.length,
        storage: { provider: 'media', key: obj.id },
        access: { readers: [String(subject)] },
        read: { method: 'not_readable', reason: 'Attached; AI has not read it yet.' },
        role: 'input',
    };
}

/**
 * Upload image bytes as a public Media object → { id, url }.
 * Shaped for the emote routes: `id` is stored as media_asset_id, `url` as media_url.
 */
async function uploadObject(buffer, { filename, mimeType } = {}) {
    const obj = await objects().upload(buffer, { kind: 'file', visibility: 'public', mimeType: mimeType || 'application/octet-stream', filename });
    return { id: obj.id, url: publicUrl(obj) };
}

/** Remove a Media object (an emote or sound was deleted). Best-effort: logged, never thrown. */
async function deleteObject(id) {
    if (!id) return false;
    try { return await objects().delete(id); } catch (err) { console.warn(`[Media] delete ${id}: ${err.message}`); return false; }
}

module.exports = { uploadObject, uploadFile, deleteObject, publicUrl, APP, _setClient(c) { _objects = c; }, _reset() { _objects = null; } };
