'use strict';
/**
 * An inbox's webhooks (server/inbox/inbox.js; migrations/0020_inbox_webhooks.sql): the team's own systems hear what
 * happens in its conversations. Up to three addresses an inbox, https only, on the public internet (openvibe-shared/
 * egress: every DNS answer must be public, no redirects followed).
 *
 *   openvibe   every event as JSON, { event: { id, type, source: 'chat', occurred_at, data } }, signed like OpenVibe.Events
 *              deliveries (X-OpenVibe-Timestamp and X-OpenVibe-Signature-V2 with the webhook's secret, shown once:
 *              openvibe-sdk/events parseDelivery checks it and returns { event }):
 *              chat.inbox.conversation.created · .conversation.waiting · .conversation.resolved · .conversation.rated ·
 *              .message.created
 *   slack      (hooks.slack.com) and discord (discord.com/api/webhooks): a readable line when a visitor waits for a
 *              person, writes while waiting (at most once a conversation every 10 minutes) or rates a conversation
 *
 * Delivery is fire and forget, three tries (now, after 30 seconds, after 5 minutes); each webhook keeps its last answer,
 * and one failing 20 times in a row is switched off (the owner switches it back on by saving it again).
 */
const crypto = require('crypto');
const https = require('https');
const db = require('../db/database');
const config = require('../config');

const MAX_WEBHOOKS = 3;
const RETRIES = [0, 30_000, 5 * 60_000];
const QUIET_MS = 10 * 60 * 1000;
const FAIL_OFF = 20;
const EVENTS = ['conversation.created', 'conversation.waiting', 'conversation.resolved', 'conversation.rated', 'message.created'];
const chatty = new Map();   // `${webhook}:${conversation}` → last line sent to Slack or Discord
let _send = null;           // tests: (url, body, headers) → { status }
let _lookup = null;         // tests: a dns.lookup stand-in for the address check

class WebhookError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new WebhookError(status, code, message); };

function formatOf(u) {
    if (u.hostname === 'hooks.slack.com') return 'slack';
    if ((u.hostname === 'discord.com' || u.hostname === 'discordapp.com') && u.pathname.startsWith('/api/webhooks/')) return 'discord';
    return 'openvibe';
}
const shape = (r) => ({
    id: Number(r.id), url: r.url, format: r.format, last_status: r.last_status == null ? null : Number(r.last_status),
    last_error: r.last_error || null, last_at: r.last_at || null, failures: Number(r.failures) || 0, on: !r.disabled_at, created_at: r.created_at,
});

async function list(inbox) {
    return (await db.all('SELECT * FROM inbox_webhooks WHERE inbox_id = ? ORDER BY id', [inbox.id])).map(shape);
}

/** Add (or switch back on) an address. → { webhook, secret } (the secret only for the openvibe format, only now). */
async function add(inbox, user, url, deps = {}) {
    const { assertPublicUrl } = require('openvibe-shared/egress');
    let u;
    const lookup = deps.lookup || _lookup;
    try { u = await assertPublicUrl(String(url || '').trim(), { protocols: ['https:'], ...(lookup ? { lookup } : {}) }); }
    catch (err) { fail(422, 'inbox.webhook_url', `That address cannot be used: ${err.message}`); }
    const href = u.href.slice(0, 1000);
    const existing = await db.get('SELECT * FROM inbox_webhooks WHERE inbox_id = ? AND url = ?', [inbox.id, href]);
    if (existing) {
        await db.run('UPDATE inbox_webhooks SET disabled_at = NULL, failures = 0 WHERE id = ?', [existing.id]);
        return { webhook: shape(await db.get('SELECT * FROM inbox_webhooks WHERE id = ?', [existing.id])), secret: null };
    }
    const n = (await db.get('SELECT COUNT(*) AS n FROM inbox_webhooks WHERE inbox_id = ?', [inbox.id])).n;
    if (Number(n) >= MAX_WEBHOOKS) fail(429, 'inbox.too_many_webhooks', `At most ${MAX_WEBHOOKS} webhooks an inbox`);
    const format = formatOf(u);
    const secret = format === 'openvibe' ? `whsec_${crypto.randomBytes(24).toString('base64url')}` : null;
    const row = await db.get(`INSERT INTO inbox_webhooks (inbox_id, url, format, secret, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *`,
        [inbox.id, href, format, secret, user.id]);
    return { webhook: shape(row), secret };
}
async function remove(inbox, id) { await db.run('DELETE FROM inbox_webhooks WHERE inbox_id = ? AND id = ?', [inbox.id, Number(id) || 0]); }

// ── Delivery ───────────────────────────────────────────────────────────────────────────────────────────────────────

function post(url, body, headers) {
    if (_send) return _send(url, body, headers);
    const { safeLookup } = require('openvibe-shared/egress');
    return new Promise((resolve) => {
        const req = https.request(url, { method: 'POST', lookup: safeLookup, timeout: 8000, headers: { 'content-type': 'application/json', 'user-agent': 'OpenVibe-Chat-Webhook/1', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
            res.resume();
            resolve({ status: res.statusCode });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', (err) => resolve({ status: 0, error: err.message }));
        req.end(body);
    });
}

async function attempt(hook, body, headers, tryNo = 0) {
    const r = await post(hook.url, body, headers);
    const ok = r.status >= 200 && r.status < 300;
    await db.run(`UPDATE inbox_webhooks SET last_status = ?, last_error = ?, last_at = ov_now(), failures = ?${!ok && Number(hook.failures) + 1 >= FAIL_OFF ? ', disabled_at = ov_now()' : ''} WHERE id = ?`,
        [r.status || null, ok ? null : (r.error || `HTTP ${r.status}`).slice(0, 200), ok ? 0 : Number(hook.failures) + 1, hook.id]).catch(() => {});
    hook.failures = ok ? 0 : Number(hook.failures) + 1;
    if (!ok && tryNo + 1 < RETRIES.length && !(r.status >= 400 && r.status < 500 && r.status !== 429)) {
        setTimeout(() => attempt(hook, body, headers, tryNo + 1).catch(() => {}), RETRIES[tryNo + 1]).unref();
    }
    return ok;
}

/** A readable line for Slack or Discord, or null when this event is not news there. */
function lineFor(hook, type, d) {
    const who = (d.conversation && d.conversation.visitor_name) || 'A visitor';
    const quote = (t) => `“${String(t || '').replace(/\s+/g, ' ').slice(0, 300)}”`;
    const link = d.url;
    const key = `${hook.id}:${d.conversation && d.conversation.id}`;
    if (type === 'conversation.waiting') { chatty.set(key, Date.now()); return `🛟 ${who} is waiting for a person in ${d.inbox.name}${d.last ? `: ${quote(d.last)}` : ''}\n${link}`; }
    if (type === 'conversation.rated') return `${d.conversation.rating > 0 ? '👍' : '👎'} ${who} rated their conversation with ${d.inbox.name}${d.conversation.rating_comment ? `: ${quote(d.conversation.rating_comment)}` : ''}\n${link}`;
    if (type === 'message.created' && d.message.author === 'visitor' && ['waiting', 'open'].includes(d.conversation.status)) {
        if (Date.now() - (chatty.get(key) || 0) < QUIET_MS) return null;
        chatty.set(key, Date.now());
        if (chatty.size > 5000) chatty.delete(chatty.keys().next().value);
        return `💬 ${who} wrote in ${d.inbox.name}: ${quote(d.message.body)}\n${link}`;
    }
    return null;
}

/**
 * Tell an inbox's webhooks about an event in a conversation (and the message, for message.created). The conversation
 * is read as it is now, with the visitor's last line. Never throws and never waits for the deliveries.
 */
async function emit(inboxId, type, { conversationId = null, message = null } = {}) {
    if (!EVENTS.includes(type)) return 0;
    const hooks = await db.all('SELECT * FROM inbox_webhooks WHERE inbox_id = ? AND disabled_at IS NULL', [inboxId]).catch(() => []);
    if (!hooks.length) return 0;
    const inbox = await db.get('SELECT id, name FROM inboxes WHERE id = ?', [inboxId]);
    if (!inbox) return 0;
    const conv = conversationId ? await db.get('SELECT * FROM inbox_conversations WHERE id = ?', [conversationId]) : null;
    const last = conv ? await db.get("SELECT body FROM inbox_messages WHERE conversation_id = ? AND author = 'visitor' ORDER BY id DESC LIMIT 1", [conv.id]) : null;
    const d = {
        conversation: conv ? require('./inbox').convShape(conv) : null, ...(message ? { message } : {}), last: last ? last.body : null,
        inbox: { id: inbox.id, name: inbox.name }, url: `${config.web.baseUrl}/inbox/${inbox.id}${conv ? `?c=${conv.id}` : ''}`,
    };
    let sent = 0;
    for (const hook of hooks) {
        let body; let headers = {};
        if (hook.format === 'openvibe') {
            body = JSON.stringify({ event: { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type: `chat.inbox.${type}`, source: 'chat', occurred_at: new Date().toISOString(), data: d } });
            const { signDeliveryHeaders } = require('openvibe-sdk/events');
            headers = signDeliveryHeaders(body, hook.secret);
        } else {
            const line = lineFor(hook, type, d);
            if (!line) continue;
            body = JSON.stringify(hook.format === 'slack' ? { text: line } : { content: line.slice(0, 1900), allowed_mentions: { parse: [] } });
        }
        attempt(hook, body, headers).catch(() => {});
        sent++;
    }
    return sent;
}
function later(inboxId, type, data) { emit(inboxId, type, data).catch((err) => console.warn(`[Inbox] webhook: ${err && err.message}`)); }

/** A test event, now: → { ok, status, error } */
async function test(inbox, id) {
    const hook = await db.get('SELECT * FROM inbox_webhooks WHERE inbox_id = ? AND id = ?', [inbox.id, Number(id) || 0]);
    if (!hook) fail(404, 'inbox.no_webhook', 'No such webhook');
    const line = `✅ OpenVibe Chat: the "${inbox.name}" inbox can reach this webhook.`;
    const body = hook.format === 'openvibe' ? JSON.stringify({ event: { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type: 'chat.inbox.test', source: 'chat', occurred_at: new Date().toISOString(), data: { inbox: { id: inbox.id, name: inbox.name } } } })
        : JSON.stringify(hook.format === 'slack' ? { text: line } : { content: line });
    const headers = hook.format === 'openvibe' ? require('openvibe-sdk/events').signDeliveryHeaders(body, hook.secret) : {};
    const r = await post(hook.url, body, headers);
    const ok = r.status >= 200 && r.status < 300;
    await db.run('UPDATE inbox_webhooks SET last_status = ?, last_error = ?, last_at = ov_now() WHERE id = ?', [r.status || null, ok ? null : (r.error || `HTTP ${r.status}`).slice(0, 200), hook.id]);
    return { ok, status: r.status || null, error: ok ? null : (r.error || `HTTP ${r.status}`) };
}

function _setSend(fn, lookup = null) { _send = fn; _lookup = lookup; chatty.clear(); }

module.exports = { WebhookError, EVENTS, MAX_WEBHOOKS, list, add, remove, emit, later, test, formatOf, _setSend };
