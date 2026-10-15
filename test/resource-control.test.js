'use strict';
/** ADR-048 amendment 2026-10-15: OpenVibe.Services archives a person's room through Chat's control API. */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('resource-control');
let h, token, owner, other;
let n = 0;
const send = (body, opts = {}) => h.http('POST', '/api/v1/resources/control', { token, body, ...opts });
const req = (action, over = {}) => ({
    action, owned: { kind: 'chat.room', id: 'control-lobby' }, owner: { type: 'user', id: owner.subject_id },
    on_behalf_of: { type: 'user', id: owner.subject_id }, idempotency_key: `idem_room_${++n}_${Date.now()}`, ...over,
});
const archived = async (slug = 'control-lobby') => (await h.db.get('SELECT archived_at FROM rooms WHERE slug = ?', [slug])).archived_at;

t('boot and seed rooms', async () => {
    h = await boot();
    token = h.serviceToken(['chat.resource.control'], { sub: 'svc:services' });
    owner = h.addUser('control-owner', { subject: contracts.ids.newId('user') });
    other = h.addUser('control-other', { subject: contracts.ids.newId('user') });
    for (const [slug, who] of [['control-lobby', owner], ['control-theirs', other]]) {
        await h.db.run('INSERT INTO rooms (slug, name, visibility, owner_id, owner_subject) VALUES (?, ?, ?, ?, ?)', [slug, `Room ${slug}`, 'public', who.id, who.subject_id]);
    }
});

t('a dry run applies nothing; archive archives once; a repeat answers the first result', async () => {
    let r = await send(req('archive', { dry_run: true }));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.state, r.body.result.dry_run], ['done', true]);
    assert.strictEqual(await archived(), null);
    const first = req('archive');
    r = await send(first);
    assert.ok(contracts.resources.checkControlResult(r.body).valid, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.state, r.body.result, r.body.resource], ['done', { archived: true, changed: true }, undefined]);
    assert.ok(await archived(), 'archived_at is set');
    assert.deepStrictEqual((await send(first)).body, r.body, 'the same key answers the first result');
    const conflict = await send({ ...first, dry_run: true });
    assert.deepStrictEqual([conflict.status, conflict.body.code], [409, 'control.idempotency_conflict']);
    assert.deepStrictEqual((await send(req('archive'))).body.result, { archived: true, changed: false });
    const index = await h.http('GET', '/api/v1/resources/?owner=' + owner.subject_id, { token: h.serviceToken(['chat.resource.read']) });
    assert.ok(!index.body.resources.some((x) => x.id === 'control-lobby'), 'an archived room leaves the index');
});

t('only the owner Chat holds; other actions and kinds are refused', async () => {
    let r = await send(req('archive', { owned: { kind: 'chat.room', id: 'control-theirs' } }));
    assert.deepStrictEqual([r.body.state, r.body.problem.code], ['refused', 'resources.unknown_resource'], 'another person\'s room is not confirmed to exist');
    assert.strictEqual(await archived('control-theirs'), null);
    r = await send(req('delete', { owned: { kind: 'chat.room', id: 'control-theirs' } }));
    assert.strictEqual(r.body.problem.code, 'control.unsupported_action');
    r = await send(req('archive', { owned: { kind: 'chat.message', id: 'x1' } }));
    assert.strictEqual(r.body.problem.code, 'resources.unknown_resource');
    r = await send(req('archive', { on_behalf_of: { type: 'user', id: other.subject_id } }));
    assert.deepStrictEqual([r.status, r.body.code], [400, 'control.bad_request'], 'a person acts only on what they own');
    r = await send({ action: 'archive', resource: 'ovrn:chat:prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C:room/roo_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', idempotency_key: 'idem_project_1' });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'control.bad_request'], 'Chat holds no project resources');
});

t('before migration 0010 has run, archive still works (its answers are just not kept)', async () => {
    await h.db.run('INSERT INTO rooms (slug, name, visibility, owner_id, owner_subject) VALUES (?, ?, ?, ?, ?)', ['control-early', 'Early', 'public', owner.id, owner.subject_id]);
    await h.db.run('ALTER TABLE chat_control_log RENAME TO chat_control_log_hidden');
    try {
        const r = await send(req('archive', { owned: { kind: 'chat.room', id: 'control-early' } }));
        assert.deepStrictEqual([r.status, r.body.state, r.body.result], [200, 'done', { archived: true, changed: true }], r.text);
        assert.ok(await archived('control-early'));
    } finally {
        await h.db.run('ALTER TABLE chat_control_log_hidden RENAME TO chat_control_log');
    }
});

t('first-party only, with chat.resource.control', async () => {
    let r = await send(req('archive', { owned: { kind: 'chat.room', id: 'control-theirs' } }), { token: h.serviceToken(['chat.resource.read'], { sub: 'svc:services' }) });
    assert.strictEqual(r.status, 403);
    r = await send(req('archive'), { token: owner.token });
    assert.ok([401, 403].includes(r.status), `a person's own token is refused (${r.status})`);
    r = await send(req('archive'), { token: '' });
    assert.strictEqual(r.status, 401);
});

t.run(() => h && h.close());
