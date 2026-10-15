'use strict';
/**
 * Chat's control API for person-owned rooms (ADR-048 amendment 2026-10-15, step 8 phase 2; capability
 * chat.resource.control): POST /api/v1/resources/control takes one common.owned-resource-control-request@1 from a
 * first-party service (OpenVibe.Services) naming a chat.room by its slug and its owner, and answers a
 * common.resource-control-result@1 (200 for every outcome, without `resource`: rooms have no OVRN; a malformed request
 * is a 400 problem).
 *
 *   archive   the room leaves every listing and takes no new messages (rooms.archived_at); its history stays
 *
 * Any other action is refused `control.unsupported_action`. Only the owner Chat holds may be named: a room of another
 * person is refused as unknown, never confirmed to exist. dry_run decides and explains without applying. The first
 * answer per (caller, idempotency_key) is kept in chat_control_log and returned for a repeat; the same key with another
 * request is refused `control.idempotency_conflict`. Loopback only, like the index (the service guard).
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const { http } = contracts;
const db = require('../db/database');
const serviceAuth = require('../net/service-auth');

const CAPABILITY = 'chat.resource.control';
const KIND = 'chat.room';

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (request) => crypto.createHash('sha256')
    .update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');

function router({ now = () => Date.now() } = {}) {
    const r = express.Router();
    const result = (request, state, extra = {}) => ({ action: request.action, state, at: new Date(now()).toISOString(), ...extra });
    const problem = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });

    async function decide(request) {
        if (request.owned.kind !== KIND) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no room ${request.owned.kind} ${request.owned.id}`) });
        }
        if (request.action !== 'archive') {
            return result(request, 'refused', { problem: problem(422, 'control.unsupported_action', `a room takes archive, not ${request.action}`) });
        }
        const room = await db.get('SELECT id, slug, owner_subject, archived_at FROM rooms WHERE slug = ?', [String(request.owned.id).toLowerCase()]);
        if (!room || room.owner_subject !== request.owner.id) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no room ${request.owned.id} of this person`) });
        }
        if (room.archived_at) return result(request, 'done', { result: { archived: true, changed: false } });
        if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: 'archive the room' } });
        await db.run('UPDATE rooms SET archived_at = ? WHERE id = ? AND archived_at IS NULL', [new Date(now()).toISOString().replace('T', ' ').slice(0, 19), room.id]);
        return result(request, 'done', { result: { archived: true, changed: true } });
    }

    r.use(serviceAuth.guard(CAPABILITY));
    r.post('/', express.json({ limit: '16kb' }), async (req, res, next) => {
        try {
            const ctx = http.requestContext(req.headers);
            if (!/^svc:/.test(String(req.principal.sub || ''))) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party`, ctx });
            const request = req.body;
            if (!request || typeof request !== 'object' || request.owned === undefined) {
                // Chat holds no project resources: a project-scoped request names nothing here.
                return http.sendProblem(res, 400, 'control.bad_request', { detail: 'Chat\'s rooms are person-owned: send common.owned-resource-control-request@1', ctx });
            }
            const check = contracts.resources.checkControlRequest(request);
            if (!check.valid) return http.sendProblem(res, 400, 'control.bad_request', { detail: JSON.stringify(check.errors).slice(0, 500), ctx });
            const caller = req.principal.sub;
            const digest = digestOf(request);
            const seen = await db.get('SELECT digest, response FROM chat_control_log WHERE caller = ? AND idempotency_key = ?', [caller, request.idempotency_key]);
            if (seen) {
                if (seen.digest !== digest) return http.sendProblem(res, 409, 'control.idempotency_conflict', { detail: 'this idempotency_key was used for another request', ctx });
                return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
            }
            const answer = await decide(request);
            await db.run(`INSERT INTO chat_control_log (caller, idempotency_key, owner_subject, digest, response, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [caller, request.idempotency_key, request.owner.id, digest, JSON.stringify(answer), now()]);
            return res.json(answer);
        } catch (err) { return next(err); }
    });
    return r;
}

module.exports = { router, CAPABILITY, digestOf };
