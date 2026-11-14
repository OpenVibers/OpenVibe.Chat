'use strict';
/**
 * Chat's activity on the Network's notifications (server/chat/activity.js writes the rows; this tells the Network).
 *
 * One activity row is one OpenVibe notification: type chat.<kind> (chat.mention, chat.reply, chat.reaction, ...), a
 * plain title ("Ada replied to you in #general"), the place's https address on openvibe.chat, and the excerpt only
 * where the activity row itself shows one (a mention and a reply). The person's Chat switch governs it, exactly as it
 * governs a direct message: the notification is filed under the category 'chat', so the Network skips it for a person
 * who switched Chat notifications off.
 *
 * The dedupe key is the activity row's own id (chat.activity.<id>): the row is claimed in Chat's own table before the
 * push, so a retry of the push, the page reading the activity again, or two people calling at once never send it
 * twice. Reading the activity on Chat clears the notification on the Network, the way reading a direct message clears
 * its own (server/chat/dm-routes.js).
 *
 * Nothing here holds up the thing that caused it: a push never fails the message, the reaction or the role. The
 * Network is told in the background; a Network that is down costs the notification, never the activity.
 */
const db = require('../db/database');
const config = require('../config');

const MAX_MESSAGE = 160;
const MAX_TITLE = 160;
const ROLE_NAMES = { owner: 'owner', admin: 'admin', mod: 'moderator', speaker: 'speaker', participant: 'participant', member: 'member', viewer: 'viewer' };
const ICONS = { mention: '@', reply: '💬', reaction: '❤️', server_invite: '📨', friend_accept: '🤝', role: '🛡️' };
// The kinds whose activity row shows an excerpt on the page (server/web/activity.js): a mention and a reply.
const WITH_EXCERPT = new Set(['mention', 'reply']);

/** The role's name as the page says it ("moderator", not "mod"). */
const roleName = (role) => ROLE_NAMES[String(role || '')] || String(role || '');

/** The person's own name in a title: their display name, else their handle. */
const who = (row) => row.actor_display_name || row.actor_username || 'Someone';

/** Where it happened, in words: "in #general", "in your chat with Maya", "". */
function placePhrase(place) {
    if (!place) return '';
    if (place.kind === 'friends') return '';
    if (place.kind === 'dm') return place.label && place.label !== 'A direct message' ? `in your chat with ${place.label}` : 'in your chat';
    return `in ${place.label}`;
}

/** The one line a person reads in the menu: who did what, and where. */
function titleOf(row, place) {
    const name = who(row);
    const where = placePhrase(place);
    switch (row.kind) {
        case 'mention': return `${name} mentioned you ${where}`.trim();
        case 'reply': return `${name} replied to you ${where}`.trim();
        case 'reaction': return `${name} reacted to your message ${where}`.trim();
        case 'server_invite': return `${name} invited you to ${place && place.label ? place.label : 'a server'}`;
        case 'friend_accept': return `${name} accepted your friend request`;
        case 'role': return `${name} gave you the ${roleName(row.role)} role ${where}`.trim();
        default: return `${name} did something ${where}`.trim();
    }
}

/** The place's address on openvibe.chat: always this site, never another host. */
function urlOf(place) {
    const base = String(config.web.baseUrl || '').replace(/\/+$/, '');
    const href = place && place.href && String(place.href).startsWith('/') ? place.href : '/';
    return `${base}${href}`;
}

/** The row with the place's names, for one activity. */
async function rowOf(activityId) {
    const id = Number(activityId) || 0;
    if (!id) return null;
    return await db.get(`SELECT a.id, a.user_id, a.kind, a.actor_user_id, a.actor_username, a.actor_display_name,
            a.actor_avatar_url, a.room_id, a.server_id, a.conversation_id, a.scope, a.excerpt, a.reaction, a.role,
            a.invite_code, a.place_label, a.place_href,
            r.slug AS room_slug, r.name AS room_name, r.channel_slug,
            rs.slug AS room_server_slug, rs.name AS room_server_name,
            s.slug AS server_slug, s.name AS server_name,
            c.name AS conversation_name
        FROM chat_activity a
        LEFT JOIN rooms r ON r.id = a.room_id
        LEFT JOIN chat_servers rs ON rs.id = r.server_id
        LEFT JOIN chat_servers s ON s.id = a.server_id
        LEFT JOIN dm_conversations c ON c.id = a.conversation_id
        WHERE a.id = ?`, [id]);
}

/** The notification one activity row is, or null when the row is gone. → { type, title, message, url, ... } */
async function notificationOf(row) {
    if (!row) return null;
    const activity = require('./activity');          // the place's label and link, the one the feed shows
    const names = row.conversation_id ? await activity.dmLabels(row.user_id, [row.conversation_id]) : new Map();
    const place = activity.placeOf(row, names);
    const type = `chat.${row.kind}`;
    const excerpt = WITH_EXCERPT.has(row.kind) && row.excerpt ? String(row.excerpt).slice(0, MAX_MESSAGE) : null;
    return {
        type,
        category: 'chat',                 // the person's Chat switch governs it, as it governs a direct message
        service: 'chat',
        icon: ICONS[row.kind] || '💬',
        priority: 'normal',
        title: titleOf(row, place).slice(0, MAX_TITLE),
        message: excerpt,
        url: urlOf(place),
        sender_name: row.actor_display_name || row.actor_username || null,
        sender_avatar: row.actor_avatar_url || null,
        actor_subject: null,              // filled in by the caller (the actor's Network subject)
        rich_content: { activity_id: Number(row.id), kind: row.kind, dedupe_key: `chat.activity.${Number(row.id)}` },
    };
}

/**
 * Tell the Network about one activity row. The row is claimed first (its own id is the dedupe key), so a retry never
 * sends it twice. → { sent, skipped, duplicate } or null when there was nothing to send.
 */
async function push(activityId) {
    if (!config.activity.notify) return null;
    const row = await rowOf(activityId);
    if (!row) return null;
    const notification = await notificationOf(row);
    if (!notification) return null;
    const dedupeKey = notification.rich_content.dedupe_key;
    // The claim: one row per activity, so the push happens once.
    const claim = await db.run(`INSERT INTO chat_activity_notifications
            (activity_id, user_id, kind, dedupe_key, type, url, status)
        VALUES (?, ?, ?, ?, ?, ?, 'sent')
        ON CONFLICT (activity_id) DO NOTHING`,
    [Number(row.id), Number(row.user_id), row.kind, dedupeKey, notification.type, notification.url]);
    if (!claim.changes) return { sent: false, duplicate: true };
    const ctx = require('../live-context');
    const subjectId = await ctx.subjectFor(row.user_id);
    if (!subjectId) {
        // Nobody on the Network to tell: the row keeps its claim, so it is never pushed twice.
        await db.run(`UPDATE chat_activity_notifications SET status = 'skipped' WHERE activity_id = ?`, [Number(row.id)]);
        return { sent: false, skipped: true };
    }
    if (row.actor_user_id) {
        try { notification.actor_subject = await ctx.subjectFor(row.actor_user_id); } catch { /* no subject, no block check */ }
    }
    try {
        const r = await require('../inbox/notify').pushOne({ subjectId, ...notification });
        const skipped = !!(r && r.skipped);
        if (skipped) await db.run(`UPDATE chat_activity_notifications SET status = 'skipped' WHERE activity_id = ?`, [Number(row.id)]);
        return { sent: !!(r && r.sent) && !skipped, skipped };
    } catch (err) {
        console.warn(`[Activity] notify ${row.kind}: ${err && err.message}`);
        // The Network could not be reached: the claim is given back, so the row may be told later.
        await db.run(`DELETE FROM chat_activity_notifications WHERE activity_id = ?`, [Number(row.id)]).catch(() => {});
        return { sent: false, failed: true };
    }
}

// The pushes in flight: a message never waits for the Network.
const pending = new Set();
/** Tell the Network about an activity row, in the background. → the promise (tests await settled()). */
function later(activityId) {
    const p = push(activityId).catch((err) => { console.warn(`[Activity] notify: ${err && err.message}`); return null; })
        .finally(() => pending.delete(p));
    pending.add(p);
    return p;
}
/** Wait for the pushes in flight to finish (tests). */
async function settled() {
    while (pending.size) await Promise.all([...pending]);
}

/**
 * The activity rows that were told to the Network, for the person: their type and their address. The rows that were
 * never pushed (before this feature) are not there.
 */
async function notifiedOf(ids) {
    const list = [...new Set([].concat(ids || []).map(Number).filter((n) => n > 0))];
    if (!list.length) return [];
    return await db.all(`SELECT activity_id, type, url, status FROM chat_activity_notifications
        WHERE activity_id = ANY(?) AND status != 'failed'`, [list]);
}

/**
 * A row read on Chat clears its notification on the Network, the way a read direct message clears its own: the same
 * type and the same address. → how many notifications changed.
 */
async function doClear(user, ids) {
    const rows = await notifiedOf(ids);
    if (!rows.length) return 0;
    const subjectId = await require('../live-context').subjectFor(user && user.id);
    if (!subjectId) return 0;
    const notify = require('../inbox/notify');
    // One call per kind and address: fifteen rows of one room are one call.
    const seen = new Set();
    let marked = 0;
    for (const r of rows) {
        const key = `${r.type}\u0000${r.url || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            marked += await notify.markRead({ subjectId, type: r.type, urlPattern: r.url ? `%${r.url}` : null });
        } catch (err) { console.warn(`[Activity] clear: ${err && err.message}`); }
    }
    return marked;
}

/** Clear the notifications of the rows that were read, in the background (settled() waits for it). */
function clear(user, ids) {
    const p = doClear(user, ids).catch((err) => { console.warn(`[Activity] clear: ${err && err.message}`); return 0; })
        .finally(() => pending.delete(p));
    pending.add(p);
    return p;
}

const UNREAD_TTL_MS = 15_000;
const UNREAD_FAIL_MS = 10_000;
const unreadCache = new Map();

/**
 * The person's unread count on the Network — the number the menu's bell shows. → the count, or null when the Network
 * does not answer (the page then falls back to Chat's own count).
 */
async function networkUnread(actor) {
    if (!actor || actor.kind !== 'user' || !actor.token) return null;
    const key = String((actor.user && actor.user.subject_id) || actor.user.id);
    const hit = unreadCache.get(key);
    if (hit && Date.now() - hit.at < (hit.value == null ? UNREAD_FAIL_MS : UNREAD_TTL_MS)) return hit.value;
    let value = null;
    try {
        // The Network's own address (the same service as the public one, without the trip through the proxy).
        const res = await fetch(`${String(config.networkInternalUrl || '').replace(/\/+$/, '')}/api/notifications/unread-count`, {
            headers: { Authorization: `Bearer ${actor.token}` },
            signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
            const body = await res.json().catch(() => null);
            const n = Number(body && body.unread);
            if (Number.isFinite(n) && n >= 0) value = n;
        }
    } catch { value = null; }
    if (unreadCache.size > 500) unreadCache.clear();
    unreadCache.set(key, { at: Date.now(), value });
    return value;
}

/** Tests: forget the cached unread counts. */
const _reset = () => { unreadCache.clear(); };

module.exports = { push, later, settled, clear, networkUnread, roleName, titleOf, urlOf, _reset };
