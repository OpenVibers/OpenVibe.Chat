/**
 * OpenVibe.Help's per-ticket conversation over Chat's service ingress (capability
 * chat.ticket.write, chat.ticket-conversation@1, openvibe-contracts 0.103.0). Loopback only, a
 * service token for audience openvibe.chat. A conversation is keyed by the ticket id and the
 * calling service, taken from the token's principal (`svc:help` → `help`), so two services on one
 * ticket never see each other's messages and a service only ever reads its own conversation.
 *
 *   POST /internal/chat/tickets/:ticket_id/messages   create the conversation on first use, append one message
 *   GET  /internal/chat/tickets/:ticket_id            the calling service's conversation and its messages, paged
 *
 * The message body is the author's plain text (1–6000 characters, not blank): stored and returned
 * as sent, never rendered as HTML. The contract carries no idempotency key, so a retried POST
 * appends another message; `created_at` is the author's clock and Chat keeps its own ordering by
 * message id (newest first by default, `after_id` pages oldest first).
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const serviceAuth = require('../net/service-auth');

const MAX_TICKET_ID = 200;
const MAX_AUTHOR = 200;
const MAX_BODY = 6000;
const MAX_CREATED_AT = 40;
const MAX_MESSAGES = 500;
const AUTHOR_KINDS = ['person', 'agent', 'staff'];
const SERVICE = /^svc:([a-z][a-z0-9-]{1,39})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TICKET_ID = /^[^\s/\u0000]{1,200}$/;  // PostgreSQL text refuses NUL: a 400 here, not a 503 later

const bad = (message) => { const e = new Error(message); e.status = 400; throw e; };
const notFound = (message) => { const e = new Error(message); e.status = 404; throw e; };
const denied = (message) => { const e = new Error(message); e.status = 403; throw e; };
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v) => Number.isSafeInteger(v) && v > 0;
const plain = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && !v.includes('\u0000');

function fields(v, allowed) {
    if (!obj(v) || Object.keys(v).some((k) => !allowed.includes(k))) bad('Invalid fields');
}

/** The calling service from its token principal: svc:help -> help. Apps, nodes and agents are refused. */
function callingService(req) {
    const m = SERVICE.exec(String((req.principal && req.principal.sub) || ''));
    if (!m) denied('A service token is required');
    return m[1];
}

function ticketId(req) {
    const raw = String(req.params.ticket_id || '');
    if (!TICKET_ID.test(raw) || raw.length > MAX_TICKET_ID) bad('Invalid ticket id');
    return raw;
}

function validateMessage(b) {
    fields(b, ['author_kind', 'author', 'body', 'created_at']);
    if (!AUTHOR_KINDS.includes(b.author_kind)) bad('Invalid author kind');
    if (!plain(b.author, MAX_AUTHOR)) bad('Invalid author');
    if (!plain(b.body, MAX_BODY) || !b.body.trim()) bad('Invalid body');
    if (!plain(b.created_at, MAX_CREATED_AT) || !DATE_TIME.test(b.created_at) || !Number.isFinite(Date.parse(b.created_at))) bad('Invalid created_at');
}

/** Query string → validated positive ids; anything not in `spec` is 400. */
function query(req, spec) {
    const out = {};
    for (const [k, raw] of Object.entries(req.query)) {
        if (!spec[k] || typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) bad(`Invalid parameter ${k}`);
        const v = Number(raw);
        if (!int(v)) bad(`Invalid ${k}`);
        out[k] = v;
    }
    return out;
}

function route(name, fn) {
    return async (req, res) => {
        try {
            res.json({ ok: true, ...await fn(req) });
        } catch (err) {
            if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
            console.error(`[ChatTickets] ${name}:`, err);
            res.status(503).json({ ok: false, error: 'Chat ticket conversation unavailable' });
        }
    };
}

/** The (ticket, service) conversation, created on first use; a concurrent create resolves to one row. */
async function conversationFor(ticket, service) {
    const existing = await db.get('SELECT id, created_at FROM ticket_conversations WHERE ticket_id = ? AND service = ?', [ticket, service]);
    if (existing) return existing;
    await db.run('INSERT INTO ticket_conversations (ticket_id, service) VALUES (?, ?) ON CONFLICT DO NOTHING', [ticket, service]);
    return await db.get('SELECT id, created_at FROM ticket_conversations WHERE ticket_id = ? AND service = ?', [ticket, service]);
}

async function postMessage(req) {
    const ticket = ticketId(req);
    const service = callingService(req);
    validateMessage(req.body);
    const b = req.body;
    await db.transaction(async () => {
        const conv = await conversationFor(ticket, service);
        await db.run(
            'INSERT INTO ticket_messages (conversation_id, author_kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
            [conv.id, b.author_kind, b.author, b.body, b.created_at]);
    });
    return { ticket_id: ticket, service, message: { author_kind: b.author_kind, author: b.author, body: b.body, created_at: b.created_at } };
}

const messageRow = (r) => ({ id: Number(r.id), author_kind: String(r.author_kind), author: String(r.author), body: String(r.body), created_at: String(r.created_at) });

async function getConversation(req) {
    const ticket = ticketId(req);
    const service = callingService(req);
    const q = query(req, { after_id: true, before_id: true, limit: true });
    const conv = await db.get('SELECT id, created_at FROM ticket_conversations WHERE ticket_id = ? AND service = ?', [ticket, service]);
    if (!conv) notFound('Ticket conversation not found');
    const where = ['conversation_id = ?'];
    const params = [conv.id];
    if (q.after_id != null) { where.push('id > ?'); params.push(q.after_id); }
    if (q.before_id != null) { where.push('id < ?'); params.push(q.before_id); }
    const max = await db.get('SELECT MAX(id) AS max_id FROM ticket_messages WHERE conversation_id = ?', [conv.id]);
    // after_id pages forward (oldest first); otherwise newest first, back from before_id.
    const order = q.after_id != null ? 'ASC' : 'DESC';
    const rows = await db.all(
        `SELECT id, author_kind, author, body, created_at FROM ticket_messages WHERE ${where.join(' AND ')} ORDER BY id ${order} LIMIT ?`,
        [...params, Math.min(q.limit || 100, MAX_MESSAGES)]);
    return { ticket_id: ticket, service, created_at: String(conv.created_at), messages: rows.map(messageRow), max_id: max && max.max_id != null ? Number(max.max_id) : null };
}

const router = express.Router();
router.post('/tickets/:ticket_id/messages', serviceAuth.guard('chat.ticket.write'), route('ticket-message', postMessage));
router.get('/tickets/:ticket_id', serviceAuth.guard('chat.ticket.write'), route('ticket-conversation', getConversation));

module.exports = router;
