'use strict';
/**
 * Telling an inbox's people (server/inbox/inbox.js) that a visitor needs one of them, when none of them follows the
 * inbox live (chat-server's inbox_watch): a conversation that starts waiting (the visitor asked for a person, Vibe
 * handed off, or Vibe is off), and a visitor writing while it waits or is open. One OpenVibe notification each through
 * the Network (Chat's service token, network.notifications.push as service 'chat'; a person can switch Chat
 * notifications off there), to whoever took the conversation, else everyone in the inbox. A visitor writing five lines
 * is one notification: at most one per conversation every 10 minutes, except that starting to wait always tells.
 * CHAT_INBOX_NOTIFY=0 turns it off.
 */
const db = require('../db/database');
const config = require('../config');

const QUIET_MS = 10 * 60 * 1000;
const lastSent = new Map();   // conversation id → when its people were last told
let _push = null;
let _testPush = null;

function push(notification) {
    if (!_push) {
        const { createClient } = require('openvibe-sdk');
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        const { createNotificationsClient } = require('openvibe-sdk/notifications');
        const tokens = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.network',
            scope: 'network.notifications.push identity.subject.resolve',
        });
        const client = createNotificationsClient(createClient({ tokenProvider: tokens, timeoutMs: 8000 }), { baseUrl: config.networkInternalUrl });
        _push = (n) => client.push(n);
    }
    return _push(notification);
}

const watchedLive = (inboxId) => { try { return require('../chat/chat-server').inboxWatchers(inboxId) > 0; } catch { return false; } };

/** reason: 'waiting' (it starts waiting for a person) | 'message' (the visitor wrote while it waits or is open). → people told */
async function people(conv, reason) {
    if (!config.inbox.notify || (!config.oauth.clientSecret && !_testPush)) return 0;
    const now = Date.now();
    if (reason !== 'waiting' && now - (lastSent.get(conv.id) || 0) < QUIET_MS) return 0;
    if (watchedLive(conv.inbox_id)) return 0;
    const inbox = await db.get('SELECT id, name FROM inboxes WHERE id = ? AND archived_at IS NULL', [conv.inbox_id]);
    if (!inbox) return 0;
    lastSent.set(conv.id, now);
    if (lastSent.size > 5000) lastSent.delete(lastSent.keys().next().value);
    const fresh = await db.get('SELECT assignee_id, visitor_name FROM inbox_conversations WHERE id = ?', [conv.id]);
    const ids = fresh && fresh.assignee_id ? [Number(fresh.assignee_id)]
        : (await db.all('SELECT user_id FROM inbox_members WHERE inbox_id = ? ORDER BY role DESC, added_at LIMIT 50', [inbox.id])).map((r) => Number(r.user_id));
    const last = await db.get("SELECT body FROM inbox_messages WHERE conversation_id = ? AND author = 'visitor' ORDER BY id DESC LIMIT 1", [conv.id]);
    const who = (fresh && fresh.visitor_name) || 'A visitor';
    const { plainText } = require('./inbox');
    const base = {
        type: 'SUPPORT_REQUEST', category: 'chat', service: 'chat', icon: '🛟', sender_name: who,
        priority: reason === 'waiting' ? 'high' : 'normal',
        title: reason === 'waiting' ? `${who} is waiting for a person · ${inbox.name}` : `${who} wrote · ${inbox.name}`,
        message: plainText(last && last.body).slice(0, 160) || 'Open the conversation to answer.',
        url: `${config.web.baseUrl}/inbox/${inbox.id}?c=${conv.id}`,
    };
    const ctx = require('../live-context');
    let told = 0;
    for (const id of ids) {
        try {
            const subjectId = await ctx.subjectFor(id);
            if (!subjectId) continue;
            const r = await (_testPush || push)({ subjectId, ...base });
            if (r && r.sent) told++;
        } catch (err) { console.warn(`[Inbox] notify ${inbox.id}: ${err && err.message}`); }
    }
    return told;
}

/** Fire and forget: a notification never holds up the visitor or Vibe. */
function later(conv, reason) { people(conv, reason).catch((err) => console.warn(`[Inbox] notify: ${err && err.message}`)); }

/** Tests: capture pushes instead of calling the Network (null restores it). */
function _setPush(fn) { _testPush = fn; lastSent.clear(); }

module.exports = { people, later, QUIET_MS, _setPush };
