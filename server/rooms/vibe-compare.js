'use strict';
/** Explicit model turns in a person's existing Vibe room. */
const db = require('../db/database');
const ai = require('../ai/client');
const rooms = require('./rooms');
const config = require('../config');
let benchOverride = null;

const modelIds = (value) => Array.isArray(value) && value.length >= 1 && value.length <= 3
    && value.every((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._/@:-]{1,255}$/i.test(id))
    && new Set(value).size === value.length;

async function settings(room) {
    const row = await db.get('SELECT models, system_prompt, temperature FROM vibe_chat_settings WHERE room_id = ?', [room.id]);
    if (!row) return { models: [], system_prompt: null, temperature: null };
    return { ...row, models: Array.isArray(row.models) ? row.models : JSON.parse(row.models || '[]') };
}

async function saveSettings(room, { models, system_prompt, temperature }) {
    if (!modelIds(models) && !(Array.isArray(models) && !models.length)) throw Object.assign(new Error('Choose up to three distinct models'), { status: 422 });
    if (system_prompt != null && (typeof system_prompt !== 'string' || system_prompt.length > 4000)) throw Object.assign(new Error('The system prompt is too long'), { status: 422 });
    if (temperature != null && (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2)) throw Object.assign(new Error('Temperature must be from 0 to 2'), { status: 422 });
    await db.run(`INSERT INTO vibe_chat_settings (room_id, models, system_prompt, temperature) VALUES (?, ?::jsonb, ?, ?)
        ON CONFLICT (room_id) DO UPDATE SET models = excluded.models, system_prompt = excluded.system_prompt, temperature = excluded.temperature`,
    [room.id, JSON.stringify(models), system_prompt || null, temperature == null ? null : Number(temperature)]);
    return settings(room);
}

async function answers(room, messageIds) {
    if (!messageIds.length) return new Map();
    const rows = await db.all('SELECT * FROM vibe_model_turns WHERE room_id = ? AND message_id = ANY(?::bigint[]) ORDER BY message_id, position', [room.id, messageIds]);
    const by = new Map();
    for (const r of rows) {
        if (!by.has(Number(r.message_id))) by.set(Number(r.message_id), []);
        by.get(Number(r.message_id)).push({ model: r.model, status: r.status, text: r.text || '', provider: r.provider || null,
            cost_usd: r.cost_usd == null ? null : Number(r.cost_usd), ms: r.ms == null ? null : Number(r.ms), run_id: r.run_id || null,
            ...(r.error ? { error: r.error } : {}) });
    }
    return by;
}

async function run(room, user, asked, models) {
    const history = await rooms.history(room, { before: asked.id, limit: 24 });
    const earlier = await answers(room, history.filter((m) => !m.ai_member_id).map((m) => Number(m.id)));
    const prefs = await settings(room);
    await Promise.allSettled(models.map(async (model) => {
        try {
            const previous = [];
            for (const m of history.filter((m) => !m.is_deleted)) {
                previous.push({ role: m.ai_member_id ? 'assistant' : 'user', content: m.message });
                const group = earlier.get(Number(m.id));
                if (group) {
                    const answer = group.find((a) => a.model === model && a.status === 'finished') || group.find((a) => a.status === 'finished');
                    if (answer) previous.push({ role: 'assistant', content: answer.text });
                }
            }
            const messages = [...(prefs.system_prompt ? [{ role: 'system', content: prefs.system_prompt }] : []), ...previous, { role: 'user', content: asked.message }];
            const result = await ai.complete({ model, messages, subject: user.subject_id, temperature: prefs.temperature });
            await db.run(`UPDATE vibe_model_turns SET status = 'finished', text = ?, provider = ?, cost_usd = ?, ms = ?, run_id = ?
                WHERE message_id = ? AND model = ?`, [result.text.slice(0, 8000), result.provider, result.cost_usd, result.ms, result.run_id, asked.id, model]);
        } catch (err) {
            await db.run("UPDATE vibe_model_turns SET status = 'failed', error = ? WHERE message_id = ? AND model = ?",
                [String(err.message || 'The model could not answer').slice(0, 250), asked.id, model]);
        }
    }));
}

async function ask(room, user, message, models, options = {}) {
    if (!modelIds(models)) throw Object.assign(new Error('Choose one to three distinct models'), { status: 422 });
    const posted = await rooms.post(room, user, message, { ai: false });
    await db.tx(async () => {
        for (const [position, model] of models.entries()) await db.run('INSERT INTO vibe_model_turns (message_id, room_id, model, position) VALUES (?, ?, ?, ?)', [posted.id, room.id, model, position]);
    });
    const prefs = await settings(room);
    await saveSettings(room, { ...prefs, ...options, models });
    setImmediate(() => run(room, user, posted, models).catch((err) => console.error('[Vibe compare]', err.message)));
    return posted;
}

async function pick(user, messageId, model) {
    const row = await db.get(`SELECT t.room_id FROM vibe_model_turns t JOIN rooms r ON r.id = t.room_id
        WHERE t.message_id = ? AND t.model = ? AND t.status = 'finished' AND r.owner_id = ? AND r.assistant = 1`, [messageId, model, user.id]);
    if (!row) throw Object.assign(new Error('That answer is not in your chat'), { status: 404 });
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', [row.room_id]);
    const prefs = await settings(room);
    await saveSettings(room, { ...prefs, models: [model] });
    return { chat: { slug: room.slug }, model };
}

async function prefer(user, messageId, model) {
    const row = await db.get(`SELECT t.room_id, m.message FROM vibe_model_turns t JOIN rooms r ON r.id = t.room_id
        JOIN room_messages m ON m.id = t.message_id WHERE t.message_id = ? AND t.model = ? AND t.status = 'finished'
        AND r.owner_id = ? AND r.assistant = 1`, [messageId, model, user.id]);
    if (!row) throw Object.assign(new Error('That answer is not in your chat'), { status: 404 });
    const all = (await answers({ id: row.room_id }, [messageId])).get(messageId) || [];
    const rival = all.find((a) => a.model !== model && a.status === 'finished');
    if (!rival) throw Object.assign(new Error('Two finished answers are needed to compare'), { status: 422 });
    if (await db.get('SELECT message_id FROM vibe_model_preferences WHERE message_id = ? AND user_id = ?', [messageId, user.id]))
        throw Object.assign(new Error('You already chose an answer'), { status: 409 });
    if (!config.oauth.clientSecret && !benchOverride) throw Object.assign(new Error('Preference voting is unavailable'), { status: 503 });
    let token = null;
    if (!benchOverride) {
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        const tokens = createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret, audience: config.bench.audience, scope: config.bench.scope });
        token = await tokens.getToken();
    }
    async function call(path, body, subject = false) {
        if (benchOverride) return path.endsWith('/votes') ? benchOverride.vote({ path, body, subject: user.subject_id }) : benchOverride.createRound(body);
        const res = await fetch(`${config.bench.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json', ...(subject ? { 'x-ov-subject': user.subject_id } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        const out = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error('Bench could not record the preference'), { status: 503 });
        return out;
    }
    const entries = [all.find((a) => a.model === model), rival];
    const built = await call('/api/v1/arena/rounds', { prompt: row.message.slice(0, 4000), category: 'chat', source: 'chat',
        entries: entries.map((a) => ({ provider: a.provider || 'openvibe', model: a.model, answer: a.text,
            cost_usd: a.cost_usd, ms: a.ms, run_id: a.run_id })) });
    const sides = built && built.entries || [];
    if (!built || !built.round || sides.length < 2) throw Object.assign(new Error('Bench did not create the comparison'), { status: 502 });
    await call(`/api/v1/arena/rounds/${encodeURIComponent(built.round.id)}/votes`,
        { outcome: 'left', pair: { left: sides[0].id, right: sides[1].id } }, true);
    await db.run('INSERT INTO vibe_model_preferences (message_id, user_id, winner, bench_round_id) VALUES (?, ?, ?, ?)',
        [messageId, user.id, model, built.round.id]);
    return { recorded: true, model };
}

module.exports = { modelIds, settings, saveSettings, answers, ask, pick, prefer, _setBench(client) { benchOverride = client; } };
