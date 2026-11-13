'use strict';
/**
 * Bringing a page's own picture into OpenVibe.Media (server/chat/link-previews.js).
 *
 * A page's og:image lives on somebody else's host, and a card must never hot-link it: the reader's browser
 * would tell that host who is reading. So the link preview job asks Media to fetch the picture once and keep
 * it: Media fetches it through its own egress rules (https only, public addresses only, at most 2 MB, images
 * only) and stores it as an unlisted attachment with a short life. The card then shows the Media address.
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
 * The Media address of one https picture, or null when there is none for it (no address, a picture Media
 * refuses, a picture that is not an image, Media down). Never throws.
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
        return out && /^https:\/\//i.test(out) ? out : null;
    } catch {
        return null;
    }
}

module.exports = { importPicture, AUDIENCE, enabled, _setFetch(fn) { _fetch = fn || null; } };
