'use strict';
/**
 * The chat apps' owner settings (the owner-setup design of 2026-11-07): the Telegram, Discord and Slack bot accounts
 * your OpenVibe agent answers through (agent plan A4), as the `chat.apps` namespace on openvibe-shared/config, which
 * the admin panel's Setup tab lists under Chat apps.
 *
 *   telegram.bot_token                 BotFather's token                          (secret)
 *   discord.bot_token                  the application's bot token                (secret)
 *   discord.public_key                 the key Discord signs interactions with    (internal: it is public)
 *   discord.application_id             the application's id                       (internal)
 *   slack.bot_token                    the app's bot token, xoxb-…                (secret)
 *   slack.signing_secret               the app's signing secret                   (secret)
 *   slack.team_id                      the workspace the app is installed in      (internal)
 *   telegram.secret_token, callback_secret
 *                                      Chat's own secrets (the webhook check, the signed buttons): made by Chat
 *                                      once when neither the environment nor the store has one, never typed by
 *                                      anyone (x-advanced, not owner inputs)
 *
 * install(config) turns config.chatApps' fields into getters: the value entered in the panel wins, the environment
 * (CHAT_TELEGRAM_BOT_TOKEN, …) stays the fallback, read at use time, so Telegram and Slack answer as soon as a token is
 * entered. Discord's gateway connects when Chat starts, so a Discord token entered later is used from the next start.
 *
 * test(key) is the Setup tab's Test button: Telegram getMe, Discord users/@me, Slack auth.test, each read-only. The
 * answer is one line and never carries a token (Telegram's token is in its URL, so every error is scrubbed).
 */
const crypto = require('crypto');
const { createConfigStore } = require('openvibe-shared/config');

const SERVICE = 'chat';
const NAMESPACE = 'chat.apps';
const TIMEOUT_MS = 10_000;

const FIELDS = Object.freeze({
    'telegram.bot_token': { app: 'telegram', field: 'botToken', env: 'CHAT_TELEGRAM_BOT_TOKEN' },
    'telegram.secret_token': { app: 'telegram', field: 'secretToken', env: 'CHAT_TELEGRAM_SECRET_TOKEN' },
    'discord.bot_token': { app: 'discord', field: 'botToken', env: 'CHAT_DISCORD_BOT_TOKEN' },
    'discord.public_key': { app: 'discord', field: 'publicKey', env: 'CHAT_DISCORD_PUBLIC_KEY' },
    'discord.application_id': { app: 'discord', field: 'applicationId', env: 'CHAT_DISCORD_APPLICATION_ID' },
    'slack.bot_token': { app: 'slack', field: 'botToken', env: 'CHAT_SLACK_BOT_TOKEN' },
    'slack.signing_secret': { app: 'slack', field: 'signingSecret', env: 'CHAT_SLACK_SIGNING_SECRET' },
    'slack.team_id': { app: 'slack', field: 'teamId', env: 'CHAT_SLACK_TEAM_ID' },
    callback_secret: { app: null, field: 'callbackSecret', env: 'CHAT_APPS_CALLBACK_SECRET' },
});
const SECRETS = new Set(['telegram.bot_token', 'telegram.secret_token', 'discord.bot_token', 'slack.bot_token', 'slack.signing_secret', 'callback_secret']);

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Chat apps',
    description: 'The Telegram, Discord and Slack bots your OpenVibe agent answers through. Enter an app\'s bot details to turn that app on; remove them to turn it off. An app with nothing entered stays hidden.',
    type: 'object',
    additionalProperties: false,
    properties: {
        'telegram.bot_token': {
            type: 'string', minLength: 20, maxLength: 200, title: 'Telegram bot token', 'x-group': 'Telegram', 'x-example': '123456789:AA…',
            description: 'The token BotFather gives your bot. With it the agent answers in Telegram chats where people message the bot; without it the Telegram option stays hidden.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets the OpenVibe agent answer in Telegram. Without it the Telegram option stays hidden.',
                get_it_at: 'https://t.me/BotFather',
                get_it_how: 'Message @BotFather, send /newbot, choose a name and a username ending in bot, and copy the token it sends back.',
                test: true,
            },
            'x-required-for': 'The agent in Telegram',
        },
        'discord.bot_token': {
            type: 'string', minLength: 20, maxLength: 200, title: 'Discord bot token', 'x-group': 'Discord',
            description: 'The token of your Discord application\'s bot. With the public key and application ID it lets the agent answer in Discord servers and direct messages; Chat connects with it when it starts.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets the OpenVibe agent answer in Discord (from Chat\'s next start). Without it the Discord option stays hidden.',
                get_it_at: 'https://discord.com/developers/applications',
                get_it_how: 'Create an application, open Bot, Reset Token and copy it; turn on the Message Content intent on the same page.',
                test: true,
            },
            'x-required-for': 'The agent in Discord',
        },
        'discord.public_key': {
            type: 'string', pattern: '^[0-9a-fA-F]{64}$', title: 'Discord public key', 'x-group': 'Discord', 'x-example': 'a1b2c3…',
            description: 'The public key Discord signs its button and command deliveries with (64 hexadecimal characters). Chat checks every delivery with it, so a delivery that is not Discord\'s is refused.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets Chat check that Discord commands and buttons really come from Discord. The Discord app stays off without it.',
                get_it_at: 'https://discord.com/developers/applications',
                get_it_how: 'Open the application, General Information, and copy the Public Key.',
                test: false,
            },
            'x-required-for': 'The agent in Discord',
        },
        'discord.application_id': {
            type: 'string', pattern: '^[0-9]{5,30}$', title: 'Discord application ID', 'x-group': 'Discord', 'x-example': '1234567890123456789',
            description: 'The number that names your Discord application. Chat registers the agent\'s commands (/link, /help, /settings) under it and the Discord app stays off without it.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets Chat register the agent\'s Discord commands. The Discord app stays off without it.',
                get_it_at: 'https://discord.com/developers/applications',
                get_it_how: 'Open the application, General Information, and copy the Application ID.',
                test: false,
            },
            'x-required-for': 'The agent in Discord',
        },
        'slack.bot_token': {
            type: 'string', minLength: 20, maxLength: 300, title: 'Slack bot token', 'x-group': 'Slack', 'x-example': 'xoxb-…',
            description: 'The bot token (xoxb-…) of your Slack app, installed in your workspace. With the signing secret and team ID it lets the agent answer in Slack; without it the Slack option stays hidden.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets the OpenVibe agent answer in Slack. Without it the Slack option stays hidden.',
                get_it_at: 'https://api.slack.com/apps',
                get_it_how: 'Create an app, add the chat:write, app_mentions:read and im:history bot scopes, install it to the workspace, and copy the Bot User OAuth Token.',
                test: true,
            },
            'x-required-for': 'The agent in Slack',
        },
        'slack.signing_secret': {
            type: 'string', minLength: 16, maxLength: 200, title: 'Slack signing secret', 'x-group': 'Slack',
            description: 'The secret Slack signs every delivery with. Chat refuses a delivery whose signature does not match, so only your Slack app can reach the agent. Never shown again after saving.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets Chat check that Slack messages really come from your Slack app. The Slack app stays off without it.',
                get_it_at: 'https://api.slack.com/apps',
                get_it_how: 'Open the app, Basic Information, App Credentials, and copy the Signing Secret.',
                test: false,
            },
            'x-required-for': 'The agent in Slack',
        },
        'slack.team_id': {
            type: 'string', pattern: '^T[A-Z0-9]{6,20}$', title: 'Slack workspace ID', 'x-group': 'Slack', 'x-example': 'T01ABCDEF',
            description: 'The ID of the Slack workspace the app is installed in (it starts with T). Chat answers only deliveries from this workspace. The Test button on the bot token shows it.',
            'x-owner-input': {
                group: 'chat-apps',
                unlocks: 'Lets Chat answer deliveries from your Slack workspace and no other. The Slack app stays off without it.',
                get_it_at: 'https://api.slack.com/apps',
                get_it_how: 'Test the bot token here and copy the workspace ID it names, or read it from your workspace\'s URL in a browser.',
                test: false,
            },
            'x-required-for': 'The agent in Slack',
        },
        'telegram.secret_token': {
            type: 'string', minLength: 16, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$', title: 'Telegram webhook check', 'x-group': 'Telegram', 'x-advanced': true,
            description: 'A random secret Chat gives Telegram when it sets the webhook, and checks on every delivery. Chat makes it itself the first time; nobody needs to type it.',
        },
        callback_secret: {
            type: 'string', minLength: 32, maxLength: 256, title: 'Button signing secret', 'x-group': 'All chat apps', 'x-advanced': true,
            description: 'A random secret Chat signs the agent\'s Approve and Decline buttons with, so a button cannot be forged. Chat makes it itself the first time; nobody needs to type it.',
        },
    },
});

async function call(fetchImpl, url, init) {
    let res;
    try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        return { status: 0, json: null, error: err && err.name === 'TimeoutError' ? 'did not answer within 10 seconds' : 'could not be reached' };
    }
    return { status: res.status, json: await res.json().catch(() => null), error: null };
}

const TESTS = {
    'telegram.bot_token': async (token, fetchImpl) => {
        const r = await call(fetchImpl, `https://api.telegram.org/bot${token}/getMe`, { method: 'GET' });
        if (r.error) return { ok: false, message: `Telegram ${r.error}.` };
        if (r.json && r.json.ok && r.json.result) return { ok: true, message: `Telegram accepted the token: the bot is @${r.json.result.username}.` };
        return { ok: false, message: `Telegram refused the token (${r.status})${r.json && r.json.description ? `: ${r.json.description}` : '.'}` };
    },
    'discord.bot_token': async (token, fetchImpl) => {
        const r = await call(fetchImpl, 'https://discord.com/api/v10/users/@me', { method: 'GET', headers: { Authorization: `Bot ${token}` } });
        if (r.error) return { ok: false, message: `Discord ${r.error}.` };
        if (r.status === 200 && r.json && r.json.id) return { ok: true, message: `Discord accepted the token: the bot is ${r.json.username || r.json.id}.` };
        return { ok: false, message: `Discord refused the token (${r.status})${r.json && r.json.message ? `: ${r.json.message}` : '.'}` };
    },
    'slack.bot_token': async (token, fetchImpl) => {
        const r = await call(fetchImpl, 'https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
        if (r.error) return { ok: false, message: `Slack ${r.error}.` };
        if (r.json && r.json.ok) return { ok: true, message: `Slack accepted the token: the bot is ${r.json.user || r.json.user_id} in the workspace ${r.json.team || ''} (${r.json.team_id}).` };
        return { ok: false, message: `Slack refused the token${r.json && r.json.error ? `: ${r.json.error}` : ` (${r.status})`}.` };
    },
};

/** One line, at most 200 characters, with the secret (and its first 12 characters) replaced. */
function oneLine(text, secret) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (typeof secret === 'string' && secret.length >= 4) {
        s = s.split(secret).join('[hidden]');
        if (secret.length >= 12) s = s.split(secret.slice(0, 12)).join('[hidden]');
    }
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/** Create the chat.apps store; make Chat's own two secrets once when nothing provides them. */
async function createChatAppSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch }) {
    const store = await createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, env,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'), log,
        onChange: ({ namespace, keys, actor, revision }) => {
            (log.info || log.log).call(log, `[config] ${namespace} revision ${revision} by ${actor && actor.id ? `${actor.type}:${actor.id}` : 'unknown'}: ${keys.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    for (const key of ['callback_secret', 'telegram.secret_token']) {
        if (String(env[FIELDS[key].env] || '').trim() || store.get(key)) continue;
        await store.setSecret(key, crypto.randomBytes(32).toString('hex'), { actor: { type: 'service', id: SERVICE }, reason: 'made by Chat: nobody needs to type it' })
            .catch((err) => log.warn(`[config] ${NAMESPACE}: ${key} could not be made: ${(err && err.message) || err}`));
    }

    /** A key at use time: { value, source: vault | env | null, env }. The panel's value wins. */
    function value(key) {
        const f = FIELDS[key];
        const own = store.get(key);
        if (typeof own === 'string' && own) return { value: own, source: 'vault', env: f ? f.env : null };
        const fallback = f ? String(env[f.env] || '').trim() : '';
        return { value: fallback, source: fallback ? 'env' : null, env: f ? f.env : null };
    }

    /** config.chatApps' fields read the panel first, then the environment, every time they are read. */
    function install(config) {
        const apps = config.chatApps;
        for (const [key, f] of Object.entries(FIELDS)) {
            const target = f.app ? apps[f.app] : apps;
            Object.defineProperty(target, f.field, { enumerable: true, configurable: true, get: () => value(key).value });
        }
        return config;
    }

    /** The Setup tab's Test: { value, source, env, run } for a key with a test, else null. */
    function test(key) {
        const t = TESTS[key];
        if (!t) return null;
        return { ...value(key), run: (v) => t(v, fetchImpl) };
    }

    return { store, namespace: NAMESPACE, value, install, test };
}

/**
 * POST /internal/config/chat.apps/test/:key behind `guard`: 200 { ok, message, state, source } (openvibe-shared
 * 4.125.0's { ok, message } with more beside it), 409 config.not_set, 404 for a key without a test.
 */
function testRoute(chatApps, { log = console } = {}) {
    return async function chatAppsTest(req, res) {
        let key = String(req.params.key || '');
        try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
        const found = chatApps.test(key);
        if (!found) return res.status(404).json({ type: 'about:blank', status: 404, code: 'config.test_not_found', detail: `${NAMESPACE} has no test for ${key}` });
        if (!found.value) return res.status(409).json({ type: 'about:blank', status: 409, code: 'config.not_set', detail: `${key} is not set, so there is nothing to test` });
        let out;
        try { out = await found.run(found.value); } catch (err) { out = { ok: false, message: `The test could not run: ${(err && err.message) || 'unknown error'}` }; }
        const ok = Boolean(out && out.ok);
        const from = found.source === 'env' && found.env ? ` (the value from the server's settings file, ${found.env})` : '';
        const message = oneLine(`${(out && out.message) || (ok ? 'It works.' : 'It did not work.')}${from}`, found.value);
        (log.info || log.log).call(log, `[config] test ${NAMESPACE} ${key}: ${ok ? 'connected' : 'not working'}`);
        return res.json({ ok, message, state: ok ? 'connected' : 'not_working', source: found.source || null, namespace: NAMESPACE, key, tested_at: new Date().toISOString() });
    };
}

module.exports = { NAMESPACE, SCHEMA, FIELDS, createChatAppSettings, testRoute, oneLine };
