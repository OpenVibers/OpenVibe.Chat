'use strict';
/**
 * Test harness: a stub OpenVibe.Network (RS256 keys, /oauth/token), a stub OpenVibe.Live that
 * answers /internal/chat-context/* and /internal/chat-effects/* the way Live's patch does
 * (docs/live-patch.diff) from in-memory data, and Chat itself booted in-process on a temp DB.
 *
 *   const h = await boot({ env });        // before requiring anything from server/
 *   h.live.users / streams / channels / policies / bans / effects …
 *   const ws = await h.ws({ ip, token, stream });   ws.next(pred), ws.send(obj), ws.all
 *   await h.http('GET', '/api/chat/…', { token })
 *   h.userToken(userId), h.serviceToken(caps, { aud })
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
        });
    });
}

function sqliteNow(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19); }

async function boot({ env = {} } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-test-'));
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
    fs.mkdirSync(path.join(tmp, 'sounds'));
    const { serviceAuth } = require('openvibe-contracts');
    let jti = 0;
    const serviceToken = (cap, { aud = 'openvibe.chat', sub = 'svc:live' } = {}) =>
        serviceAuth.signServiceToken({ iss: ISS, sub, actor_type: sub.startsWith('app:') ? 'app' : 'service', aud: [aud], cap, iat: now(), exp: now() + 300, jti: `tok_test_${++jti}` }, keys.privateKey);

    // ── Stub Network ──
    const tokenRequests = [];
    const network = http.createServer(async (req, res) => {
        const raw = await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s)); });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') {
            const f = new URLSearchParams(raw);
            tokenRequests.push({ audience: f.get('audience'), scope: f.get('scope'), client: f.get('client_id') });
            const cap = String(f.get('scope') || '').split(/\s+/).filter(Boolean);
            return res.end(JSON.stringify({ access_token: serviceToken(cap.length ? cap : ['live.chat_context.read', 'live.chat_effects.write', 'live.chat_mirror.write'], { aud: f.get('audience'), sub: 'svc:chat' }), expires_in: 300 }));
        }
        if (req.url === '/api/.well-known/jwks') return res.end(JSON.stringify({ public_key: keys.publicKey }));
        res.statusCode = 404; res.end('{}');
    });

    // ── Stub Live ──
    const live = {
        users: new Map(),          // id → projection row
        tokens: new Map(),         // token → { userId, apiScopes? }
        streams: new Map(),        // id → stream row
        managed: new Map(),
        channels: new Map(),       // id → { id, user_id, title }
        policies: new Map(),       // channelId → { settings, moderator_ids }
        follows: new Map(),        // userId → [streamerIds]
        approved: new Set(),       // `${channelId}|${ip}`
        bans: [],                  // rows
        settings: { tts_enabled: true, tts_per_user_voices: true, gif_tenor_api_key: '' },
        decor: new Map(),          // userId → { cosmetic, tag }
        anon: new Map(),           // ip → { num, first_seen }
        effects: [],               // { name, body }
        mirror: [],                // changes
        mirrorStatus: 200,
        down: false,
        nextAnon: 1,
        mediaState: { queue: [], now_playing: null },
        seenTokens: [],
        requests: [],              // every path Chat called, in order
    };
    let banVersion = 1;
    live.addBan = (row) => { live.bans.push({ id: live.bans.length + 1, stream_id: null, user_id: null, ip_address: null, anon_id: null, expires_at: null, ...row }); banVersion++; };
    live.clearBans = () => { live.bans = []; banVersion++; };

    const verify = (req, cap) => {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) return 'no token';
        const r = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: keys.publicKey, issuer: ISS, audience: 'openvibe.live' });
        if (!r.ok) return r.code;
        if (!r.claims.cap.includes(cap)) return `missing ${cap}`;
        live.seenTokens.push(r.claims.sub);
        return null;
    };
    const liveServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://live');
        const p = url.pathname;
        const body = req.method === 'POST' ? await readBody(req) : {};
        live.requests.push(p);
        const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
        if (live.down) { req.socket.destroy(); return; }
        if (p.startsWith('/internal/chat-context/')) {
            const bad = verify(req, 'live.chat_context.read');
            if (bad) return send(401, { error: bad });
            const q = p.slice('/internal/chat-context'.length);
            const pageOf = (map) => { const after = parseInt(url.searchParams.get('after_id') || '0', 10); const lim = parseInt(url.searchParams.get('limit') || '1000', 10); return [...map.values()].filter((r) => r.id > after).sort((a, b) => a.id - b.id).slice(0, lim); };
            let m;
            if (q === '/auth') {
                const t = live.tokens.get(body.token);
                if (!t) return send(200, { user: null, reason: 'invalid' });
                const u = live.users.get(t.userId);
                return send(200, { user: { ...u, auth_source: t.apiScopes ? 'api_token' : 'network', ...(t.apiScopes ? { scopes: t.apiScopes } : {}) }, expires_at: new Date(Date.now() + 3600e3).toISOString() });
            }
            if (q === '/users') return send(200, { rows: pageOf(live.users) });
            if (q === '/users/lookup') {
                const out = [];
                for (const id of body.ids || []) if (live.users.has(id)) out.push(live.users.get(id));
                for (const n of body.usernames || []) { const u = [...live.users.values()].find((x) => x.username.toLowerCase() === String(n).toLowerCase()); if (u) out.push(u); }
                return send(200, { users: out });
            }
            if ((m = /^\/users\/(\d+)\/follows$/.exec(q))) return send(200, { streamer_ids: live.follows.get(Number(m[1])) || [] });
            if (q === '/users/profile') {
                const n = url.searchParams.get('username');
                const u = [...live.users.values()].find((x) => x.username.toLowerCase() === String(n).toLowerCase());
                if (!u) return send(404, { error: 'User not found' });
                return send(200, { id: u.id, username: u.username, display_name: u.display_name, messageCount: 0, followerCount: 0, followingCount: 0, ...(Number(url.searchParams.get('viewer_id')) === u.id ? { last_seen: 'x' } : {}) });
            }
            if (q === '/streams') return send(200, { rows: pageOf(live.streams) });
            if (q === '/streams/active') return send(200, { rows: [...live.streams.values()].filter((s) => s.is_live) });
            if ((m = /^\/streams\/(\d+)$/.exec(q))) {
                const s = live.streams.get(Number(m[1]));
                if (!s) return send(200, { stream: null });
                return send(200, { stream: s, owner: live.users.get(s.user_id) || null, managed_stream: s.managed_stream_id ? live.managed.get(s.managed_stream_id) || null : null, channel: s.channel_id ? live.channels.get(s.channel_id) : [...live.channels.values()].find((c) => c.user_id === s.user_id) || null });
            }
            if (q === '/managed-streams') return send(200, { rows: pageOf(live.managed) });
            if (q === '/channels') return send(200, { rows: pageOf(live.channels) });
            if ((m = /^\/channels\/by-user\/(\d+)$/.exec(q))) return send(200, { channel: [...live.channels.values()].find((c) => c.user_id === Number(m[1])) || null });
            if ((m = /^\/channels\/(\d+)\/policy$/.exec(q))) {
                const id = Number(m[1]);
                const pol = live.policies.get(id) || {};
                return send(200, { channel: live.channels.get(id) || null, settings: pol.settings || null, moderator_ids: pol.moderator_ids || [], language: pol.language || 'en' });
            }
            if ((m = /^\/channels\/(\d+)\/approved-ip$/.exec(q))) return send(200, { approved: live.approved.has(`${m[1]}|${url.searchParams.get('ip')}`) });
            if (q === '/bans') {
                const version = String(banVersion);
                if (url.searchParams.get('version') === version) return send(200, { version, unchanged: true });
                return send(200, { version, bans: live.bans });
            }
            if (q === '/decor') {
                const decor = {};
                for (const id of body.user_ids || []) decor[id] = live.decor.get(Number(id)) || { cosmetic: {}, tag: null };
                return send(200, { decor });
            }
            if (q === '/settings') return send(200, { settings: live.settings });
            if ((m = /^\/anon\/(\d+)$/.exec(q))) { const hit = [...live.anon.values()].find((a) => a.num === Number(m[1])); return send(200, { first_seen: hit ? hit.first_seen : null }); }
            if (q === '/anon-first-seen') { const hit = live.anon.get(url.searchParams.get('ip')); return send(200, { first_seen: hit ? hit.first_seen : null }); }
            if ((m = /^\/tts-audio\/(.+)$/.exec(q))) {
                if (m[1] === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); return res.end(Buffer.from('ID3live')); }
                return send(404, { error: 'No such clip' });
            }
            return send(404, { error: `no context ${q}` });
        }
        if (p.startsWith('/internal/chat-effects/')) {
            const name = p.slice('/internal/chat-effects/'.length);
            const bad = verify(req, name === 'mirror' ? 'live.chat_mirror.write' : 'live.chat_effects.write');
            if (bad) return send(401, { error: bad });
            if (name === 'mirror') {
                if (live.mirrorStatus !== 200) return send(live.mirrorStatus, { error: 'refused' });
                live.mirror.push(...(body.changes || []));
                return send(200, { ok: true, applied: (body.changes || []).length, skipped: [] });
            }
            live.effects.push({ name, body });
            switch (name) {
                case 'anon': {
                    if (!live.anon.has(body.ip)) live.anon.set(body.ip, { num: live.nextAnon++, first_seen: sqliteNow(-2 * 86400e3) });
                    const a = live.anon.get(body.ip);
                    return send(200, { anon_number: a.num, first_seen: a.first_seen });
                }
                case 'ban': {
                    const actor = live.users.get(body.actor_user_id);
                    if (!actor) return send(403, { error: 'You do not have permission.' });
                    if (body.action === 'unban') { live.bans = live.bans.filter((b) => !(b.user_id === body.user_id && (b.stream_id === body.stream_id || b.stream_id == null))); banVersion++; return send(200, { ok: true }); }
                    live.addBan({ stream_id: body.stream_id || null, user_id: body.user_id || null, ip_address: body.ip_address || null, anon_id: body.anon_id || null, expires_at: body.expires_at || null });
                    return send(200, { ok: true });
                }
                case 'chat-message': return send(200, { coin: body.award ? { coins: 5, total: 105, streamerId: live.streams.get(body.stream_id)?.user_id || null } : null });
                case 'user-color': { const u = live.users.get(body.user_id); if (u) u.profile_color = body.color; return send(200, { ok: true }); }
                case 'channel-settings': { const pol = live.policies.get(body.channel_id) || {}; pol.settings = { ...(pol.settings || {}), ...body.fields }; live.policies.set(body.channel_id, pol); return send(200, { ok: true }); }
                case 'paste': return send(200, { paste: { slug: 'abc123' } });
                case 'translate': return send(200, { translation: null });
                case 'ai/mod-command': return send(200, { reply: `AI viewers: ${(body.args || []).join(' ')} ok` });
                case 'media-queue':
                    if (body.op === 'add') {
                        if (!body.input) return send(400, { error: 'Give me a link to queue.' });
                        return send(200, { request: { username: body.username, title: 'A Video', duration_seconds: 65, cost: 25 } });
                    }
                    if (body.op === 'state') return send(200, { state: live.mediaState });
                    if (body.op === 'skip') return send(200, { ended: live.mediaState.now_playing, next: live.mediaState.queue[0] || null });
                    return send(400, { error: 'unknown op' });
                case 'hardware': return send(200, { ok: false, reason: 'no_hardware' });
                case 'ensure-channel': {
                    let ch = [...live.channels.values()].find((c) => c.user_id === body.user_id);
                    if (!ch) { ch = { id: 100 + live.channels.size, user_id: body.user_id, title: 'New Channel' }; live.channels.set(ch.id, ch); }
                    return send(200, { channel: ch });
                }
                case 'site-settings': Object.assign(live.settings, body.settings || {}); return send(200, { ok: true, updated: Object.keys(body.settings || {}).length });
                default: return send(200, { ok: true });
            }
        }
        send(404, { error: 'not found' });
    });

    const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
    const networkPort = await listen(network);
    const livePort = await listen(liveServer);

    Object.assign(process.env, {
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        BASE_URL: 'https://openvibe.live',
        TRUST_PROXY: '2',
        CHAT_DB_PATH: path.join(tmp, 'chat.db'),
        CHAT_CACHE_DIR: path.join(tmp, 'cache'),
        SOUNDS_PATH: path.join(tmp, 'sounds'),
        OV_NETWORK_URL: ISS,
        OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${networkPort}`,
        OV_NETWORK_PUBLIC_KEY: path.join(tmp, 'network.pem'),
        OV_OAUTH_CLIENT_ID: 'chat',
        OV_OAUTH_CLIENT_SECRET: 'chat-secret',
        OV_LIVE_INTERNAL_URL: `http://127.0.0.1:${livePort}`,
        LIVE_MIRROR: '0',
        EVENTS_URL: '',
        SITE_URL: 'https://openvibe.live',
        ...env,
    });

    const h = {
        tmp, keys, live, network, liveServer, tokenRequests, serviceToken, ISS,
        userSeq: 0,
        /** Add a Live user (projection row) with a browser token; returns { id, token, ...row }. */
        addUser(username, { role = 'user', subject = null, created_at = sqliteNow(-30 * 86400e3), apiScopes = null, is_owner = 0, display_name = null } = {}) {
            const id = 1000 + (++h.userSeq);
            const row = { id, username, display_name: display_name || username.charAt(0).toUpperCase() + username.slice(1), avatar_url: null, profile_color: '#8b5cf6', role, is_banned: 0, ban_reason: null, is_owner, created_at, subject_id: subject };
            live.users.set(id, row);
            const token = `tok-${username}-${crypto.randomBytes(4).toString('hex')}`;
            live.tokens.set(token, { userId: id, apiScopes });
            return { ...row, token };
        },
        addChannel(userId, { moderators = [], settings = null } = {}) {
            const id = 10 + live.channels.size;
            live.channels.set(id, { id, user_id: userId, title: 'Channel' });
            live.policies.set(id, { settings, moderator_ids: moderators });
            return id;
        },
        addStream(userId, channelId, { title = 'Live now', is_live = 1, managed = null } = {}) {
            const id = 500 + live.streams.size;
            if (managed) live.managed.set(managed.id, { user_id: userId, sort_order: 0, created_at: sqliteNow(), ...managed });
            live.streams.set(id, { id, user_id: userId, channel_id: channelId, managed_stream_id: managed ? managed.id : null, title, is_live, started_at: sqliteNow(-3600e3), ended_at: null, created_at: sqliteNow(-3600e3) });
            return id;
        },
    };

    const index = require('../server/index');
    const started = await index.start();
    h.server = started.server;
    h.mirrorRelay = started.mirror;
    h.eventsRelay = started.relay;
    h.port = started.server.address().port;
    h.base = `http://127.0.0.1:${h.port}`;
    h.db = require('../server/db/database');
    h.ctx = require('../server/live-context');
    h.chatServer = require('../server/chat/chat-server');

    h.http = async (method, p, { token, body, headers = {}, raw } = {}) => {
        const res = await fetch(`${h.base}${p}`, {
            method,
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
            body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, body: json, text, headers: res.headers };
    };

    const WebSocket = require('ws');
    /** Open /ws/chat as a browser would (through nginx: the address arrives in CF-Connecting-IP). */
    h.ws = ({ ip = '203.0.113.10', token = null, stream = null, origin = 'https://openvibe.live', query = '' } = {}) => new Promise((resolve, reject) => {
        const qs = new URLSearchParams();
        if (stream) qs.set('stream', stream);
        if (token) qs.set('token', token);
        const url = `ws://127.0.0.1:${h.port}/ws/chat${qs.toString() ? `?${qs}` : ''}${query}`;
        const ws = new WebSocket(url, { headers: { 'cf-connecting-ip': ip, origin } });
        const all = [];
        const waiters = [];
        ws.on('message', (d) => {
            let m; try { m = JSON.parse(d.toString()); } catch { return; }
            all.push(m);
            for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
        });
        ws.all = all;
        ws.next = (pred, ms = 3000) => {
            const hit = all.find((m) => pred(m) && !m.__taken);
            if (hit) { hit.__taken = true; return Promise.resolve(hit); }
            return new Promise((res, rej) => {
                const w = { pred: (m) => { if (pred(m)) { m.__taken = true; return true; } return false; }, resolve: res };
                w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timed out waiting (got: ${JSON.stringify(all.map((x) => [x.type, x.message]).slice(-12))})`)); }, ms);
                waiters.push(w);
            });
        };
        ws.none = async (pred, ms = 300) => { await new Promise((r) => setTimeout(r, ms)); return !all.some(pred); };
        ws.sendJson = (o) => ws.send(JSON.stringify(o));
        ws.on('open', () => resolve(ws));
        ws.on('error', (e) => reject(e));
        ws.on('unexpected-response', (req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
    });
    /** Whether an upgrade is refused (socket destroyed). */
    h.wsRefused = (opts) => h.ws(opts).then((ws) => new Promise((r) => { const t = setTimeout(() => { ws.close(); r(false); }, 300); ws.on('close', () => { clearTimeout(t); r(true); }); }), () => true);

    h.close = async () => {
        try { h.chatServer.close(); } catch { /* */ }
        try { h.ctx.stop(); h.mirrorRelay.stop(); h.eventsRelay.stop(); } catch { /* */ }
        await new Promise((r) => h.server.close(() => r()));
        network.close(); liveServer.close();
        try { h.db.close(); } catch { /* */ }
        fs.rmSync(tmp, { recursive: true, force: true });
    };
    h.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    h.sqliteNow = sqliteNow;
    return h;
}

/** Tiny runner: named steps, stop at the first failure, exit code for test/run.js. */
function suite(name) {
    const steps = [];
    const t = (label, fn) => steps.push({ label, fn });
    t.run = async (cleanup) => {
        let failed = 0;
        for (const s of steps) {
            try { await s.fn(); process.stdout.write(`  ✓ ${s.label}\n`); } catch (err) { failed++; process.stdout.write(`  ✗ ${s.label}\n${err && err.stack || err}\n`); break; }
        }
        try { if (cleanup) await cleanup(); } catch { /* */ }
        process.stdout.write(`${name}: ${failed ? 'FAILED' : `${steps.length} checks passed`}\n`);
        process.exit(failed ? 1 : 0);
    };
    return t;
}

module.exports = { boot, suite, sqliteNow, b64url };
