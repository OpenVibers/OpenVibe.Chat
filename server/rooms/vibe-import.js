'use strict';
const config = require('../config');
const db = require('../db/database');
const vibe = require('./vibe');

let tokens = null;
let exportOverride = null;
async function exportFor(subject) {
    if (exportOverride) return exportOverride(subject);
    if (!config.oauth.clientSecret) throw Object.assign(new Error('Import is unavailable'), { status: 503 });
    if (!tokens) {
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        tokens = createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.exchange', scope: 'exchange.chat.export' });
    }
    const token = await tokens.getToken();
    const res = await fetch(`${config.exchange.internalUrl}/internal/exchange/chat/export`, {
        headers: { Authorization: `Bearer ${token}`, 'x-ov-subject': subject, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw Object.assign(new Error('Exchange could not export your chats'), { status: 503 });
    return res.json();
}

async function status(user) {
    const notice = await db.get('SELECT dismissed_at, imported_at FROM vibe_import_notices WHERE user_id = ?', [user.id]);
    if (notice && (notice.dismissed_at || notice.imported_at)) return { count: 0, show: false };
    const body = await exportFor(user.subject_id);
    const ids = (body.chats || []).map((c) => c.id);
    if (!ids.length) return { count: 0, show: false };
    const existing = await db.all('SELECT exchange_id FROM vibe_chat_settings WHERE exchange_id = ANY(?::text[])', [ids]);
    const imported = new Set(existing.map((r) => r.exchange_id));
    const count = ids.filter((id) => !imported.has(id)).length;
    return { count, show: count > 0 };
}

async function dismiss(user) {
    await db.run(`INSERT INTO vibe_import_notices (user_id, dismissed_at) VALUES (?, ov_now())
        ON CONFLICT (user_id) DO UPDATE SET dismissed_at = ov_now()`, [user.id]);
    return { show: false };
}

async function bring(user) {
    const body = await exportFor(user.subject_id);
    let imported = 0;
    for (const c of body.chats || []) {
        if (!/^exc_[0-9A-Za-z]+$/.test(String(c.id)) || !Array.isArray(c.messages)) continue;
        if (await db.get('SELECT room_id FROM vibe_chat_settings WHERE exchange_id = ?', [c.id])) continue;
        const room = await vibe.createRoom(user, c.title || 'Imported chat');
        try {
            const member = await db.get('SELECT id FROM room_ai_members WHERE room_id = ?', [room.id]);
            await db.tx(async () => {
                await db.run('UPDATE rooms SET name = ?, created_at = ?, last_message_at = ? WHERE id = ?', [String(c.title || 'Imported chat').slice(0, 120), c.created_at || c.updated_at, c.updated_at || c.created_at, room.id]);
                await db.run('INSERT INTO vibe_chat_settings (room_id, models, exchange_id) VALUES (?, ?::jsonb, ?)',
                    [room.id, JSON.stringify((c.models || []).filter((x) => typeof x === 'string').slice(0, 3)), c.id]);
                for (const m of c.messages.slice(0, 1000)) {
                    if (!['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string') continue;
                    await db.run(`INSERT INTO room_messages (room_id, user_id, subject_id, ai_member_id, message, created_at, vibe_model)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`, [room.id, m.role === 'assistant' ? 0 : user.id,
                        m.role === 'assistant' ? null : user.subject_id, m.role === 'assistant' ? member.id : null,
                        m.content, m.created_at || c.created_at || c.updated_at, m.role === 'assistant' ? m.model || null : null]);
                }
                const count = await db.get('SELECT COUNT(*) AS n FROM room_messages WHERE room_id = ?', [room.id]);
                await db.run('UPDATE rooms SET message_count = ? WHERE id = ?', [Number(count.n), room.id]);
            });
            imported += 1;
        } catch (err) { await vibe.erase(room.id); throw err; }
    }
    await db.run(`INSERT INTO vibe_import_notices (user_id, imported_at) VALUES (?, ov_now())
        ON CONFLICT (user_id) DO UPDATE SET imported_at = ov_now()`, [user.id]);
    return { imported };
}

module.exports = { exportFor, status, dismiss, bring, _setExport(fn) { exportOverride = fn; } };
