'use strict';
/**
 * The chat apps' own rows (migrations/0037_chat_apps.sql): the one-time link tokens a person gets
 * from /link, the rules of a group and the buttons a person may press.
 *
 *   The link token   One row per /link: the token's hash (the token itself is only in the person's
 *                    link and in the Network's page), the app, the person in the app and when it
 *                    expires. It is used once: the person confirms it on the Network's page (signed
 *                    in there) and the same token binds the app's account to their OpenVibe subject.
 *   The settings     One row per chat (a group, a channel, a server): what the bot may do there
 *                    (off, answer only, act with approvals) and how many answers an hour it may give.
 *   The callback     One row per button: who may press it, what it does and until when. A button is
 *                    used once: the row is marked used the first time it is pressed, so the same
 *                    button cannot approve twice.
 *
 * The account link itself is the Network's (linked_accounts, the account link every service reads);
 * these rows are the chat apps' own bookkeeping.
 */
const crypto = require('crypto');

const MODES = ['off', 'answer_only', 'act_with_approvals'];
const ACTIONS = ['approve', 'decline'];

const iso = (ms) => new Date(ms).toISOString();
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** A new one-time token: 32 random bytes, base64url. Only its hash is kept. */
function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

/** A new button's id: 16 characters of base64url (96 bits), unguessable and short enough for Telegram. */
function newId() {
    return crypto.randomBytes(12).toString('base64url');
}

function createStore({ db, now = () => Date.now() }) {
    /** The pending token of a person in an app (the newest one that has not expired), if any. */
    async function pendingToken(app, serviceUserId) {
        return await db.get(
            `SELECT * FROM chat_app_link_tokens
              WHERE app = ? AND service_user_id = ? AND state = 'pending' AND expires_at > ?
              ORDER BY created_at DESC LIMIT 1`,
            [app, serviceUserId, iso(now())]);
    }

    /** A token's row by its hash (the person carries the token itself). */
    async function tokenRow(token) {
        if (!token) return null;
        return await db.get('SELECT * FROM chat_app_link_tokens WHERE token_hash = ?', [hash(token)]);
    }

    /** Keep the token: one row per token, and the newest pending one for that person. */
    async function saveToken({ token, app, serviceUserId, serviceUsername, expiresAt }) {
        const h = hash(token);
        await db.run(
            `INSERT INTO chat_app_link_tokens (token_hash, app, service_user_id, service_username, state, created_at, expires_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT (token_hash) DO UPDATE SET app = excluded.app, service_user_id = excluded.service_user_id,
                service_username = excluded.service_username, state = 'pending', created_at = excluded.created_at, expires_at = excluded.expires_at`,
            [h, app, serviceUserId, serviceUsername || null, iso(now()), iso(expiresAt)]);
        return h;
    }

    /** The token is used: it is bound to the subject and cannot be used again. */
    async function useToken(token, subject) {
        const h = hash(token);
        const r = await db.run(
            `UPDATE chat_app_link_tokens SET state = 'used', subject = ?, used_at = ?
              WHERE token_hash = ? AND state = 'pending' AND expires_at > ?`,
            [subject, iso(now()), h, iso(now())]);
        return r.changes > 0;
    }

    /** The rules of a chat. The default is the safe one: answer when mentioned, never act. */
    async function settings(app, chatId) {
        const row = await db.get('SELECT * FROM chat_app_settings WHERE app = ? AND chat_id = ?', [app, chatId]);
        return {
            mode: row && MODES.includes(row.mode) ? row.mode : 'answer_only',
            rate_per_hour: row ? Number(row.rate_per_hour) || 20 : 20,
        };
    }

    /** Change the rules of a chat. */
    async function saveSettings(app, chatId, { mode, rate_per_hour }) {
        if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
        const rate = Math.max(1, Math.min(500, Number(rate_per_hour) || 20));
        await db.run(
            `INSERT INTO chat_app_settings (app, chat_id, mode, rate_per_hour, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (app, chat_id) DO UPDATE SET mode = excluded.mode, rate_per_hour = excluded.rate_per_hour, updated_at = excluded.updated_at`,
            [app, chatId, mode, rate, iso(now())]);
        return { mode, rate_per_hour: rate };
    }

    /** A button: one row, open until it is pressed or it expires. */
    async function openCallback({ app, chatId, userId, subject, action, approvalId, expiresAt }) {
        if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
        const id = newId();
        await db.run(
            `INSERT INTO chat_app_callbacks (id, app, chat_id, user_id, subject, action, approval_id, state, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
            [id, app, chatId, userId, subject || null, action, approvalId || null, iso(now()), iso(expiresAt)]);
        return id;
    }

    /**
     * Take a button: it is used once. The row is marked used only when it was open and had not
     * expired, so a second press (or a press after the expiry) changes nothing.
     */
    async function takeCallback(id, { app, chatId, userId, subject }) {
        const row = await db.get(`UPDATE chat_app_callbacks SET state = 'used', used_at = ?
            WHERE id = ? AND app = ? AND chat_id = ? AND user_id = ? AND subject = ?
            AND state = 'open' AND expires_at > ? RETURNING *`,
        [iso(now()), id, app, chatId, userId, subject, iso(now())]);
        return row ? { ok: true, row } : { ok: false, reason: 'unavailable' };
    }
    async function rate(key, limit) {
        const hour_bucket = Math.floor(now() / 3600000);
        const row = await db.get(`INSERT INTO chat_app_rates (key, hour_bucket, count) VALUES (?, ?, 1)
            ON CONFLICT (key) DO UPDATE SET hour_bucket = excluded.hour_bucket,
            count = CASE WHEN chat_app_rates.hour_bucket = excluded.hour_bucket THEN chat_app_rates.count + 1 ELSE 1 END
            WHERE chat_app_rates.hour_bucket != excluded.hour_bucket OR chat_app_rates.count < ? RETURNING count`, [key, hour_bucket, limit]);
        return Boolean(row);
    }
    async function enqueue(app, id, message) {
        return Boolean(await db.get(`INSERT INTO chat_app_deliveries (app, id, message) VALUES (?, ?, ?::jsonb)
            ON CONFLICT DO NOTHING RETURNING id`, [app, id, JSON.stringify(message)]));
    }
    async function next(button = false) {
        return db.get(`UPDATE chat_app_deliveries SET state = 'running' WHERE (app, id) =
            (SELECT app, id FROM chat_app_deliveries WHERE state = 'pending' AND ((message->>'kind' = 'button') = ?::boolean) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            AND state = 'pending' RETURNING *`, [button]);
    }
    async function finish(app, id, ok) {
        await db.run("UPDATE chat_app_deliveries SET state = ?, message = '{}'::jsonb WHERE app = ? AND id = ?", [ok ? 'done' : 'failed', app, id]);
    }

    /** The buttons of a chat that are still open (for the tests and for a restart). */
    async function openCallbacks(app, chatId) {
        return await db.all(
            `SELECT * FROM chat_app_callbacks WHERE app = ? AND chat_id = ? AND state = 'open' AND expires_at > ?`,
            [app, chatId, iso(now())]);
    }

    /** Old rows are dropped: a token that expired and a button that was pressed are of no use. */
    async function prune() {
        await db.run('DELETE FROM chat_app_deliveries WHERE created_at < ?', [iso(now() - 86400000)]);
        await db.run('DELETE FROM chat_app_rates WHERE hour_bucket < ?', [Math.floor(now() / 3600000) - 1]);
        await db.run('DELETE FROM chat_app_link_tokens WHERE expires_at < ?', [iso(now() - 24 * 3600 * 1000)]);
        await db.run('DELETE FROM chat_app_callbacks WHERE expires_at < ?', [iso(now() - 24 * 3600 * 1000)]);
    }

    return { rate, enqueue, next, finish, pendingToken, tokenRow, saveToken, useToken, settings, saveSettings, openCallback, takeCallback, openCallbacks, prune, newToken, newId, MODES, ACTIONS };
}

module.exports = { createStore, MODES, ACTIONS, newToken, newId };
