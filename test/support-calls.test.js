'use strict';
/**
 * Support calls (server/inbox/inbox.js startCall, server/calls/call-server.js support-<cid>): one of an inbox's people
 * starts a voice call from a conversation; the visitor joins with their visitor token, the inbox's people as themselves,
 * anyone else is refused; the visitor declining or hanging up ends it for everyone, and so does resolving; the panel
 * loads the call client and the inbox page shows the Call button.
 */
const assert = require('assert');
const WebSocket = require('ws');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('support calls');
let h, ann, bob, cat, inbox, token, cid;
const agentsApi = (method, path, u, body) => h.http(method, `/api/chat/inboxes${path}`, { token: u && u.token, body });
const widget = (path, body) => fetch(`${h.base}/api/chat/widget/inbox/${inbox.id}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

/** Join /ws/call: resolves with the socket and its first welcome or error. */
function join(channelId, { bearer = null, first = null } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/call?channelId=${encodeURIComponent(channelId)}`, { headers: { origin: 'https://openvibe.live', 'cf-connecting-ip': `203.0.113.${Math.floor(Math.random() * 200) + 20}`, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
        const all = [];
        ws.all = all;
        ws.wait = (pred, ms = 3000) => new Promise((res, rej) => {
            const hit = all.find(pred); if (hit) return res(hit);
            const timer = setTimeout(() => rej(new Error(`timed out (got ${JSON.stringify(all.map((m) => m.type))})`)), ms);
            ws.on('message', function on(d) { let m; try { m = JSON.parse(d.toString()); } catch { return; } if (pred(m)) { clearTimeout(timer); ws.off('message', on); res(m); } });
        });
        ws.on('message', (d) => { try { all.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', async () => {
            if (first) ws.send(JSON.stringify(first));
            try { ws.first = await ws.wait((m) => m.type === 'welcome' || m.type === 'error'); resolve(ws); } catch (e) { reject(e); }
        });
        ws.on('error', reject);
    });
}

t('boot (calls on)', async () => {
    h = await boot({ env: { CHAT_CALLS: '1', CHAT_INBOX_POSTS_PER_MINUTE: '500' } });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    for (const u of [ann, bob, cat]) await h.ctx.upsertUser(h.live.users.get(u.id));
    inbox = (await agentsApi('POST', '', ann, { name: 'Acme', ai_enabled: false })).body.inbox;
    await agentsApi('POST', `/${inbox.id}/members`, ann, { username: 'bob' });
    token = (await widget('/visit', {})).token;
    cid = (await widget('/messages', { token, message: 'Can someone talk me through the setup?', name: 'Dana' })).conversation.id;
});

t('one of the people starts a call; the visitor and the people join, nobody else does', async () => {
    const before = await join(`support-${cid}`, { first: { type: 'support-visitor', token } });
    assert.strictEqual(before.first.type, 'error', 'no call yet: nothing to join');
    before.close();
    assert.strictEqual((await agentsApi('POST', `/${inbox.id}/conversations/${cid}/call`, cat)).status, 404, 'not one of the people');
    const started = await agentsApi('POST', `/${inbox.id}/conversations/${cid}/call`, bob);
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    assert.strictEqual(started.body.channel, `support-${cid}`);
    const seen = await widget(`/messages?token=${token}`);
    assert.strictEqual(seen.conversation.call, true, 'the panel learns there is a call');
    assert.ok(seen.messages.some((m) => m.author === 'system' && m.body === 'Bob started a voice call.'), JSON.stringify(seen.messages.map((m) => m.body)));

    const visitor = await join(`support-${cid}`, { first: { type: 'support-visitor', token } });
    assert.strictEqual(visitor.first.type, 'welcome', JSON.stringify(visitor.first));
    const agent = await join(`support-${cid}`, { bearer: bob.token });
    assert.strictEqual(agent.first.type, 'welcome');
    const dana = agent.first.participants.find((p) => p.supportRole === 'visitor');
    assert.ok(dana && dana.displayName === 'Dana', 'the people see the visitor by the name they gave');
    assert.ok(agent.first.participants.some((p) => p.supportRole === 'agent'));
    const stranger = await join(`support-${cid}`, { bearer: cat.token });
    assert.strictEqual(stranger.first.type, 'error', 'someone else is refused');
    const forged = await join(`support-${cid}`, { first: { type: 'support-visitor', token: 'x'.repeat(32) } });
    assert.strictEqual(forged.first.type, 'error', 'a wrong visitor token too');
    for (const ws of [stranger, forged]) ws.close();

    // The visitor hangs up: everyone is told, the channel goes, the thread says so.
    assert.deepStrictEqual(await widget('/call/end', { token }), { ended: true });
    await Promise.all([visitor.wait((m) => m.type === 'call-ended'), agent.wait((m) => m.type === 'call-ended')]);
    assert.ok((await widget(`/messages?token=${token}`)).messages.some((m) => m.body === 'The visitor ended the call.'));
    assert.strictEqual((await widget(`/messages?token=${token}`)).conversation.call, false);
    for (const ws of [visitor, agent]) ws.close();
});

t('resolving ends a call; a resolved conversation cannot be called; the pages carry the call', async () => {
    await agentsApi('POST', `/${inbox.id}/conversations/${cid}/call`, bob);
    const visitor = await join(`support-${cid}`, { first: { type: 'support-visitor', token } });
    assert.strictEqual(visitor.first.type, 'welcome');
    const page = await fetch(`${h.base}/inbox/${inbox.id}?c=${cid}`, { headers: { cookie: `ov_token=${bob.token}` } }).then((r) => r.text());
    assert.ok(page.includes('id="ib-call"') && page.includes('id="ib-callbar"') && page.includes('support-call.js') && page.includes('"call":true'));
    assert.strictEqual((await agentsApi('PATCH', `/${inbox.id}/conversations/${cid}`, bob, { status: 'resolved' })).status, 200);
    await visitor.wait((m) => m.type === 'call-ended');
    visitor.close();
    assert.strictEqual((await agentsApi('POST', `/${inbox.id}/conversations/${cid}/call`, bob)).body.code, 'inbox.resolved');
    const panel = await fetch(`${h.base}/embed/inbox/${inbox.id}`).then((r) => r.text());
    assert.ok(panel.includes('support-call.js'), 'the panel loads the call client');
    const widgetJs = await fetch(`${h.base}/widget.js`).then((r) => r.text());
    assert.ok(widgetJs.includes("frame.allow = 'clipboard-write; microphone; autoplay'"), 'the panel may ask for the microphone');
});

t.run(async () => { if (h && h.close) await h.close(); });
