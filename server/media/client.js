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

module.exports = { uploadObject, deleteObject, publicUrl, APP, _setClient(c) { _objects = c; }, _reset() { _objects = null; } };
