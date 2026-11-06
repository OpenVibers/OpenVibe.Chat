'use strict';
const express = require('express');
const crypto = require('crypto');
const sdk = require('openvibe-sdk/chat-apps');
function parse(app, body, provider, cfg) {
    let m;
    if (app === 'telegram') m = sdk.parseTelegramUpdate(body, { botUsername: provider.botUsername, botUserId: provider.botUserId });
    if (app === 'discord') {
        m = sdk.parseDiscordInteraction(body);
        if (m) { m.guildId = body.guild_id || ''; m.args = (body.data?.options || []).map(o => String(o.value)).join(' '); }
    }
    if (app === 'slack') {
        const teamId = typeof body.team === 'object' ? body.team.id : body.team_id;
        if (teamId !== cfg.slack.teamId) return null;
        if (body.type === 'block_actions') m = sdk.parseSlackInteraction(body);
        else if (body.command) m = { app, kind: 'command', chatId: body.channel_id, chatType: /^D/.test(body.channel_id || '') ? 'private' : 'group',
            userId: body.user_id, userName: body.user_name, command: body.command.replace(/^\//, ''), args: body.text || '', text: body.text || '', mention: true };
        else m = sdk.parseSlackEvent(body.event, { botUserId: provider.botUserId });
        if (m) m.teamId = teamId;
    }
    if (!m || ['unknown', 'ping'].includes(m.kind)) return null;
    // Never persist provider access/interaction tokens or arbitrary raw event content.
    const permissions = m.raw?.member?.permissions;
    m.raw = permissions ? { member: { permissions } } : {};
    if (app === 'telegram' && body.callback_query) m.callbackQueryId = body.callback_query.id;
    return m;
}
function router({ config, providers, store, wake, onError = () => {} }) {
    const r = express.Router();
    r.post('/:app', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
        const app = req.params.app;
        const c = config.chatApps[app];
        if (!providers[app]?.on) return res.status(503).json({ error: 'App is off' });
        const raw = req.body;
        if (!Buffer.isBuffer(raw) || !sdk.verifyDelivery({ provider: app, secret: c.secretToken || c.signingSecret, publicKey: c.publicKey, raw, headers: req.headers })) return res.sendStatus(401);
        let body;
        try {
            if (req.is('application/x-www-form-urlencoded')) {
                const form = Object.fromEntries(new URLSearchParams(raw.toString()));
                body = form.payload ? JSON.parse(form.payload) : form;
            } else body = JSON.parse(raw.toString());
        } catch { return res.sendStatus(400); }
        if (app === 'discord' && body.type === 1) return res.json({ type: 1 });
        if (app === 'slack' && body.type === 'url_verification') return res.json({ challenge: body.challenge });
        try {
            const m = parse(app, body, providers[app], config.chatApps);
            if (m) {
                const id = String(body.update_id ?? body.event_id ?? body.id ?? crypto.createHash('sha256').update(raw).digest('hex'));
                if (await store.enqueue(app, id, m)) wake();
            }
            // Final acknowledgement immediately; all work/replies use the bot API outside the HTTP request.
            if (app === 'discord') return res.json({ type: 4, data: { content: 'Received. I will reply in this chat.', flags: 64, allowed_mentions: { parse: [] } } });
            res.sendStatus(200);
        } catch { onError(); res.sendStatus(503); }
    });
    return r;
}
module.exports = { router, parse };
