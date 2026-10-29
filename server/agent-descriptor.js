'use strict';
// What openvibe.chat tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// The public pages are the global room, the server and room directories and their public channels; the
// JSON API is under /api and /developers documents it. Every field here is served by this site.
module.exports = {
    id: 'chat',
    name: 'OpenVibe.Chat',
    purpose: 'The chat behind every OpenVibe site: a global room, public servers and rooms with text and voice channels, direct messages, calls, and Vibe, the network\'s assistant.',
    home: 'https://openvibe.chat',
    site: 'openvibe.chat',
    api: '/api',
    docs: '/developers',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '900 GET/HEAD API requests a minute per address, 180 writes; web forms are limited to 30 a minute',
    },
};
