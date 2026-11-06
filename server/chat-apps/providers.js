'use strict';
// Secrets are used only for fixed provider origins and are never included in errors or logs.
function createProviders({ config, fetchImpl = globalThis.fetch }) {
    const cfg = config.chatApps;
    const known = {};
    const api = async (app, method, body, verb = 'POST') => {
        const c = cfg[app];
        const origin = app === 'telegram' ? `https://api.telegram.org/bot${c.botToken}/` : app === 'discord' ? 'https://discord.com/api/v10/' : 'https://slack.com/api/';
        const headers = { 'Content-Type': 'application/json', ...(app === 'telegram' ? {} : { Authorization: `${app === 'discord' ? 'Bot' : 'Bearer'} ${c.botToken}` }) };
        let r;
        try { r = await fetchImpl(origin + method, { method: verb, headers, ...(verb === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) }); }
        catch { throw new Error(`${app} unavailable`); }
        const out = await r.json().catch(() => null);
        if (!r.ok || !out || out.ok === false) throw new Error(`${app} request refused`);
        return app === 'telegram' ? out.result : out;
    };
    const providers = {};
    for (const app of ['telegram', 'discord', 'slack']) {
        const c = cfg[app];
        providers[app] = {
            app,
            get on() { return Boolean(cfg.callbackSecret && c.botToken && (app === 'telegram' ? c.secretToken : app === 'discord' ? c.publicKey && c.applicationId : c.signingSecret && c.teamId)); },
            get botUserId() { return known[app]?.id || known[app]?.user_id || null; },
            get botUsername() { return c.username || known[app]?.username || null; },
            async whoami() {
                if (!this.on) return;
                known[app] = await api(app, app === 'telegram' ? 'getMe' : app === 'discord' ? 'users/@me' : 'auth.test', {}, app === 'discord' ? 'GET' : 'POST');
            },
            async sendText({ chatId, text, threadTs }) {
                if (!this.on) throw new Error('App is off');
                if (app === 'telegram') return api(app, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
                if (app === 'discord') return api(app, `channels/${encodeURIComponent(chatId)}/messages`, { content: text, allowed_mentions: { parse: [] } });
                return api(app, 'chat.postMessage', { channel: chatId, text, mrkdwn: false, unfurl_links: false, unfurl_media: false, ...(threadTs ? { thread_ts: threadTs } : {}) });
            },
            async sendButtons({ chatId, text, buttons, threadTs }) {
                if (!this.on) throw new Error('App is off');
                if (buttons.some(b => Buffer.byteLength(b.id) > 64)) throw new Error('Button is too long');
                if (app === 'telegram') return api(app, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.label, callback_data: b.id }))] } });
                if (app === 'discord') return api(app, `channels/${encodeURIComponent(chatId)}/messages`, { content: text, allowed_mentions: { parse: [] }, components: [{ type: 1, components: buttons.map(b => ({ type: 2, style: 2, label: b.label, custom_id: b.id })) }] });
                return api(app, 'chat.postMessage', { channel: chatId, text, ...(threadTs ? { thread_ts: threadTs } : {}), blocks: [
                    { type: 'section', text: { type: 'plain_text', text } },
                    { type: 'actions', elements: buttons.map(b => ({ type: 'button', text: { type: 'plain_text', text: b.label }, action_id: b.id, value: b.id })) },
                ] });
            },
            async answerButton({ buttonId, text }) {
                if (app === 'telegram') await api(app, 'answerCallbackQuery', { callback_query_id: buttonId, text });
            },
            async isAdmin({ message }) {
                if (app === 'telegram') { const u = await api(app, 'getChatMember', { chat_id: message.chatId, user_id: message.userId }); return ['creator', 'administrator'].includes(u.status); }
                if (app === 'discord') {
                    if (message.gateway) return message.admin === true;
                    const permissions = String(message.raw?.member?.permissions || '');
                    return /^\d+$/.test(permissions) && (BigInt(permissions) & (8n | 32n)) !== 0n;
                }
                const u = (await api(app, `users.info?user=${encodeURIComponent(message.userId)}`, null, 'GET')).user;
                return Boolean(u && u.team_id === c.teamId && (u.is_admin || u.is_owner));
            },
        };
    }
    return { providers, async whoami() { await Promise.all(Object.values(providers).filter(p => p.on).map(p => p.whoami())); } };
}
module.exports = { createProviders };
