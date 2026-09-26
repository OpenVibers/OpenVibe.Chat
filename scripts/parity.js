#!/usr/bin/env node
/**
 * Chat parity (roadmap WS-I task 6): the chat product, end to end over the real protocol, with two
 * or three connected people, checking what each of them sees. One scenario per item: join, send,
 * DM, /tts, soundboard, moderation (ban, timeout, purge), slow mode, sub-only mode, the popout, and
 * reconnect convergence for deleted and blocked messages.
 *
 * test/parity.test.js runs these same scenarios against Chat booted with stubs (and adds what only
 * a test can see). This CLI runs them against a running Chat:
 *
 *   OV_PARITY_BASE=http://127.0.0.1:4401 \
 *   OV_PARITY_STREAM=<live stream id of a test channel> \
 *   OV_PARITY_TOKEN_A=… OV_PARITY_TOKEN_B=… OV_PARITY_TOKEN_MOD=… [OV_PARITY_TOKEN_STREAMER=…] \
 *   OV_PARITY_TEST_ACCOUNTS=parity_a,parity_b,parity_mod,parity_streamer \
 *   [OV_PARITY_SOUND=honk] [OV_PARITY_ORIGIN=https://openvibe.live] [OV_PARITY_CHANNEL_USER_ID=…] \
 *   node scripts/parity.js [--apply] [--only join,send,…]
 *
 * Roles: A and B are viewers (B is the one banned, timed out and reconnecting), MOD moderates the
 * stream's channel (a channel moderator or its owner), STREAMER owns it (the purge; optional).
 *
 * Without --apply this is a dry run: it prints what each scenario would do and as whom, and opens
 * no connection. With --apply it first signs each token in (one WebSocket join each) and reads the
 * stream's channel owner, and runs NOTHING (exit 2) unless every one of those accounts is named in
 * OV_PARITY_TEST_ACCOUNTS: the messages, DMs, bans, timeouts, slow mode and purges then only ever
 * touch dedicated test accounts and their own channel. Never point --apply at a real channel.
 * Tokens are never printed. Exit 0 = no scenario failed (gaps and skips are reported, not failed).
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');

const PACE_MS = 1150;           // Chat allows one chat line per second per address and room
const WAIT_MS = 4000;           // how long a frame may take to arrive
const QUIET_MS = 400;           // how long "nobody got it" is watched
const ROLES = ['a', 'b', 'mod', 'streamer'];

class Gap extends Error { constructor(reason) { super(reason); this.status = 'gap'; } }
class Skip extends Error { constructor(reason) { super(reason); this.status = 'skip'; } }

const names = (list) => ((list && list.logged) || []).map((u) => String(u.username).toLowerCase());
const lower = (s) => String(s || '').toLowerCase();

/**
 * One parity run: who is who, the stream, and the helpers every scenario uses.
 *
 * driver = {
 *   connect({ role, stream }) → a socket to /ws/chat (stream = the ?stream= id or null) with
 *       .all (frames received), .next(pred, ms) (the first frame matching, not taken before),
 *       .none(pred, ms) (true when none arrives), .sendJson(obj), .close();
 *   http(method, path, { token, body }) → { status, body, text };
 *   address(role) → the address that role's sockets come from (Chat's rate limit key).
 * }
 */
class Parity {
    constructor({ driver, tokens, streamId, channelUserId = null, sound = null, testAccounts = [], log = () => {} }) {
        this.driver = driver;
        this.tokens = tokens;
        this.streamId = Number(streamId);
        this.ownerId = channelUserId ? Number(channelUserId) : null;
        this.owner = null;
        this.sound = sound ? String(sound).replace(/^!/, '').toLowerCase() : null;
        this.testAccounts = testAccounts.map(lower);
        this.log = log;
        this.users = {};
        this.nonce = crypto.randomBytes(3).toString('hex');
        this.sockets = new Set();
        this.lastSend = new Map();
    }

    /** Sign each token in (a join) and find the stream's channel owner. */
    async resolve() {
        for (const role of ROLES) {
            if (!this.tokens[role]) continue;
            const ws = await this.driver.connect({ role, stream: null });
            try {
                ws.sendJson({ type: 'join', token: this.tokens[role] });
                const auth = await ws.next((m) => m.type === 'auth', WAIT_MS);
                if (!auth.authenticated) throw new Error(`the token for ${role} did not sign in`);
                this.users[role] = { id: auth.user_id, username: auth.core_username, display: auth.username, role: auth.role };
            } finally { ws.close(); }
        }
        const hist = await this.http('GET', `/api/chat/${this.streamId}/history?limit=1`);
        if (hist.status !== 200 || !hist.body || !hist.body.channel) throw new Error(`stream ${this.streamId}: no channel (${hist.status})`);
        this.owner = hist.body.channel;
        if (!this.ownerId) {
            const prof = await this.http('GET', `/api/chat/user/${encodeURIComponent(this.owner)}/profile`);
            if (prof.status !== 200 || !prof.body || !prof.body.id) throw new Error(`no user id for the channel owner (${prof.status}); set OV_PARITY_CHANNEL_USER_ID`);
            this.ownerId = Number(prof.body.id);
        }
    }

    /** Accounts --apply would touch that are not named as test accounts. */
    untested() {
        const touched = [...Object.values(this.users).map((u) => u.username), this.owner];
        return [...new Set(touched.filter((n) => !this.testAccounts.includes(lower(n))))];
    }

    text(label) { return `[parity ${this.nonce}] ${label}`; }
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
    gap(reason) { throw new Gap(reason); }
    skip(reason) { throw new Skip(reason); }

    http(method, path, { as = null, body } = {}) {
        return this.driver.http(method, path, { token: as ? this.tokens[as] : null, body });
    }

    /**
     * Open /ws/chat and join the way Live's chat.js does (the token only in the join message):
     * stream → ?stream=<id> and join { streamId }; channel → join { channelUserId } (the channel
     * room, as the popout and an offline channel page do). role 'anon' joins without a token.
     */
    async join(role, { stream = true, channel = false } = {}) {
        const ws = await this.driver.connect({ role, stream: stream ? this.streamId : null });
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
        ws.role = role;
        ws.rateKey = `${this.driver.address(role)}|${stream ? this.streamId : 'global'}`;
        ws.sendJson({
            type: 'join',
            ...(stream ? { streamId: this.streamId } : {}),
            ...(channel ? { channelUserId: this.ownerId } : {}),
            ...(this.tokens[role] ? { token: this.tokens[role] } : {}),
        });
        ws.auth = await ws.next((m) => m.type === 'auth', WAIT_MS);
        return ws;
    }

    /** Send a chat line, one per PACE_MS per address and room (Chat's flood limit). */
    async say(ws, message) {
        const wait = (this.lastSend.get(ws.rateKey) || 0) + PACE_MS - Date.now();
        if (wait > 0) await this.sleep(wait);
        ws.sendJson({ type: 'chat', message });
        this.lastSend.set(ws.rateKey, Date.now());
    }

    saw(ws, message, ms = WAIT_MS) { return ws.next((m) => m.type === 'chat' && m.message === message, ms); }
    system(ws, message, ms = WAIT_MS) { return ws.next((m) => m.type === 'system' && m.message === message, ms); }
    async left(ws) {
        if (ws.readyState === 3) return;
        await new Promise((r) => { ws.once('close', r); ws.close(); });
    }
    async closeAll() { await Promise.all([...this.sockets].map((ws) => this.left(ws).catch(() => {}))); }

    /** Poll fn until it returns something truthy. */
    async until(fn, ms = WAIT_MS) {
        const end = Date.now() + ms;
        for (;;) {
            const v = await fn();
            if (v) return v;
            if (Date.now() > end) return null;
            await this.sleep(150);
        }
    }

    /** Run one scenario → { key, status: 'pass' | 'gap' | 'skip' | 'fail', note, error }. */
    async run(scenario) {
        const started = Date.now();
        try {
            for (const r of scenario.needs || []) if (!this.tokens[r]) this.skip(`needs OV_PARITY_TOKEN_${r.toUpperCase()}`);
            const note = await scenario.run(this);
            return { key: scenario.key, status: 'pass', note: note || '', ms: Date.now() - started };
        } catch (err) {
            if (err instanceof Gap || err instanceof Skip) return { key: scenario.key, status: err.status, note: err.message, ms: Date.now() - started };
            return { key: scenario.key, status: 'fail', note: err && err.message, error: err, ms: Date.now() - started };
        } finally {
            await this.closeAll();
        }
    }
}

/**
 * A reader's view of a room, the way chat.js keeps it: the ids of the messages on screen, from a
 * history page, the live frames (chat lines in, delete-messages out) and cursor reads (?after_id=:
 * new rows in, deleted_ids out).
 */
class RoomView {
    constructor(page) {
        this.ids = new Set((page.messages || []).map((m) => m.id));
        this.cursor = page.latest_id || 0;
    }
    frames(list) {
        for (const m of list) {
            if (m.type === 'chat' && Number.isInteger(m.id)) { this.ids.add(m.id); this.cursor = Math.max(this.cursor, m.id); }
            if (m.type === 'delete-messages') for (const id of m.ids || []) this.ids.delete(id);
        }
        return this;
    }
    delta(d) {
        for (const m of d.messages || []) this.ids.add(m.id);
        for (const id of d.deleted_ids || []) this.ids.delete(id);
        this.cursor = Math.max(this.cursor, d.latest_id || 0);
        return this;
    }
    sorted() { return [...this.ids].sort((x, y) => x - y); }
}

// ── The scenarios ────────────────────────────────────────────────────────────────────────────
// kind: 'write' posts into the test channel or DMs; 'destructive' bans, times out, deletes or
// changes the channel's chat mode. Both run only with --apply and only on test accounts. 'gap': the
// product has no such behaviour yet; the scenario reports why and touches nothing.

const SCENARIOS = [
    {
        key: 'join', kind: 'write', as: ['anon', 'a', 'b'], needs: ['a', 'b'],
        does: 'anonymous and signed-in sockets join the stream; each gets its auth frame; the user list names A and B',
        async run(p) {
            const anon = await p.join('anon');
            assert.strictEqual(anon.auth.authenticated, false, 'anonymous join');
            assert.match(String(anon.auth.username), /^anon\d+$/, 'an anon number');
            assert.strictEqual(anon.auth.role, 'anon');
            const a = await p.join('a');
            assert.strictEqual(a.auth.authenticated, true, 'signed-in join');
            assert.strictEqual(a.auth.core_username, p.users.a.username);
            assert.strictEqual(a.auth.user_id, p.users.a.id);
            const b = await p.join('b');
            const both = (m) => m.type === 'users-list' && names(m.users).includes(lower(p.users.a.username)) && names(m.users).includes(lower(p.users.b.username));
            anon.sendJson({ type: 'get-users' });
            const list = await anon.next(both, WAIT_MS);
            assert.ok(list.users.anonCount >= 1, 'the anonymous viewer is counted');
            await a.next(both, WAIT_MS);    // pushed to everyone in the room, not only on request
            return `anon ${anon.auth.username}; list ${list.users.logged.length} named, ${list.users.anonCount} anon`;
        },
    },
    {
        key: 'send', kind: 'write', as: ['a', 'b', 'anon'], needs: ['a', 'b'],
        does: 'A sends a line: A gets its own echo, B and an anonymous viewer get it with the same id; it is in the stream history',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b'); const anon = await p.join('anon');
            const text = p.text('hello from A');
            await p.say(a, text);
            const echo = await p.saw(a, text);
            const got = await p.saw(b, text);
            const gotAnon = await p.saw(anon, text);
            assert.ok(Number.isInteger(echo.id), 'the echo carries the stored id');
            assert.strictEqual(got.id, echo.id); assert.strictEqual(gotAnon.id, echo.id);
            assert.strictEqual(got.core_username, p.users.a.username);
            assert.strictEqual(got.user_id, p.users.a.id);
            assert.strictEqual(got.stream_id, p.streamId);
            const hist = await p.http('GET', `/api/chat/${p.streamId}/history?limit=50`);
            assert.ok(hist.body.messages.some((m) => m.id === echo.id && m.message === text), 'in the stream history');
            return `message ${echo.id}`;
        },
    },
    {
        key: 'dm', kind: 'write', as: ['a', 'b', 'mod'], needs: ['a', 'b', 'mod'],
        does: 'A opens a DM with B and writes: B’s socket gets it, A’s socket is not echoed, MOD (not a participant) gets nothing and is refused the conversation',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b'); const x = await p.join('mod');
            const conv = await p.http('POST', '/api/dm/conversations', { as: 'a', body: { user_ids: [p.users.b.id] } });
            assert.strictEqual(conv.status, 200, conv.text);
            const convId = conv.body.conversation.id;
            assert.deepStrictEqual(conv.body.conversation.participants.map((u) => u.id).sort(), [p.users.a.id, p.users.b.id].sort());
            const text = p.text('a private hello');
            const sent = await p.http('POST', `/api/dm/conversations/${convId}/messages`, { as: 'a', body: { message: text } });
            assert.strictEqual(sent.status, 200, sent.text);
            const got = await b.next((m) => m.type === 'dm' && m.conversation_id === convId && m.message && m.message.message === text);
            assert.strictEqual(got.message.sender_id, p.users.a.id);
            const isIt = (m) => m.type === 'dm' && m.message && m.message.message === text;
            assert.ok(await a.none(isIt, QUIET_MS), 'the sender’s socket is not echoed (the REST answer carries it)');
            assert.ok(await x.none(isIt, QUIET_MS), 'delivered to participants only');
            assert.strictEqual((await p.http('GET', `/api/dm/conversations/${convId}/messages`, { as: 'mod' })).status, 403, 'a non-participant cannot read it');
            const inbox = await p.http('GET', `/api/dm/conversations/${convId}/messages`, { as: 'b' });
            assert.ok(inbox.body.messages.some((m) => m.message === text), 'B reads it');
            return `conversation ${convId}`;
        },
    },
    {
        key: 'tts', kind: 'write', as: ['a', 'b', 'mod'], needs: ['a', 'b', 'mod'],
        does: 'A sends /tts: the room gets the tts line and the request is in the channel’s TTS queue (read as MOD); the audio frame follows when it plays',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b');
            const text = p.text('read this out');
            await p.say(a, `/tts ${text}`);
            const line = await b.next((m) => m.type === 'tts' && m.message === text);
            assert.strictEqual(line.core_username, p.users.a.username);
            const req = await p.until(async () => {
                const q = await p.http('GET', `/api/tts/queue?stream_id=${p.streamId}&recent=50`, { as: 'mod' });
                assert.strictEqual(q.status, 200, q.text);
                return [q.body.playing, ...q.body.queued, ...q.body.recent].filter(Boolean).find((r) => r.kind === 'tts' && r.label === text);
            });
            assert.ok(req, 'the /tts request is in the room’s queue');
            assert.strictEqual(req.requested_by, p.users.a.display);
            let audio = 'not played yet';
            if (req.state === 'played' || req.state === 'playing') {
                const f = await b.next((m) => m.type === 'tts-audio' && m.message === text, 8000);
                assert.ok(f.audio, 'the audio frame carries audio');
                audio = 'audio frame received';
            }
            return `queue request ${req.id} (${req.state}); ${audio}`;
        },
    },
    {
        key: 'soundboard', kind: 'write', as: ['a', 'b', 'mod'], needs: ['a', 'b', 'mod'],
        does: 'A types !<sound>: the room gets the “played !sound” line and the soundboard-audio frame; the channel’s queue has it',
        async run(p) {
            if (!p.sound) p.skip('no channel sound command (OV_PARITY_SOUND)');
            const a = await p.join('a'); const b = await p.join('b');
            await p.say(a, `!${p.sound}`);
            const isAnnounce = (m) => m.type === 'chat' && m.message_type === 'channel-sound' && m.message === `played !${p.sound}`;
            const ann = await b.next(isAnnounce);
            assert.strictEqual(ann.core_username, p.users.a.username);
            await a.next(isAnnounce);
            const audio = await b.next((m) => m.type === 'soundboard-audio' && m.title === `!${p.sound}`, 8000);
            assert.ok(audio.audio && audio.audio.length > 0, 'the clip is in the frame');
            const q = await p.http('GET', `/api/tts/queue?stream_id=${p.streamId}&recent=50`, { as: 'mod' });
            const req = [q.body.playing, ...q.body.queued, ...q.body.recent].filter(Boolean).find((r) => r.kind === 'channel-sound' && r.label === `!${p.sound}`);
            assert.ok(req, 'the sound went through the room’s queue');
            return `!${p.sound}: announce ${ann.id}, queue request ${req.id} (${req.state})`;
        },
    },
    {
        key: 'ban', kind: 'destructive', as: ['mod', 'a', 'b'], needs: ['a', 'b', 'mod'],
        does: 'MOD /ban B in the stream: everyone sees the notice; B’s next line is refused and reaches nobody; /unban lifts it',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b'); const mod = await p.join('mod');
            const target = p.users.b.username;
            await p.say(mod, `/ban ${target}`);
            await p.system(a, `${target} has been banned.`);
            await p.system(b, `${target} has been banned.`);
            try {
                const text = p.text('can B still talk?');
                await p.say(b, text);
                await p.system(b, 'You are banned from this chat.');
                assert.ok(await a.none((m) => m.type === 'chat' && m.message === text, QUIET_MS), 'a banned line reaches nobody');
            } finally {
                await p.say(mod, `/unban ${target}`);
                await p.system(mod, `${target} has been unbanned.`);
            }
            const back = p.text('B is back');
            await p.say(b, back);
            await p.saw(a, back);
            return `${target} banned and unbanned`;
        },
    },
    {
        key: 'timeout', kind: 'destructive', as: ['mod', 'a', 'b'], needs: ['a', 'b', 'mod'],
        does: 'MOD /timeout B 2: B’s line inside the 2 s is refused; after it B’s line reaches A',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b'); const mod = await p.join('mod');
            const target = p.users.b.username;
            const secs = 2;
            await p.say(mod, `/timeout ${target} ${secs}`);
            await p.system(mod, `${target} timed out for ${secs}s.`);
            const t0 = Date.now();
            const during = p.text('timed out?');
            await p.say(b, during);
            await p.system(b, 'You are banned from this chat.');
            assert.ok(await a.none((m) => m.type === 'chat' && m.message === during, QUIET_MS), 'a timed-out line reaches nobody');
            await p.sleep(Math.max(0, t0 + secs * 1000 + 700 - Date.now()));
            const after = p.text('the timeout is over');
            await p.say(b, after);
            await p.saw(a, after);
            return `${target} timed out for ${secs}s, then talked again`;
        },
    },
    {
        key: 'purge', kind: 'destructive', as: ['streamer', 'a', 'b'], needs: ['a', 'b', 'streamer'],
        does: 'STREAMER purges a time range of the stream (the dashboard’s ISO range): A and B get the purge frame; the lines in the range are gone from history, the one before stays',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b');
            const before = p.text('before the purge');
            await p.say(a, before);
            const kept = await p.saw(b, before);
            // The range starts after `before` and is built from the server's own timestamps, so a
            // client clock that is off does not matter. Rows keep whole seconds.
            const from = new Date(Date.parse(kept.timestamp) + 1500).toISOString();
            await p.sleep(2700);
            const g1 = p.text('purge me (A)'); const g2 = p.text('purge me (B)');
            await p.say(a, g1); const m1 = await p.saw(b, g1);
            await p.say(b, g2); const m2 = await p.saw(a, g2);
            assert.ok(Date.parse(m1.timestamp) >= Date.parse(from) + 1000, 'the purged lines are inside the range');
            const to = new Date(Date.parse(m2.timestamp) + 1500).toISOString();
            const range = { streamId: p.streamId, from, to };
            const preview = await p.http('POST', '/api/chat/admin/purge/preview', { as: 'streamer', body: range });
            assert.strictEqual(preview.status, 200, preview.text);
            assert.ok(preview.body.count >= 2, `the preview counts the range (${preview.body.count})`);
            const r = await p.http('DELETE', '/api/chat/admin/purge', { as: 'streamer', body: range });
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(r.body.deleted >= 2, `purged ${r.body.deleted}`);
            for (const ws of [a, b]) await ws.next((m) => m.type === 'purge' && m.from === from && m.to === to);
            const ids = (await p.http('GET', `/api/chat/${p.streamId}/history?limit=200`)).body.messages.map((m) => m.id);
            assert.ok(!ids.includes(m1.id) && !ids.includes(m2.id), 'the range is gone from history');
            assert.ok(ids.includes(kept.id), 'the line before the range stays');
            return `${r.body.deleted} purged`;
        },
    },
    {
        key: 'slow', kind: 'destructive', as: ['mod', 'a', 'b'], needs: ['a', 'b', 'mod'],
        does: 'MOD /slow 2: A’s second line inside 2 s is refused and reaches nobody; MOD’s two lines 1.2 s apart both go out (moderators are exempt); /slow off',
        async run(p) {
            const a = await p.join('a'); const b = await p.join('b'); const mod = await p.join('mod');
            const secs = 2;
            await p.say(mod, `/slow ${secs}`);
            assert.strictEqual((await a.next((m) => m.type === 'slowmode')).seconds, secs);
            await p.system(a, `Slow mode enabled: ${secs}s between messages`);
            try {
                // Everyone may share one address (the CLI): let the /slow line's window pass first.
                await p.sleep(secs * 1000 + 200);
                const one = p.text('slow one'); const two = p.text('slow two');
                await p.say(a, one);
                await p.saw(b, one);
                await p.say(a, two);
                await p.system(a, 'Slow down! You are sending messages too fast.');
                assert.ok(await b.none((m) => m.type === 'chat' && m.message === two, QUIET_MS), 'a slowed line reaches nobody');
                const m1 = p.text('mod one'); const m2 = p.text('mod two');
                await p.say(mod, m1); await p.saw(b, m1);
                await p.say(mod, m2); await p.saw(b, m2);
            } finally {
                // Turn it off whatever happened; a Chat that slows moderators refuses the first try.
                await p.say(mod, '/slow off');
                const off = await Promise.race([
                    p.system(a, 'Slow mode disabled.').then(() => true),
                    mod.next((m) => m.type === 'system' && /^Slow down!/.test(m.message)).then(() => false),
                ]).catch(() => false);
                if (!off) {
                    await p.sleep(secs * 1000 + 200);
                    await p.say(mod, '/slow off');
                    await p.system(a, 'Slow mode disabled.');
                }
            }
            return `viewer slowed, moderator exempt (${secs}s)`;
        },
    },
    {
        key: 'subonly', kind: 'gap', as: [], needs: [],
        does: 'sub-only mode: a non-subscriber is refused, a subscriber may talk',
        async run(p) {
            p.gap('no sub-only mode exists: no channel setting, no command and no check in Chat or Live (followers-only exists), and Chat has no subscriber lookup in live-context (subscriptions are Live’s)');
        },
    },
    {
        key: 'popout', kind: 'write', as: ['a', 'b', 'mod'], needs: ['a', 'b', 'mod'],
        does: 'Live’s popout (popout-chat.html + chat.js): a live popout (stream join) and a channel-room popout (join by channelUserId) read their histories, get stream lines, and the channel popout’s line reaches the stream; get-users answers',
        async run(p) {
            const pop = await p.join('a', { stream: true, channel: true });
            const chan = await p.join('b', { stream: false, channel: true });
            const viewer = await p.join('mod');
            assert.strictEqual(chan.auth.authenticated, true);
            const sHist = await p.http('GET', `/api/chat/${p.streamId}/history?limit=500`);
            assert.strictEqual(sHist.status, 200); assert.strictEqual(lower(sHist.body.channel), lower(p.owner));
            assert.strictEqual((await p.http('GET', '/api/chat/global/history?limit=500')).status, 200);
            const cHist = await p.http('GET', `/api/chat/channel/${p.ownerId}/history?limit=500`);
            assert.strictEqual(cHist.status, 200); assert.strictEqual(lower(cHist.body.channel), lower(p.owner));
            const t1 = p.text('to the popouts');
            await p.say(viewer, t1);
            const f1 = await p.saw(pop, t1); await p.saw(chan, t1);
            const t2 = p.text('from the channel popout');
            await p.say(chan, t2);
            const f2 = await p.saw(viewer, t2); await p.saw(pop, t2);
            assert.strictEqual(f2.channel_user_id, p.ownerId);
            const ids = (await p.http('GET', `/api/chat/channel/${p.ownerId}/history?limit=50`)).body.messages.map((m) => m.id);
            assert.ok(ids.includes(f1.id) && ids.includes(f2.id), 'both lines are in the channel history a popout reloads');
            pop.sendJson({ type: 'get-users' });
            await pop.next((m) => m.type === 'users-list' && names(m.users).includes(lower(p.users.a.username)));
            // The channel-room popout's users panel: is it the channel's? (MOD is also in global chat.)
            await p.join('mod', { stream: false });
            chan.sendJson({ type: 'get-users' });
            const list = await chan.next((m) => m.type === 'users-list' && names(m.users).includes(lower(p.users.b.username)) && names(m.users).includes(lower(p.users.mod.username)), 1500).catch(() => null);
            return `live and channel-room popouts${list ? '; GAP: the channel-room popout’s users panel also names people in global chat (getUserList(null) is everyone outside a stream)' : ''}`;
        },
    },
    {
        key: 'reconnect', kind: 'destructive', as: ['a', 'b', 'mod'], needs: ['a', 'b', 'mod'],
        does: 'A stays connected, B leaves; MOD’s line is deleted (MOD’s own delete-all) and A writes while B is away; B reconnects and reads ?after_id=<cursor>: B’s view equals A’s, and a fresh page agrees',
        async run(p) {
            const room = `/api/chat/channel/${p.ownerId}/history`;
            const stayer = await p.join('a'); let leaver = await p.join('b'); const writer = await p.join('mod');
            const viewA = new RoomView((await p.http('GET', `${room}?limit=500`)).body); const fromA = stayer.all.length;
            const viewB = new RoomView((await p.http('GET', `${room}?limit=500`)).body); const fromB = leaver.all.length;
            const doomed = p.text('this line will be deleted');
            await p.say(writer, doomed);
            const m1 = await p.saw(stayer, doomed); await p.saw(leaver, doomed);
            viewB.frames(leaver.all.slice(fromB));
            await p.left(leaver);
            // While B is away: a deletion, and a new line.
            writer.sendJson({ type: 'self-delete-history' });
            await writer.next((m) => m.type === 'self-delete-result');
            await stayer.next((m) => m.type === 'delete-messages' && (m.ids || []).includes(m1.id));
            const meanwhile = p.text('written while B was away');
            await p.say(stayer, meanwhile);
            const m2 = await p.saw(stayer, meanwhile);
            viewA.frames(stayer.all.slice(fromA));
            // B comes back: a new socket, then the cursor read chat.js makes.
            leaver = await p.join('b');
            const d = await p.http('GET', `${room}?after_id=${viewB.cursor}`);
            assert.strictEqual(d.status, 200); assert.strictEqual(d.body.complete, true);
            viewB.delta(d.body);
            assert.ok(!viewB.ids.has(m1.id), 'the line deleted while B was away is gone from B’s view');
            assert.ok(viewB.ids.has(m2.id), 'the line written while B was away is in B’s view');
            assert.deepStrictEqual(viewB.sorted(), viewA.sorted(), 'B converges on what A saw');
            // A fresh page (the main pane's reload) agrees with both, over the rows it covers.
            const fresh = (await p.http('GET', `${room}?limit=500`)).body.messages.map((m) => m.id);
            const lo = Math.min(...fresh);
            assert.deepStrictEqual(fresh.slice().sort((x, y) => x - y), viewA.sorted().filter((id) => id >= lo), 'a fresh page shows the same');
            return `deleted ${m1.id} dropped via deleted_ids; ${m2.id} added via the delta`;
        },
    },
    {
        key: 'blocked', kind: 'gap', as: [], needs: [],
        does: 'reconnect convergence for blocked messages: lines from someone the reader blocked (network blocks) are hidden live and after a reconnect',
        async run(p) {
            p.gap('public chat does not apply blocks: network.block.changed and dm_blocks are honoured for DMs and calls only (server/chat/network-blocks.js, dm.js isBlockedEither); room broadcasts and history pages show a blocked person’s lines to the blocker, live and after a reconnect alike, and Live’s chat.js hides nothing either');
        },
    },
];

// ── The command line ─────────────────────────────────────────────────────────────────────────

/** A socket with the frame inbox the scenarios read (the same semantics as test/helpers.js h.ws). */
function openSocket(url, headers) {
    const WebSocket = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers });
        const all = [];
        const waiters = [];
        ws.on('message', (d) => {
            let m; try { m = JSON.parse(d.toString()); } catch { return; }
            all.push(m);
            for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
        });
        ws.all = all;
        ws.next = (pred, ms = WAIT_MS) => {
            const hit = all.find((m) => pred(m) && !m.__taken);
            if (hit) { hit.__taken = true; return Promise.resolve(hit); }
            return new Promise((res, rej) => {
                const w = { pred: (m) => { if (pred(m)) { m.__taken = true; return true; } return false; }, resolve: res };
                w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timed out waiting (last frames: ${JSON.stringify(all.slice(-8).map((x) => [x.type, x.message]))})`)); }, ms);
                waiters.push(w);
            });
        };
        ws.none = async (pred, ms = QUIET_MS) => { await new Promise((r) => setTimeout(r, ms)); return !all.some(pred); };
        ws.sendJson = (o) => ws.send(JSON.stringify(o));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
    });
}

function networkDriver({ base, origin }) {
    const wsBase = base.replace(/^http/, 'ws');
    return {
        address: () => 'this machine',
        connect: ({ stream }) => openSocket(`${wsBase}/ws/chat${stream ? `?stream=${stream}` : ''}`, { origin }),
        async http(method, path, { token, body } = {}) {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000),
            });
            const text = await res.text();
            let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
            return { status: res.status, body: json, text };
        },
    };
}

function parseArgs(argv) {
    const o = { apply: false, only: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') o.apply = true;
        else if (a === '--only') { o.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); }
        else if (a === '--help' || a === '-h') o.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return o;
}

function configFrom(env) {
    const base = String(env.OV_PARITY_BASE || '').replace(/\/+$/, '');
    return {
        base,
        origin: env.OV_PARITY_ORIGIN || 'https://openvibe.live',
        streamId: parseInt(env.OV_PARITY_STREAM, 10) || null,
        channelUserId: parseInt(env.OV_PARITY_CHANNEL_USER_ID, 10) || null,
        sound: env.OV_PARITY_SOUND || null,
        tokens: { a: env.OV_PARITY_TOKEN_A || null, b: env.OV_PARITY_TOKEN_B || null, mod: env.OV_PARITY_TOKEN_MOD || null, streamer: env.OV_PARITY_TOKEN_STREAMER || null },
        testAccounts: String(env.OV_PARITY_TEST_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
}

const LABEL = { pass: 'PASS', gap: 'GAP ', skip: 'SKIP', fail: 'FAIL' };

/** → exit code: 0 ok, 1 a scenario failed, 2 refused (configuration, or accounts not named as test accounts). */
async function main(argv = process.argv.slice(2), env = process.env, log = console.log, { driver = null } = {}) {
    let o;
    try { o = parseArgs(argv); } catch (err) { log(err.message); return 2; }
    if (o.help) { log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 32).join('\n')); return 0; }
    const cfg = configFrom(env);
    const chosen = SCENARIOS.filter((s) => !o.only || o.only.includes(s.key));
    if (o.only && chosen.length !== o.only.length) { log(`unknown scenario in --only (known: ${SCENARIOS.map((s) => s.key).join(', ')})`); return 2; }
    const problems = [];
    if (!cfg.base && !driver) problems.push('OV_PARITY_BASE is required');
    if (!cfg.streamId) problems.push('OV_PARITY_STREAM is required (a live stream of a test channel)');
    const have = ROLES.map((r) => `${r} ${cfg.tokens[r] ? 'set' : '-'}`).join(', ');

    if (!o.apply) {
        log('Chat parity: dry run. Nothing is sent and no connection is opened; --apply runs it.');
        log(`  base ${cfg.base || '(none)'}  origin ${cfg.origin}  stream ${cfg.streamId || '(none)'}  sound ${cfg.sound ? `!${cfg.sound}` : '(none)'}`);
        log(`  tokens: ${have}`);
        log(`  test accounts (OV_PARITY_TEST_ACCOUNTS): ${cfg.testAccounts.join(', ') || '(none)'}`);
        for (const p of problems) log(`  missing: ${p}`);
        log('');
        for (const s of chosen) {
            const missing = (s.needs || []).filter((r) => !cfg.tokens[r]);
            const would = s.kind === 'gap' ? 'reports a gap, touches nothing'
                : missing.length ? `would skip: needs ${missing.map((r) => `OV_PARITY_TOKEN_${r.toUpperCase()}`).join(', ')}`
                    : s.key === 'soundboard' && !cfg.sound ? 'would skip: needs OV_PARITY_SOUND' : `as ${s.as.join(', ')}`;
            log(`  ${s.key.padEnd(11)} ${s.kind.padEnd(11)} ${would}`);
            log(`              ${s.does}`);
        }
        log('');
        log('With --apply every account behind the tokens, and the stream’s channel owner, must be named in');
        log('OV_PARITY_TEST_ACCOUNTS, or nothing runs.');
        return problems.length ? 2 : 0;
    }

    if (problems.length) { for (const p of problems) log(p); return 2; }
    const p = new Parity({ driver: driver || networkDriver(cfg), tokens: cfg.tokens, streamId: cfg.streamId, channelUserId: cfg.channelUserId, sound: cfg.sound, testAccounts: cfg.testAccounts, log });
    try { await p.resolve(); } catch (err) { log(`could not resolve the accounts and the stream: ${err.message}`); return 2; }
    const outside = p.untested();
    if (outside.length) {
        log(`refused: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not named in OV_PARITY_TEST_ACCOUNTS; nothing was run.`);
        return 2;
    }
    log(`Chat parity against ${cfg.base || 'the given driver'}: stream ${p.streamId} (channel ${p.owner}), run ${p.nonce}`);
    const results = [];
    for (const s of chosen) {
        const r = await p.run(s);
        results.push(r);
        log(`  ${LABEL[r.status]} ${s.key.padEnd(11)} ${r.note || ''}`);
    }
    const count = (st) => results.filter((r) => r.status === st).length;
    log(`\n${count('pass')} passed, ${count('gap')} gap(s), ${count('skip')} skipped, ${count('fail')} failed`);
    return count('fail') ? 1 : 0;
}

module.exports = { SCENARIOS, Parity, RoomView, Gap, Skip, openSocket, networkDriver, main, PACE_MS };

if (require.main === module) {
    main().then((code) => process.exit(code), (err) => { console.error(err && err.stack || err); process.exit(1); });
}
