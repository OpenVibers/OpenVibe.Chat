'use strict';
/**
 * The agent's step (design 2026-11-07): a task in a Chat room (or in Vibe's own chat) is one step of the agent's
 * timeline. Chat publishes agent.step.started|updated|ended with the person who asked as the subject, so the one
 * timeline behind the Dock shows what the agent did for them. The payload is a title, an outcome and a link: never
 * the task's title or details (the person's own words), never a message, a result or a source.
 */
const AGENT_TOPICS = Object.freeze({
    started: 'agent.step.started',
    updated: 'agent.step.updated',
    ended: 'agent.step.ended',
});
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_OF = Object.freeze({ queued: 'waiting', running: 'running', succeeded: 'done', failed: 'failed', cancelled: 'stopped' });
const TITLE_OF_KIND = Object.freeze({
    answer: 'Answering in your chat',
    research: 'Researching for your chat',
    web: 'Looking it up for your chat',
    code: 'Coding from your chat',
    computer: 'Working on your computer from your chat',
    other: 'Working on your chat task',
});

/** What one task's current state is as an agent step: a generated title, an outcome and a link. */
function agentStepOf(task, room, { status = null, baseUrl = 'https://openvibe.chat', startedAt = null, endedAt = null, costUsd = null, reason = null } = {}) {
    const state = STATUS_OF[status] || status || STATUS_OF[task.status] || 'running';
    const cost = costUsd == null ? task.cost_usd : costUsd;
    const base = String(baseUrl || 'https://openvibe.chat').replace(/\/+$/, '');
    const slug = room && room.slug ? String(room.slug) : null;
    return {
        step_id: String(task.id),
        mode: 'talk',
        product: 'chat',
        ref: String(task.id),
        title: TITLE_OF_KIND[task.kind] || TITLE_OF_KIND.other,
        status: state,
        started_at: new Date(startedAt == null ? Date.now() : startedAt).toISOString(),
        ended_at: state === 'waiting' || state === 'running' ? null : new Date(endedAt == null ? Date.now() : endedAt).toISOString(),
        placement: { where: 'In your chat', why: 'it runs from the conversation you are in, with the answer coming back here' },
        cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
        link: slug ? `${base}/r/${encodeURIComponent(slug)}/tasks/${Number(task.id)}` : null,
        reason: state === 'failed' || state === 'stopped' ? (reason == null ? null : String(reason).slice(0, 240)) : null,
    };
}

/** The topic a current state is: a step starts, changes or ends. */
function topicOf(status) {
    const state = STATUS_OF[status] || status;
    return state === 'waiting' || state === 'running' ? 'started' : 'ended';
}

/**
 * Write one agent step row for the task's current state, in the caller's transaction (the same one as the change).
 * A task with no person behind it (a service's) has no timeline and publishes nothing.
 */
async function emitAgentStep(task, room, { topic = null, status = null, costUsd = null, reason = null, baseUrl = 'https://openvibe.chat', startedAt = null, now = Date.now } = {}) {
    if (!task || !USER_SUBJECT.test(String(task.requested_subject || ''))) return null;
    const state = STATUS_OF[status] || status || STATUS_OF[task.status] || 'running';
    const kind = topic || topicOf(state);
    const event_type = AGENT_TOPICS[kind];
    if (!event_type) return null;
    const outbox = require('./service-outbox');
    const ms = now();
    return outbox.emit({
        event_type,
        subject: { type: 'user', id: task.requested_subject },
        actorSubject: task.requested_subject,
        priority: kind === 'ended' ? 'important' : 'low',
        payload: agentStepOf(task, room, { status: state, costUsd, reason, baseUrl, startedAt, endedAt: ms }),
    });
}

module.exports = { AGENT_TOPICS, agentStepOf, emitAgentStep, topicOf, STATUS_OF, TITLE_OF_KIND, USER_SUBJECT };
