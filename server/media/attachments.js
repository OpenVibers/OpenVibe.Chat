'use strict';
/**
 * OpenVibe.Media's composer attachments (composer.attachment@1) — the files a person picks in a box and
 * sends with a message. Media owns the bytes and the answer; the site keeps the attachment with the
 * message it belongs to.
 *
 *   GET    /api/v1/attachments/:id       where the attachment stands, for the person it belongs to
 *   POST   /api/v1/attachments/:id/keep  { message_id } — kept with that message (the kept window)
 *   DELETE /api/v1/attachments/:id       the person who uploaded it → 204
 *
 * Credentials: Chat's own service token (client 'chat', audience openvibe.media, scope
 * media.object.upload) with the person named in X-OV-Subject. Media checks the owner: an attachment that
 * is not the named person's is a 404, exactly like one that does not exist.
 *
 * The shape Media answers: { id, kind, name, size, mime, url, poster, playback { url, mime, ready },
 * duration_s, width, height }. A video a browser can play as it is keeps its own bytes; one it cannot
 * (an MKV, an AVI, an HEVC MOV) gets a web copy made in the background, and until that copy is there
 * playback.ready is false.
 *
 * The same call the link preview job makes for a card's picture (server/chat/media-import.js), with the
 * read and the delete the files a message carries need.
 */
const config = require('../config');
const serviceAuth = require('../net/service-auth');

const AUDIENCE = 'openvibe.media';
const TIMEOUT_MS = 8000;
const ATTACHMENT_ID = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;

let _fetch = null;

/** Media is asked through its internal address; the caller needs a service token to do that. */
function enabled() {
    return !!(config.media && config.media.baseUrl && config.oauth.clientSecret);
}

/** One call to Media: the answer as an object, or a throw with the status Media answered. */
async function request(method, path, { json, subject } = {}) {
    if (!enabled()) {
        const err = new Error('Attachments need Chat\'s service principal (OV_OAUTH_CLIENT_SECRET)');
        err.status = 503; err.code = 'attachment.unavailable';
        throw err;
    }
    const headers = await serviceAuth.headers(AUDIENCE, config.media.scope);
    const send = _fetch || globalThis.fetch;
    const res = await send(config.media.baseUrl + path, {
        method,
        headers: {
            ...headers,
            accept: 'application/json',
            ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(subject ? { 'X-OV-Subject': String(subject) } : {}),
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        const err = new Error('Media ' + method + ' ' + path + ' ' + res.status + ': ' + ((body && (body.detail || body.error)) || 'failed'));
        err.status = Number(res.status) || 502;
        err.code = (body && body.code) || null;
        throw err;
    }
    return body || {};
}

/**
 * One composer attachment, for the person it belongs to. Media checks the owner: an attachment that is
 * not the named person's is a 404, exactly like one that does not exist.
 */
async function attachment(id, subject) {
    const att = String(id || '').trim();
    if (!ATTACHMENT_ID.test(att)) {
        const err = new Error('That is not a Media attachment id');
        err.status = 400; err.code = 'attachment.invalid';
        throw err;
    }
    return await request('GET', '/api/v1/attachments/' + encodeURIComponent(att), { subject });
}

/**
 * Keep the attachment with the message it belongs to, so it lives as long as that message (Media's kept
 * window, 30 days) instead of the 24 hours an unsent file has.
 */
async function keepAttachment(id, subject, messageId) {
    const att = String(id || '').trim();
    const message = String(messageId == null ? '' : messageId).trim();
    if (!ATTACHMENT_ID.test(att) || !message || message.length > 200) return false;
    try {
        await request('POST', '/api/v1/attachments/' + encodeURIComponent(att) + '/keep', { json: { message_id: message }, subject });
        return true;
    } catch (err) {
        if (err && err.status === 404) return false;
        throw err;
    }
}

/**
 * Remove the attachment from Media: the message it belonged to is gone, so the file goes with it. The
 * person who uploaded it is named, so Media knows whose file this is.
 */
async function deleteAttachment(id, subject) {
    const att = String(id || '').trim();
    if (!ATTACHMENT_ID.test(att)) return false;
    try {
        await request('DELETE', '/api/v1/attachments/' + encodeURIComponent(att), { subject });
        return true;
    } catch (err) {
        if (err && err.status === 404) return true;   // already gone: the message keeps nothing either
        throw err;
    }
}

module.exports = { attachment, keepAttachment, deleteAttachment, enabled, AUDIENCE, ATTACHMENT_ID, _setFetch(fn) { _fetch = fn || null; } };
