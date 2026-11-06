'use strict';
// discord.js owns heartbeat, reconnect/resume and identify rate limits. HTTP interactions remain signed ingress.
const { parseDiscordMessage } = require('openvibe-sdk/chat-apps');
async function start({ config, provider, store, wake, log }) {
    const { Client, GatewayIntentBits, Partials, PermissionFlagsBits } = require('discord.js');
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
    client.on('error', () => log.warn('[chat-apps] Discord gateway unavailable'));
    client.on('messageCreate', async msg => {
        try {
            const m = parseDiscordMessage({ id: msg.id, channel_id: msg.channelId, guild_id: msg.guildId,
                author: { id: msg.author.id, username: msg.author.username, bot: msg.author.bot }, webhook_id: msg.webhookId,
                content: msg.content, mentions: [...msg.mentions.users.values()].map(u => ({ id: u.id })),
                attachments: [...msg.attachments.values()].map(f => ({ url: f.url, filename: f.name })) }, { botUserId: client.user.id });
            if (!m) return;
            if (msg.reference?.messageId) {
                const parent = await msg.fetchReference().catch(() => null);
                m.replyToBot = parent?.author?.id === client.user.id;
            }
            m.guildId = msg.guildId || ''; m.gateway = true; m.raw = {};
            m.admin = m.command === 'settings' && msg.guild ? Boolean((await msg.guild.members.fetch(msg.author.id)).permissions.has(PermissionFlagsBits.ManageGuild)) : false;
            if (await store.enqueue('discord', msg.id, m)) wake();
        } catch { log.warn('[chat-apps] Discord delivery refused'); }
    });
    try { await client.login(config.chatApps.discord.botToken); }
    catch { client.destroy(); throw new Error('Discord unavailable'); }
    return client;
}
module.exports = { start };
