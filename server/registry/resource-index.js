/**
 * Chat's authority resource index (ADR-048, plan T13 step 8). Rooms are person-owned,
 * so their summaries have no project or OVRN. This router is mounted on the loopback API.
 */
'use strict';

const express = require('express');
const contracts = require('openvibe-contracts');
const db = require('../db/database');
const serviceAuth = require('../net/service-auth');

const SERVICE = 'chat';
const ROOM_KIND = 'chat.room';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The room fields allowed by common.resource-summary@1. */
function roomSummary(room) {
    const summary = {
        id: room.slug,
        kind: ROOM_KIND,
        service: SERVICE,
        ...(USER_SUBJECT_RE.test(String(room.owner_subject || '')) ? { owner: { type: 'user', id: room.owner_subject } } : {}),
        name: room.name,
        state: room.visibility,
        // rooms.created_at is nullable (a default, not a constraint): a row without one reads as the epoch.
        created_at: new Date(room.created_at ? `${String(room.created_at).replace(' ', 'T')}Z` : 0).toISOString(),
    };
    const ovrn = contracts.resources.nameOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** An opaque [kind, id] keyset position, in the same form as Host's cursor. */
const encodeCursor = (summary) => Buffer.from(JSON.stringify([summary.kind, summary.id])).toString('base64url');
function decodeCursor(raw) {
    let value;
    try { value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(value) && value.length === 2 && value[0] === ROOM_KIND && typeof value[1] === 'string' &&
        encodeCursor({ kind: value[0], id: value[1] }) === raw ? value[1] : null;
}

/** Unknown kinds and valid project filters match no person-owned rooms. */
function filtersOf(query) {
    const project = typeof query.project === 'string' && query.project !== '' ? query.project : null;
    if (project && !PROJECT_ID_RE.test(project)) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (cursor === null) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, limit, cursor };
}

async function page(req, res, next) {
    try {
        const filters = filtersOf(req.query);
        if (filters.error) return contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail: filters.error });
        if (filters.project || (filters.kind && filters.kind !== ROOM_KIND)) {
            return res.set('Cache-Control', 'private, max-age=60').json({ resources: [], next_cursor: null });
        }
        const rows = await db.all(`SELECT slug, name, visibility, owner_subject, created_at FROM rooms
            WHERE archived_at IS NULL AND slug > ? COLLATE "C" ORDER BY slug COLLATE "C" LIMIT ?`,
        [filters.cursor || '', filters.limit + 1]);
        const resources = rows.slice(0, filters.limit).map(roomSummary);
        const next_cursor = rows.length > filters.limit ? encodeCursor(resources[resources.length - 1]) : null;
        return res.set('Cache-Control', 'private, max-age=60').json({ resources, next_cursor });
    } catch (err) { return next(err); }
}

/** No Chat room has an OVRN: a name can never identify a person-owned room. */
function one(req, res) {
    return contracts.http.sendProblem(res, 404, 'resources.unknown_resource', { detail: `no resource named ${req.params.ovrn}` });
}

function router() {
    const r = express.Router();
    r.use(serviceAuth.guard('chat.resource.read'));
    r.get('/', page);
    r.get('/:ovrn', one);
    return r;
}

module.exports = { router, roomSummary, filtersOf, encodeCursor, SERVICE, ROOM_KIND, DEFAULT_LIMIT, MAX_LIMIT };
