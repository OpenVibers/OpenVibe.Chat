'use strict';
/**
 * Friends and requests (the plan, 2026-11-09, stage V2: the side column on Home carries "Friends, Requests and
 * Vibe, then DMs"). Migration 0051 keeps the contacts a person has chosen: a friend is a contact both ways, a
 * request is one the other person has not accepted yet.
 *
 * A friend is only ever a person on OpenVibe: the id comes from Network's user directory (ctx_users), never from
 * the request body. A blocked person is never a friend.
 */
const db = require('../db/database');

/**
 * The contacts of `userId`: their friends and the requests they sent or received.
 *
 * The person's Network friends are merged in (plan §AB.51): the friend system is one across every site, so the
 * friends they made on OpenVibe.Network are here too, first. Chat's own contacts stay as they are.
 */
async function of(userId) {
    const rows = await db.all(`
        SELECT c.contact_id, c.status, u.username, u.display_name, u.avatar_url, u.subject_id
        FROM dm_contacts c LEFT JOIN ctx_users u ON u.id = c.contact_id
        WHERE c.user_id = ? ORDER BY lower(COALESCE(u.display_name, u.username, ''))`, [userId]);
    const friends = [];
    const requests = [];
    const asked = [];
    for (const r of rows) {
        const person = { id: Number(r.contact_id), username: r.username || '', display_name: r.display_name || r.username || '', avatar_url: r.avatar_url || null, subject_id: r.subject_id || null, status: r.status };
        if (r.status === 'friend') friends.push(person);
        else if (r.status === 'incoming') requests.push(person);   // they asked: it waits for you
        else if (r.status === 'outgoing') asked.push(person);      // you asked: it waits for them
    }
    // The person's Network friends, read with Chat's service token (network.friends.read) and kept for a
    // minute. A Network that cannot be reached is not an error here: the person's own contacts stand alone.
    const subject = await db.subjectFor(userId);
    const networkFriends = subject ? await require('./network-friends').peopleOf(subject) : [];
    const seen = new Set(networkFriends.map((f) => f.subject_id || f.id));
    return { friends: [...networkFriends, ...friends.filter((f) => !seen.has(f.subject_id || f.id))], requests, asked };
}

/** The people who asked `userId` to be their friend (they answer in the side column). */
async function incoming(userId) {
    const rows = await db.all(`
        SELECT c.user_id, u.username, u.display_name, u.avatar_url, u.subject_id
        FROM dm_contacts c LEFT JOIN ctx_users u ON u.id = c.user_id
        WHERE c.contact_id = ? AND c.status = 'incoming'`, [userId]);
    return rows.map((r) => ({ id: Number(r.user_id), username: r.username || '', display_name: r.display_name || r.username || '', avatar_url: r.avatar_url || null, subject_id: r.subject_id || null }));
}

/** Ask someone to be a friend (or accept them: both people then carry the other as a friend). */
async function add(userId, contactId) {
    const a = Number(userId); const b = Number(contactId);
    if (!a || !b || a === b) return null;
    // The other way round already: both are friends.
    const mine = await db.get('SELECT status FROM dm_contacts WHERE user_id = ? AND contact_id = ?', [a, b]);
    const theirs = await db.get('SELECT status FROM dm_contacts WHERE user_id = ? AND contact_id = ?', [b, a]);
    if (mine && mine.status === 'friend') return 'friend';
    if (theirs && theirs.status === 'incoming') {
        await db.run("UPDATE dm_contacts SET status = 'friend' WHERE user_id = ? AND contact_id = ?", [b, a]);
        await db.run("UPDATE dm_contacts SET status = 'friend' WHERE user_id = ? AND contact_id = ?", [a, b]);
        return 'friend';
    }
    if (mine && mine.status === 'incoming') {
        await db.run("UPDATE dm_contacts SET status = 'friend' WHERE user_id = ? AND contact_id = ?", [a, b]);
        await db.run("UPDATE dm_contacts SET status = 'friend' WHERE user_id = ? AND contact_id = ?", [b, a]);
        return 'friend';
    }
    await db.run("INSERT INTO dm_contacts (user_id, contact_id, status) VALUES (?, ?, 'outgoing') ON CONFLICT (user_id, contact_id) DO UPDATE SET status = 'outgoing'", [a, b]);
    if (!theirs) await db.run("INSERT INTO dm_contacts (user_id, contact_id, status) VALUES (?, ?, 'incoming') ON CONFLICT (user_id, contact_id) DO NOTHING", [b, a]);
    return 'outgoing';
}

/** Accept a request from someone (both ways become friends). */
async function accept(userId, contactId) {
    const a = Number(userId); const b = Number(contactId);
    // The request waits for them: their own row says so ('incoming' means they asked).
    const mine = await db.get('SELECT status FROM dm_contacts WHERE user_id = ? AND contact_id = ?', [a, b]);
    if (!mine || mine.status !== 'incoming') return false;
    await db.run("UPDATE dm_contacts SET status = 'friend' WHERE user_id = ? AND contact_id = ?", [a, b]);
    await db.run("UPDATE dm_contacts SET status = 'friend' WHERE user_id = ? AND contact_id = ?", [b, a]);
    // The person who asked hears that it was accepted (server/chat/activity.js friend_accept): the actor is the
    // person who accepted.
    try {
        const actor = await require('../live-context').getUserById(a);
        if (actor) await require('./activity').friendAccept({ userId: b, actor });
    } catch { /* a contact change is never held up by its activity */ }
    return true;
}

/** Drop a friend or a request (both ways). */
async function remove(userId, contactId) {
    const a = Number(userId); const b = Number(contactId);
    await db.run('DELETE FROM dm_contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)', [a, b, b, a]);
    return true;
}

module.exports = { of, incoming, add, accept, remove };
