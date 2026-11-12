'use strict';
/**
 * The chat apps' bot accounts as owner settings (chat.apps, the owner-setup design of 2026-11-07), listed by the
 * admin panel's Setup tab under Chat apps.
 *
 * Proves: every field has a title and a 30+ character description, and the outside credentials carry x-owner-input
 * (chat-apps) with x-required-for; Chat makes its own two secrets once, so nobody types them; config.chatApps reads
 * the panel's value first and the environment second, every time, so an app turns on as soon as its details are
 * entered; Telegram getMe, Discord users/@me and Slack auth.test answer in one line and never carry the token (not
 * even Telegram's, which is in the URL); no log or console line carries a token.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, suite } = require('./helpers');

const t = suite('chat-apps-settings');
const CAP = 'chat.config.manage';
const NS = 'chat.apps';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
// Made-up tokens, built at run time so a secret scanner never reads a provider-shaped string in the source.
const ENV_TG = ['555000111', 'madeUpTelegramTokenFROMTHESETTINGSFILE00'].join(':');
const PANEL_TG = ['555000222', 'madeUpTelegramTokenENTEREDINSETUP0000000'].join(':');
const BAD_TG = ['555000333', 'madeUpTelegramTokenTHATTELEGRAMREFUSES00'].join(':');
const DISCORD = ['madeUpDiscordBotToken', 'NEVERSHOWN', 'ANYWHERE00000'].join('.');
const SLACK = ['xoxb', '000000', 'madeUpSlackTokenNEVERSHOWN000'].join('-');
const SIGNING = crypto.randomBytes(16).toString('hex');
const SECRETS = [ENV_TG, PANEL_TG, BAD_TG, DISCORD, SLACK, SIGNING];

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!/^https:\/\/(api\.telegram\.org|discord\.com|slack\.com)\//.test(u)) return realFetch(url, init);
    const auth = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    calls.push({ url: u, auth });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('https://api.telegram.org/bot')) {
        const token = decodeURIComponent(u.slice('https://api.telegram.org/bot'.length).split('/')[0]);
        if (token === ENV_TG || token === PANEL_TG) return json(200, { ok: true, result: { id: 1, is_bot: true, username: token === ENV_TG ? 'ov_env_bot' : 'ov_panel_bot' } });
        return json(401, { ok: false, error_code: 401, description: `Unauthorized: the token ${token} is not valid` });
    }
    if (u === 'https://discord.com/api/v10/users/@me') return auth === `Bot ${DISCORD}` ? json(200, { id: '42', username: 'OpenVibe agent' }) : json(401, { message: '401: Unauthorized' });
    if (u === 'https://slack.com/api/auth.test') return auth === `Bearer ${SLACK}` ? json(200, { ok: true, user: 'openvibe', user_id: 'U1', team: 'OpenVibe', team_id: 'T0123ABCD' }) : json(200, { ok: false, error: 'invalid_auth' });
    return json(404, {});
};

let h;
const consoleLines = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
const cfg = (method, p, body) => h.http(method, p, { token: h.serviceToken([CAP]), headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' }, ...(body ? { body } : {}) });
const test = (key) => cfg('POST', `/internal/config/${NS}/test/${key}`);
const config = () => require('../server/config');

t('boot with a Telegram token in the environment', async () => {
    for (const k of Object.keys(original)) console[k] = (...a) => { consoleLines.push(a.join(' ')); original[k](...a); };
    h = await boot({ env: { CHAT_TELEGRAM_BOT_TOKEN: ENV_TG, CHAT_APPS_CALLBACK_SECRET: '' , CHAT_TELEGRAM_SECRET_TOKEN: '' } });
});

t('every field reads clearly; the bot details are owner inputs in Chat apps', async () => {
    const r = await cfg('GET', `/internal/config/${NS}`);
    assert.strictEqual(r.status, 200, r.text);
    const props = r.body.schema.properties;
    assert.ok(r.body.schema.description.length >= 30);
    for (const [key, p] of Object.entries(props)) {
        assert.ok(p.title && p.title.length >= 3, `${key}: a title`);
        assert.ok(p.description && p.description.length >= 30, `${key}: a 30+ character description`);
    }
    const inputs = Object.keys(props).filter((k) => props[k]['x-owner-input']).sort();
    assert.deepStrictEqual(inputs, ['discord.application_id', 'discord.bot_token', 'discord.public_key', 'slack.bot_token', 'slack.signing_secret', 'slack.team_id', 'telegram.bot_token']);
    for (const k of inputs) {
        const oi = props[k]['x-owner-input'];
        assert.strictEqual(oi.group, 'chat-apps', k);
        assert.match(oi.get_it_at, /^https:\/\//, k);
        assert.ok(oi.unlocks.length > 20 && oi.get_it_how.length > 10, k);
        assert.match(props[k]['x-required-for'], /^The agent in (Telegram|Discord|Slack)$/, k);
    }
    assert.deepStrictEqual(['telegram.bot_token', 'discord.bot_token', 'slack.bot_token'].map((k) => props[k]['x-owner-input'].test), [true, true, true]);
    assert.strictEqual(props['telegram.bot_token']['x-owner-input'].get_it_at, 'https://t.me/BotFather');
    assert.strictEqual(props.callback_secret['x-advanced'], true, 'Chat\'s own secret is advanced, not an owner input');
});

t('Chat makes its own two secrets once; the environment\'s Telegram token is read until the panel has one', async () => {
    const summary = await cfg('GET', `/internal/config/${NS}`);
    assert.ok(summary.body.values.callback_secret && summary.body.values.callback_secret.redacted, 'the button secret was made and sealed');
    assert.ok(summary.body.values['telegram.secret_token'].redacted, 'the webhook check was made');
    assert.strictEqual(config().chatApps.callbackSecret.length, 64);
    assert.strictEqual(config().chatApps.telegram.botToken, ENV_TG);
    const r = await test('telegram.bot_token');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.ok, r.body.state, r.body.source], [true, 'connected', 'env']);
    assert.strictEqual(r.body.message, "Telegram accepted the token: the bot is @ov_env_bot. (the value from the server's settings file, CHAT_TELEGRAM_BOT_TOKEN)");
});

t('a panel token is sealed, write-only and read at use time: Telegram turns on with it', async () => {
    const put = await cfg('PUT', `/internal/config/${NS}/secrets/telegram.bot_token`, { value: PANEL_TG, reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    assert.ok(!put.text.includes(PANEL_TG));
    assert.strictEqual(config().chatApps.telegram.botToken, PANEL_TG, 'the panel value wins, without a restart');
    const { createProviders } = require('../server/chat-apps/providers');
    const { providers } = createProviders({ config: config() });
    assert.strictEqual(providers.telegram.on, true, 'the token and Chat\'s own secrets turn Telegram on');
    await providers.telegram.whoami();
    assert.ok(calls.some((c) => c.url.startsWith(`https://api.telegram.org/bot${PANEL_TG}/getMe`)), 'the provider called Telegram with the panel token');
    const r = await test('telegram.bot_token');
    assert.deepStrictEqual([r.body.ok, r.body.source, r.body.message], [true, 'vault', 'Telegram accepted the token: the bot is @ov_panel_bot.']);
    const carried = await cfg('POST', `/internal/config/${NS}`, { values: { 'telegram.bot_token': PANEL_TG }, reason: 'not here' });
    assert.deepStrictEqual([carried.status, carried.body.code], [422, 'config.secret_write_only']);
});

t('a refused Telegram token is Not working in one line; the token in Telegram\'s URL and answer never comes back', async () => {
    await cfg('PUT', `/internal/config/${NS}/secrets/telegram.bot_token`, { value: BAD_TG, reason: 'wrong' });
    const r = await test('telegram.bot_token');
    assert.deepStrictEqual([r.status, r.body.ok, r.body.state], [200, false, 'not_working']);
    assert.match(r.body.message, /^Telegram refused the token \(401\): Unauthorized: the token \[hidden\] is not valid$/);
    assert.ok(!r.text.includes(BAD_TG) && !r.text.includes(BAD_TG.slice(0, 12)));
});

t('Discord and Slack: the tokens are tested with users/@me and auth.test, and their apps turn on when complete', async () => {
    const none = await test('discord.bot_token');
    assert.deepStrictEqual([none.status, none.body.code], [409, 'config.not_set']);
    assert.strictEqual((await cfg('PUT', `/internal/config/${NS}/secrets/discord.bot_token`, { value: DISCORD, reason: 'setup' })).status, 200);
    const d = await test('discord.bot_token');
    assert.deepStrictEqual([d.body.ok, d.body.message], [true, 'Discord accepted the token: the bot is OpenVibe agent.']);
    assert.strictEqual((await cfg('PUT', `/internal/config/${NS}/secrets/slack.bot_token`, { value: SLACK, reason: 'setup' })).status, 200);
    const s = await test('slack.bot_token');
    assert.deepStrictEqual([s.body.ok, s.body.message], [true, 'Slack accepted the token: the bot is openvibe in the workspace OpenVibe (T0123ABCD).']);
    const { createProviders } = require('../server/chat-apps/providers');
    assert.strictEqual(createProviders({ config: config() }).providers.slack.on, false, 'Slack waits for its signing secret and workspace ID');
    assert.strictEqual((await cfg('PUT', `/internal/config/${NS}/secrets/slack.signing_secret`, { value: SIGNING, reason: 'setup' })).status, 200);
    const team = await cfg('POST', `/internal/config/${NS}`, { values: { 'slack.team_id': 'T0123ABCD', 'discord.public_key': 'a'.repeat(64), 'discord.application_id': '9'.repeat(18) }, merge: true, reason: 'setup' });
    assert.strictEqual(team.status, 200, team.text);
    const p = createProviders({ config: config() }).providers;
    assert.deepStrictEqual([p.slack.on, p.discord.on], [true, true]);
    const noTest = await test('slack.signing_secret');
    assert.deepStrictEqual([noTest.status, noTest.body.code], [404, 'config.test_not_found']);
});

t('removing the panel token falls back to the environment; the hook is guarded', async () => {
    const del = await cfg('DELETE', `/internal/config/${NS}/secrets/telegram.bot_token`, { reason: 'back to env' });
    assert.strictEqual(del.status, 200, del.text);
    assert.strictEqual(config().chatApps.telegram.botToken, ENV_TG);
    const denied = await h.http('POST', `/internal/config/${NS}/test/telegram.bot_token`, { token: h.serviceToken(['chat.stats.read']) });
    assert.strictEqual(denied.status, 403);
    const voices = await cfg('GET', '/internal/config');
    assert.deepStrictEqual(voices.body.namespaces.map((n) => n.namespace), ['chat.voices', 'chat.apps', 'chat.persona'], 'every namespace on one route (2026-11-12: chat.persona)');
});

t('no log or console line carries a token', async () => {
    for (const k of Object.keys(original)) console[k] = original[k];
    for (const s of SECRETS) assert.ok(consoleLines.every((l) => !l.includes(s) && !l.includes(s.slice(0, 12))), `a line carries ${s.slice(0, 8)}…`);
    assert.ok(consoleLines.some((l) => /\[config\] test chat\.apps telegram\.bot_token: not working/.test(l)), 'the outcome is logged without the token');
});

t.run(async () => { if (h) await h.close(); });
