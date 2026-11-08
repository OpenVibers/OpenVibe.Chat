'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { splitText, signButton, verifyButton } = require('openvibe-sdk/chat-apps');
const { createResolver, linkCommand, unlinkCommand } = require('./links');
const { lineOk } = require('../chat/global-standard');
const identity = m => m.app === 'slack' ? `${m.teamId}:${m.userId}` : m.userId;
const group = m => `${m.teamId || m.guildId || ''}:${m.chatId}`;
const conversation = m => `${m.app}:${group(m)}`;
function createHandler({ config, store, providers, network, actor, now = () => Date.now(), sleep = delay }) {
    const resolve = createResolver({ network });
    const send = async (m, text) => {
        const safe = lineOk(text) ? text : 'I cannot share that answer under the chat rules.';
        for (const part of splitText(m.app, safe)) await providers[m.app].sendText({ chatId: m.chatId, text: part, threadTs: m.threadTs });
    };
    async function handle(m, deliveryId, signal) {
        if (!m || !m.userId || !m.chatId || !providers[m.app]?.on) return;
        const p = providers[m.app];
        const privateChat = m.chatType === 'private';
        const settings = await store.settings(m.app, group(m));
        if (!privateChat && m.kind !== 'button' && !m.mention && !m.replyToBot) return;
        if (!privateChat && settings.mode === 'off' && m.command !== 'settings') return;
        const ident = identity(m);
        // Rate-limit link/help as well, including an unlinked sender. Callbacks have their own bounded budget.
        if (!await store.rate(`${m.app}:user:${ident}:${m.kind === 'button' ? 'buttons' : 'messages'}`, m.kind === 'button' ? 60 : config.chatApps.perUserRatePerHour)) return;
        if (m.command === 'help') return send(m, 'Send /link in a direct message to connect your OpenVibe agent. /unlink disconnects it. In a group, mention or reply to me. Admins: /settings off|answer_only|act_with_approvals [answers per hour].');
        if (m.command === 'link') {
            if (!privateChat) return send(m, 'Send /link to me in a direct message.');
            return linkCommand({ message: { ...m, userId: ident }, provider: p, store, network, config });
        }
        const subject = await resolve({ app: m.app, serviceUserId: ident });
        if (!subject) {
            // The confirm page sends the person back here with a 6-digit code. Only the chat
            // account that started /link can finish it (Network checks the identity), and only in
            // a direct message: a code in a group would be read by everyone there.
            const code = privateChat ? (/^\d{6}$/.test(String(m.command ? m.args : m.text || '').trim()) ? String(m.command ? m.args : m.text).trim() : null) : null;
            if (code) {
                const out = await network.finish({ app: m.app, serviceUserId: ident, code }).catch(() => null);
                if (out?.ok) {
                    const linkedSubject = out.subject || await resolve({ app: m.app, serviceUserId: ident });
                    const binding = linkedSubject ? await actor.registerAccount({ subject: linkedSubject,
                        account: { kind: m.app, id: ident, label: m.userName || `${m.app} account` } }).catch(() => null) : null;
                    if (binding && !binding.bound) return send(m, 'You are linked. Bind this account to an agent on openvibe.actor before asking here.');
                    return send(m, 'You are linked. Ask me anything — I am your OpenVibe agent here.');
                }
                if (out?.error === 'code') return send(m, out.attemptsLeft ? `That code is not right. ${out.attemptsLeft} ${out.attemptsLeft === 1 ? 'try' : 'tries'} left; after that, send /link again.` : 'That code is not right. Send /link to start again.');
                if (out?.error === 'expired') return send(m, 'That code expired. Send /link to start again.');
                if (out?.error === 'conflict') return send(m, 'This chat account is already linked to another OpenVibe account, or that account already has a chat account of this service.');
            }
            return send(m, 'Link your account first: send /link in a direct message.');
        }
        if (m.command === 'unlink') {
            const out = await unlinkCommand({ message: { ...m, userId: ident }, subject, provider: p, network, forget: resolve.forget });
            if (out.ok) await actor.unregisterAccount({ subject, account: { kind: m.app, id: ident } }).catch(() => null);
            return out;
        }
        if (m.command === 'settings') {
            if (privateChat || !await p.isAdmin({ message: m })) return send(m, 'Only a group or workspace administrator can change these settings.');
            const args = m.args.replace(/mode=|rate=/g, '').trim().split(/\s+/);
            if (!['off', 'answer_only', 'act_with_approvals'].includes(args[0]) || (args[1] && !/^\d{1,3}$/.test(args[1]))) return send(m, 'Use /settings off|answer_only|act_with_approvals [1–500 answers per hour].');
            const out = await store.saveSettings(m.app, group(m), { mode: args[0], rate_per_hour: Number(args[1] || settings.rate_per_hour) });
            return send(m, `Group setting: ${out.mode}, up to ${out.rate_per_hour} answers per hour.`);
        }
        if (m.kind === 'button') {
            // Telegram keeps a spinner on the button until its callback is answered.
            if (m.app === 'telegram' && m.callbackQueryId) await p.answerButton({ buttonId: m.callbackQueryId }).catch(() => {});
            if (!privateChat && settings.mode !== 'act_with_approvals') return send(m, 'Acting is disabled in this group.');
            const id = verifyButton({ secret: config.chatApps.callbackSecret, token: m.button?.id });
            const taken = id && await store.takeCallback(id, { app: m.app, chatId: group(m), userId: ident, subject });
            if (!taken?.ok) return send(m, 'This button is unavailable, expired, or belongs to someone else.');
            await actor.decide({ subject, approvalId: taken.row.approval_id, decision: taken.row.action });
            return send(m, taken.row.action === 'approve' ? 'Approved.' : 'Declined.');
        }
        if (m.command && m.command !== 'ask') return send(m, 'Use /help to see the commands.');
        if (!privateChat && !await store.rate(`${m.app}:group:${group(m)}`, settings.rate_per_hour)) return;
        const text = (m.command === 'ask' ? m.args.replace(/^text=/, '') : m.text).trim();
        if (!text) return;
        let started;
        try {
            started = await actor.start({ subject, text, policy: privateChat ? 'dm' : settings.mode, conversation: conversation(m), deliveryId,
                account: { kind: m.app, id: ident, label: m.userName || `${m.app} account` } });
        } catch (err) {
            if (err && err.status === 409) return send(m, 'No agent is listening on this account. Bind it on your agent page at openvibe.actor.');
            throw err;
        }
        const shown = new Set();
        const until = now() + 11 * 60_000;
        while (now() < until) {
            signal?.throwIfAborted();
            // Revocation or a change of the group policy stops delivery of private results/approval cards.
            if (await resolve({ app: m.app, serviceUserId: ident }) !== subject) return;
            if (!privateChat && (await store.settings(m.app, group(m))).mode !== settings.mode) return;
            const task = await actor.task(subject, started.id);
            for (const a of await actor.approvals(subject, conversation(m))) {
                if (shown.has(a.id)) continue;
                const buttons = [];
                for (const action of ['approve', 'decline']) {
                    const id = await store.openCallback({ app: m.app, chatId: group(m), userId: ident, subject, action, approvalId: a.id,
                        expiresAt: Math.min(Date.parse(a.expires_at), now() + config.chatApps.callbackTtlMs) });
                    buttons.push({ label: action === 'approve' ? 'Approve' : 'Decline', id: signButton({ secret: config.chatApps.callbackSecret, id }) });
                }
                const summary = lineOk(a.summary) ? a.summary : 'Review this request on OpenVibe.Actor.';
                await p.sendButtons({ chatId: m.chatId, threadTs: m.threadTs, text: `Needs you: ${summary}`.slice(0, 1800), buttons });
                shown.add(a.id);
            }
            if (['succeeded', 'failed', 'cancelled'].includes(task.state)) {
                if (task.state !== 'succeeded') return send(m, 'Your agent could not finish this request. Check your task on openvibe.actor.');
                const result = task.result || {};
                const files = (result.artifacts || []).filter(a => /^https:\/\//.test(a.url || '')).map(a => `${a.name || 'File'}: ${a.url}`);
                return send(m, [result.answer || result.text || 'Done.', ...files].join('\n\n'));
            }
            await sleep(1500, undefined, { signal });
        }
        await send(m, 'Your agent is still working. You can follow the task on openvibe.actor.');
    }
    return { handle, send };
}
module.exports = { createHandler, identity, group, conversation };
