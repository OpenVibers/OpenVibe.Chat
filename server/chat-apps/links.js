'use strict';
/**
 * Linking: /link and /unlink.
 *
 *   /link     The bot answers a one-time link to openvibe.network. The person opens it while signed
 *             in and confirms; the Network writes the account link (its linked_accounts, the link
 *             every service reads) and Chat hears that it was made. The token is good for ten
 *             minutes, is registered with the Network (so its page can show what is being linked)
 *             and is used once.
 *   /unlink   The account link is removed and the bot forgets the person in that app.
 *
 * Nothing else works for an account that is not linked: without a subject there is no person to
 * act as, so only /link and /help are answered.
 */

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Resolve afresh: unlink must revoke approval authority immediately. Fail closed on outage. */
function createResolver({ network }) {
    const resolver = async ({ app, serviceUserId }) => {
        const subject = await network.resolve({ app, serviceUserId });
        return SUBJECT_RE.test(String(subject || '')) ? subject : null;
    };
    resolver.forget = () => {};
    return resolver;
}

/**
 * The answer to /link: the one-time link the person opens. The link is registered with the Network
 * first, so the page there can show what is being linked (the app and the name) before it asks.
 */
async function linkCommand({ message, provider, store, network, config, log = console }) {
    const token = store.newToken();
    const expiresAt = Date.now() + config.chatApps.linkTtlMs;
    await store.saveToken({
        token, app: message.app, serviceUserId: message.userId,
        serviceUsername: message.userName, expiresAt,
    });
    try {
        const registered = await network.registerPending({
            token, app: message.app, serviceUserId: message.userId,
            serviceUsername: message.userName, expiresAt,
        });
        if (!registered) throw new Error('Link registration failed');
    } catch (err) {
        throw new Error('Link service unavailable');
    }
    const url = `${config.chatApps.linkUrl}?t=${encodeURIComponent(token)}`;
    await provider.sendText({
        chatId: message.chatId,
        text: `Link your ${message.app} account to OpenVibe: open this link while you are signed in to openvibe.network and confirm it.\n\n${url}\n\nThe link is good for ${Math.round(config.chatApps.linkTtlMs / 60000)} minutes and works once.`,
    });

    return { token, url };
}

/** The answer to /unlink: the account link is removed and the person is forgotten in that app. */
async function unlinkCommand({ message, subject, provider, network, forget, log = console }) {
    if (!subject) {
        await provider.sendText({ chatId: message.chatId, text: 'You are not linked here. Send /link to link your account.' });
        return { ok: false, reason: 'not_linked' };
    }
    let removed = false;
    try { removed = await network.unlink({ app: message.app, serviceUserId: message.userId, subject }); } catch (err) {
        log.warn(`[chat-apps] ${message.app}: the Network did not take the unlink: ${err && err.message}`);
    }
    if (removed && forget) forget({ app: message.app, serviceUserId: message.userId });
    await provider.sendText({
        chatId: message.chatId,
        text: removed ? 'You are not linked here any more. Send /link to link again.' : 'I could not remove the link just now. Try again in a while.',
    });
    return { ok: removed };
}

module.exports = { createResolver, linkCommand, unlinkCommand, SUBJECT_RE };
