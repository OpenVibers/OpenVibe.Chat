/**
 * Chat's one SDK events outbox. Producers call emit inside the transaction that makes the change.
 */
'use strict';

const { ids, validate } = require('openvibe-contracts');
const { createServiceOutbox } = require('openvibe-sdk/events');
const db = require('../db/database');

const SOURCE = 'chat';
const SERVICE_ACTOR = { type: 'service', id: SOURCE };
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_TYPES = [
    'chat.message.created', 'chat.message.deleted', 'chat.dm.created',
    'chat.moderation.action', 'chat.room.message.created', 'chat.room.message.deleted',
];
let instance = null;

function actorFor(subjectId) {
    return subjectId && USER_SUBJECT.test(subjectId) ? { type: 'user', id: subjectId } : SERVICE_ACTOR;
}

function configure({ config, log = console }) {
    if (instance) throw new Error('service outbox is already configured');
    instance = createServiceOutbox({
        db: db.getDb(), source: SOURCE, eventsUrl: config.events.url,
        networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs, log, table: 'service_outbox',
        eventTypes: EVENT_TYPES,
        validate: (env) => validate('events.event-envelope@1', env),
    });
    return instance;
}

function current() {
    if (!instance) throw new Error('service outbox is not configured');
    return instance;
}

/** Preserve Chat's envelope fields and defaults across the SDK migration. */
async function emit({ event_type, subject, payload, visibility = 'internal', priority = 'important', actorSubject = null }) {
    const ms = Date.now();
    return current().emit({
        event_id: ids.newId('event', ms), event_type, version: 1, source: SOURCE,
        actor: actorFor(actorSubject), timestamp: new Date(ms).toISOString(),
        priority, visibility, subject, payload: payload || {},
    });
}

function reset() { instance = null; }

module.exports = { configure, current, emit, reset, actorFor };
