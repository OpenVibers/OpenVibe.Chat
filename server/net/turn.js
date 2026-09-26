'use strict';
/**
 * ICE servers for calls (openvibe.chat's call rooms; the same logic as OpenVibe.Live server/net/turn.js
 * and its GET /api/auth/ice-servers, so both sites hand out the same kind of list).
 *
 *   GET /api/chat/ice-servers → { iceServers: [{ urls }, { urls, username, credential }…] }
 *
 * One STUN server, plus the TURN server when TURN_URL is set and can be authenticated. With
 * TURN_AUTH_SECRET (coturn `use-auth-secret` with the same `static-auth-secret`) every list carries a
 * credential that expires (TURN REST API: username `<expiry>:<tag>`, credential base64 HMAC-SHA1 of the
 * username); otherwise the static TURN_USERNAME / TURN_CREDENTIAL pair; a turn: URL with neither is left
 * out (a browser refuses such an entry outright). Nothing here asks another service.
 */
const crypto = require('crypto');
const express = require('express');

const TTL_SECONDS = 3600;
const STUN = { urls: 'stun:stun.l.google.com:19302' };

/** turn:host[:port][?query] or turns:…, no credentials in it; '' when unusable. */
function normalizeTurnUrl(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    const m = /^(turns?):(?:\/\/)?([^/?#@\s]+)([?][^#\s]*)?$/i.exec(v);
    if (!m) return '';
    return `${m[1].toLowerCase()}:${m[2]}${m[3] || ''}`;
}

function turnConfig(env = process.env) {
    return {
        url: normalizeTurnUrl(env.TURN_URL),
        secret: String(env.TURN_AUTH_SECRET || '').trim(),
        username: String(env.TURN_USERNAME || '').trim(),
        credential: String(env.TURN_CREDENTIAL || '').trim(),
    };
}

function turnCredentials(tag = 'anon', cfg = turnConfig(), now = Date.now()) {
    if (cfg.secret) {
        const username = `${Math.floor(now / 1000) + TTL_SECONDS}:${String(tag).replace(/[^A-Za-z0-9_-]/g, '')}`;
        return { username, credential: crypto.createHmac('sha1', cfg.secret).update(username).digest('base64'), ephemeral: true };
    }
    if (cfg.username && cfg.credential) return { username: cfg.username, credential: cfg.credential, ephemeral: false };
    return null;
}

/** The list for a viewer (tag: u<id> or anon). */
function iceServers(tag = 'anon', cfg = turnConfig(), now = Date.now()) {
    const servers = [STUN];
    let ephemeral = false;
    if (cfg.url) {
        const c = turnCredentials(tag, cfg, now);
        if (c) {
            const tcp = cfg.url.includes('?') ? `${cfg.url}&transport=tcp` : `${cfg.url}?transport=tcp`;
            servers.push({ urls: cfg.url, username: c.username, credential: c.credential }, { urls: tcp, username: c.username, credential: c.credential });
            ephemeral = c.ephemeral;
        }
    }
    return { iceServers: servers, ephemeral };
}

function createIceRoutes() {
    const { optionalAuth } = require('../auth/auth');
    const router = express.Router();
    router.get('/', optionalAuth, (req, res) => {
        const { iceServers: list, ephemeral } = iceServers(req.user ? `u${req.user.id}` : 'anon');
        res.set('Cache-Control', ephemeral ? 'private, max-age=300' : 'private, no-store').json({ iceServers: list });
    });
    return router;
}

module.exports = { createIceRoutes, iceServers, turnCredentials, normalizeTurnUrl, turnConfig, TTL_SECONDS };
