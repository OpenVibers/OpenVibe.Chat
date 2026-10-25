'use strict';
/**
 * "How Vibe did this" (consumer plan §4, the Vibe app): under a finished agent task's answer in a Vibe chat, folded,
 * what ran it and with which model, the check, how long it took, what it cost, its sources, and a link to every step
 * on OpenVibe.Actor. Built from the task row (its `how`, kept by workspace.js from Actor's result) and Actor's public
 * agent catalog for the agents' names (read at most once an hour; an agent's id stands in while Actor is away).
 *
 *   forRoom(room) → Map(message id → info) for the room's announced tasks
 *   of(task, names) → info { lines: [text], sources: [url], actor_url } or null: plain text, escaped where it is shown
 *   html(info)      → the <details class="vb-how"> markup, escaped
 */
const config = require('../config');
const db = require('../db/database');

const NAMES_TTL_MS = 3_600_000;
let cached = { at: 0, names: new Map() };

/** Actor's agent names (GET /api/v1/agents is public), cached for an hour; a failed read keeps what it had. */
async function names({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    if (now - cached.at < NAMES_TTL_MS) return cached.names;
    cached = { at: now, names: cached.names };
    try {
        const res = await fetchImpl(`${config.actor.internalUrl}/api/v1/agents`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
        const body = res.ok ? await res.json() : null;
        if (body && Array.isArray(body.agents)) cached.names = new Map(body.agents.filter((a) => a && a.id && a.name).map((a) => [String(a.id), String(a.name)]));
    } catch { /* Actor away: the ids stand in */ }
    return cached.names;
}

const DONE_AS = { research: 'Researched', web: 'Looked up', computer: 'Done on your computer', code: 'Coded on your computer' };
const atOf = (ts) => { const s = String(ts || ''); const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : null; };
const json = (v, dflt) => { try { const x = JSON.parse(v || ''); return x == null ? dflt : x; } catch { return dflt; } };

function of(t, agentNames = new Map()) {
    if (!t || t.status !== 'succeeded') return null;
    const how = json(t.how, {});
    const sources = json(t.sources, []).filter((u) => /^https?:\/\//.test(String(u || ''))).slice(0, 6);
    const agent = how.agent ? (agentNames.get(String(how.agent)) || String(how.agent)) : null;
    const lines = [`${DONE_AS[t.kind] || 'Done'}${agent ? ` by ${agent}` : ''}${how.model ? ` (${how.model})` : ''}`];
    const checked = how.checked && typeof how.checked === 'object' ? how.checked : null;
    if (checked && checked.by && checked.by !== 'none') lines.push(`Checked by a second model (${checked.by})${checked.reason ? `: ${String(checked.reason).slice(0, 200)}` : ''}`);
    const bits = [];
    const started = atOf(t.started_at), finished = atOf(t.finished_at);
    if (started != null && finished != null && finished >= started) {
        const mins = Math.round((finished - started) / 60_000);
        bits.push(mins < 1 ? 'Took under a minute' : `Took ${mins} min`);
    }
    if (t.cost_usd != null && Number.isFinite(Number(t.cost_usd))) {
        const usd = Number(t.cost_usd);
        bits.push(`cost $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} of your daily allowance`);
    }
    if (bits.length) lines.push(bits.join(' · '));
    const actor_url = how.actor_task ? `https://openvibe.actor/tasks/${encodeURIComponent(String(how.actor_task))}` : null;
    if (lines.length === 1 && !agent && !sources.length && !actor_url) return null;   // nothing to say beyond "Done"
    return { lines, sources, actor_url };
}

async function forRoom(room) {
    const rows = await db.all('SELECT * FROM room_tasks WHERE room_id = ? AND posted_message IS NOT NULL AND status = ? ORDER BY id DESC LIMIT 200', [room.id, 'succeeded']);
    const out = new Map();
    if (!rows.length) return out;
    const agentNames = await names();
    for (const t of rows) { const info = of(t, agentNames); if (info) out.set(Number(t.posted_message), info); }
    return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function html(info) {
    if (!info) return '';
    return `<details class="vb-how"><summary>How Vibe did this</summary><ul>${info.lines.map((l) => `<li>${esc(l)}</li>`).join('')}`
        + `${info.sources.length ? `<li>Sources: ${info.sources.map((u) => `<a href="${esc(u)}" rel="nofollow ugc noopener" target="_blank">${esc(hostOf(u))}</a>`).join(', ')}</li>` : ''}`
        + `${info.actor_url ? `<li><a href="${esc(info.actor_url)}">Every step on OpenVibe Agents</a></li>` : ''}</ul></details>`;
}

module.exports = { names, of, forRoom, html, _reset: () => { cached = { at: 0, names: new Map() }; } };
