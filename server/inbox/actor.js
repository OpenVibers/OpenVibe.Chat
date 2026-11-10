'use strict';
/**
 * OpenVibe.Actor, asked to answer one turn of a support conversation (one-engine slice).
 *
 * The turn is POSTed to Actor's task API and followed until it ends:
 *
 *   turn({...})  POST /api/v1/tasks with Chat's own service token, then GET /api/v1/tasks/:id until the turn
 *                ends. The task is the visitor's when they are signed in (their own subject id in X-OV-Subject, so
 *                their allowance pays for it and it is their task), and Chat's own when they are not: an anonymous
 *                visitor has no account, and Chat never borrows one for them.
 *   read({...})  GET /api/v1/tasks/:id, for a turn still running when the wait ended (the next view reconciles it).
 *
 * A turn the model cannot answer (refused, failed, cancelled) throws a TurnError whose code and detail are the
 * task's own: the product shows those words. A turn still running when the wait ends resolves { pending: true,
 * taskId } instead of throwing, so the product can reconcile it on the next view.
 *
 * Actor down is a TurnError too, in words. There is no second engine: this client never falls back to OpenVibe.AI.
 */
const config = require('../config');

class TurnError extends Error {
    constructor(status, code, detail, taskId = null) {
        super(String(detail || code || 'the turn failed').slice(0, 500));
        this.name = 'TurnError';
        this.status = status;
        this.code = code;
        this.detail = String(detail || code || 'the turn failed').slice(0, 500);
        this.taskId = taskId;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

let _tokens = null;
/** Chat's service token for Actor: client credentials, audience openvibe.actor, the two task capabilities. */
function tokenClient() {
    if (_tokens) return _tokens;
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    _tokens = createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.actor',
        scope: 'actor.task.create actor.task.read',
    });
    return _tokens;
}
/**
 * The turn Actor answers: the inbox's own instructions and pages, the conversation so far and the visitor's new
 * words. The same words the old direct call sent, so the visitor sees the same answer.
 *
 * The transcript already ends with the visitor's new message (it is saved before the turn starts), so the whole
 * conversation is sent once, as it stands.
 */
function turnText({ system, history }) {
    const lines = [String(system || ''), '', 'The conversation so far:'];
    for (const m of history || []) {
        const text = String((m && m.content) == null ? '' : m.content);
        if (!text) continue;
        lines.push((m.role === 'assistant' ? 'Vibe: ' : 'The visitor: ') + text);
    }
    return lines.join('\n').slice(0, 60000);
}

function createActor({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const timeoutMs = Math.max(2000, Number(process.env.CHAT_ACTOR_TIMEOUT_MS) || 15_000);
    const waitMs = Math.max(5000, Number(process.env.CHAT_ACTOR_WAIT_MS) || 90_000);
    const pollMs = Math.max(500, Number(process.env.CHAT_ACTOR_POLL_MS) || 2000);
    async function jsonOf(res) {
        const text = await res.text();
        try { return text ? JSON.parse(text) : null; } catch { return null; }
    }

    /** One call to Actor. The subject is the visitor's when they have one; Chat's own task otherwise. */
    async function call(method, path, subject, body) {
        if (!config.oauth.clientSecret) throw new TurnError(503, 'actor.off', 'The assistant is not available on this server just now.');
        let token;
        try { token = await tokenClient().getToken(); }
        catch (err) { throw new TurnError(503, 'actor.unreachable', 'The assistant could not be reached just now. Nothing was charged. Try again in a moment.'); }
        let res;
        try {
            res = await fetchImpl(`${config.actor.internalUrl}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    // The person the turn is for. Absent: the turn is Chat's own (an anonymous visitor), and Actor
                    // charges it to Chat's cap. Never a person Chat made up.
                    ...(subject ? { 'X-OV-Subject': subject } : {}),
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new TurnError(503, 'actor.unreachable', 'The assistant could not be reached just now. Nothing was charged. Try again in a moment.');
        }
        const out = await jsonOf(res);
        if (res.status === 401 || res.status === 403) {
            throw new TurnError(res.status, (out && out.code) || 'actor.not_allowed', 'The answer needs a fresh sign-in. Sign in again and send once more.');
        }
        if (!res.ok || !out) {
            throw new TurnError(res.status, (out && out.code) || 'actor.failed', (out && (out.detail || out.title)) || `OpenVibe.Actor answered ${res.status}`);
        }
        return out;
    }

    /**
     * One conversation turn answered by Actor.
     *
     *   subject      the visitor's own subject id (a signed-in visitor), or null for an anonymous one (Chat's task)
     *   task         the words Actor answers
     *   tools        the registry tool names the run may call (an empty list answers with no tool calls)
     *   budgetUsd    what this one turn may cost
     *   conversation { product, id }: the product conversation this turn answers
     *
     * There is no tier here on purpose: the adult tier is for a person who confirmed they are 18 or older, and
     * a support inbox's visitor is not that person. Chat never asks for it.
     */
    async function turn({ subject = null, task, tools = [], budgetUsd = null, conversation = null, idempotencyKey = null, model = null, waitMs: turnWaitMs = null } = {}) {
        const who = SUBJECT_RE.test(String(subject || '')) ? String(subject) : null;
        const limitMs = turnWaitMs != null ? Math.max(5000, Number(turnWaitMs)) : waitMs;
        const started = now();
        const created = await call('POST', '/api/v1/tasks', who, {
            task: String(task || ''),
            mode: 'cheapest',
            ...(model ? { model: String(model).slice(0, 256) } : {}),
            ...(budgetUsd != null ? { budget: { per_task_usd: Number(budgetUsd) } } : {}),
            ...(idempotencyKey ? { idempotency_key: String(idempotencyKey).slice(0, 200) } : {}),
            ...(conversation ? { conversation } : {}),
            ...(tools ? { tools } : {}),
        });
        const taskId = created && created.id;
        if (!taskId) throw new TurnError(502, 'actor.failed', 'The assistant answered without a task. Nothing was charged.');
        for (;;) {
            const t = await call('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`, who);
            if (t.state !== 'queued' && t.state !== 'running') {
                if (t.state === 'succeeded') {
                    const result = t.result || {};
                    return {
                        pending: false, taskId,
                        answer: typeof result.answer === 'string' && result.answer.trim() ? result.answer : '',
                        agent: result.agent || null, model: result.model || null,
                        costUsd: t.cost && t.cost.usd != null ? Number(t.cost.usd) : null,
                        explanation: Array.isArray(t.explanation) ? t.explanation : [],
                        latencyMs: now() - started,
                    };
                }
                const err = t.error || {};
                throw new TurnError(502, err.code || `actor.task.${t.state}`, err.detail || `The turn ${t.state}. Nothing more was charged.`, taskId);
            }
            if (now() - started > limitMs) return { pending: true, taskId };
            await sleep(pollMs);
        }
    }

    /** Read a task back (a turn still running when the wait ended). */
    async function read({ subject = null, taskId }) {
        const who = SUBJECT_RE.test(String(subject || '')) ? String(subject) : null;
        return call('GET', `/api/v1/tasks/${encodeURIComponent(String(taskId))}`, who);
    }

    return { turn, read, TurnError };
}

// One client for the process (the token client is cached inside it), and a stand-in a test may put in its place.
let _actor = null;
/** The client the inbox asks. A test may replace it with a stand-in (the _setActor hook below). */
function actor() {
    if (!_actor) _actor = createActor({});
    return _actor;
}

module.exports = { createActor, actor, TurnError, turnText, SUBJECT_RE, _setTokens(t) { _tokens = t; }, _setActor(a) { _actor = a; }, _reset() { _actor = null; _tokens = null; } };
