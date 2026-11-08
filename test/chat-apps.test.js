'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../server/db/database');
const { createStore } = require('../server/chat-apps/store');
const { createHandler, group, identity } = require('../server/chat-apps/handler');
const { router, parse } = require('../server/chat-apps/ingress');
const { createProviders } = require('../server/chat-apps/providers');
const { signButton } = require('openvibe-sdk/chat-apps');
(async () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const cfg = { chatApps: { callbackSecret: 'fixture-callback-only', linkTtlMs: 600000, callbackTtlMs: 600000, perUserRatePerHour: 100,
        linkUrl: 'https://openvibe.network/chat-apps/link',
        telegram: { botToken: 'fixture', secretToken: 'fixture-telegram' },
        discord: { botToken: 'fixture', applicationId: '222222222222222222', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') },
        slack: { botToken: 'fixture', signingSecret: 'fixture-slack', teamId: 'T123' } } };
    const store = createStore({ db });
    const sent = [], starts = [], decisions = [], links = [], registrations = [], unregistrations = [];
    let linked = false, admin = false, pendingCode = null, pendingUser = null;
    const subject = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1';
    const providers = Object.fromEntries(['telegram','discord','slack'].map(app => [app, { on: true, botUserId: '999', botUsername: 'our_bot', sendText: async b => sent.push(b), sendButtons: async b => sent.push(b), isAdmin: async () => admin }]));
    const network = {
        resolve: async () => linked ? subject : null,
        registerPending: async b => { links.push(b); return true; },
        // Network only finishes a link for the chat account that started it and only with its code.
        finish: async ({ serviceUserId, code }) => {
            if (serviceUserId !== pendingUser) return { ok: false, error: 'no_link' };
            if (code !== pendingCode) return { ok: false, error: 'code', attemptsLeft: 2 };
            linked = true; pendingCode = null;
            return { ok: true, subject };
        },
        unlink: async () => { linked = false; return true; },
    };
    const actor = { start: async b => { starts.push(b); return { id: 'task1' }; }, registerAccount: async b => { registrations.push(b); return { bound: true }; }, unregisterAccount: async b => { unregistrations.push(b); return { ok: true }; }, task: async () => ({ state: 'succeeded', result: { answer: 'The answer.', artifacts: [{ name: 'Report', url: 'https://openvibe.actor/file/1' }] } }), approvals: async () => [], decide: async b => { decisions.push(b); return {}; } };
    const handler = createHandler({ config: cfg, store, providers, network, actor });
    for (const app of ['telegram','discord','slack']) {
        const fixture = require(`./fixtures/chat-apps/${app}.json`);
        const m = parse(app, fixture, providers[app], cfg.chatApps);
        assert.ok(m); assert.equal(m.chatType, 'private');
        linked = false; pendingCode = null; pendingUser = null;
        await handler.handle(m, `${app}-unlinked`); assert.equal(starts.length, 0);
        await handler.handle({ ...m, command: 'link', kind: 'command' }, `${app}-link`);
        assert.ok(links.at(-1).token.length === 43, 'a one-time link was registered');
        assert.equal(links.at(-1).botUsername, 'our_bot');
        pendingCode = '123456'; pendingUser = identity(m);
        // Another chat account sending the code finishes nothing.
        await handler.handle({ ...m, userId: 'stranger', text: '123456', command: null, kind: 'message' }, `${app}-code-wrong-person`);
        assert.equal(linked, false);
        // A wrong code does not link.
        await handler.handle({ ...m, text: '000000', command: null, kind: 'message' }, `${app}-code-wrong`);
        assert.equal(linked, false); assert.match(sent.at(-1).text, /not right/);
        // The chat account that started /link finishes with the code.
        await handler.handle({ ...m, text: '123456', command: null, kind: 'message' }, `${app}-code`);
        assert.equal(linked, true); assert.match(sent.at(-1).text, /You are linked/);
        assert.equal(registrations.at(-1).account.kind, app);
        assert.equal(registrations.at(-1).account.id, identity(m));
        await handler.handle(m, `${app}-ask`); assert.equal(starts.at(-1).policy, 'dm');
        assert.equal(starts.at(-1).account.id, identity(m));
        assert.match(sent.at(-1).text, /Report: https/);
        starts.length = 0;
        const g = { ...m, text: 'hello', command: null, args: '', kind: 'message', chatType: 'group', chatId: `g-${app}`, mention: false, replyToBot: false };
        await handler.handle(g, 'unmentioned'); assert.equal(starts.length, 0);
        await handler.handle({ ...g, mention: true }, 'mentioned'); assert.equal(starts.at(-1).policy, 'answer_only'); starts.length = 0;
        admin = false;
        await handler.handle({ ...g, mention: true, command: 'settings', args: 'act_with_approvals 10' }, 'badadmin');
        assert.equal((await store.settings(app, group(g))).mode, 'answer_only');
        admin = true;
        await handler.handle({ ...g, mention: true, command: 'settings', args: 'act_with_approvals 10' }, 'admin');
        assert.equal((await store.settings(app, group(g))).mode, 'act_with_approvals');
        const id = await store.openCallback({ app, chatId: group(m), userId: identity(m), subject, action: 'approve', approvalId: 'approval1', expiresAt: Date.now() + 60000 });
        const button = { ...m, command: null, kind: 'button', button: { id: signButton({ secret: cfg.chatApps.callbackSecret, id }) } };
        await handler.handle({ ...button, userId: 'stranger' }, 'wrong'); assert.equal(decisions.length, 0);
        await Promise.all([handler.handle(button, 'right'), handler.handle(button, 'duplicate')]); assert.equal(decisions.length, 1); decisions.length = 0;
        const expired = await store.openCallback({ app, chatId: group(m), userId: identity(m), subject, action: 'approve', approvalId: 'old', expiresAt: Date.now() - 1 });
        await handler.handle({ ...button, button: { id: signButton({ secret: cfg.chatApps.callbackSecret, id: expired }) } }, 'expired'); assert.equal(decisions.length, 0);
        await handler.handle({ ...m, command: 'unlink' }, 'unlink'); assert.equal(linked, false);
        assert.equal(unregistrations.at(-1).account.id, identity(m));
    }
    assert.equal(parse('slack', { ...require('./fixtures/chat-apps/slack.json'), team_id: 'TOTHER' }, providers.slack, cfg.chatApps), null);
    // Signed raw payloads cross the real Express boundary. Work never runs before verification.
    const web = express(); web.use('/hooks', router({ config: cfg, providers, store, wake() {} }));
    const server = web.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/hooks`;
    try {
        for (const app of ['telegram','discord','slack']) {
            const raw = JSON.stringify(require(`./fixtures/chat-apps/${app}.json`));
            const ts = String(Math.floor(Date.now()/1000));
            const headers = { 'content-type': 'application/json' };
            if (app === 'telegram') headers['x-telegram-bot-api-secret-token'] = cfg.chatApps.telegram.secretToken;
            if (app === 'slack') { headers['x-slack-request-timestamp'] = ts; headers['x-slack-signature'] = 'v0=' + crypto.createHmac('sha256', cfg.chatApps.slack.signingSecret).update(`v0:${ts}:${raw}`).digest('hex'); }
            if (app === 'discord') { headers['x-signature-timestamp'] = ts; headers['x-signature-ed25519'] = crypto.sign(null, Buffer.from(ts + raw), keys.privateKey).toString('hex'); }
            assert.equal((await fetch(`${base}/${app}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status, 401);
            const at = Date.now();
            assert.equal((await fetch(`${base}/${app}`, { method: 'POST', headers, body: raw })).status, 200); assert.ok(Date.now() - at < 3000);
            assert.equal((await fetch(`${base}/${app}`, { method: 'POST', headers, body: raw })).status, 200);
            assert.equal(Number((await db.get('SELECT count(*) AS n FROM chat_app_deliveries WHERE app = ?', [app])).n), 1);
            providers[app].on = false;
            assert.equal((await fetch(`${base}/${app}`, { method: 'POST', headers, body: raw })).status, 503);
        }
    } finally { await new Promise(r => server.close(r)); }
    const real = createProviders({ config: cfg, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, user: { team_id: 'T123', is_admin: true } }) }) }).providers;
    assert.equal(await real.discord.isAdmin({ message: { raw: { member: { permissions: '8' } } } }), true);
    assert.equal(await real.discord.isAdmin({ message: { raw: { member: { permissions: '0' } } } }), false);
    assert.equal(await real.slack.isAdmin({ message: { userId: 'U123' } }), true);
    const rates = await Promise.all(Array.from({ length: 10 }, () => store.rate('race', 2)));
    assert.equal(rates.filter(Boolean).length, 2);
    console.log('chat apps: three payloads, signatures, linking, approvals, identity, expiry, group policy, durable dedupe and rates passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
