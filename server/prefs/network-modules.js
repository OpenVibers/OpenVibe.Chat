/**
 * Chat's client for OpenVibe.Network user modules (Network server/identity/modules.js, service routes):
 *
 *   GET    /internal/modules/:ns/:subject                    network.modules.read
 *   PUT    /internal/modules/:ns/:subject  If-Match: <rev>   network.modules.write (owner service only)
 *   DELETE /internal/modules/:ns/:subject  If-Match: <rev>   network.modules.write (owner service only)
 *
 * with Chat's service token for audience openvibe.network (server/net/service-auth.js). A 401 drops the
 * cached token and tries once more. Network down, slow or without a token for us → status 0 with
 * `error`; every other answer is returned as { status, body } for the caller to judge.
 */
'use strict';

const config = require('../config');
const serviceAuth = require('../net/service-auth');

const AUDIENCE = 'openvibe.network';
const SCOPE = 'network.modules.read network.modules.write';

async function request(method, namespace, subject, { data, revision } = {}) {
    const url = `${config.networkInternalUrl}/internal/modules/${encodeURIComponent(namespace)}/${encodeURIComponent(subject)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        let auth;
        try { auth = await serviceAuth.headers(AUDIENCE, SCOPE); } catch (err) { return { status: 0, error: `no service token: ${err.message}` }; }
        const headers = { ...auth, Accept: 'application/json' };
        if (data !== undefined) headers['Content-Type'] = 'application/json';
        if (revision !== undefined && revision !== null) headers['If-Match'] = `"${Number(revision)}"`;
        let res;
        try {
            res = await fetch(url, { method, headers, body: data !== undefined ? JSON.stringify({ data }) : undefined, signal: AbortSignal.timeout(config.prefs.timeoutMs) });
        } catch (err) {
            return { status: 0, error: `Network unreachable: ${err.message}` };
        }
        if (res.status === 401 && attempt === 0) { serviceAuth.invalidate(AUDIENCE, SCOPE); continue; }
        const body = res.status === 204 ? null : await res.json().catch(() => null);
        return { status: res.status, body };
    }
    return { status: 401, body: null };
}

module.exports = { AUDIENCE, SCOPE, request };
