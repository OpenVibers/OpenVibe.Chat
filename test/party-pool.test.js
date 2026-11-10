'use strict';
// OpenVibe's own computers for openvibe.party (message 11): the owner registers a Link machine and what it can run,
// a party with no machine of its own asks the pool, placement holds a machine by capacity and load (or gives the
// party a place in line), the machine claims it, and the hold is released when the room ends or goes idle.
//
// The placement engine is also driven directly with a fake registry (no owner routes, no Link): that is the unit
// under test, and the HTTP flow around it proves the party, panel and machine sides meet.
const assert = require('assert');
const http = require('http');
const { ids, serviceAuth } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('party pool');
let h, owner, ann, bob, cat, dave, db, poolModule;
const LINK_SECRET = 'party-pool-test-shared-secret-01234567890123456789';
const api = (method, path, u, body) => h.http(method, `/api/chat${path}`, { token: u && u.token, body });
/** A page on the party host: Node's fetch keeps the URL's Host, so a Host header needs its own request. */
const page = (path, u) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, method: 'GET', headers: { host: 'openvibe.party', cookie: `ov_token=${u.token}` } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
});
const newLink = () => `lnk_${ids.ulid()}`;
const nodeToken = (principal, subject) => {
    const at = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: h.ISS, sub: `link:${principal}`, actor_type: 'link', on_behalf_of: subject,
        aud: ['openvibe.chat'], cap: [], iat: at, exp: at + 300, jti: `pool_${ids.ulid()}`,
    }, h.keys.privateKey);
};

/** A registry the placement engine can use with no database and no Link: the fake the brief asks for. */
function fakeRegistry(machines) {
    const rows = machines.map((m) => ({ can_run: ['desktop'], enabled: true, ...m }));
    return {
        rows,
        async list() { return rows.map((m) => ({ ...m, can_run: [...m.can_run] })); },
        async get(id) { const m = rows.find((x) => x.principal_id === id); return m ? { ...m, can_run: [...m.can_run] } : null; },
        async upsert(f) {
            const i = rows.findIndex((x) => x.principal_id === f.principal_id);
            if (i >= 0) rows[i] = { ...rows[i], ...f }; else rows.push({ ...f });
            return await this.get(f.principal_id);
        },
        async update(id, f) { const i = rows.findIndex((x) => x.principal_id === id); if (i < 0) return null; rows[i] = { ...rows[i], ...f }; return await this.get(id); },
        async remove(id) { const i = rows.findIndex((x) => x.principal_id === id); if (i >= 0) rows.splice(i, 1); return i >= 0; },
        async touch(id) { const m = rows.find((x) => x.principal_id === id); if (m) m.last_seen_at = new Date().toISOString(); },
    };
}

t('boot', async () => {
    h = await boot({ env: {
        CHAT_PARTY_URL: 'https://openvibe.party', CHAT_PARTY_OAUTH_REDIRECT_URI: 'https://openvibe.party/auth/callback',
        CHAT_PARTY_CONNECT_SECRET: LINK_SECRET, TURN_URL: 'turns:turn.openvibe.live:443', TURN_AUTH_SECRET: 'party-test-turn-secret',
    } });
    owner = h.addUser('owner', { role: 'admin', is_owner: 1, subject: ids.newId('user') });
    ann = h.addUser('ann', { subject: ids.newId('user') });
    bob = h.addUser('bob', { subject: ids.newId('user') });
    cat = h.addUser('cat', { subject: ids.newId('user') });
    dave = h.addUser('dave', { subject: ids.newId('user') });
    for (const u of [owner, ann, bob, cat, dave]) await h.ctx.upsertUser(h.live.users.get(u.id));
    db = h.db;
    poolModule = require('../server/rooms/party-pool');
});

t('the pool is off by default, only the owner runs it, and off means no OpenVibe party', async () => {
    const off = await api('GET', '/parties/pool', owner);
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(off.body.enabled, false, 'the owner switch starts off');
    assert.strictEqual((await api('GET', '/parties/pool', ann)).status, 403, 'a person who is not the owner cannot read the pool');
    assert.strictEqual((await api('PUT', '/parties/pool/enabled', ann, { enabled: true })).status, 403, 'nor turn it on');
    const no = await api('POST', '/parties', ann, { desktop_hosting: 'openvibe', title: 'Off party' });
    assert.strictEqual(no.status, 503, no.text);
    assert.strictEqual(no.body.code, 'party.pool_off');
    const on = await api('PUT', '/parties/pool/enabled', owner, { enabled: true });
    assert.strictEqual(on.status, 200, on.text);
    assert.strictEqual(on.body.enabled, true);
});

const M1 = newLink();
const M2 = newLink();

t('the owner registers machines, and a party asks the pool and is held a machine by capacity', async () => {
    assert.strictEqual((await api('POST', '/parties/pool/machines', ann, { principal_id: M1, name: 'Dell tower 1', desktops: 2 })).status, 403);
    const bad = await api('POST', '/parties/pool/machines', owner, { principal_id: 'dev_nope', name: 'X', desktops: 1 });
    assert.strictEqual(bad.status, 422, bad.text);
    const one = await api('POST', '/parties/pool/machines', owner, { principal_id: M1, name: 'Dell tower 1', desktops: 2, can_run: ['desktop'] });
    assert.strictEqual(one.status, 201, one.text);
    assert.strictEqual(one.body.machine.desktops, 2);
    const two = await api('POST', '/parties/pool/machines', owner, { principal_id: M2, name: 'Dell tower 2', desktops: 1, can_run: ['desktop'] });
    assert.strictEqual(two.status, 201, two.text);
    const panel = await api('GET', '/parties/pool', owner);
    assert.strictEqual(panel.body.machines.length, 2);
    assert.strictEqual(panel.body.machines.reduce((n, m) => n + m.free, 0), 3);

    const made = await api('POST', '/parties', ann, { desktop_hosting: 'openvibe', title: 'Film on the pool' });
    assert.strictEqual(made.status, 201, made.text);
    assert.strictEqual(made.body.party.desktop.hosting, 'openvibe');
    assert.strictEqual(made.body.party.desktop.where.state, 'held');
    assert.strictEqual(made.body.party.desktop.where.machine, 'Dell tower 1');
    assert.match(made.body.party.desktop.where.line, /Dell tower 1/);
    ann.party = made.body.party;
    ann.key = made.body.join_secret;

    const seen = await api('GET', `/parties/${ann.party.id}`, ann);
    assert.strictEqual(seen.body.party.desktop.where.machine, 'Dell tower 1', 'the room view says where it runs');
    assert.strictEqual(seen.body.party.desktop.where.state, 'held');

    const assignment = await h.http('GET', '/api/chat/parties/desktop/assignment', { token: nodeToken(M1, owner.subject_id) });
    assert.strictEqual(assignment.status, 200, assignment.text);
    assert.strictEqual(assignment.body.assignment.party, ann.party.id, 'the held machine is told which party to host');
    assert.ok(assignment.body.assignment.hold);
});

t('the held machine claims the party, and the room says when it runs there', async () => {
    const wrong = await h.http('POST', `/api/chat/parties/${ann.party.id}/desktop/claim`, { token: nodeToken(M2, owner.subject_id), body: { port: 18180 } });
    assert.strictEqual(wrong.status, 404, 'a machine the pool did not hold cannot claim it');
    const claim = await h.http('POST', `/api/chat/parties/${ann.party.id}/desktop/claim`, { token: nodeToken(M1, owner.subject_id), body: { port: 18180 } });
    assert.strictEqual(claim.status, 200, claim.text);
    assert.ok(claim.body.share_grant);
    assert.ok(claim.body.ice_servers.some((s) => String(s.urls).startsWith('turns:')));
    const share = `shr_${ids.ulid()}`;
    const ready = await h.http('POST', `/api/chat/parties/${ann.party.id}/desktop/ready`, {
        token: nodeToken(M1, owner.subject_id),
        body: { share_id: share, url: `https://${ann.party.id}--x.openvibe.link/` },
    });
    assert.strictEqual(ready.status, 200, ready.text);
    const seen = await api('GET', `/parties/${ann.party.id}`, ann);
    assert.strictEqual(seen.body.party.desktop.state, 'ready');
    assert.strictEqual(seen.body.party.desktop.where.state, 'ready');
    assert.match(seen.body.party.desktop.where.line, /Running on Dell tower 1/);
    const after = await h.http('GET', '/api/chat/parties/desktop/assignment', { token: nodeToken(M1, owner.subject_id) });
    assert.strictEqual(after.body.assignment, null, 'a claimed party is no longer an assignment');
});

t('the pool seats three parties, queues the fourth with its place in line, and promotes it when one ends', async () => {
    bob.party = (await api('POST', '/parties', bob, { desktop_hosting: 'openvibe', title: 'Bob pool party' })).body.party;
    cat.party = (await api('POST', '/parties', cat, { desktop_hosting: 'openvibe', title: 'Cat pool party' })).body.party;
    assert.ok(bob.party.desktop.where.state === 'held' && cat.party.desktop.where.state === 'held');
    const waiting = await api('POST', '/parties', dave, { desktop_hosting: 'openvibe', title: 'Dave pool party' });
    assert.strictEqual(waiting.status, 201, waiting.text);
    assert.strictEqual(waiting.body.party.desktop.where.state, 'queued');
    assert.strictEqual(waiting.body.party.desktop.where.queue_position, 1);
    assert.match(waiting.body.party.desktop.where.line, /next/);
    dave.party = waiting.body.party;

    const panel = await api('GET', '/parties/pool', owner);
    assert.strictEqual(panel.body.queued, 1);
    assert.strictEqual(panel.body.machines.reduce((n, m) => n + m.free, 0), 0);

    const ended = await api('POST', `/rooms/${bob.party.id}/party/end`, bob);
    assert.strictEqual(ended.status, 200, ended.text);
    const swept = await poolModule.sweep();
    assert.strictEqual(swept.promoted, 1);
    const seated = await api('GET', `/parties/${dave.party.id}`, dave);
    assert.strictEqual(seated.body.party.desktop.where.state, 'held');
    assert.strictEqual(seated.body.party.desktop.where.machine, bob.party.desktop.where.machine, 'the freed machine goes to the oldest room in line');
});

t('ending a room releases its machine, and a hold nobody renews goes idle and is released', async () => {
    const ended = await api('POST', `/rooms/${cat.party.id}/party/end`, cat);
    assert.strictEqual(ended.status, 200, ended.text);
    let panel = await api('GET', '/parties/pool', owner);
    assert.strictEqual(panel.body.holds.filter((x) => x.state !== 'released').length, 2, 'the ended room no longer holds a machine');

    // Ann's machine is Ready; make its heartbeat old and sweep: the room loses the desktop and says why.
    await db.run("UPDATE party_pool_holds SET renewed_at = ? WHERE room_id = (SELECT room_id FROM room_parties WHERE host_subject = ? AND ended_at IS NULL ORDER BY created_at LIMIT 1)", ['2020-01-01T00:00:00.000Z', ann.subject_id]);
    const released = await poolModule.sweep();
    assert.ok(released.released >= 1);
    const seen = await api('GET', `/parties/${ann.party.id}`, ann);
    assert.strictEqual(seen.body.party.desktop.state, 'stopped');
    assert.strictEqual(seen.body.party.desktop.where.state, 'released');
    assert.match(seen.body.party.desktop.where.line, /idle/);
    panel = await api('GET', '/parties/pool', owner);
    assert.strictEqual(panel.body.holds.filter((x) => x.state !== 'released').length, 1, 'only Dave keeps a machine');
});

t('a person has a cap on waiting and running OpenVibe parties', async () => {
    const first = await api('POST', '/parties', bob, { desktop_hosting: 'openvibe', title: 'Bob one' });
    const second = await api('POST', '/parties', bob, { desktop_hosting: 'openvibe', title: 'Bob two' });
    assert.strictEqual(first.status, 201, first.text);
    assert.strictEqual(second.status, 201, second.text);
    const third = await api('POST', '/parties', bob, { desktop_hosting: 'openvibe', title: 'Bob three' });
    assert.strictEqual(third.status, 429, third.text);
    assert.strictEqual(third.body.code, 'party.pool_limit');
});

t('placement is tested with a fake registry: capacity, load, queue, promotion and idle release', async () => {
    assert.ok(poolModule, 'the module is loaded');
    const A = newLink(), B = newLink();
    const registry = fakeRegistry([
        { principal_id: A, owner_subject: owner.subject_id, name: 'Fake one', desktops: 2, can_run: ['desktop'] },
        { principal_id: B, owner_subject: owner.subject_id, name: 'Fake two', desktops: 1, can_run: ['desktop'] },
    ]);
    let clock = Date.now();
    const pool = poolModule.createPool({ registry, now: () => clock });
    const actor = () => ids.newId('user');
    const p1 = await pool.place({ actor: actor(), slug: 'party-fake1' });
    const p2 = await pool.place({ actor: actor(), slug: 'party-fake2' });
    const p3 = await pool.place({ actor: actor(), slug: 'party-fake3' });
    const p4 = await pool.place({ actor: actor(), slug: 'party-fake4' });
    assert.deepStrictEqual([p1.machine.principal_id, p2.machine.principal_id, p3.machine.principal_id], [A, B, A], 'most free first, then the least loaded');
    assert.strictEqual(p4.queued, true);
    assert.strictEqual(p4.position, 1);
    await pool.cancel(p2.hold.id, 'test');
    const swept = await pool.sweep();
    assert.strictEqual(swept.promoted, 1);
    assert.strictEqual(await pool.where(null), null, 'a fake hold has no room, so no room line');
    const after = await db.get('SELECT * FROM party_pool_holds WHERE id = ?', [p4.hold.id]);
    assert.strictEqual(after.state, 'held');
    assert.strictEqual(after.principal_id, B);
    // Idle: the machine is held but nobody renewed it for longer than the window.
    clock += 11 * 60_000;
    const idle = await pool.sweep();
    assert.ok(idle.released >= 2, 'the stale holds are released');
    const rows = await db.all("SELECT * FROM party_pool_holds WHERE slug LIKE 'party-fake%'");
    assert.ok(rows.every((r) => r.state === 'released'));
    await db.run("DELETE FROM party_pool_holds WHERE slug LIKE 'party-fake%'");
});

t('the owner panel is openvibe.party/pool, shows the machines and holds, and is the owner only', async () => {
    const panel = await page('/pool', owner);
    assert.strictEqual(panel.status, 200, panel.text.slice(0, 200));
    assert.match(panel.text, /OpenVibe computers/);
    assert.match(panel.text, /Dell tower 1/);
    const nobody = await page('/pool', ann);
    assert.strictEqual(nobody.status, 403);
});

t('close', async () => {
    await h.close();
});

t.run();
