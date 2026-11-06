'use strict';
const config = require('../config');
let cached;
function client() {
    if (!cached) {
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        const tokens = createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret, audience: 'openvibe.actor', scope: 'actor.agent.manage actor.task.read' });
        cached = require('openvibe-sdk').createClient({ tokenProvider: tokens, timeoutMs: 20_000 });
    }
    return cached;
}
function createActorClient({ http = null } = {}) {
    const call = (subject, opts) => (http || client()).json({ service: 'actor', baseUrl: config.actor.internalUrl, audience: 'openvibe.actor',
        headers: { 'X-OV-Subject': subject }, retries: 0, ...opts });
    return {
        async start({ subject, text, policy, conversation, deliveryId }) {
            return call(subject, { method: 'POST', path: '/api/v1/chat-apps/tasks', json: { text, policy, conversation, delivery_id: deliveryId } });
        },
        async task(subject, id) { return call(subject, { method: 'GET', path: `/api/v1/tasks/${encodeURIComponent(id)}` }); },
        async approvals(subject, conversation) { const out = await call(subject, { method: 'GET', path: '/api/v1/chat-apps/approvals', query: { conversation } }); return out.items || []; },
        async decide({ subject, approvalId, decision }) {
            return call(subject, { method: 'POST', path: `/api/v1/chat-apps/approvals/${encodeURIComponent(approvalId)}/decide`, json: { decision } });
        },
    };
}
module.exports = { createActorClient };
