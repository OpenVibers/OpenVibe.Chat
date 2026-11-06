#!/usr/bin/env node
'use strict';
/**
 * The chat apps' setup helper (agent plan A4): show what is configured, and register what the
 * providers let a service register for itself.
 *
 *   node --env-file=/etc/openvibe/chat.env scripts/chat-apps.js
 *       Which apps are on (a token and its own secret are set), and the bot each one is.
 *   node --env-file=/etc/openvibe/chat.env scripts/chat-apps.js --register
 *       Telegram: setWebhook (our /hooks/chat-apps/telegram, the secret token, messages and
 *       callbacks) and setMyCommands. Discord: the global application commands. Slack: the
 *       slash commands and the Request URL are set in the app's dashboard, so this only checks
 *       the token and prints what to paste there.
 *
 * No value of a token or a secret is ever printed. The URLs are read from CHAT_WEB_URL (Chat's
 * own origin), so a staging run registers a staging URL.
 */
const config = require('../server/config');
const { createProviders } = require('../server/chat-apps/providers');

const base = config.web.baseUrl.replace(/\/$/, '');
const url = (app) => `${base}/hooks/chat-apps/${app}`;

const COMMANDS = {
    telegram: [
        { command: 'link', description: 'Link this chat to your OpenVibe account' },
        { command: 'unlink', description: 'Disconnect this chat from your OpenVibe account' },
        { command: 'help', description: 'What this agent can do here' },
        { command: 'settings', description: 'Group admins: off, answer only, or act with approvals' },
    ],
    discord: [
        { name: 'link', description: 'Link this chat to your OpenVibe account', type: 1 },
        { name: 'unlink', description: 'Disconnect this chat from your OpenVibe account', type: 1 },
        { name: 'help', description: 'What this agent can do here', type: 1 },
        {
            name: 'settings', description: 'Server admins: what the agent may do here', type: 1,
            options: [
                { name: 'mode', description: 'off, answer_only or act_with_approvals', type: 3, required: true,
                    choices: ['off', 'answer_only', 'act_with_approvals'].map((v) => ({ name: v, value: v })) },
                { name: 'rate', description: 'Answers per hour in this server (1-500)', type: 4, required: false, min_value: 1, max_value: 500 },
            ],
        },
    ],
};

async function api(app, method, body, verb = 'POST') {
    const c = config.chatApps[app];
    const origin = app === 'telegram' ? `https://api.telegram.org/bot${c.botToken}/` : app === 'discord' ? 'https://discord.com/api/v10/' : 'https://slack.com/api/';
    const headers = { 'Content-Type': 'application/json', ...(app === 'telegram' ? {} : { Authorization: `${app === 'discord' ? 'Bot' : 'Bearer'} ${c.botToken}` }) };
    const res = await fetch(origin + method, { method: verb, headers, ...(verb === 'GET' ? {} : { body: JSON.stringify(body || {}) }), signal: AbortSignal.timeout(15_000) });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || out.ok === false) throw new Error(`${app}: ${(out && (out.description || out.message || out.error)) || `HTTP ${res.status}`}`);
    return app === 'telegram' ? out.result : out;
}

async function check(providers) {
    for (const app of ['telegram', 'discord', 'slack']) {
        const p = providers[app];
        if (!p.on) { console.log(`${app}: off (no token, or no secret of its own)`); continue; }
        try {
            await p.whoami();
            console.log(`${app}: on, as ${p.botUsername || p.botUserId || 'the configured bot'}`);
        } catch (err) {
            console.log(`${app}: configured, but ${err.message}`);
        }
    }
}

async function register(app) {
    const c = config.chatApps[app];
    if (!c.botToken) throw new Error(`${app}: no bot token is set`);
    if (app === 'telegram') {
        if (!c.secretToken) throw new Error('telegram: set CHAT_TELEGRAM_SECRET_TOKEN first (it is the webhook secret the deliveries are checked with)');
        await api('telegram', 'setWebhook', { url: url('telegram'), secret_token: c.secretToken, allowed_updates: ['message', 'callback_query'] });
        await api('telegram', 'setMyCommands', { commands: COMMANDS.telegram });
        console.log(`telegram: webhook ${url('telegram')} set, ${COMMANDS.telegram.length} commands registered`);
        return;
    }
    if (app === 'discord') {
        if (!c.applicationId) throw new Error('discord: set CHAT_DISCORD_APPLICATION_ID first');
        await api('discord', `applications/${encodeURIComponent(c.applicationId)}/commands`, COMMANDS.discord, 'PUT');
        console.log(`discord: ${COMMANDS.discord.length} global commands registered; the interactions endpoint is ${url('discord')} (set it in the app's General Information page, with the public key already in CHAT_DISCORD_PUBLIC_KEY)`);
        console.log('discord: enable the Message Content intent (Bot page) so a message in a group reaches the agent outside a slash command');
        return;
    }
    await api('slack', 'auth.test', {});
    console.log(`slack: token ok; set the Request URL ${url('slack')} under Event Subscriptions, and the slash command Request URL ${url('slack')}`);
    console.log('slack: subscribe to app_mention and message.im; enable Interactivity (same Request URL); the bot needs chat:write, users:read, team:read and commands');
}

(async () => {
    const { providers } = createProviders({ config });
    if (process.argv.includes('--register')) {
        for (const app of ['telegram', 'discord', 'slack']) {
            if (!providers[app].on) { console.log(`${app}: off, nothing registered`); continue; }
            try { await register(app); } catch (err) { console.log(`${app}: ${err.message}`); process.exitCode = 1; }
        }
        return;
    }
    await check(providers);
    console.log(`\nEndpoints: telegram ${url('telegram')} · discord ${url('discord')} · slack ${url('slack')}`);
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
