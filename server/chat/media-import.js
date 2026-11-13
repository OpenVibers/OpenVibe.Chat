'use strict';
/**
 * Bringing a page's own picture into OpenVibe.Media (server/chat/link-previews.js).
 *
 * A page's og:image lives on somebody else's host, and a card must never hot-link it: the reader's browser
 * would tell that host who is reading. So the link preview job asks Media to fetch the picture once and keep
 * it: Media fetches it through its own egress rules (https only, public addresses only, at most 2 MB, images
 * only) and stores it as an unlisted attachment with a short life. The card then shows the Media address.
 *
 * The picture belongs to Chat (Chat brought it in), so Chat may keep it with the message it is shown under
 * (keepPicture): it then lives in Media's kept window (30 days) instead of the day-long one, and it is kept
 * again for every message that shows it. A card's picture is therefore still there long after the day.
 *
 * The call is Chat's own service token (client `chat`, audience openvibe.media, scope media.object.upload) —
 * the same one that stores an emote's image. A picture that cannot be brought in is simply left off the card:
 * this never throws, and a message never waits for it.
 */
const config = require('../config');
const serviceAuth = require('../net/service-auth');

const AUDIENCE = 'openvibe.media';
const TIMEOUT_MS = 8000;
let _fetch = null;

/** Media is asked through its internal address; the caller needs a service token to do that. */
function enabled() {
    return !!(config.media && config.media.baseUrl && config.oauth.clientSecret);
}

/**
 * The Media picture of one https address: { id, url } — the address Media serves it from and the id of the
 * attachment behind it (the id is what a keep names). Null when there is no picture for it (no address, a
 * picture Media refuses, a picture that is not an image, Media down). Never throws.
 */
async function importPicture(url) {
    const address = String(url || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(address)) return null;
    if (!enabled()) return null;
    // A test that does not stub the network never makes one.
    if (process.env.NODE_ENV === 'test' && !_fetch) return null;
    try {
        const headers = await serviceAuth.headers(AUDIENCE, config.media.scope);
        const send = _fetch || globalThis.fetch;
        const res = await send(`${config.media.baseUrl}/api/v1/attachments/import`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ url: address }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res || (Number(res.status) !== 200 && Number(res.status) !== 201)) return null;
        const body = await res.json().catch(() => null);
        const out = body && typeof body.url === 'string' ? body.url : null;
        if (!out || !/^https:\/\//i.test(out)) return null;
        const id = body && typeof body.id === 'string' ? body.id : null;
        return id ? { id, url: out } : null;
    } catch {
        return null;
    }
}

/**
 * Keep the picture with the message it is shown under: Media's POST /api/v1/attachments/:id/keep with that
 * message's id. The picture leaves its day-long life (an attachment that was never sent to a message lives
 * 24 hours) and lives in the kept window instead (Media's keepDays: 30 days), so a card's picture is still
 * there a month later. A picture that is shown by a second message is kept again for that message.
 *
 * The picture belongs to Chat (Chat brought it in), so Chat is the one who may keep it. Never throws: a
 * picture that cannot be kept is left as it is, and the page drops it if it ever stops loading.
 */
async function keepPicture(id, messageId) {
    const attachment = String(id || '').trim();
    const message = String(messageId == null ? '' : messageId).trim();
    if (!/^att_[A-Za-z0-9_-]{1,64}$/.test(attachment)) return false;
    if (!message || message.length > 200) return false;
    if (!enabled()) return false;
    // A test that does not stub the network never makes one.
    if (process.env.NODE_ENV === 'test' && !_fetch) return false;
    try {
        const headers = await serviceAuth.headers(AUDIENCE, config.media.scope);
        const send = _fetch || globalThis.fetch;
        const res = await send(`${config.media.baseUrl}/api/v1/attachments/${encodeURIComponent(attachment)}/keep`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ message_id: message }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return !!(res && Number(res.status) === 200);
    } catch {
        return false;
    }
}

module.exports = { importPicture, keepPicture, AUDIENCE, enabled, _setFetch(fn) { _fetch = fn || null; } };
