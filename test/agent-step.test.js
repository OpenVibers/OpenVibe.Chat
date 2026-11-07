'use strict';
/**
 * The agent's step (design 2026-11-07): a task in a chat room is one step of the agent's timeline — waiting, running,
 * done, failed or stopped. The payload is a generated title, an outcome and a link: never the task's title or
 * details (the person's own words), never a message, a result or a source.
 *
 *   node test/agent-step.test.js
 */
const assert = require('assert');
const { AGENT_TOPICS, agentStepOf, topicOf, STATUS_OF } = require('../server/events/agent-step');
const { EVENT_TYPES } = require('../server/events/service-outbox');

const ROOM = { slug: 'staff' };
const TASK = {
    id: 42, title: 'Add a dark favicon to Tools', details: 'the person\'s own words, which never leave Chat',
    kind: 'code', status: 'queued', requested_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS',
    result: 'the answer the agent wrote', error: null, cost_usd: null,
};

assert.strictEqual(AGENT_TOPICS.started, 'agent.step.started');
assert.strictEqual(AGENT_TOPICS.updated, 'agent.step.updated');
assert.strictEqual(AGENT_TOPICS.ended, 'agent.step.ended');
assert.ok(EVENT_TYPES.includes('agent.step.started') && EVENT_TYPES.includes('agent.step.ended'), 'the outbox allows the agent topics');

const waiting = agentStepOf(TASK, ROOM, { status: 'waiting', startedAt: 1762000000000, baseUrl: 'https://openvibe.chat' });
assert.strictEqual(waiting.step_id, '42');
assert.strictEqual(waiting.mode, 'talk');
assert.strictEqual(waiting.product, 'chat');
assert.strictEqual(waiting.status, 'waiting');
assert.strictEqual(waiting.title, 'Coding from your chat');
assert.strictEqual(waiting.link, 'https://openvibe.chat/r/staff/tasks/42');
assert.strictEqual(waiting.ended_at, null);
assert.ok(waiting.placement && waiting.placement.where && waiting.placement.why);
const raw = JSON.stringify(waiting);
assert.ok(!raw.includes('Add a dark favicon to Tools'), 'the task title never travels');
assert.ok(!raw.includes('the person\'s own words'), 'the details never travel');
assert.ok(!('title_text' in waiting) && !('details' in waiting) && !('result' in waiting) && !('messages' in waiting), 'no field for a person\'s content');

const done = agentStepOf({ ...TASK, status: 'succeeded', cost_usd: 0.04 }, ROOM, { endedAt: 1762000060000 });
assert.strictEqual(done.status, 'done');
assert.strictEqual(done.cost_usd, 0.04);
assert.ok(done.ended_at, 'an ended step says when it ended');
assert.strictEqual(agentStepOf({ ...TASK, status: 'failed' }, ROOM, { reason: 'the build failed' }).reason, 'the build failed');

assert.strictEqual(STATUS_OF.cancelled, 'stopped');
assert.strictEqual(topicOf('queued'), 'started');
assert.strictEqual(topicOf('running'), 'started');
assert.strictEqual(topicOf('succeeded'), 'ended');
assert.strictEqual(topicOf('cancelled'), 'ended');
console.log('chat agent step: a generated title, an outcome and a link — never the person\'s words');
console.log('all passed');
