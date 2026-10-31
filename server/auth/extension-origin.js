'use strict';
// A browser extension page is not a web origin. Chrome can send `Origin: chrome-extension://<id>` and
// Firefox `Origin: moz-extension://<uuid>`; the UUID is random per install, so there is no origin to
// put on an allow-list. The rules:
//
//   * the origin alone is never a reason to answer 403;
//   * no Access-Control-Allow-Origin / Access-Control-Allow-Credentials is sent (an extension page with
//     its host permissions does not need CORS, and a page origin must never get a credentialed grant);
//   * a cookie session is never accepted from such an origin — only a Bearer token is.
const EXTENSION_ORIGIN_RE = /^(?:chrome-extension|moz-extension):\/\/[^/]+$/;

function isExtensionOrigin(origin) {
    return typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin.trim());
}

module.exports = { isExtensionOrigin };
