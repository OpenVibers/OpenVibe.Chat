'use strict';
// Link's node token starts and maintains a party desktop. A short-lived signed
// grant lets Connect create only this party's share, bound to that same node.
const crypto = require('crypto');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const contracts = require('openvibe-contracts');
const config = require('../config');
const db = require('../db/database');
const { keys } = require('../net/service-auth');
const { iceServers } = require('../net/turn');
const controlLease = require('./control-lease');
const rooms = require('./rooms');
const parties = require('./parties');

const NODE = /^node:(nod_[0-9A-HJKMNP-TV-Z]{26})$/;
const SHARE = /^shr_[0-9A-HJKMNP-TV-Z]{26}$/;

async function nodeOf(req) {
    const header = String(req.get('authorization') || '');
    if (!header.startsWith('Bearer ')) return null;
    const r = await verifyServiceToken(header.slice(7).trim(), {
        ...keys().verifyOptions, issuer: config.networkUrl, audience: 'openvibe.chat', contracts,
    });
    if (!r.ok || r.claims.actor_type !== 'node') return null;
    const m = NODE.exec(String(r.claims.sub || ''));
    const owner = String(r.claims.on_behalf_of || '');
    return m && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(owner) ? { id: m[1], owner } : null;
}

function grant(data, secret = process.env.CHAT_PARTY_CONNECT_SECRET) {
    if (!secret || secret.length < 32) throw new Error('CHAT_PARTY_CONNECT_SECRET is not configured');
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

async function authorized(req) {
    const node = await nodeOf(req);
    const row = await parties.bySlug(req.params.slug);
    const party = parties.partyOf(row);
    if (!node || !row || !party || party.party_kind !== 'desktop' || party.host_subject !== node.owner) return null;
    if (party.desktop_node_id && party.desktop_node_id !== node.id) return null;
    return { node, row, party };
}

async function claim({ node, row, party }, port) {
    if (party.ended_at || party.desktop_state === 'stopped') throw new parties.PartyError(410, 'party.ended', 'This party has ended');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new parties.PartyError(422, 'party.port', 'Name a local port');
    if (party.desktop_hosting === 'openvibe') throw new parties.PartyError(503, 'party.no_openvibe_machine', 'No OpenVibe machine is free right now');
    // neko reads ICE credentials at container start. Match the Connect share's
    // 24-hour expiry; ordinary call rooms retain their one-hour credentials.
    const turn = iceServers(`p${row.id}`, undefined, Date.now(), 24 * 3600);
    const ice = turn.iceServers;
    if (!turn.ephemeral) throw new parties.PartyError(503, 'party.turn_unavailable', 'The party TURN relay needs short-lived credentials');
    if (!ice.some((x) => String(x.urls).startsWith('turns:') && String(x.urls).includes(':443'))) {
        throw new parties.PartyError(503, 'party.turn_unavailable', 'The party TURN relay is not available over TLS on port 443');
    }
    const host = await db.get('SELECT username FROM ctx_users WHERE subject_id = ? LIMIT 1', [party.host_subject]);
    if (!host || !host.username) throw new parties.PartyError(409, 'party.host_username', 'The host needs a username');
    await db.run('UPDATE room_parties SET desktop_node_id = ? WHERE room_id = ? AND desktop_node_id IS NULL AND ended_at IS NULL', [node.id, party.room_id]);
    const fresh = parties.partyOf(await parties.bySlug(row.slug));
    if (fresh.desktop_node_id !== node.id) throw new parties.PartyError(409, 'party.host_taken', 'Another machine is hosting this party');
    return {
        ice_servers: ice,
        share_grant: grant({ type: 'create', party: row.slug, owner: party.host_subject, username: host.username, node: node.id, port, exp: Math.floor(Date.now() / 1000) + 90 }),
    };
}

async function access({ node, row, party }, subject) {
    const members = (await rooms.members(row, { subjects: true }))
        .filter((m) => m.subject_id && m.role !== 'blocked')
        .map((m) => ({ subject: m.subject_id, username: m.username }));
    const lease = await controlLease.state({ id: row.id, slug: row.slug });
    return {
        active: !party.ended_at && party.desktop_state !== 'stopped' && party.desktop_node_id === node.id,
        member: members.some((m) => m.subject === subject),
        members,
        holder: lease && lease.holder && lease.holder.kind === 'person' ? lease.holder.subject : null,
    };
}

async function ready({ node, row, party }, { share_id: shareId, url }) {
    if (party.ended_at || party.desktop_node_id !== node.id) throw new parties.PartyError(409, 'party.host', 'This machine cannot host the party');
    if (!SHARE.test(String(shareId || ''))) throw new parties.PartyError(422, 'party.share', 'Invalid Connect share');
    let u;
    try { u = new URL(url); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname !== '/' ||
        !u.hostname.startsWith(`${row.slug}--`) || !u.hostname.endsWith('.openvibe.link')) {
        throw new parties.PartyError(422, 'party.share_url', 'Invalid Connect share address');
    }
    await db.run("UPDATE room_parties SET desktop_state = 'ready', desktop_share_id = ?, desktop_share_url = ? WHERE room_id = ? AND desktop_node_id = ? AND ended_at IS NULL", [shareId, u.toString().replace(/\/$/, ''), party.room_id, node.id]);
    const fresh = await parties.bySlug(row.slug);
    return parties.view(fresh, parties.partyOf(fresh));
}

async function ticket(row, party, user) {
    if (!row || !party || party.party_kind !== 'desktop' || party.ended_at || party.desktop_state !== 'ready' || !party.desktop_share_id || !party.desktop_share_url)
        throw new parties.PartyError(404, 'party.desktop_unavailable', 'The shared computer is not ready');
    const access = await rooms.access(row, user);
    if (!access.read || !user || !user.subject_id) throw new parties.PartyError(404, 'rooms.not_found', 'No such room');
    const username = String(user.username || '');
    if (!username) throw new parties.PartyError(409, 'party.username', 'Your account needs a username');
    const value = grant({ type: 'access', share: party.desktop_share_id, subject: user.subject_id,
        username, exp: Math.floor(Date.now() / 1000) + 60 });
    return { url: `${party.desktop_share_url}/__ovc/party#${value}` };
}

async function stopped({ node, party }) {
    await db.run("UPDATE room_parties SET desktop_state = 'stopped', desktop_share_url = NULL WHERE room_id = ? AND desktop_node_id = ?", [party.room_id, node.id]);
}

module.exports = { nodeOf, authorized, grant, claim, access, ready, stopped, ticket };
