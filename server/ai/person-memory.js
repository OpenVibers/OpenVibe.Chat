'use strict';

// Chat owns this data. Day records read new messages; week and month records read only
// the records immediately below them. The worker is serial and bounded on every tick.
const db = require('../db/database');
const consent = require('../net/consent');
const ai = require('./client');

const CAP_USD = 0.25;
const RESERVE_USD = 0.01;
const ENABLED = process.env.CHAT_PERSON_MEMORY_ENABLED === '1';
const MAX_MESSAGES = 180;

const date = (s) => String(s || '').slice(0, 10);
const week = (s) => {
    const d = new Date(`${date(s)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const monday = d.toISOString().slice(0, 10);
    // Split a week at a month boundary so a monthly rollup never includes another month.
    return monday < month(s) ? month(s) : monday;
};
const month = (s) => `${date(s).slice(0, 7)}-01`;
const text = (s, n = 600) => String(s || '').trim().slice(0, n);
const array = (x, n = 8) => Array.isArray(x) ? x.map(v => text(v, 100)).filter(Boolean).slice(0, n) : [];
const json = (x) => { if (Array.isArray(x)) return x; try { return JSON.parse(x || '[]'); } catch { return []; } };

async function optedOut(userId) {
    const row = await db.get('SELECT opted_out FROM person_chat_memory_settings WHERE user_id = ?', [userId]);
    return !!(row && Number(row.opted_out));
}

async function forget(userId, optOut = true) {
    const last = await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM person_chat_memory WHERE user_id = ?', [userId]);
    // The former rolling cache must also go: otherwise the old profile remains visible.
    await db.run("DELETE FROM chat_ai_summaries WHERE scope = 'user' AND subject_id = ?", [userId]);
    await db.run("DELETE FROM chat_timeline_events WHERE scope = 'user' AND subject_id = ?", [userId]);
    await db.run(`INSERT INTO person_chat_memory_settings (user_id, opted_out, resume_after_id, updated_at) VALUES (?, ?, ?, ov_now())
        ON CONFLICT (user_id) DO UPDATE SET opted_out = excluded.opted_out,
        resume_after_id = GREATEST(person_chat_memory_settings.resume_after_id, excluded.resume_after_id),
        updated_at = excluded.updated_at`, [userId, optOut ? 1 : 0, Number(last?.id || 0)]);
}

async function spentToday() {
    const row = await db.get('SELECT spent_usd, calls FROM person_chat_memory_spend WHERE day = ?', [new Date().toISOString().slice(0, 10)]);
    return { usd: Number(row?.spent_usd || 0), calls: Number(row?.calls || 0) };
}

async function summarize(source, prior, level, period) {
    const spent = await spentToday();
    if (spent.usd + RESERVE_USD > CAP_USD || spent.calls >= 25) return null;
    try {
        return await ai.structured('chat.person-memory', {
            level, period, prior_summary: text(prior?.summary, 500), sources_text: JSON.stringify(source).slice(0, 15000),
        }, { onRun: async (run) => {
            const measured = Number(run.usage?.cost_usd);
            const cost = Number.isFinite(measured) && measured >= 0 ? measured : RESERVE_USD;
            await db.run(`INSERT INTO person_chat_memory_spend (day, spent_usd, calls) VALUES (?, ?, 1)
                ON CONFLICT (day) DO UPDATE SET spent_usd = person_chat_memory_spend.spent_usd + excluded.spent_usd, calls = person_chat_memory_spend.calls + 1`,
            [new Date().toISOString().slice(0, 10), Math.max(cost, 0.000001)]);
        } });
    } catch { return null; }
}

function build(source, model, prior, count, lastId) {
    const fallback = text(prior?.summary, 500) || `${count} chat message${count === 1 ? '' : 's'} in this period`;
    const additions = (Array.isArray(model?.highlights) ? model.highlights : []).slice(0, 5).map(h => {
        const item = source[Number(h.index)];
        if (!item) return null;
        return { detail: text(h.detail, 180), stream_id: item.stream_id || null, at: item.timestamp || item.period_start || null };
    }).filter(Boolean);
    const highlights = [...json(prior?.highlights), ...additions].slice(-5);
    return { summary: text(model?.summary || fallback, 500), topics: model ? array(model.topics, 5) : json(prior?.topics), highlights,
        tone: text(model?.tone || prior?.tone, 120), catchphrases: model ? array(model.catchphrases, 5) : json(prior?.catchphrases), people: json(prior?.people),
        message_count: count, last_message_id: lastId };
}

async function save(userId, channelId, level, period, row) {
    await db.run(`INSERT INTO person_chat_memory
        (user_id, channel_user_id, level, period_start, summary, topics, highlights, tone, catchphrases, people, message_count, last_message_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?::jsonb, ?, ?, ov_now())
        ON CONFLICT (user_id, channel_user_id, level, period_start) DO UPDATE SET
        summary = excluded.summary, topics = excluded.topics, highlights = excluded.highlights,
        tone = excluded.tone, catchphrases = excluded.catchphrases, people = excluded.people,
        message_count = excluded.message_count, last_message_id = excluded.last_message_id, updated_at = excluded.updated_at`,
    [userId, channelId, level, period, row.summary, JSON.stringify(row.topics), JSON.stringify(row.highlights), row.tone,
        JSON.stringify(row.catchphrases), JSON.stringify(row.people), row.message_count, row.last_message_id]);
}

async function rollup(userId, channelId, level, period, childLevel) {
    const start = level === 'week' ? week(period) : month(period);
    const end = new Date(`${start}T00:00:00Z`);
    if (level === 'week') end.setUTCDate(end.getUTCDate() + (7 - ((end.getUTCDay() + 6) % 7)));
    else end.setUTCMonth(end.getUTCMonth() + 1);
    const rows = await db.all(`SELECT * FROM person_chat_memory WHERE user_id = ? AND channel_user_id = ? AND level = ?
        AND period_start >= ? AND period_start < ? ORDER BY period_start`, [userId, channelId, childLevel, start, end.toISOString().slice(0, 10)]);
    if (!rows.length) return;
    const prior = await db.get('SELECT * FROM person_chat_memory WHERE user_id = ? AND channel_user_id = ? AND level = ? AND period_start = ?', [userId, channelId, level, start]);
    const source = rows.map(r => ({ summary: r.summary, period_start: r.period_start }));
    const model = await summarize(source, prior, level, start);
    const count = rows.reduce((n, r) => n + Number(r.message_count || 0), 0);
    await save(userId, channelId, level, start, build(source, model, prior, count, Math.max(...rows.map(r => Number(r.last_message_id || 0)))));
}

async function processDay(c) {
    if (await optedOut(c.user_id)) return;
    const messages = await db.all(`SELECT id, message, timestamp, stream_id, subject_id FROM chat_messages
        WHERE user_id = ? AND COALESCE(channel_user_id, 0) = ? AND left(timestamp, 10) = ? AND id > ?
        AND is_deleted = 0 AND is_filtered = 0 AND message_type = 'chat'
        ORDER BY id ASC LIMIT ?`, [c.user_id, c.channel_user_id, c.period_start, Math.max(Number(c.last_message_id || 0), Number(c.resume_after_id || 0)), MAX_MESSAGES]);
    const allowed = await consent.filterRows(messages);
    const prior = await db.get('SELECT * FROM person_chat_memory WHERE user_id = ? AND channel_user_id = ? AND level = ? AND period_start = ?', [c.user_id, c.channel_user_id, 'day', c.period_start]);
    if (!allowed.length) {
        // A withdrawn or unverifiable consent erases every cached level and the old profile.
        await forget(c.user_id, false);
        return;
    }
    // Mentions can name a person who opted out; strip them from the model input.
    const source = allowed.map(m => ({ message: text(m.message, 200).replace(/@[A-Za-z0-9_]+/g, '@someone'), timestamp: m.timestamp, stream_id: m.stream_id }));
    const model = await summarize(source, prior, 'day', c.period_start);
    await save(c.user_id, c.channel_user_id, 'day', c.period_start,
        build(source, model, prior, Number(prior?.message_count || 0) + allowed.length, messages[messages.length - 1].id));
    await rollup(c.user_id, c.channel_user_id, 'week', c.period_start, 'day');
    await rollup(c.user_id, c.channel_user_id, 'month', c.period_start, 'week');
    if (c.channel_user_id !== -1) {
        const daily = await db.all("SELECT * FROM person_chat_memory WHERE user_id = ? AND channel_user_id >= 0 AND level = 'day' AND period_start = ? AND message_count > 0", [c.user_id, c.period_start]);
        const source = daily.map(r => ({ summary: r.summary, period_start: r.period_start }));
        const priorAll = await db.get("SELECT * FROM person_chat_memory WHERE user_id = ? AND channel_user_id = -1 AND level = 'day' AND period_start = ?", [c.user_id, c.period_start]);
        const allModel = await summarize(source, priorAll, 'day', c.period_start);
        await save(c.user_id, -1, 'day', c.period_start, build(source, allModel, priorAll,
            daily.reduce((n, r) => n + Number(r.message_count), 0), Math.max(...daily.map(r => Number(r.last_message_id)))));
        await rollup(c.user_id, -1, 'week', c.period_start, 'day');
        await rollup(c.user_id, -1, 'month', c.period_start, 'week');
    }
}

async function tick() {
    if (!ENABLED) return;
    const candidates = await db.all(`SELECT m.user_id, COALESCE(m.channel_user_id, 0) AS channel_user_id,
        left(m.timestamp, 10) AS period_start, COALESCE(p.last_message_id, 0) AS last_message_id,
        COALESCE(s.resume_after_id, 0) AS resume_after_id
        FROM chat_messages m LEFT JOIN person_chat_memory p ON p.user_id = m.user_id
        AND p.channel_user_id = COALESCE(m.channel_user_id, 0) AND p.level = 'day' AND p.period_start = left(m.timestamp, 10)
        LEFT JOIN person_chat_memory_settings s ON s.user_id = m.user_id
        WHERE m.user_id IS NOT NULL AND m.id > COALESCE(p.last_message_id, 0)
        AND m.id > COALESCE(s.resume_after_id, 0)
        AND m.is_deleted = 0 AND m.is_filtered = 0 AND m.message_type = 'chat'
        AND COALESCE(s.opted_out, 0) = 0
        GROUP BY m.user_id, COALESCE(m.channel_user_id, 0), left(m.timestamp, 10), p.last_message_id, s.resume_after_id
        ORDER BY period_start DESC LIMIT 2`);
    for (const c of candidates) await processDay(c);
}

async function read(userId, { channelId = null, level = 'day', privateView = false, limit = 60 } = {}) {
    if (await optedOut(userId)) return [];
    const params = [userId, level];
    let where = '';
    if (channelId != null) { where = ' AND channel_user_id = ?'; params.push(channelId); }
    else { where = ' AND channel_user_id = -1'; }
    params.push(limit);
    const rows = await db.all(`SELECT * FROM person_chat_memory WHERE user_id = ? AND level = ?${where} AND message_count > 0 ORDER BY period_start DESC, channel_user_id LIMIT ?`, params);
    return rows.map(r => ({ level: r.level, period_start: r.period_start, channel_user_id: Number(r.channel_user_id),
        summary: r.summary, topics: json(r.topics), highlights: json(r.highlights), message_count: Number(r.message_count),
        ...(privateView ? { tone: r.tone, catchphrases: json(r.catchphrases), people: json(r.people) } : {}) }));
}

let timer = null;
let busy = false;
function start() {
    if (!ENABLED || timer) return;
    const due = async () => {
        if (busy) return;
        busy = true;
        try { await tick(); } catch (err) { console.warn('[PersonMemory]', err.message); }
        finally { busy = false; }
    };
    timer = setInterval(due, 60_000);
    timer.unref?.();
    due();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { ENABLED, CAP_USD, tick, start, stop, read, forget, optedOut, spentToday, week, month };
