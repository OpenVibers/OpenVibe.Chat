'use strict';
/**
 * Chat → the Network: the account links and the person behind a chat identity.
 *
 * The Network owns the linked accounts (its linked_accounts, the account link every service reads);
 * Chat asks it for three things:
 *
 *   registerPending({ token, app, serviceUserId, serviceUsername, expiresAt })
 *       The one-time token from /link is registered with the Network, so the page that asks the
 *       person (openvibe.network/chat-apps/link, signed in there) can show what is being linked and
 *       write the account link when they say yes.
 *   pending(token) → { state: 'pending' | 'confirmed' | 'unknown', subject }
 *       Whether the person confirmed the link, and the subject it was confirmed for.
 *   resolve({ app, serviceUserId }) → subject | null
 *       The OpenVibe subject of a person in a chat app. A person who is not linked has no subject here.
 *   unlink({ app, serviceUserId, subject }) → true
 *       The account link is removed: the bot forgets the person in that app.
 *
 * The calls go to the Network's own routes with Chat's service token (client `chat`, audience
 * openvibe.network, the capability identity.subject.resolve).
 */
const config = require('../config');

let _client = null;

function client() {
    if (_client) return _client;
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const { createClient } = require('openvibe-sdk');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve',
    });
    _client = createClient({ tokenProvider: tokens, timeoutMs: 20000 });
    return _client;
}

/** The Network's answer, or null when it cannot be reached or does not know the person. */
function createNetworkClient({ http = null } = {}) {
    const call = async (opts) => {
        const c = http || client();
        try {
            return await c.json({ service: 'network', baseUrl: config.networkInternalUrl, audience: 'openvibe.network', retries: 1, ...opts });
        } catch (err) {
            if (err && (err.status === 404 || err.status === 400)) return null;
            throw err;
        }
    };

    return {
        /** Register the one-time link token with the Network (its page asks the person). */
        async registerPending({ token, app, serviceUserId, serviceUsername, expiresAt }) {
            const out = await call({
                method: 'POST', path: '/internal/chat-app-links', idempotent: true,
                json: {
                    token, app, service_user_id: serviceUserId, service_username: serviceUsername || null,
                    expires_at: new Date(expiresAt).toISOString(),
                },
            });
            return !!(out && out.ok !== false);
        },

        /** Whether the person confirmed the link, and for which subject. */
        async pending(token) {
            const out = await call({ method: 'GET', path: '/internal/chat-app-links', query: { t: token } });
            if (!out) return { state: 'unknown' };
            return { state: out.state || 'pending', subject: out.subject || null, app: out.app || null, service_username: out.service_username || null };
        },

        /** The OpenVibe subject of a person in a chat app, or null when they are not linked. */
        async resolve({ app, serviceUserId }) {
            const out = await call({ method: 'GET', path: '/internal/chat-app-links/resolve', query: { app, id: serviceUserId } });
            const subject = out && (out.subject_id || (out.subject && out.subject.id));
            return subject ? String(subject) : null;
        },

        /** The account link is removed. */
        async unlink({ app, serviceUserId, subject }) {
            const out = await call({
                method: 'POST', path: '/internal/chat-app-links/unlink', idempotent: true,
                json: { app, service_user_id: serviceUserId, subject: subject || null },
            });
            return !!(out && out.ok !== false);
        },
    };
}

module.exports = { createNetworkClient };
