'use strict';
/**
 * "How Vibe did this" (consumer plan §4, the Vibe app): under a finished agent task's answer in a Vibe chat, folded,
 * what ran it and with which model, the check, how long it took, what it cost, its sources, and a link to every step
 * on OpenVibe.Actor. Built from the task row (its `how`, kept by workspace.js from Actor's result) and Actor's public
 * agent catalog for the agents' names (read at most once an hour; an agent's id stands in while Actor is away).
 *
 *   forRoom(room) → Map(message id → info) for the room's announced tasks and Vibe's answers that kept their steps
 *   of(task, names) → info { lines: [text], sources: [url], actor_url } or null: plain text, escaped where it is shown
 *   ofMessage(how)  → the same info from a chat answer's room_messages.how { steps, sources, citations }, or null
 *   step(acc, tool, args) adds what a tool call did, in plain words, to { steps, sources } (ai-members.js)
 *   cite(acc, tool, result) keeps a search result's URL, site, provider and dates as a citation (ai-members.js)
 *   linksOf(info)   → the sources resolved and deduped: { url, site, date }, citations first then plain sources
 *   chips(info)     → the source chips under the answer, each the site, the date and the page it opens
 *   html(info)      → the <details class="vb-how"> markup, escaped, with the same sources
 */
const config = require('../config');
const db = require('../db/database');
const { sourceOf } = require('./search-fabric');

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

// A chat answer's steps (ai-members.js answerWithTools): each tool call in plain words, at most MAX_STEPS.
const MAX_STEPS = 12;
const MAX_CITES = 6;
const quoted = (v, max = 80) => { const s = String(v || '').replace(/\s+/g, ' ').trim(); return s ? `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”` : ''; };
const STEP = {
    search_openvibe: (a) => `Searched OpenVibe for ${quoted(a.query)}`,
    web_search: (a) => `Searched the web for ${quoted(a.query)}`,
    read_page: (a) => `Read ${hostOf(String(a.url || 'a page'))}`,
    current_time: () => 'Checked the time',
    roll_dice: () => 'Rolled dice',
    pick_one: () => 'Picked one at random',
    household_pantry: () => 'Looked at the household\'s pantry',
    remember: () => 'Saved a note to your memory',
    forget: () => 'Deleted a note from your memory',
    set_up_agent: (a) => `Set up an agent${a.name ? `: ${quoted(a.name, 60)}` : ''}`,
    my_agents: () => 'Looked at your agents',
};
function step(acc, tool, raw = null) {
    if (!acc || !STEP[tool] || acc.steps.length >= MAX_STEPS) return;
    let args = {};
    if (raw) { try { args = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { args = {}; } }
    if (!args || typeof args !== 'object') args = {};
    const line = STEP[tool](args);
    if (acc.steps[acc.steps.length - 1] !== line) acc.steps.push(line);   // the same step twice in a row reads once
    if (tool === 'read_page' && /^https?:\/\//.test(String(args.url || ''))) {
        const url = String(args.url).slice(0, 500);
        if (!Array.isArray(acc.sources)) acc.sources = [];
        if (acc.sources.length < 6 && !acc.sources.includes(url)) acc.sources.push(url);
        if (!Array.isArray(acc.citations)) acc.citations = [];
        // A page read has no publication date of its own: the chip shows the date Vibe read it (11-01).
        if (!acc.citations.some((c) => c && c.url === url) && acc.citations.length < MAX_CITES) {
            acc.citations.push({ url, site: hostOf(url), title: null, provider: null, published_at: null, retrieved_at: new Date().toISOString() });
        }
    }
}
function ofMessage(raw) {
    const how = typeof raw === 'string' ? json(raw, null) : raw;
    if (!how || !Array.isArray(how.steps) || !how.steps.length) return null;
    const citations = (Array.isArray(how.citations) ? how.citations : []).filter((c) => c && /^https?:\/\//.test(String(c.url || ''))).slice(0, MAX_CITES)
        .map((c) => {
            const src = sourceOf(c);
            return { url: String(src.url).slice(0, 500), site: src.site ? String(src.site).slice(0, 253) : hostOf(src.url), title: c.title ? String(c.title).slice(0, 200) : null, provider: c.provider ? String(c.provider).slice(0, 40) : null, ...(src.display_url ? { display_url: String(src.display_url).slice(0, 500) } : {}), published_at: c.published_at ? String(c.published_at).slice(0, 40) : null, retrieved_at: c.retrieved_at ? String(c.retrieved_at).slice(0, 40) : null };
        });
    return { lines: how.steps.map((l) => String(l).slice(0, 200)).slice(0, MAX_STEPS), sources: (Array.isArray(how.sources) ? how.sources : []).filter((u) => /^https?:\/\//.test(String(u || ''))).slice(0, 6), ...(citations.length ? { citations } : {}), actor_url: null };
}

/**
 * Keep the citations a search tool returned with its answer: each result's URL, provider and dates. The
 * model already sees them in the tool result; this puts the same links under "How Vibe did this".
 */
function cite(acc, tool, raw) {
    if (!acc || (tool !== 'search_openvibe' && tool !== 'web_search')) return;
    let result = null;
    try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!result || typeof result !== 'object') return;
    const list = Array.isArray(result.citations) && result.citations.length ? result.citations
        : Array.isArray(result.results) ? result.results
            : Array.isArray(result.sources) ? result.sources.map((url) => ({ url })) : [];
    if (!Array.isArray(acc.sources)) acc.sources = [];
    if (!Array.isArray(acc.citations)) acc.citations = [];
    for (const item of list) {
        if (!item || acc.sources.length >= MAX_CITES) break;
        const src = sourceOf(typeof item === 'string' ? { url: item } : item);
        const url = String(src.url || '').slice(0, 500);
        if (!/^https?:\/\//.test(url) || acc.sources.includes(url)) continue;
        acc.sources.push(url);
        acc.citations.push({
            url,
            site: src.site ? String(src.site).slice(0, 253) : hostOf(url),
            title: item.title ? String(item.title).slice(0, 200) : null,
            provider: item.provider ? String(item.provider).slice(0, 40) : null,
            ...(src.display_url ? { display_url: src.display_url } : {}),
            published_at: item.published_at ? String(item.published_at).slice(0, 40) : null,
            retrieved_at: item.retrieved_at ? String(item.retrieved_at).slice(0, 40) : null,
        });
    }
}

async function forRoom(room) {
    const rows = await db.all('SELECT * FROM room_tasks WHERE room_id = ? AND posted_message IS NOT NULL AND status = ? ORDER BY id DESC LIMIT 200', [room.id, 'succeeded']);
    const out = new Map();
    for (const m of await db.all('SELECT id, how FROM room_messages WHERE room_id = ? AND how IS NOT NULL AND is_deleted = 0 ORDER BY id DESC LIMIT 200', [room.id])) {
        const info = ofMessage(m.how);
        if (info) out.set(Number(m.id), info);
    }
    if (!rows.length) return out;
    const agentNames = await names();
    for (const t of rows) { const info = of(t, agentNames); if (info) out.set(Number(t.posted_message), info); }
    return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u); } };
const shortDate = (ts) => {
    const at = Date.parse(String(ts || ''));
    return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null;
};

/**
 * The answer's sources, resolved and deduped: its citations first, then plain sources (a page it read, an agent task's
 * links). Each is { url, site, date } and names the host it will open, never a guess (11-01).
 */
function linksOf(info) {
    if (!info) return [];
    const out = []; const seen = new Set();
    const add = (c) => {
        if (!c || out.length >= MAX_CITES) return;
        const item = typeof c === 'string' ? { url: c } : c;
        const src = sourceOf(item);
        if (!/^https?:\/\//.test(src.url) || seen.has(src.url)) return;
        seen.add(src.url);
        out.push({
            url: src.url, site: src.site || hostOf(src.url), title: item.title ? String(item.title).slice(0, 200) : null,
            provider: item.provider ? String(item.provider).slice(0, 40) : null, date: shortDate(item.published_at || item.retrieved_at),
            ...(src.display_url ? { display_url: src.display_url } : {}),
        });
    };
    (Array.isArray(info.citations) ? info.citations : []).forEach(add);
    (Array.isArray(info.sources) ? info.sources : []).forEach(add);
    return out;
}
const anchor = (l) => `<a class="vb-source" href="${esc(l.url)}" rel="nofollow ugc noopener" target="_blank"><span class="vb-source-site">${esc(l.site || hostOf(l.url))}</span>${l.date ? `<span class="vb-source-date">${esc(l.date)}</span>` : ''}</a>`;

/** The source chips under an answer: the site name, the date, and the page they open. */
function chips(info) {
    const links = linksOf(info);
    if (!links.length) return '';
    return `<ul class="vb-sources" aria-label="Sources">${links.map((l) => `<li>${anchor(l)}</li>`).join('')}</ul>`;
}

function html(info) {
    if (!info) return '';
    const links = linksOf(info);
    return `<details class="vb-how"><summary>How Vibe did this</summary><ul>${info.lines.map((l) => `<li>${esc(l)}</li>`).join('')}`
        + `${links.length ? `<li class="vb-how-sources"><span>Sources:</span> ${links.map(anchor).join(' ')}</li>` : ''}`
        + `${info.actor_url ? `<li><a href="${esc(info.actor_url)}">Every step on OpenVibe Agents</a></li>` : ''}</ul></details>`;
}

module.exports = { names, of, ofMessage, step, cite, forRoom, linksOf, chips, html, _reset: () => { cached = { at: 0, names: new Map() }; } };
