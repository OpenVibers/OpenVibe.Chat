'use strict';
/**
 * Feeds (server/feeds/, docs/platform.md step 2): a person makes a feed and gets its key once; a publisher posts events
 * with the key (one, a batch, Live's envelopes, Claude Code's hook JSON as is); secrets and home folders are wiped on the
 * way in; viewers get what the feed's settings let them see, after its delay, over HTTP and the socket; a feed on a Live
 * channel slot reaches that slot's live chat as Live's vibe-coding frame; rooms, the embed and the pages show it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');
let feeds;

const t = suite('feeds');
const SITE = 'https://openvibe.chat';
let h, ann, bob, feed, key, streamId;
const api = (method, path, u, body, headers) => h.http(method, `/api/chat/feeds${path}`, { token: u && u.token, body, headers });
const pub = (path, body, k = key) => fetch(`${h.base}/api/chat/feeds/${feed.id}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const view = async (q = '') => (await fetch(`${h.base}/api/chat/feeds/${feed.id}${q}`)).json();
const patch = (settings, extra = {}) => api('PATCH', `/${feed.id}`, ann, { settings, ...extra });

t('boot', async () => {
    h = await boot({ env: { CHAT_WEB_URL: SITE } });
    feeds = require('../server/feeds/feeds');
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    for (const u of [ann, bob]) await h.ctx.upsertUser(h.live.users.get(u.id));
    const channel = h.addChannel(ann.id);
    streamId = h.addStream(ann.id, channel, { managed: { id: 77, title: 'Camp code', slug: 'camp-code' } });
    await h.ctx.ensureStream(streamId);
});

t('a person makes a feed and gets its key once; others cannot touch it', async () => {
    const r = await api('POST', '', ann, { title: 'Building Pixel Lamp' });
    assert.strictEqual(r.status, 201, r.text);
    feed = r.body.feed; key = r.body.key;
    assert.ok(/^fed_[0-9A-HJKMNP-TV-Z]{26}$/.test(feed.id) && /^ovf_[A-Za-z0-9_-]{32}$/.test(key));
    assert.strictEqual(feed.key_hint, key.slice(-4));
    assert.ok(!('key_hash' in feed), 'the hash is never shown');
    assert.deepStrictEqual((await api('GET', '/mine', ann)).body.feeds.map((f) => f.id), [feed.id]);
    assert.strictEqual((await api('PATCH', `/${feed.id}`, bob, { title: 'Mine' })).status, 404);
    assert.strictEqual((await api('PATCH', `/${feed.id}`, ann, { slot: 77 })).status, 200, 'her own slot');
    assert.strictEqual((await api('POST', '', bob, { title: 'Sneaky', slot: 77 })).status, 403, 'not his slot');
});

t('publishing needs the key; secrets and home folders are wiped on the way in', async () => {
    assert.strictEqual((await pub('/events', { eventType: 'prompt', text: 'hi' }, `ovf_${'x'.repeat(32)}`)).status, 401);
    const r = await pub('/events', { eventType: 'prompt', text: 'Use sk-ant-api03-abcdefghijklmnopqrstuvwx and PASSWORD=hunter22 in /home/ann/pixel-lamp/.env' });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.events[0].delivered, true);
    const stored = await h.db.get('SELECT payload FROM feed_events WHERE feed_id = ?', [feed.id]);
    const text = JSON.stringify(stored.payload);
    assert.ok(!text.includes('sk-ant') && !text.includes('hunter22') && !text.includes('/home/ann'), text);
    assert.ok(text.includes('[hidden]') && text.includes('~/pixel-lamp'));
});

t('a batch, Live\'s envelopes, and a repeated event delivered once; viewers see what the settings allow', async () => {
    const r = await pub('/events', { events: [
        { type: 'vibe-coding.event', event: { eventId: 'e-think', eventType: 'thinking', thinking: { text: 'Maybe the lamp needs a dimmer' } } },
        { eventId: 'e-tool', eventType: 'tool.call', summary: 'Ran npm test in server/lamp', tool: { name: 'Bash', argumentsPreview: 'npm test' } },
        { eventId: 'e-file', eventType: 'file.change', file: { relativePath: 'server/lamp/dimmer.js' } },
        { eventId: 'e-file', eventType: 'file.change', file: { relativePath: 'server/lamp/dimmer.js' } },
        { eventId: 'e-done', eventType: 'response', text: 'Added a dimmer.' },
    ] });
    assert.deepStrictEqual(r.body.events.map((e) => e.delivered), [false, true, true, false, true], 'thinking is off by default; the repeat is not delivered again');
    const v = await view();
    const byId = Object.fromEntries(v.events.map((e) => [e.eventId, e]));
    assert.ok(!byId['e-think'], 'thinking hidden');
    assert.strictEqual(byId['e-tool'].tool.argumentsPreview, null, 'what tools were given is off by default');
    assert.strictEqual(byId['e-file'].file.relativePath, 'dimmer.js', 'file names only');
    assert.strictEqual(byId['e-done'].response.text, 'Added a dimmer.');
    assert.strictEqual(v.feed.enabled, true);
    await patch({ show_prompts: 0, redact_file_paths: 0 });
    const v2 = await view();
    assert.ok(!v2.events.some((e) => e.eventType === 'prompt'), 'turning prompts off hides them in the history too');
    assert.strictEqual(v2.events.find((e) => e.eventId === 'e-file').file.relativePath, 'server/lamp/dimmer.js');
    await patch({ show_prompts: 1, redact_file_paths: 1 });
});

t('Claude Code\'s hooks, as they are: prompt, tools, files, the answer; never blocks it', async () => {
    const base = { session_id: 'abc-123', cwd: '/home/ann/pixel-lamp', transcript_path: '/home/ann/.claude/x.jsonl' };
    assert.deepStrictEqual((await pub('/hooks/claude-code', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Make the lamp glow purple', prompt_id: 'p1' })).body, {});
    await pub('/hooks/claude-code', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/home/ann/pixel-lamp/web/lamp.css' }, tool_use_id: 'tu0' });
    await pub('/hooks/claude-code', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/home/ann/pixel-lamp/web/lamp.css', old_string: 'a', new_string: 'b' }, tool_response: { ok: true }, tool_use_id: 'tu1' });
    await pub('/hooks/claude-code', { ...base, hook_event_name: 'Stop', last_assistant_message: 'The lamp glows purple now.' });
    const mine = (await view('?limit=50')).events.filter((e) => e.publisher && e.publisher.integrationId === 'claude-code');
    assert.deepStrictEqual(mine.map((e) => e.eventType), ['prompt', 'file.change', 'response'], 'PreToolUse is not shown; an edit is a file event');
    assert.strictEqual(mine[0].prompt.text, 'Make the lamp glow purple');
    assert.deepStrictEqual([mine[1].summary, mine[1].file.relativePath], ['Editing lamp.css', 'lamp.css'], 'the folder is not shown');
    assert.strictEqual(mine[2].response.text, 'The lamp glows purple now.');
    await pub('/hooks/claude-code', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat /home/ann/pixel-lamp/.env' }, tool_use_id: 'tu2' });
    const ran = (await view('?limit=50')).events.pop();
    assert.deepStrictEqual([ran.summary, ran.tool.argumentsPreview], ['Ran a command', null], 'what a command was is off by default');
    assert.strictEqual((await pub('/hooks/claude-code', { hook_event_name: 'UserPromptSubmit', prompt: 'x' }, `ovf_${'y'.repeat(32)}`)).status, 401);
});

t('the delay is the server\'s: the history waits for it too', async () => {
    await patch({ delay_ms: 60000 });
    await pub('/events', { eventId: 'e-late', eventType: 'response', text: 'Not yet' });
    assert.ok(!(await view()).events.some((e) => e.eventId === 'e-late'));
    await patch({ delay_ms: 0 });
    assert.ok((await view()).events.some((e) => e.eventId === 'e-late'));
});

t('the socket: watchers and the Live slot\'s chat hear new steps', async () => {
    const watcher = await h.ws({});
    watcher.sendJson({ type: 'feed_watch', feed: feed.id });
    await watcher.next((m) => m.type === 'feed_watching');
    const chat = await h.ws({ token: bob.token, stream: streamId });
    await chat.next((m) => m.type === 'users-list');
    await pub('/events', { eventId: 'e-live', eventType: 'tool.call', summary: 'Ran the lamp tests', tool: { name: 'Bash' } });
    const got = await watcher.next((m) => m.type === 'feed_event' && m.event.eventId === 'e-live');
    assert.strictEqual(got.feed, feed.id);
    const frame = await chat.next((m) => m.type === 'vibe-coding' && m.event.eventId === 'e-live');
    assert.deepStrictEqual([frame.managed_stream_id, frame.slot_slug], [77, 'camp-code']);
    watcher.close(); chat.close();
});

t('Live\'s chat finds a channel\'s feeds; any site may read a feed (no cookies)', async () => {
    const r = await fetch(`${h.base}/api/chat/feeds?channel=ann`, { headers: { origin: 'https://openvibe.live' } });
    const list = (await r.json()).feeds;
    assert.deepStrictEqual(list.map((f) => [f.id, f.managed_stream_id]), [[feed.id, 77]]);
    const other = await fetch(`${h.base}/api/chat/feeds/${feed.id}`, { headers: { origin: 'https://elsewhere.example' } });
    assert.strictEqual(other.status, 200);
    assert.strictEqual(other.headers.get('access-control-allow-origin'), 'https://elsewhere.example');
    assert.strictEqual(other.headers.get('access-control-allow-credentials'), null);
    await patch({ paused: 1 });
    assert.deepStrictEqual((await (await fetch(`${h.base}/api/chat/feeds?slot=77`)).json()).feeds, [], 'a paused feed is not listed');
    assert.deepStrictEqual((await view()).events, [], 'nor shown');
    await patch({ paused: 0 });
});

t('the pages: making a feed shows its key once, the feed page has the hooks, the embed, rooms show the card', async () => {
    const page = async (path, u, opts = {}) => { const r = await fetch(`${h.base}${path}`, { redirect: 'manual', ...opts, headers: { cookie: `ov_token=${u.token}`, ...(opts.headers || {}) } }); return { status: r.status, text: await r.text(), headers: r.headers }; };
    assert.ok((await page('/feeds', ann)).text.includes(`href="/feeds/${feed.id}"`));
    const made = await page('/feeds', ann, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, body: 'title=Second+feed' });
    assert.strictEqual(made.status, 201, made.text.slice(0, 300));
    assert.ok(/ovf_[A-Za-z0-9_-]{32}/.test(made.text), 'the key, once');
    const settings = await page(`/feeds/${feed.id}`, ann);
    assert.ok(settings.text.includes('/hooks/claude-code') && settings.text.includes('OPENVIBE_FEED_KEY') && !/ovf_[A-Za-z0-9_-]{32}/.test(settings.text), 'the hooks, not the key');
    assert.strictEqual((await page(`/feeds/${feed.id}`, bob)).status, 404);
    const embed = await fetch(`${h.base}/embed/feed/${feed.id}`);
    assert.ok(/frame-ancestors \*/.test(embed.headers.get('content-security-policy')) && (await embed.text()).includes(`data-feed="${feed.id}"`));
    const room = (await h.http('POST', '/api/chat/rooms', { token: ann.token, body: { name: 'Pixel Lamp dev' } })).body.room;
    await patch({}, { room: room.slug });
    assert.ok((await page(`/r/${room.slug}`, bob)).text.includes(`class="fv oc-room-fv" data-feed="${feed.id}"`));
    assert.strictEqual((await api('PATCH', `/${feed.id}`, bob, { room: room.slug })).status, 404);
});

t('Live\'s feed history comes over once: a feed per slot, its newest events, scrubbed, verified', async () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feeds-')), 'live.jsonl');
    const rows = [
        { kind: 'slot', managed_stream_id: 77, user_id: ann.id, title: 'Camp code', settings: { enabled: 0, widget_title: 'Night Bus Refactor', show_thinking: 1 } },
        { kind: 'session', managed_stream_id: 77, session_key: 'copilot-1', publisher: { integrationId: 'github-copilot', integrationLabel: 'GitHub Copilot' }, status: 'ended', created_at: '2026-04-21 23:10:00' },
        { kind: 'event', managed_stream_id: 77, session_key: 'copilot-1', event_id: 'old-1', seq: 1, type: 'prompt', summary: 'Refactor the bus', payload: JSON.stringify({ eventId: 'old-1', eventType: 'prompt', prompt: { text: 'Refactor with ghp_abcdefghijklmnopqrstuvwxyz0123' } }), created_at: '2026-04-21 23:10:01' },
        { kind: 'event', managed_stream_id: 77, session_key: 'copilot-1', event_id: 'old-2', seq: 2, type: 'response', summary: 'Done', payload: JSON.stringify({ eventId: 'old-2', eventType: 'response', response: { text: 'Done' } }), created_at: '2026-04-21 23:11:00' },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
    const { main } = require('../scripts/import-live-feeds');
    const said = [];
    assert.strictEqual(await main(['--file', file], (m) => said.push(m)), 0);
    assert.ok(said.some((m) => m.includes('dry run')) && !(await h.db.get("SELECT 1 FROM feeds WHERE legacy_source = 'live:managed_stream:77'")));
    assert.strictEqual(await main(['--file', file, '--apply'], (m) => said.push(m)), 0, said.join('\n'));
    const copied = await h.db.get("SELECT * FROM feeds WHERE legacy_source = 'live:managed_stream:77'");
    assert.deepStrictEqual([copied.title, Number(copied.owner_id), Number(copied.managed_stream_id), copied.key_hash], ['Night Bus Refactor', ann.id, 77, null]);
    const events = await h.db.all('SELECT event_id, payload FROM feed_events WHERE feed_id = ? ORDER BY id', [copied.id]);
    assert.deepStrictEqual(events.map((e) => e.event_id), ['old-1', 'old-2']);
    assert.ok(!JSON.stringify(events[0].payload).includes('ghp_'), 'old events are scrubbed too');
    assert.strictEqual(await main(['--file', file, '--apply'], () => {}), 0, 'a second run adds nothing');
    assert.strictEqual((await h.db.get("SELECT count(*)::int AS n FROM feeds WHERE legacy_source = 'live:managed_stream:77'")).n, 1);
});

t('deleting a feed deletes what was published to it', async () => {
    assert.strictEqual((await api('DELETE', `/${feed.id}`, ann)).status, 204);
    assert.strictEqual((await h.db.get('SELECT count(*)::int AS n FROM feed_events WHERE feed_id = ?', [feed.id])).n, 0);
    assert.strictEqual((await fetch(`${h.base}/api/chat/feeds/${feed.id}`)).status, 404);
});

t.run(async () => { if (h && h.close) await h.close(); });
