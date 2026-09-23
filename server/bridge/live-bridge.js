/**
 * OpenVibe.Chat — the bridge Live uses while it still hosts code that talks to chat.
 *
 * With CHAT_AUTHORITY=chat Live stops running the chat server; its `require('./chat/chat-server')`
 * becomes a proxy (Live server/chat/chat-remote.js, docs/live-patch.diff) that sends every call
 * here, in order, in small batches:
 *
 *   POST /internal/live/calls     capability chat.live_bridge.write
 *       { boot, ops: [{ seq, op, args, ref? }] } → { ok, results: [{ seq, ok, result?, error? }] }
 *       op = a ChatServer method Live's modules call (broadcastToStream, forwardToGlobal, sendDm,
 *       synthesizeAndBroadcastTTS, triggerChannelSound, disconnectUser, sendUserUpdate, …), a few
 *       bridge-only ops (sendToConn, deployNotice, userChanged, invalidate, broadcastAllRaw), or `db` — one of
 *       the chat-table writes Live's un-moved code still makes (AI viewers, relays, donations,
 *       /api/mod), executed on Chat's database, which is the authority.
 *
 *       Pending ids: Live's saveChatMessage cannot wait for Chat's id, so it hands its caller a
 *       placeholder (a large negative number, `ref`) and sends the insert with it. Chat maps the
 *       placeholder to the real id, and every later op in that Live boot that carries it — a
 *       broadcast `{ id }`, a TTS key `m<ref>`, a reply_to_id — is rewritten before it runs.
 *
 *   GET  /internal/live/presence  capability chat.presence.read
 *       Who is connected where (counts, slow modes, user/anon → ip), for Live's synchronous
 *       reads (getTotalConnections, getStreamViewerCount, getConnectedUserIp, findClientByAnonId,
 *       slowModeByStream). Internal only: it carries addresses.
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const ctx = require('../live-context');
const serviceAuth = require('../net/service-auth');

// Chat-table writes Live's remaining modules make (function names and arguments of Live's
// database.js, which Chat's database.js keeps).
const DB_OPS = new Set([
    'saveChatMessage', 'mergeChatMessageMetadata', 'deleteChatMessage', 'deleteUserChatMessages',
    'deleteAnonChatMessages', 'deleteRelayUserMessages', 'deleteChatMessagesByTimeRange',
    'holdMessageForApproval', 'reviewPendingIpMessage', 'approveAllFromIp', 'denyAllFromIp',
    'recordRelayUser', 'hideRelayUser', 'unhideRelayUser', 'unhideRelayUserByIdentity',
    'logModerationAction', 'recordFirstChat', 'setTtsVoiceOverride', 'deleteTtsVoiceOverride',
    'createChannelSound', 'setChannelSoundEmote', 'deleteChannelSound', 'renameChannelSoundCommand',
    'updateChannelSoundEmoteRefs',
]);

// ChatServer methods Live's modules call, and where their stream id argument sits (the stream is
// loaded into the projection first, so labels like source_channel are right on a fresh stream).
const SERVER_OPS = {
    broadcastToStream: [0],
    broadcastToChannelRoom: [1],
    broadcastGlobal: [],
    broadcastAll: [],
    forwardToGlobal: [0],
    forwardToGlobalByChannel: [],
    forwardToStreamerRooms: [0],
    broadcastToOwnerStreams: [],
    sendDm: [],
    sendUserUpdate: [],
    disconnectUser: [],
    synthesizeAndBroadcastTTS: [0],
    triggerChannelSound: [],
    sendToConn: [],
};

const REF_TTL_MS = 10 * 60 * 1000;
const REF_MIN = -(2 ** 40);   // Live's placeholders are ≤ this

function createBridge({ chatServer }) {
    const router = express.Router();
    const refs = new Map();   // `${boot}|${ref}` → { id, at }

    function sweepRefs() {
        const cutoff = Date.now() - REF_TTL_MS;
        for (const [k, v] of refs) if (v.at < cutoff) refs.delete(k);
        try { db.run('DELETE FROM bridge_applied WHERE applied_at < ?', [Date.now() - 7 * 24 * 3600 * 1000]); } catch { /* */ }
    }
    const sweep = setInterval(sweepRefs, 60_000);
    if (sweep.unref) sweep.unref();

    function mapRefs(value, boot) {
        if (typeof value === 'number') {
            if (value <= REF_MIN) { const hit = refs.get(`${boot}|${value}`); return hit ? hit.id : value; }
            return value;
        }
        if (typeof value === 'string') {
            const m = /^(m|ov-)(-\d{13,})$/.exec(value);
            if (m) { const hit = refs.get(`${boot}|${Number(m[2])}`); return hit ? `${m[1]}${hit.id}` : value; }
            return value;
        }
        if (Array.isArray(value)) return value.map((v) => mapRefs(v, boot));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) out[k] = mapRefs(v, boot);
            return out;
        }
        return value;
    }

    const plain = (r) => {
        if (r && typeof r === 'object' && 'changes' in r && 'lastInsertRowid' in r) return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
        return r === undefined ? null : r;
    };

    async function runOp(op, rawArgs, boot, ref, key) {
        const args = mapRefs(Array.isArray(rawArgs) ? rawArgs : [], boot);
        if (op === 'db') {
            const [fn, ...fnArgs] = args;
            if (!DB_OPS.has(fn) || typeof db[fn] !== 'function') throw new Error(`db.${fn} is not a bridge write`);
            // saveChatMessage derives the channel from the stream: have the stream first.
            if (fn === 'saveChatMessage' && fnArgs[0] && fnArgs[0].stream_id) await ctx.ensureStream(fnArgs[0].stream_id);
            const remember = (result) => {
                if (ref != null && result && result.lastInsertRowid != null) refs.set(`${boot}|${ref}`, { id: Number(result.lastInsertRowid), at: Date.now() });
                return result;
            };
            if (!key) return plain(remember(db[fn](...fnArgs)));
            // Applied once per idempotency key, in the same transaction as the write.
            return db.transaction(() => {
                const done = db.get('SELECT result FROM bridge_applied WHERE key = ?', [key]);
                if (done) { const prev = done.result ? JSON.parse(done.result) : null; return remember(prev); }
                const result = plain(db[fn](...fnArgs));
                db.run('INSERT INTO bridge_applied (key, result, applied_at) VALUES (?, ?, ?)', [key, JSON.stringify(result === undefined ? null : result), Date.now()]);
                return remember(result);
            });
        }
        if (Object.prototype.hasOwnProperty.call(SERVER_OPS, op)) {
            for (const i of SERVER_OPS[op]) if (args[i]) await ctx.ensureStream(args[i]);
            if (op === 'disconnectUser') await ctx.invalidateBans();   // a ban was just written in Live
            if (op === 'triggerChannelSound') {
                // (ws, client, stream, command, args, relay) — Live passes no socket.
                const [, client, stream, command, soundArgs, relay] = args;
                return plain(chatServer.triggerChannelSound(null, client || {}, stream, command, soundArgs || [], relay || null));
            }
            return plain(chatServer[op](...args));
        }
        switch (op) {
            case 'broadcastAllRaw': {
                // Live code that iterated chatServer.clients and sent a pre-serialized payload.
                let data;
                try { data = JSON.parse(String(args[0])); } catch { throw new Error('broadcastAllRaw: not JSON'); }
                return plain(chatServer.broadcastAll(data));
            }
            case 'deployNotice':
                return require('../chat/deploy-notice').announceCommits({ db, chatServer, commits: args[0] });
            case 'userChanged':
                ctx.invalidateUser(args[0]);
                await ctx.ensureUsers([args[0]]).catch(() => {});
                return null;
            case 'invalidate': {
                // Live wrote data Chat caches (channel moderators/settings, IP approvals, bans, a user).
                const [kind, id] = args;
                if (kind === 'channel') ctx.invalidateChannel(id);
                else if (kind === 'approvals') ctx.invalidateApprovals(id);
                else if (kind === 'bans') await ctx.invalidateBans();
                else if (kind === 'user') ctx.invalidateUser(id);
                else throw new Error(`invalidate: unknown kind ${kind}`);
                return null;
            }
            default:
                throw new Error(`unknown op ${op}`);
        }
    }

    router.post('/calls', serviceAuth.guard('chat.live_bridge.write'), async (req, res) => {
        const boot = String((req.body && req.body.boot) || '').slice(0, 64) || 'unknown';
        const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops.slice(0, 500) : [];
        const results = [];
        for (const o of ops) {
            try {
                const result = await runOp(String(o.op || ''), o.args, boot, typeof o.ref === 'number' ? o.ref : null, typeof o.key === 'string' ? o.key.slice(0, 80) : null);
                results.push({ seq: o.seq, ok: true, result });
            } catch (err) {
                console.warn(`[Bridge] ${o.op}${o.op === 'db' && Array.isArray(o.args) ? `.${o.args[0]}` : ''} failed: ${err.message}`);
                results.push({ seq: o.seq, ok: false, error: err.message });
            }
        }
        res.json({ ok: true, results });
    });

    router.get('/presence', serviceAuth.guard('chat.presence.read'), (req, res) => {
        const streams = {};
        const users = [];
        const anons = [];
        for (const [, c] of chatServer.clients) {
            if (c.streamId) streams[c.streamId] = null;
            if (c.user) users.push({ user_id: c.user.id, ip: c.ip, stream_id: c.streamId || null });
            else if (c.anonId) anons.push({ anon_id: c.anonId, ip: c.ip, stream_id: c.streamId || null });
        }
        for (const sid of Object.keys(streams)) streams[sid] = chatServer.getStreamViewerCount(Number(sid));
        res.json({
            at: new Date().toISOString(),
            total: chatServer.getTotalConnections(),
            streams,
            slow_mode: Object.fromEntries(chatServer.slowModeByStream),
            users,
            anons,
        });
    });

    router._mapRefs = mapRefs;
    router._refs = refs;
    return router;
}

module.exports = { createBridge, DB_OPS, SERVER_OPS };
