/**
 * OpenVibe.Chat — which address a request comes from.
 *
 * Browsers reach Chat through Cloudflare → nginx → Chat. nginx forwards the visitor's
 * CF-Connecting-IP and appends its own peer to X-Forwarded-For (and sets X-Real-IP to it). But
 * the same nginx server block also answers hosts that are NOT behind Cloudflare (DNS-only names
 * such as ingest.openvibe.live point straight at the origin), and there CF-Connecting-IP and the
 * left of X-Forwarded-For are whatever the client wrote. So those headers are believed only when
 * nginx's peer is one of Cloudflare's addresses; otherwise the peer nginx saw is the client.
 * Without that, IP bans, the per-address socket cap and chat rate limits (and anon numbers, which
 * are per address) could be set by the client.
 *
 * Cloudflare's published ranges (https://www.cloudflare.com/ips/); CLOUDFLARE_IP_RANGES
 * (comma-separated CIDRs) replaces the list if Cloudflare changes it.
 */
'use strict';

const net = require('net');

const DEFAULT_CLOUDFLARE_RANGES = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32',
];

function normalizeIp(ip) {
    let s = String(ip || '').trim();
    if (s === '::1') return '127.0.0.1';
    if (s.startsWith('::ffff:')) s = s.slice(7);
    return s;
}

const cloudflare = new net.BlockList();
const ranges = String(process.env.CLOUDFLARE_IP_RANGES || '').split(',').map((r) => r.trim()).filter(Boolean);
for (const cidr of (ranges.length ? ranges : DEFAULT_CLOUDFLARE_RANGES)) {
    const [addr, bits] = cidr.split('/');
    const fam = net.isIP(addr);
    if (!fam || !Number.isFinite(Number(bits))) continue;
    try { cloudflare.addSubnet(addr, Number(bits), fam === 6 ? 'ipv6' : 'ipv4'); } catch { /* skip a bad entry */ }
}

function isCloudflare(ip) {
    const s = normalizeIp(ip);
    const fam = net.isIP(s);
    if (!fam) return false;
    try { return cloudflare.check(s, fam === 6 ? 'ipv6' : 'ipv4'); } catch { return false; }
}

function isLoopback(ip) {
    const s = normalizeIp(ip);
    return s === '127.0.0.1' || s.startsWith('127.') || s === '::1';
}

/**
 * The client address of a raw (upgrade) request. Chat listens on loopback behind nginx; a peer
 * that is not loopback is the client itself. From nginx: X-Real-IP (else the last
 * X-Forwarded-For entry) is nginx's peer — the visitor's CF-Connecting-IP is used only when that
 * peer is Cloudflare. A loopback request with no nginx headers (local tools, tests) keeps the
 * old order: CF-Connecting-IP, X-Forwarded-For, socket.
 */
function clientIpOf(req) {
    const h = req.headers || {};
    const peer = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
    if (peer && !isLoopback(peer)) return peer;
    const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const edge = String(h['x-real-ip'] || '').trim() || xff[xff.length - 1] || '';
    if (!edge) return h['cf-connecting-ip'] || xff[0] || peer || 'unknown';
    if (!isCloudflare(edge)) return edge;
    const viaCf = String(h['cf-connecting-ip'] || '').trim();
    if (viaCf) return viaCf;
    // Cloudflare without the header: the entry Cloudflare appended before nginx's.
    const idx = xff.lastIndexOf(edge);
    return (idx > 0 ? xff[idx - 1] : '') || edge;
}

/**
 * Express 'trust proxy' for `hops` proxies (TRUST_PROXY, 2 = Cloudflare → nginx): the socket peer
 * (nginx) is trusted, a further hop only when it is a Cloudflare address.
 */
function trustProxy(hops) {
    const n = Number.isFinite(Number(hops)) ? Number(hops) : 2;
    return (addr, i) => i < n && (i === 0 ? true : isCloudflare(addr));
}

module.exports = { clientIpOf, trustProxy, isCloudflare, normalizeIp, DEFAULT_CLOUDFLARE_RANGES };
